import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadVerifiedAgentArtifact, validateAgentArtifactJson, verifyAgentArtifact } from '../../../packages/plugin-sdk/src/agent-artifacts.ts';
import type { AgentArtifactInput } from '../../../packages/plugin-sdk/src/agent-artifacts.ts';
import type { NodeHandler } from '../../../packages/plugin-sdk/src/index.ts';

type Entry = { input: AgentArtifactInput; loaded: boolean; methods: string[]; reason?: string };
type Active = { methods: Map<string, NodeHandler>; disposers: (() => unknown)[]; accepting: boolean };

export function createAgentArtifactLoader({ dataDir }: { dataDir: string }) {
  const directory = join(dataDir, 'agent-artifacts');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('制品私有目录不能是符号链接');
  chmodSync(directory, 0o700);
  const file = join(directory, 'confirmed.json');
  const entries = new Map<string, Entry>();
  const active = new Map<string, Active>();
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error('制品记录不能是符号链接');
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(saved)) throw new Error('制品记录格式无效');
    for (const value of saved) {
      const input = verifyAgentArtifact(value);
      entries.set(input.manifest.id, { input, loaded: false, methods: [], reason: '进程已重启；仅展示记录，需再次确认后显式加载' });
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const handlers: Record<string, NodeHandler> = Object.create(null);
  let closed = false;
  let queue = Promise.resolve();
  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.then(() => {}, () => {});
    return result;
  }
  function snapshot(entry: Entry) {
    return { ...entry.input.manifest, loaded: entry.loaded, methods: [...entry.methods], ...(entry.reason ? { reason: entry.reason } : {}) };
  }
  async function cleanup(id: string) {
    const resource = active.get(id);
    if (!resource) return;
    resource.accepting = false;
    for (const [method, handler] of resource.methods) if (handlers[method] === handler) delete handlers[method];
    const entry = entries.get(id);
    if (entry) { entry.loaded = false; entry.methods = []; }
    const errors: unknown[] = [];
    for (const dispose of resource.disposers.splice(0).reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    active.delete(id);
    if (errors.length) throw new Error(`插件 ${id} 清理失败：${errors.length} 个回调异常`);
  }
  handlers['extension.status'] = async params => {
    validateAgentArtifactJson(params);
    const id = params.id;
    if (id !== undefined && typeof id !== 'string') throw new Error('插件 id 必须为字符串');
    if (typeof id === 'string') {
      const entry = entries.get(id);
      if (!entry) throw new Error('未知插件，尚未确认');
      return snapshot(entry);
    }
    return { artifacts: [...entries.values()].map(snapshot), closed };
  };
  // The node snapshots its public RPC whitelist. A stable gateway reaches only
  // methods registered by the verified, currently active artifact.
  handlers['extension.call'] = async (params, emit) => {
    validateAgentArtifactJson(params);
    const id = params.id, method = params.method;
    if (typeof id !== 'string' || typeof method !== 'string') throw new Error('需指定插件 id 与方法');
    const entry = entries.get(id);
    const resource = active.get(id);
    if (!entry?.loaded || params.version !== entry.input.manifest.version || params.sha256 !== entry.input.manifest.sha256 || !entry.methods.includes(method) || !resource?.methods.has(method)) throw new Error('插件未加载或方法未注册');
    const input = params.params ?? {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('方法参数必须为 JSON 对象');
    return resource.methods.get(method)!(input, emit);
  };
  handlers['extension.load'] = async params => serialized(async () => {
    if (closed) throw new Error('制品加载器已关闭');
    // Invalid replacement requests must never stop an existing verified plugin or execute code.
    const input = verifyAgentArtifact(params);
    const { id, version, sha256 } = input.manifest;
    const previous = entries.get(id);
    if (previous?.loaded && previous.input.manifest.sha256 === sha256 && previous.input.manifest.version === version) return snapshot(previous);
    await cleanup(id);
    const entry: Entry = { input, loaded: false, methods: [] };
    entries.set(id, entry);
    const resource: Active = { methods: new Map(), disposers: [], accepting: true };
    active.set(id, resource);
    try {
      // Save confirmed source as private inert data, never scan/import old files at startup.
      const temporary = join(directory, 'confirmed.json.tmp');
      writeFileSync(temporary, JSON.stringify([...entries.values()].map(item => item.input)), { mode: 0o600, flag: 'w' });
      chmodSync(temporary, 0o600);
      renameSync(temporary, file);
      const module = await loadVerifiedAgentArtifact(input);
      const plugin = module.default as { id?: unknown; version?: unknown; activate?: unknown } | undefined;
      if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin) || plugin.id !== id || plugin.version !== version || typeof plugin.activate !== 'function') throw new Error('插件 default 必须为匹配 manifest 的 {id,version,activate}');
      await plugin.activate(Object.freeze({
        register(method: string, handler: NodeHandler) {
          if (!resource.accepting) throw new Error('注册仅允许在 activate 期间');
          if (typeof method !== 'string' || !method.startsWith(`x.${id}.`) || method.length <= id.length + 3
            || typeof handler !== 'function' || Object.hasOwn(handlers, method) || resource.methods.has(method)) throw new Error('插件方法必须使用自己的 x.<id>.* 且不能重复注册');
          const wrapped: NodeHandler = async (params, emit) => {
            validateAgentArtifactJson(params);
            const result = await handler(params, (event, data) => { validateAgentArtifactJson(data); emit(event, data); });
            validateAgentArtifactJson(result);
            return result;
          };
          resource.methods.set(method, wrapped);
        },
        defer(dispose: () => unknown) {
          if (!resource.accepting || typeof dispose !== 'function') throw new Error('defer 仅接受 activate 期间的清理回调');
          resource.disposers.push(dispose);
        },
      }));
      resource.accepting = false;
      if (closed) throw new Error('制品加载器已关闭');
      for (const [method, handler] of resource.methods) {
        if (Object.hasOwn(handlers, method)) throw new Error('插件方法已被占用');
        handlers[method] = handler;
      }
      entry.loaded = true;
      entry.methods = [...resource.methods.keys()];
      return snapshot(entry);
    } catch (error) {
      let reason = error instanceof Error ? error.message : '插件加载失败';
      try { await cleanup(id); } catch (failure) { reason += `；${(failure as Error).message}`; }
      entry.reason = reason;
      throw new Error(reason);
    }
  });
  let closing: Promise<void> | undefined;
  return { handlers, close(): Promise<void> {
    closed = true;
    return closing ??= serialized(async () => {
      const errors: unknown[] = [];
      for (const id of [...active.keys()]) { try { await cleanup(id); } catch (error) { errors.push(error); } }
      if (errors.length) throw new Error('部分插件资源清理失败');
    });
  } };
}

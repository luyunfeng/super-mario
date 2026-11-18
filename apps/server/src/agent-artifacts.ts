import { randomUUID } from 'node:crypto';
import { agentArtifactSha256, validateAgentArtifactJson, validateAgentArtifactManifest, verifyAgentArtifact } from '../../../packages/plugin-sdk/src/agent-artifacts.ts';
import type { AgentArtifactApproval, AgentArtifactManifest } from '../../../packages/plugin-sdk/src/agent-artifacts.ts';
import type { EventBus, MachineClient, Store } from '../../../packages/plugin-sdk/src/index.ts';

type State = 'pending' | 'confirmed' | 'deploying' | 'loaded' | 'failed' | 'unknown' | 'unloaded';
export interface AgentArtifactRecord {
  id: string; pluginId: string; machineId: string; manifest: AgentArtifactManifest; source: string;
  status: State; approval?: AgentArtifactApproval; reason?: string; methods?: string[];
}
const collection = 'agent-artifacts';
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function createAgentArtifacts({ store, events, machines }: { store: Store; events: EventBus; machines: () => MachineClient | undefined }) {
  // A server crash during delivery cannot establish whether activation finished.
  for (const record of store.list<AgentArtifactRecord>(collection)) {
    if (record.status === 'deploying') save({ ...record, status: 'unknown', reason: '服务端在加载期间重启，执行结果未知；请查看执行机状态，不会自动重试' });
  }
  function save(record: AgentArtifactRecord) {
    store.put(collection, record.id, record);
    events.publish('agent-artifacts.changed', { id: record.id, pluginId: record.pluginId, status: record.status });
    return structuredClone(record);
  }
  function get(id: string) { return store.get<AgentArtifactRecord>(collection, id) ?? fail('制品记录不存在', 404); }
  function client(record: AgentArtifactRecord): MachineClient {
    const value = machines();
    if (!value) fail('执行机连接服务不可用', 503);
    if (!value.list().some(machine => machine.id === record.machineId && machine.online)) fail('执行机离线；未发送加载请求', 503);
    return value;
  }
  function validResult(value: unknown, record: AgentArtifactRecord): value is { loaded: true; methods: string[] } {
    validateAgentArtifactJson(value);
    return object(value) && value.id === record.pluginId && value.version === record.manifest.version
      && value.sha256 === record.manifest.sha256 && value.loaded === true && Array.isArray(value.methods)
      && value.methods.every(method => typeof method === 'string' && method.startsWith(`x.${record.pluginId}.`))
      && new Set(value.methods).size === value.methods.length;
  }
  return {
    list(): AgentArtifactRecord[] { return store.list<AgentArtifactRecord>(collection); },
    stage(input: unknown): AgentArtifactRecord {
      validateAgentArtifactJson(input);
      if (!object(input) || !object(input.manifest) || typeof input.machineId !== 'string' || !input.machineId.trim()
        || typeof input.source !== 'string') fail('需提供 machineId、manifest 和单文件 ESM source');
      const sha256 = agentArtifactSha256(input.source);
      if (input.manifest.sha256 !== undefined && input.manifest.sha256 !== sha256) fail('制品 SHA256 不符');
      const manifest = validateAgentArtifactManifest({ ...input.manifest, sha256 });
      // Every stage creates a new immutable review record, even when the plugin ID is unchanged.
      return save({ id: randomUUID(), pluginId: manifest.id, machineId: input.machineId, manifest, source: input.source, status: 'pending' });
    },
    approve(id: string, input: unknown): AgentArtifactRecord {
      validateAgentArtifactJson(input);
      const record = get(id);
      if (!object(input) || input.sha256 !== record.manifest.sha256) fail('确认的 SHA256 必须与当前制品精确相同');
      if (record.status !== 'pending' && record.status !== 'confirmed') fail('该记录已经尝试加载；请核查状态，需要再次尝试时重新暂存并确认');
      if (agentArtifactSha256(record.source) !== record.manifest.sha256) fail('存储的制品 SHA256 不符');
      return save({ ...record, status: 'confirmed', approval: { id: record.pluginId, version: record.manifest.version, sha256: record.manifest.sha256, approved: true } });
    },
    async deploy(id: string): Promise<AgentArtifactRecord> {
      const record = get(id);
      if (record.status !== 'confirmed') fail('必须先确认此版本；失败或结果未知不会自动重试');
      const input = verifyAgentArtifact({ manifest: record.manifest, source: record.source, approval: record.approval ?? null });
      let attempted = false;
      try {
        const node = client(record);
        save({ ...record, status: 'deploying' });
        attempted = true;
        const result = await node.call(record.machineId, 'extension.load', { manifest: { ...input.manifest }, source: input.source, approval: { ...input.approval } });
        if (!validResult(result, record)) throw new Error('执行机未返回匹配版本、SHA256 与 loaded:true 的有效确认，结果未知');
        return save({ ...record, status: 'loaded', methods: result.methods });
      } catch (error) {
        const noDelivery = object(error) && error.delivery === 'no';
        const status = attempted && !noDelivery ? 'unknown' : 'failed';
        save({ ...record, status, reason: error instanceof Error ? error.message : '加载失败，执行结果未知' });
        throw error;
      }
    },
    async call(id: string, input: unknown) {
      validateAgentArtifactJson(input);
      const record = get(id);
      if (record.status !== 'loaded' || !object(input) || typeof input.method !== 'string' || !record.methods?.includes(input.method)) fail('插件未核实加载或方法不属于此制品');
      verifyAgentArtifact({ manifest: record.manifest, source: record.source, approval: record.approval ?? null });
      return client(record).call(record.machineId, 'extension.call', { id: record.pluginId, version: record.manifest.version, sha256: record.manifest.sha256, method: input.method, params: input.params as import('../../../packages/protocol/src/index.ts').Json ?? {} });
    },
    async status(id: string): Promise<AgentArtifactRecord> {
      const record = get(id);
      if (!record.approval || record.status === 'pending') return { ...record, reason: '尚未确认此版本，不核实或加载代码' };
      verifyAgentArtifact({ manifest: record.manifest, source: record.source, approval: record.approval });
      try {
        const result = await client(record).call(record.machineId, 'extension.status', { id: record.pluginId });
        if (validResult(result, record)) return save({ ...record, status: 'loaded', methods: result.methods, reason: '执行机已核实该版本正在加载' });
        if (object(result) && result.loaded === false && result.id === record.pluginId
          && result.version === record.manifest.version && result.sha256 === record.manifest.sha256) {
          return save({ ...record, status: 'unloaded', methods: [], reason: '执行机仅保留记录，当前未加载；重新暂存并确认后才可加载' });
        }
        return save({ ...record, status: record.status === 'loaded' ? 'unknown' : record.status, reason: '执行机当前状态与此制品不匹配，不能证明已加载' });
      } catch (error) {
        return save({ ...record, status: record.status === 'loaded' ? 'unknown' : record.status, reason: error instanceof Error ? error.message : '无法获取执行机状态' });
      }
    },
  };
}

import { summarizeNativeUsage } from './native-session-usage.ts';
import { readNativeTranscript, transcriptRange } from './native-session-transcript.ts';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, parse, relative } from 'node:path';
import type { AgentSessionDiscovery, NativeExecutorId, ObservedAgentSession } from '../packages/protocol/src/index.ts';
import type { NodeHandler } from '../packages/plugin-sdk/src/index.ts';
import { createProjectDiscovery, parseSessionHeader } from './project-discovery.ts';

const limits = { roots: 32, directories: 2048, entries: 16384, perDirectory: 2048, files: 4096, results: 2048, head: 16 * 1024, index: 1024 * 1024, warnings: 12 };
type Options = { home?: string; codexHome?: string; claudeHome?: string; cwd?: string; roots?: string[]; temporaryRoots?: string[] };
type Selection = { executorId: NativeExecutorId; nativeSessionId: string; cwd: string };
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function absolute(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /\p{Cc}/u.test(value) || !isAbsolute(value)) throw new Error('cwd/roots 必须是绝对目录');
  return normalize(value);
}
function rootsList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > limits.roots) throw new Error('roots 必须是最多 32 个绝对目录');
  return value.map(absolute);
}
function only(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('会话请求包含无效参数');
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.startsWith('-') && !/[\s\p{Cc}]/u.test(value);
}
function date(value: unknown): string | undefined {
  const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function inside(root: string, path: string): boolean { const rest = relative(root, path); return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('../')); }
function missing(error: unknown): boolean { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? ''); }

// Reject links in every component, including a symlink above a metadata root.
async function noLinks(path: string): Promise<boolean> {
  for (let current = path; ; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) return false;
    if (dirname(current) === current) return true;
  }
}

/** Native history only. No process inspection, spawn, writes, or transcript retention. */
export function createCliSessionDiscovery(options: Options = {}) {
  const home = absolute(options.home ?? homedir());
  // A configured home may itself be an OS/user alias; pin its canonical root once.
  const canonicalHome = realpath(home).catch(() => home);
  // These are CLI config directories, not user homes. Never mix explicit profiles
  // with default history; only the configured root may be a canonicalized alias.
  function profileRoot(value: string | undefined, name: string) {
    if (value === undefined) return canonicalHome.then(root => join(root, name));
    const root = absolute(value);
    if (root === parse(root).root) throw new Error('CLI 配置目录不能是文件系统根目录');
    return realpath(root).catch(() => root);
  }
  const codexHome = profileRoot(options.codexHome, '.codex');
  const claudeHome = profileRoot(options.claudeHome, '.claude');
  const configuredRoots = options.roots === undefined ? undefined : rootsList(options.roots);
  const projects = createProjectDiscovery({ ...options, home, roots: [], ignoreEnvironmentRoots: true });

  async function scan(target?: Selection) {
    const result: AgentSessionDiscovery = { sessions: [], roots: [], warnings: [], truncated: false };
    const logs = new Map<string, { path: string; dev: number; ino: number }>();
    const found = new Map<string, ObservedAgentSession>();
    const conflicts = new Set<string>();
    let directories = 0, entries = 0, files = 0;
    function warn(message: string) {
      if (result.warnings.includes(message)) return;
      if (result.warnings.length < limits.warnings) result.warnings.push(message);
      else result.truncated = true;
    }
    function cut() { result.truncated = true; warn('会话元数据读取达到限额，结果不完整'); }
    async function head(path: string, max: number) {
      if (files >= limits.files) { cut(); return; }
      files++;
      let file;
      try {
        if (!await noLinks(path) || !(await lstat(path)).isFile()) return;
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await file.stat();
        if (!info.isFile()) return;
        // fstat detects an oversized file without reading one byte beyond the head budget.
        const buffer = Buffer.alloc(max);
        const { bytesRead } = await file.read(buffer, 0, max, 0);
        return { dev: info.dev, ino: info.ino, text: buffer.subarray(0, bytesRead).toString('utf8'), cut: info.size > bytesRead, observedAt: new Date().toISOString(), fileModifiedAt: info.mtime.toISOString() };
      } catch (error) { if (!missing(error)) { cut(); warn('部分会话元数据无法读取'); } }
      finally { await file?.close(); }
    }
    async function add(executorId: NativeExecutorId, meta: Record<string, unknown>, observedAt: string, index = false, outerTime?: unknown, fileModifiedAt?: string) {
      const id = executorId === 'codex' ? meta.id : meta.sessionId ?? meta.session_id;
      if (!validId(id)) { warn('部分会话元数据缺少有效原生 ID，已跳过'); return false; }
      if (target && (executorId !== target.executorId || id !== target.nativeSessionId)) return true;
      const key = `${executorId}:${id}`;
      if (executorId === 'claude-code' && meta.sessionId !== undefined && meta.session_id !== undefined && meta.sessionId !== meta.session_id) {
        for (const candidate of [meta.sessionId, meta.session_id]) if (validId(candidate)) { conflicts.add(`${executorId}:${candidate}`); found.delete(`${executorId}:${candidate}`); }
        warn('会话原生 ID 元数据冲突，已跳过'); return false;
      }
      let cwd: string;
      try {
        const raw = absolute(index ? meta.projectPath : meta.cwd);
        cwd = await realpath(raw);
        if (!(await stat(cwd)).isDirectory()) throw new Error('not directory');

      } catch {
        if ((index ? meta.projectPath : meta.cwd) !== undefined) { conflicts.add(key); found.delete(key); }
        warn('部分会话目录不存在或无效，已跳过'); return false;
      }
      if (conflicts.has(key)) return true;
      const previous = found.get(key);
      if (previous && previous.cwd !== cwd) {
        found.delete(key); conflicts.add(key); warn('相同原生会话 ID 对应不同目录，已拒绝'); return true;
      }
      const metadataTimestamp = date(index ? meta.modified ?? meta.created : meta.timestamp ?? outerTime);
      const source = object(meta.source) ? meta.source : undefined;
      const subagent = object(source?.subagent) ? source.subagent : undefined;
      const spawned = object(subagent?.thread_spawn) ? subagent.thread_spawn : undefined;
      const parent = meta.parent_thread_id ?? spawned?.parent_thread_id ?? meta.parent_session_id ?? meta.parentSessionId ?? meta.forked_from_id;
      if (previous) {
        previous.observedAt = observedAt;
        if (fileModifiedAt && (!previous.fileModifiedAt || fileModifiedAt > previous.fileModifiedAt)) previous.fileModifiedAt = fileModifiedAt;
        if (metadataTimestamp && (!previous.metadataTimestamp || metadataTimestamp > previous.metadataTimestamp)) previous.metadataTimestamp = metadataTimestamp;
        if (validId(parent) && !previous.parentNativeSessionId) previous.parentNativeSessionId = parent;
        return true;
      }
      if (found.size >= limits.results) { cut(); return true; }
      found.set(key, { id: key, executorId, nativeSessionId: id, cwd, observedAt,
        ...(metadataTimestamp ? { metadataTimestamp } : {}), ...(fileModifiedAt ? { fileModifiedAt } : {}), ...(validId(parent) ? { parentNativeSessionId: parent } : {}),
        source: 'session-metadata', state: 'historical', writable: false });
      return true;
    }
    async function metadata(path: string, executorId: NativeExecutorId, index: boolean) {
      const data = await head(path, index ? limits.index : limits.head);
      if (!data) return;
      if (index) {
        if (data.cut) { cut(); return; }
        try {
          const value: unknown = JSON.parse(data.text);
          if (!object(value) || !Array.isArray(value.entries)) throw new Error('index');
          for (const entry of value.entries) {
            if (entries >= limits.entries) { cut(); break; }
            entries++;
            if (object(entry)) await add(executorId, entry, data.observedAt, true);
          }
        } catch { warn('部分会话索引 JSON 无效，已跳过'); }
        return;
      }
      const lines = path.endsWith('.json') && !data.cut ? [data.text] : data.text.split('\n');
      let matched = false;
      for (const [i, line] of (path.endsWith('.json') && data.cut ? [data.text] : lines.slice(0, 8)).entries()) {
        if (!line.trim()) continue;
        let row: unknown;
        try { row = JSON.parse(line); }
        catch {
          // Only an incomplete bounded first record permits structural prefix parsing.
          // A complete malformed record must never turn into a plausible session.
          if (i === 0 && data.cut && (path.endsWith('.json') || lines.length === 1)) row = parseSessionHeader(line, executorId === 'codex');
          else { warn('部分会话头 JSON 无效，已跳过'); continue; }
        }
        if (!object(row)) continue;
        const meta = executorId === 'codex' ? row.type === 'session_meta' && object(row.payload) ? row.payload : undefined : row;
        if (meta) matched = await add(executorId, meta, data.observedAt, false, row.timestamp, data.fileModifiedAt) || matched;
        if (matched) {
          if (target && path.endsWith('.jsonl') && meta && (meta.id === target.nativeSessionId && executorId === 'codex' || executorId === 'claude-code' && (meta.sessionId ?? meta.session_id) === target.nativeSessionId)) {
            logs.set(path, { path, dev: data.dev, ino: data.ino });
          }
          break;
        }
      }
      if (!matched) {
        if (data.cut || lines.length > 8) cut();
        warn('部分会话头缺少有效身份或目录，已跳过');
      }
    }
    async function walk(path: string, executorId: NativeExecutorId, depth: number) {
      if (directories >= limits.directories || entries >= limits.entries || files >= limits.files) { cut(); return; }
      directories++;
      try {
        if (!await noLinks(path)) { cut(); warn('部分会话元数据路径是软链接，未读取'); return; }
        if (!(await lstat(path)).isDirectory()) return;
        const dir = await opendir(path);
        const children = [];
        for await (const entry of dir) {
          if (children.length >= limits.perDirectory || entries >= limits.entries) { cut(); break; }
          entries++; children.push(entry);
        }
        children.sort((a, b) => b.name.localeCompare(a.name));
        for (const entry of children) {
          if (files >= limits.files) { cut(); break; }
          const child = join(path, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { if (depth > 0) await walk(child, executorId, depth - 1); else cut(); }
          else if (entry.isFile() && /\.jsonl?$/.test(entry.name) && (!target || entry.name === 'sessions-index.json' || entry.name.includes(target.nativeSessionId))) await metadata(child, executorId, entry.name === 'sessions-index.json');
        }
      } catch (error) { if (!missing(error)) { cut(); warn('部分会话目录无法读取'); } }
    }
    async function available(root: string, explicit: boolean, label: string) {
      if (!explicit) return true;
      try { if (root !== parse(root).root && await noLinks(root) && (await lstat(root)).isDirectory()) return true; }
      catch { /* Explicit missing/unreadable roots never fall back to another profile. */ }
      warn(`${label} 显式配置目录不存在或不可用，未读取会话`);
      return false;
    }
    const codexRoot = await codexHome, claudeRoot = await claudeHome;
    if ((!target || target.executorId === 'codex') && await available(codexRoot, options.codexHome !== undefined, 'Codex')) {
      await walk(join(codexRoot, 'sessions'), 'codex', 3);
      await walk(join(codexRoot, 'archived_sessions'), 'codex', 0);
    }
    if ((!target || target.executorId === 'claude-code') && await available(claudeRoot, options.claudeHome !== undefined, 'Claude')) {
      await walk(join(claudeRoot, 'projects'), 'claude-code', 2);
      await walk(join(claudeRoot, 'sessions'), 'claude-code', 1);
    }
    return { result, found, conflicts, logs };
  }

  function visibleParents(sessions: ObservedAgentSession[]) {
    const ids = new Set(sessions.map(session => session.id));
    return sessions.map(session => {
      const copy = { ...session };
      if (!ids.has(`${copy.executorId}:${copy.parentNativeSessionId}`)) delete copy.parentNativeSessionId;
      return copy;
    });
  }
  async function sessions(params: unknown): Promise<AgentSessionDiscovery> {
    only(params, ['roots']);
    const requested = params.roots === undefined ? configuredRoots : rootsList(params.roots);
    const { result, found } = await scan();
    const allowed = projects.nativeDirectoryFilter(message => {
      if (!result.warnings.includes(message) && result.warnings.length < limits.warnings) result.warnings.push(message);
    });
    const authorized = new Set<string>();
    for (const cwd of new Set([...found.values()].map(session => session.cwd))) {
      if (await allowed(cwd)) authorized.add(cwd);
    }
    if (requested) for (const raw of requested) {
      try {
        const root = await realpath(raw);
        if (!(await stat(root)).isDirectory() || root === parse(root).root) throw new Error('root');
        if (!result.roots.includes(root)) result.roots.push(root);
      } catch { if (result.warnings.length < limits.warnings) result.warnings.push('指定会话范围不存在、为软链接或不可用'); else result.truncated = true; }
    }
    result.sessions = visibleParents([...found.values()].filter(session => authorized.has(session.cwd)
      && (!requested || result.roots.some(root => inside(root, session.cwd)))));
    result.sessions.sort((a, b) => (b.fileModifiedAt ?? b.metadataTimestamp ?? '').localeCompare(a.fileModifiedAt ?? a.metadataTimestamp ?? '') || a.id.localeCompare(b.id));
    return result;
  }
  async function validateResume(input: Selection): Promise<ObservedAgentSession> {
    only(input, ['executorId', 'nativeSessionId', 'cwd']);
    if (!['codex', 'claude-code'].includes(input.executorId) || !validId(input.nativeSessionId)) throw new Error('无效的原生会话身份');
    const asked = absolute(input.cwd);
    let cwd: string;
    try { cwd = await realpath(asked); if (!(await stat(cwd)).isDirectory()) throw new Error('directory'); }
    catch { throw new Error('恢复目录不存在或不是文件夹'); }
    // Native filenames/indexes locate the requested thread before reading headers.
    // This avoids making one exact lookup depend on every unrelated transcript's budget.
    // Identity/cwd still come from metadata, never from the filename itself.
    const broad = await scan();
    const key = `${input.executorId}:${input.nativeSessionId}`;
    if (broad.conflicts.has(key)) throw new Error('原生会话目录元数据冲突，拒绝恢复');
    // Preserve all conflicts seen in normal history; only bypass an unrelated
    // history budget when every matching indexed record was read completely.
    let selected = broad;
    if (broad.result.truncated) {
      const indexed = await scan(input);
      if (indexed.found.has(key) || indexed.conflicts.has(key)) selected = indexed;
    }
    const { result, found, conflicts } = selected;
    if (conflicts.has(key)) throw new Error('原生会话目录元数据冲突，拒绝恢复');
    if (result.truncated) throw new Error('原生会话元数据读取不足，无法验证恢复');
    const session = found.get(key);
    if (!session || session.cwd !== cwd) throw new Error('未找到身份和目录完全匹配的原生会话');
    // The exact lookup returns one session; its parent is outside this return scope.
    return visibleParents([session])[0];
  }
  const handlers = {
    'agents.transcript': async (params: unknown) => {
      only(params, ['executorId', 'nativeSessionId', 'cwd', 'offset', 'snapshot']);
      const target = params as Selection;
      if (!['codex', 'claude-code'].includes(target.executorId) || !validId(target.nativeSessionId)) throw new Error('无效会话');
      const range = transcriptRange(params.offset, params.snapshot);
      const cwd = await realpath(absolute(target.cwd));
      if (!await projects.nativeDirectoryFilter(() => {})(cwd)) throw new Error('目录不在会话读取范围');
      const { result, logs, found, conflicts } = await scan(target);
      const key = `${target.executorId}:${target.nativeSessionId}`;
      const [log] = logs.values();
      // An incomplete scan cannot prove uniqueness or exclude a conflicting header.
      if (result.truncated || !log || logs.size !== 1 || conflicts.has(key) || found.get(key)?.cwd !== cwd) throw new Error('未找到唯一匹配的完整会话日志');
      return readNativeTranscript(log, range, noLinks);
    },
    'agents.usage': async (params: unknown) => {
      only(params, ['executorId', 'nativeSessionId', 'cwd']);
      const target = params as Selection;
      if (!['codex', 'claude-code'].includes(target.executorId) || !validId(target.nativeSessionId)) throw new Error('无效会话');
      const cwd = await realpath(absolute(target.cwd));
      if (!await projects.nativeDirectoryFilter(() => {})(cwd)) throw new Error('目录不在会话读取范围');
      const { logs, found, conflicts } = await scan(target);
      const key = target.executorId + ':' + target.nativeSessionId;
      const [log] = logs.values();
      if (!log || logs.size !== 1 || conflicts.has(key) || found.get(key)?.cwd !== cwd || !await noLinks(log.path)) throw new Error('未找到唯一匹配的会话日志');
      const file = await open(log.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.dev !== log.dev || stat.ino !== log.ino) throw new Error('会话日志已被替换');
        const size = Math.min(stat.size, 8 * 1024 * 1024), start = stat.size - size;
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await file.read(buffer, 0, size, start);
        const bytes = buffer.subarray(0, bytesRead);
        const boundary = start ? bytes.indexOf(10) : -1;
        const text = start && boundary < 0 ? '' : bytes.subarray(boundary + 1).toString('utf8');
        return summarizeNativeUsage(text, target.executorId, target.nativeSessionId, start > 0 || bytesRead !== size);
      } finally { await file.close(); }
    },
    'agents.sessions': async (params: unknown) => { const result = await sessions(params); return { ...result, sessions: result.sessions.map(session => ({ ...session })) }; },
    'agents.session': async (params: unknown) => { only(params, ['executorId', 'nativeSessionId', 'cwd']); return { ...await validateResume(params as Selection) }; },
  } satisfies Record<string, NodeHandler>;
  return { handlers, validateResume };
}

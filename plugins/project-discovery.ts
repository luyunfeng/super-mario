import { constants } from 'node:fs';
import { workspaceCode } from './workspace-code.ts';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, normalize, parse, resolve, relative } from 'node:path';
import type { DiscoveredProject, ProjectDiscovery } from '../packages/protocol/src/index.ts';
import type { NodeHandler } from '../packages/plugin-sdk/src/index.ts';

// Per request budgets bound disk work and memory, including directories with huge fan-out.
const limits = { roots: 32, directories: 512, entries: 8192, perDirectory: 512, sessions: 256, projects: 512, head: 16 * 1024, index: 1024 * 1024, warnings: 12 };
const skipped = new Set(['node_modules', '.git', '.cache', 'cache', 'caches', 'Cache', 'Caches', '.npm', '.local', '.venv', 'venv', 'dist', 'build', 'vendor', 'Library', '.Trash']);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function absolute(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 4096 || !isAbsolute(value)) throw new Error('目录必须是绝对路径');
  return normalize(value);
}
function rootList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > limits.roots) throw new Error('roots 必须是最多 32 个绝对目录');
  return value.map(absolute);
}
function paramsOnly(params: unknown, keys: string[]): asserts params is Record<string, unknown> {
  if (!object(params) || Object.keys(params).some(key => !keys.includes(key))) throw new Error('目录请求包含无效参数');
}
function missing(error: unknown): boolean { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? ''); }
async function noLinks(path: string): Promise<boolean> {
  for (let current = path; ; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) return false;
    if (dirname(current) === current) return true;
  }
}
function date(value: unknown): string | undefined {
  const time = typeof value === 'number' || typeof value === 'string' ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

// Extract scalar object headers from an incomplete first line. Strings and nested values
// are skipped structurally, so a cwd mentioned inside prompt text is never a project.
export function parseSessionHeader(text: string, nestedPayload = false): Record<string, unknown> {
  let at = 0;
  const whitespace = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  function value(): unknown {
    whitespace();
    const start = at;
    if (text[at] === '"') {
      at++;
      while (at < text.length) {
        if (text[at] === '\\') { at += 2; continue; }
        if (text[at++] === '"') return JSON.parse(text.slice(start, at));
      }
      throw new Error('incomplete');
    }
    if (text[at] === '{' || text[at] === '[') {
      const end = text[at++] === '{' ? '}' : ']';
      while (at < text.length) {
        whitespace();
        if (text[at] === end) { at++; return undefined; }
        if (text[at] === ',' || text[at] === ':') { at++; continue; }
        value();
      }
      throw new Error('incomplete');
    }
    while (at < text.length && !/[\s,}\]]/.test(text[at])) at++;
    if (at === start) throw new Error('invalid');
    return JSON.parse(text.slice(start, at));
  }
  function fields(payload: boolean, section = 'meta'): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    whitespace();
    if (text[at++] !== '{') return out;
    try {
      while (at < text.length) {
        whitespace();
        if (text[at] === '}') { at++; break; }
        const key = value();
        whitespace();
        if (typeof key !== 'string' || text[at++] !== ':') break;
        whitespace();
        const child = section === 'meta' && key === 'source' ? 'source' : section === 'source' && key === 'subagent' ? 'subagent' : section === 'subagent' && key === 'thread_spawn' ? 'thread_spawn' : undefined;
        if (payload && key === 'payload') out.payload = fields(false);
        else if (child && text[at] === '{') out[key] = fields(false, child);
        else {
          const scalar = value();
          if (['cwd', 'type', 'timestamp', 'id', 'sessionId', 'session_id', 'parentSessionId', 'parent_session_id', 'parent_thread_id', 'forked_from_id'].includes(key)) out[key] = scalar;
        }
        whitespace();
        if (text[at++] !== ',') break;
      }
    } catch { /* Only fully decoded header scalars are retained from a bounded prefix. */ }
    return out;
  }
  return fields(nestedPayload);
}

/** Read-only inventory. No terminal, process spawning, project persistence or directory creation. */
export function createProjectDiscovery(options: { home?: string; codexHome?: string; claudeHome?: string; cwd?: string; roots?: string[]; temporaryRoots?: string[]; ignoreEnvironmentRoots?: boolean } = {}) {
  const home = absolute(options.home ?? homedir());
  const canonicalHome = realpath(home).catch(() => home);
  // Pin aliases only at the user/config root. Metadata descendants remain link-free.
  function profileRoot(value: string | undefined, name: string) {
    if (value === undefined) return canonicalHome.then(root => join(root, name));
    const root = absolute(value);
    if (/\p{Cc}/u.test(root) || root === parse(root).root) throw new Error('CLI 配置目录必须是有界的绝对目录');
    return realpath(root).catch(() => root);
  }
  const codexHome = profileRoot(options.codexHome, '.codex');
  const claudeHome = profileRoot(options.claudeHome, '.claude');
  if (options.cwd !== undefined) absolute(options.cwd);
  // Injectable roots keep temporary test fixtures independent of the host's /tmp.
  const temporaryRoots = (options.temporaryRoots ?? [tmpdir(), '/tmp', '/var/tmp', '/dev/shm']).map(absolute);
  const temporary = (path: string) => temporaryRoots.some(root => { const rest = relative(root, path); return rest === '' || (rest !== '..' && !rest.startsWith('../') && !isAbsolute(rest)); });
  const configuredRoots = options.roots === undefined ? undefined : rootList(options.roots);

  async function directory(params: unknown) {
    paramsOnly(params, ['cwd']);
    const asked = absolute(params.cwd);
    try {
      const canonical = await realpath(asked);
      if (!(await stat(canonical)).isDirectory()) throw new Error('not directory');
      return { cwd: canonical, exists: true as const };
    } catch { throw new Error('文件夹不存在、不可访问或不是目录'); }
  }

  async function projects(params: unknown) {
    paramsOnly(params, ['roots']);
    const requested = params.roots === undefined ? configuredRoots : rootList(params.roots);
    const result: ProjectDiscovery = { projects: [], roots: [], warnings: [], truncated: false };
    const found = new Map<string, DiscoveredProject>();
    const worktreeCache = new Map<string, boolean>();
    let directories = 0, entriesRead = 0, sessions = 0;
    function warn(message: string) {
      if (result.warnings.includes(message)) return;
      if (result.warnings.length < limits.warnings) result.warnings.push(message);
      else result.truncated = true;
    }
    async function add(raw: unknown, source: string, lastUsedAt?: unknown) {
      let path: string;
      try { path = absolute(raw); } catch { warn('部分项目元数据缺少有效绝对目录，已跳过'); return; }
      if (temporary(path)) return;
      let exists = true;
      try {
        path = await realpath(path);
        if (!(await stat(path)).isDirectory()) { warn('部分项目路径不是文件夹，已跳过'); return; }
      } catch (error) {
        if (!missing(error)) { warn('部分项目文件夹不可访问，已跳过'); return; }
        exists = false;
      }
      if (temporary(path) || await inLinkedWorktree(path)) return;
      if (!exists && source === 'git') return;
      const time = date(lastUsedAt);
      const previous = found.get(path);
      if (previous) {
        if (!previous.sources.includes(source)) previous.sources.push(source);
        if (time && (!previous.lastUsedAt || time > previous.lastUsedAt)) previous.lastUsedAt = time;
        return;
      }
      if (found.size >= limits.projects) { result.truncated = true; return; }
      found.set(path, { name: basename(path) || path, cwd: path, sources: [source], exists, ...(time ? { lastUsedAt: time } : {}) });
    }
    async function children(path: string) {
      if (directories >= limits.directories || entriesRead >= limits.entries) { result.truncated = true; return []; }
      directories++;
      try {
        // Explicit scan roots may be links, but recursive traversal never follows directory links.
        if ((await lstat(path)).isSymbolicLink()) return [];
        const out = [];
        const dir = await opendir(path);
        for await (const entry of dir) {
          if (out.length >= limits.perDirectory || entriesRead >= limits.entries) { result.truncated = true; break; }
          entriesRead++;
          out.push(entry);
        }
        return out.sort((a, b) => b.name.localeCompare(a.name));
      } catch (error) { if (!missing(error)) warn('部分目录无法读取，已跳过'); return []; }
    }
    async function head(path: string, maxBytes = limits.head): Promise<{ text: string; cut: boolean } | undefined> {
      let file;
      try {
        // Do not follow metadata symlinks or open named pipes/devices.
        if (!(await lstat(path)).isFile()) return;
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (!(await file.stat()).isFile()) return;
        const buffer = Buffer.alloc(maxBytes + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return { text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf8'), cut: bytesRead > maxBytes };
      } catch (error) { if (!missing(error)) warn('部分项目元数据无法读取，已跳过'); return; }
      finally { await file?.close(); }
    }
    // A .git file can also belong to a submodule or a separated git-dir. Only
    // commondir identifies a linked worktree. Inspect ancestors too: CLI history
    // often stores a worktree's subdirectory rather than its root.
    async function inLinkedWorktree(path: string): Promise<boolean> {
      const cached = worktreeCache.get(path);
      if (cached !== undefined) return cached;
      let linked = false;
      try {
        const marker = join(path, '.git'), info = await lstat(marker);
        if (info.isFile()) {
          const data = await head(marker);
          const target = data && !data.cut ? /^gitdir: (.+)\r?$/m.exec(data.text)?.[1]?.trim() : undefined;
          if (target) {
            const gitdir = resolve(path, target);
            const common = await head(join(gitdir, 'commondir'));
            linked = Boolean(common && !common.cut && common.text.trim() && resolve(gitdir, common.text.trim()) !== gitdir);
          }
        }
        // A repository boundary prevents classifying an independent nested repo
        // as part of a parent's worktree.
      } catch (error) {
        if (missing(error)) { const parent = dirname(path); if (parent !== path) linked = await inLinkedWorktree(parent); }
        else { linked = true; warn('部分目录的 Git 标记无法读取，已跳过'); }
      }
      worktreeCache.set(path, linked);
      return linked;
    }
    async function metadata(path: string, source: string, kind: 'session' | 'config' | 'index') {
      if (sessions >= limits.sessions) { result.truncated = true; return; }
      try { if (!await noLinks(path)) { warn('部分项目元数据路径是软链接，未读取'); return; } }
      catch (error) { if (!missing(error)) warn('部分项目元数据无法读取，已跳过'); return; }
      // Project indexes are JSON documents, unlike transcript headers. Give them
      // a separate bounded budget so ordinary large CLI configs are not discarded.
      const data = await head(path, kind === 'session' ? limits.head : limits.index);
      if (!data) return;
      sessions++;
      if (kind !== 'session') {
        if (data.cut) { result.truncated = true; warn('部分项目索引超过读取上限，已跳过'); return; }
        try {
          const value: unknown = JSON.parse(data.text);
          if (!object(value)) throw new Error('metadata');
          if (kind === 'config') {
            if (object(value.projects)) for (const [path, info] of Object.entries(value.projects)) {
              await add(path, source, object(info) ? info.lastUsedAt ?? info.lastSessionDate : undefined);
            }
          } else {
            if (value.originalPath !== undefined) await add(value.originalPath, source);
            if (Array.isArray(value.entries)) for (const entry of value.entries) {
              if (object(entry) && entry.projectPath !== undefined) await add(entry.projectPath, source, entry.modified);
            }
          }
        } catch { warn('部分项目元数据格式无效，已跳过'); }
        return;
      }
      // Only inspect a bounded head. Never read the rest of a transcript or retain prompt text.
      const lines = path.endsWith('.json') && !data.cut ? [data.text] : data.text.split('\n');
      if (data.cut) lines.pop();
      let matched = false;
      for (const line of lines.slice(0, 8)) {
        if (!line.trim()) continue;
        try {
          const row: unknown = JSON.parse(line);
          if (!object(row)) continue;
          const meta = source === 'codex' ? row.type === 'session_meta' && object(row.payload) ? row.payload : undefined : row;
          if (meta?.cwd !== undefined) { await add(meta.cwd, source, meta.timestamp ?? row.timestamp); matched = true; break; }
        } catch { warn('部分会话元数据格式无效，已跳过'); }
      }
      if (!matched && data.cut) {
        // Large session_meta may include instructions after cwd. Extract only header scalars.
        const row = parseSessionHeader(data.text.split('\n', 1)[0], source === 'codex');
        const meta = source === 'codex' ? row.type === 'session_meta' && object(row.payload) ? row.payload : undefined : row;
        if (meta?.cwd !== undefined) { await add(meta.cwd, source, meta.timestamp ?? row.timestamp); matched = true; }
        if (!matched) { result.truncated = true; warn('部分会话头超过读取上限，无法识别文件夹'); }
      }
      if (!matched && !data.cut) {
        if (lines.length > 8) result.truncated = true;
        warn('部分会话元数据缺少目录，已跳过');
      }
    }
    async function walkMetadata(root: string, source: string, depth: number) {
      try { if (!await noLinks(root)) { warn('部分项目元数据路径是软链接，未读取'); return; } }
      catch (error) { if (!missing(error)) warn('部分项目元数据无法读取，已跳过'); return; }
      for (const entry of await children(root)) {
        if (sessions >= limits.sessions) { result.truncated = true; break; }
        if (entry.isSymbolicLink() || skipped.has(entry.name)) continue;
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
          if (depth > 0) await walkMetadata(path, source, depth - 1);
          else result.truncated = true;
        } else if (entry.isFile()) {
          if (entry.name === 'sessions-index.json') await metadata(path, source, 'index');
          else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json')) await metadata(path, source, 'session');
        }
      }
    }

    async function available(root: string, explicit: boolean, label: string) {
      if (!explicit) return true;
      try { if (root !== parse(root).root && await noLinks(root) && (await lstat(root)).isDirectory()) return true; }
      catch { /* Missing explicit profiles are empty, never a reason to scan defaults. */ }
      warn(`${label} 显式配置目录不存在或不可用，未读取项目历史`);
      return false;
    }
    const codexRoot = await codexHome, claudeRoot = await claudeHome;
    if (options.claudeHome === undefined) await metadata(join(await canonicalHome, '.claude.json'), 'claude', 'config');
    if (await available(codexRoot, options.codexHome !== undefined, 'Codex')) await walkMetadata(join(codexRoot, 'sessions'), 'codex', 3);
    if (await available(claudeRoot, options.claudeHome !== undefined, 'Claude')) {
      await metadata(join(claudeRoot, 'config.json'), 'claude', 'config');
      await walkMetadata(join(claudeRoot, 'projects'), 'claude', 2);
      await walkMetadata(join(claudeRoot, 'sessions'), 'claude', 1);
    }

    // Default inventory comes from CLI project history, not arbitrary nearby repositories.
    // Git traversal is opt-in through explicit roots or SUPER_MARIO_PROJECT_ROOTS.
    const envRoots: string[] = [];
    for (const value of (options.ignoreEnvironmentRoots ? '' : process.env.SUPER_MARIO_PROJECT_ROOTS ?? '').split(delimiter).filter(Boolean)) {
      try { envRoots.push(absolute(value)); } catch { warn('环境变量包含无效扫描目录，已跳过'); }
      if (envRoots.length >= limits.roots) { result.truncated = true; break; }
    }
    const visited = new Map<string, number>();
    async function scan(path: string, depth: number) {
      if (temporary(path) || await inLinkedWorktree(path)) return;
      if ((visited.get(path) ?? -1) >= depth) return;
      visited.set(path, depth);
      try {
        const git = await lstat(join(path, '.git'));
        if (git.isFile() || git.isDirectory()) { await add(path, 'git'); return; }
      } catch (error) { if (!missing(error)) warn('部分项目标记不可访问，已跳过'); }
      for (const entry of await children(path)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || skipped.has(entry.name) || entry.name.startsWith('.')) continue;
        if (depth > 0) await scan(join(path, entry.name), depth - 1);
        else result.truncated = true;
      }
    }
    for (const root of [...new Set([...(requested ?? []), ...envRoots])]) {
      if (result.roots.length >= limits.roots) { result.truncated = true; break; }
      // A filesystem root is never a recursive discovery root, even if explicitly requested.
      if (root === parse(root).root) { warn('为避免扫描整盘，已跳过文件系统根目录'); continue; }
      try {
        const canonical = (await directory({ cwd: root })).cwd;
        if (canonical === parse(canonical).root) { warn('为避免扫描整盘，已跳过文件系统根目录'); continue; }
        if (result.roots.includes(canonical)) continue;
        result.roots.push(canonical);
        await scan(canonical, 2);
      } catch { if (requested?.includes(root) || envRoots.includes(root)) warn('指定扫描目录不存在或不可访问，已跳过'); }
    }
    result.projects = [...found.values()].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.cwd.localeCompare(b.cwd));
    // Plain objects satisfy the transport's JSON boundary without changing shared contracts.
    return { ...result, projects: result.projects.map(project => ({ ...project })) };
  }
  const handlers = { 'workspace.projects': projects, 'workspace.directory': directory, 'workspace.code': workspaceCode } satisfies Record<string, NodeHandler>;
  return { handlers };
}

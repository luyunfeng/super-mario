import { constants } from 'node:fs';
import { readWorktreeHistory, readWorktreeChange, retainedBranchStatus, deleteRetainedBranch, removeRunWorktree, inspectRunWorktree, prepareRunWorktree, readCommitDiff, worktreeBase } from './task-git.ts';
import { workspaceCode } from './workspace-code.ts';
import { lstat, mkdir, open, opendir, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, normalize, parse, resolve, relative } from 'node:path';
import type { DiscoveredProject, ProjectDiscovery } from '../packages/protocol/src/index.ts';
import type { NodeHandler } from '../packages/plugin-sdk/src/index.ts';

// Per request budgets bound disk work and memory, including directories with huge fan-out.
const limits = { roots: 32, directories: 512, entries: 8192, perDirectory: 512, sessions: 256, head: 16 * 1024, transcript: 1024 * 1024, providerBytes: 32 * 1024 * 1024, warnings: 12 };
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

// CLI wrappers and tool results can carry the user role without a user turn.
function userText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return !!text && !/^(?:\[tool output for unknown call\]|# AGENTS\.md instructions\b|<(?:environment_context|permissions instructions|collaboration_mode|skills_instructions|system-reminder|environment_details|INSTRUCTIONS|skill|codex_delegation|local-command-[^>]+|command-name|command-message|task-notification|subagent_notification|user_instructions|turn_aborted)\b)/i.test(text);
}
function userContent(value: unknown, blockType: string): boolean {
  if (typeof value === 'string') return userText(value);
  return Array.isArray(value) && !value.some(block => object(block) && block.type === 'tool_result')
    && value.some(block => object(block) && block.type === blockType && userText(block.text));
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

/** Discovery is read-only. Only workspace.directory.create writes a directory. */
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

  async function createDirectory(params: unknown) {
    paramsOnly(params, ['parent', 'name']);
    const { parent, name } = params;
    if (parent !== undefined && (typeof parent !== 'string' || !parent.trim() || parent.length > 4096 || parent.split('/').includes('..') || /\p{Cc}/u.test(parent))) throw new Error('父目录路径无效');
    if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[/\\\p{Cc}]/u.test(name)) throw new Error('名称必须是单个文件夹名');
    const base = await canonicalHome;
    const root = await realpath(resolve(base, parent ?? '.')).catch(() => { throw new Error('父目录不存在或不可访问'); });
    if (parent && !isAbsolute(parent)) {
      const rest = relative(base, root);
      if (rest === '..' || rest.startsWith('../')) throw new Error('相对父目录必须位于执行机主目录内');
    }
    // On Linux, anchor every lookup to an open directory, including the final mkdir.
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let handle = await open('/', flags);
    try {
      for (const part of root.split('/').filter(Boolean)) {
        const next = await open(join('/proc/self/fd', String(handle.fd), part), flags);
        await handle.close();
        handle = next;
      }
      await mkdir(join('/proc/self/fd', String(handle.fd), name), { mode: 0o700 });
      return { cwd: join(root, name), exists: true as const };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('同名文件或文件夹已存在');
      throw new Error('父目录不可用或无权创建文件夹');
    } finally { await handle.close(); }
  }

  // Session inventory keeps its metadata-only contract and original path policy.
  // Project discovery applies its stronger transcript and workspace checks separately.
  function nativeDirectoryFilter(warn: (message: string) => void, excludeStale = false) {
    const worktreeCache = new Map<string, boolean>();
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
    // the worktrees admin path or commondir identifies a linked worktree. Inspect ancestors too: CLI history
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
            linked = (excludeStale && /\/worktrees\/[^/]+$/.test(gitdir)) || Boolean(common && !common.cut && common.text.trim() && resolve(gitdir, common.text.trim()) !== gitdir);
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
    return async (path: string) => !temporary(path) && !await inLinkedWorktree(path);
  }

  async function projects(params: unknown) {
    paramsOnly(params, ['roots']);
    if (params.roots !== undefined && (!Array.isArray(params.roots) || params.roots.length > limits.roots)) throw new Error('roots 必须是最多 32 个绝对目录');
    const requested = params.roots as unknown[] | undefined;
    const [homeDir, codexRoot, claudeRoot] = await Promise.all([canonicalHome, codexHome, claudeHome]);
    const result: ProjectDiscovery = { homeDir, projects: [], roots: [], warnings: [], truncated: false };
    const found = new Map<string, DiscoveredProject>();
    const configRoots = ['/etc', codexRoot, claudeRoot, ...['.codex', '.claude', '.config', '.cache', '.local', '.super-mario', '.ssh', 'tmp', 'temp'].map(name => join(homeDir, name))];
    function warn(message: string) {
      if (result.warnings.includes(message)) return;
      if (result.warnings.length < limits.warnings) result.warnings.push(message);
      else result.truncated = true;
    }
    const environment = options.ignoreEnvironmentRoots ? [] : (process.env.SUPER_MARIO_PROJECT_ROOTS ?? '').split(delimiter).filter(Boolean);
    const scopes = requested?.length ? requested : [...(configuredRoots ?? []), ...environment];
    for (const raw of scopes.slice(0, limits.roots)) {
      try {
        const root = (await directory({cwd: raw})).cwd;
        if (root === parse(root).root) throw new Error('whole disk');
        if (!result.roots.includes(root)) result.roots.push(root);
      } catch { warn('指定扫描目录无效、不存在或为文件系统根目录，已跳过'); }
    }
    if (scopes.length > limits.roots) result.truncated = true;
    if (scopes.length && !result.roots.length) return { ...result, projects: [] };
    const nativeAllowed = nativeDirectoryFilter(warn, true);
    function excluded(path: string) {
      if (temporary(path) || path === homeDir || path === parse(path).root) return true;
      if (configRoots.some(root => path === root || path.startsWith(root + '/'))) return true;
      if (path.split('/').some(part => /^(?:\.?worktrees?|.+-worktrees)$/.test(part) || part === '.git')) return true;
      return /^\d{4}-\d{2}-\d{2}(?:\/|$)/.test(relative(join(homeDir, 'Documents', 'Codex'), path));
    }

    async function add(raw: unknown, source: string, timestamp: unknown) {
      let path: string;
      try {
        path = absolute(raw);
        if (excluded(path)) return;
        path = await realpath(path);
        if (result.roots.length && !result.roots.some(root => path === root || path.startsWith(root + '/'))) return;
        if (excluded(path) || !(await stat(path)).isDirectory() || !await nativeAllowed(path)) return;
      } catch (error) { if (!missing(error)) warn('部分会话目录无效或无法访问，已跳过'); return; }
      const time = date(timestamp);
      const previous = found.get(path);
      if (previous) {
        if (!previous.sources.includes(source)) previous.sources.push(source);
        if (time && (!previous.lastUsedAt || time > previous.lastUsedAt)) previous.lastUsedAt = time;
        return;
      }
      found.set(path, { name: basename(path), cwd: path, sources: [source], exists: true, ...(time ? {lastUsedAt: time} : {}) });
    }

    async function scanProvider(source: 'codex' | 'claude', root: string) {
      let directories = 0, entriesRead = 0, sessions = 0, bytes = 0;
      const deadline = performance.now() + 8000;
      function exhausted() {
        return sessions >= limits.sessions || bytes >= limits.providerBytes || performance.now() >= deadline;
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
      async function metadata(path: string) {
        sessions++;
        let file;
        try {
          file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const info = await file.stat();
          if (!info.isFile()) return;
          const end = Math.min(info.size, limits.transcript, limits.providerBytes - bytes);
          const buffer = Buffer.alloc(Math.min(65536, end));
          const decoder = new TextDecoder();
          let offset = 0, partial = '', cwd: unknown, created: unknown;
          while (offset < end && performance.now() < deadline) {
            const {bytesRead} = await file.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
            if (!bytesRead) break;
            offset += bytesRead;
            bytes += bytesRead;
            const lines = (partial + decoder.decode(buffer.subarray(0, bytesRead), {stream: offset < info.size})).split('\n');
            partial = offset < info.size ? lines.pop()! : '';
            for (const line of lines) {
              if (!line.trim()) continue;
              let row: unknown;
              try { row = JSON.parse(line); }
              catch { warn('部分会话记录格式无效，已跳过'); continue; }
              if (!object(row)) continue;
              if (source === 'codex') {
                const payload = row.payload;
                if (!object(payload)) continue;
                if (row.type === 'session_meta') {
                  if (object(payload.source) && payload.source.subagent || payload.source === 'exec') return;
                  cwd = payload.cwd;
                  created = payload.timestamp ?? row.timestamp;
                } else if (cwd && ((row.type === 'event_msg' && payload.type === 'user_message' && userText(payload.message))
                  || (row.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && userContent(payload.content, 'input_text')))) {
                  await add(cwd, source, row.timestamp ?? created);
                  return;
                }
              } else if (row.type === 'user' && !row.isMeta && !row.isSidechain && !row.isCompactSummary && !row.agentId
                && !row.sourceToolAssistantUUID && !row.isSynthetic && object(row.message) && row.message.role === 'user' && userContent(row.message.content, 'text')) {
                await add(row.cwd, source, row.timestamp);
                return;
              }
            }
          }
          if (offset < info.size) result.truncated = true;
        } catch (error) { if (!missing(error)) warn('部分会话历史无法读取，已跳过'); }
        finally { await file?.close(); }
      }
      async function walkMetadata(root: string, depth: number) {
        try { if (!await noLinks(root)) { warn('部分项目元数据路径是软链接，未读取'); return; } }
        catch (error) { if (!missing(error)) warn('部分项目元数据无法读取，已跳过'); return; }
        for (const entry of await children(root)) {
          if (exhausted()) { result.truncated = true; break; }
          if (entry.isSymbolicLink() || skipped.has(entry.name)) continue;
          const path = join(root, entry.name);
          if (entry.isDirectory()) {
            if (source === 'claude' && entry.name === 'subagents') continue;
            if (depth > 0) await walkMetadata(path, depth - 1);
            else result.truncated = true;
          } else if (entry.isFile()) {
            if (entry.name.endsWith('.jsonl')) await metadata(path);
          }
        }
      }

      await walkMetadata(root, source === 'codex' ? 3 : 2);
    }

    async function available(root: string, explicit: boolean, label: string) {
      if (!explicit) return true;
      try { if (root !== parse(root).root && await noLinks(root) && (await lstat(root)).isDirectory()) return true; }
      catch { /* Missing explicit profiles are empty, never a reason to scan defaults. */ }
      warn(`${label} 显式配置目录不存在或不可用，未读取项目历史`);
      return false;
    }
    // Each provider owns a byte, file and time budget. A busy provider cannot
    // exhaust the other's allowance or force a full transcript scan.
    if (await available(codexRoot, options.codexHome !== undefined, 'Codex')) await scanProvider('codex', join(codexRoot, 'sessions'));
    if (await available(claudeRoot, options.claudeHome !== undefined, 'Claude')) await scanProvider('claude', join(claudeRoot, 'projects'));

    result.projects = [...found.values()].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.cwd.localeCompare(b.cwd));
    // Plain objects satisfy the transport's JSON boundary without changing shared contracts.
    return { ...result, projects: result.projects.map(project => ({ ...project })) };
  }
  const handlers = { 'workspace.projects': projects, 'workspace.directory': directory, 'workspace.directory.create': createDirectory, 'workspace.code': workspaceCode, 'workspace.commitDiff': readCommitDiff, 'workspace.prepareRunWorktree': prepareRunWorktree, 'workspace.worktreeBase': worktreeBase, 'workspace.inspectRunWorktree': inspectRunWorktree, 'workspace.readWorktreeChange': readWorktreeChange, 'workspace.worktreeHistory': readWorktreeHistory, 'workspace.removeRunWorktree': removeRunWorktree, 'workspace.retainedBranchStatus': retainedBranchStatus, 'workspace.deleteRetainedBranch': deleteRetainedBranch } satisfies Record<string, NodeHandler>;
  return { handlers, nativeDirectoryFilter };
}

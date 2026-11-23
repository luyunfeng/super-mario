import { constants } from 'node:fs';
import { open, realpath, stat, opendir, lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NodeHandler } from '../packages/plugin-sdk/src/index.ts';
import type { Json } from '../packages/protocol/src/index.ts';

const execute = promisify(execFile);
const limit = 256 * 1024;
// Deny credentials by component, including aliases resolved through symlinks.
export const sensitiveWorkspacePath = (path: string) => path.split(/[\\/]/).some(p => /^(\.git|\.ssh|\.aws|\.gnupg|\.codex|\.claude|\.docker|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.?credentials(?:\..*)?|secrets?(?:\..*)?|auth\.json|service-account\.json|id_(?:rsa|ed25519))$/i.test(p) || /\.(pem|key|p12|pfx|sqlite|sqlite3|db)$/i.test(p));
function inside(root: string, path: string) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('路径越出项目根目录');
  if (sensitiveWorkspacePath(rel)) throw new Error('敏感文件不可浏览');
}
const searchSkip = new Set(['.git', '.hg', '.svn', 'node_modules', '__pycache__', '.cache', '.gradle',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.next', '.nuxt', '.turbo', '.parcel-cache', '.venv', 'DerivedData', '.Trash']);
const maxSearchEntries = 20000;
const maxFileHits = 50;

function searchScore(path: string, terms: string[]): number | undefined {
  const lower = path.toLowerCase(), base = path.lastIndexOf('/') + 1, name = lower.slice(base);
  let score = -path.length * 0.02;
  for (const term of terms) {
    // Discard non-matches cheaply before scoring alternative character alignments.
    let cursor = -1;
    for (const ch of term) {
      cursor = lower.indexOf(ch, cursor + 1);
      if (cursor === -1) return;
    }
    let previous = new Float64Array(lower.length).fill(-Infinity);
    let current = new Float64Array(lower.length);
    for (let i = 0; i < term.length; i++) {
      let separated = -Infinity;
      for (let j = 0; j < lower.length; j++) {
        if (j >= 2) separated = Math.max(separated, previous[j - 2]!) - 1.2;
        current[j] = -Infinity;
        if (term[i] !== lower[j]) continue;
        const prior = path[j - 1] ?? '';
        const boundary = !j || prior === '/' ? 12 : /[. _-]/.test(prior) ? 10
          : /[a-z]/.test(prior) && /[A-Z]/.test(path[j] ?? '') ? 9 : 0;
        const alignment = i === 0 ? (j < base ? -0.15 * j : 0) : Math.max((previous[j - 1] ?? -Infinity) + 6, separated);
        current[j] = alignment + boundary + (j >= base ? 3 : 0);
      }
      [previous, current] = [current, previous];
    }
    score += Math.max(...previous) + (name === term ? 30 : name.startsWith(term) ? 12 : 0);
  }
  return score;
}

async function searchFiles(root: string, query: unknown) {
  if (typeof query !== 'string' || !query.trim() || query.length > 256 || /[\p{Cc}]/u.test(query)) throw new Error('文件检索词无效');
  const terms = query.trim().toLowerCase().split(/\s+/u);
  const hits: Array<{ path: string; score: number }> = [];
  let truncated = false;
  function consider(path: string) {
    const score = searchScore(path, terms);
    if (score !== undefined) hits.push({ path, score });
  }

  // Git handles repository ignore rules (including tracked files that now match an ignore).
  // Pass no inherited Git variables, and disable repository-configured external fsmonitor commands.
  let tracked: string | undefined;
  try {
    const result = await execute('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
      'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], {
      cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
    });
    tracked = result.stdout;
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && typeof failure.stdout === 'string') {
      tracked = failure.stdout.slice(0, failure.stdout.lastIndexOf('\0') + 1);
      truncated = true;
    } else if (failure.code !== 'ENOENT' && !failure.stderr?.includes('not a git repository')) {
      throw new Error('无法读取 Git 工作区文件清单');
    }
  }
  // Keep scans bounded even on a very deep tree or an unusually expensive fuzzy query.
  const deadline = performance.now() + 5000;
  if (tracked !== undefined) {
    const names = tracked.split('\0');
    if (names.length - 1 > maxSearchEntries) truncated = true;
    for (const path of new Set(names.slice(0, maxSearchEntries))) {
      if (performance.now() > deadline) { truncated = true; break; }
      if (!path || path.length > 4096 || isAbsolute(path) || /[\p{Cc}]/u.test(path) || sensitiveWorkspacePath(path) ||
          path.split('/').some(part => part === '..' || searchSkip.has(part))) continue;
      consider(path);
    }
  } else {
    const folders = [root];
    let scanned = 0;
    for (let i = 0; i < folders.length; i++) {
      if (i === 300 || scanned >= maxSearchEntries || performance.now() > deadline) { truncated = true; break; }
      const folder = folders[i]!;
      try {
        if (await realpath(folder) !== folder) { truncated = true; continue; }
        const dir = await opendir(folder);
        for await (const child of dir) {
          if (++scanned > maxSearchEntries || performance.now() > deadline) { truncated = true; break; }
          if (sensitiveWorkspacePath(child.name) || searchSkip.has(child.name) || /[\p{Cc}]/u.test(child.name)) continue;
          const entry = resolve(folder, child.name);
          if (child.isDirectory()) folders.push(entry);
          if (child.isFile()) consider(relative(root, entry));
        }
      } catch (error) {
        if (folder === root) throw error;
        truncated = true;
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const paths: string[] = [];
  for (const hit of hits) {
    if (performance.now() > deadline + 1000) { truncated = true; break; }
    // Recheck actual files: Git also lists deleted entries, submodules and symlinks.
    const full = resolve(root, hit.path);
    try {
      if (await realpath(full) !== full || !(await lstat(full)).isFile()) continue;
    } catch { continue; }
    if (paths.length === maxFileHits) { truncated = true; break; }
    paths.push(hit.path);
  }
  return { paths, truncated };
}

export const workspaceCode: NodeHandler = async (params): Promise<Json> => {
  if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd) || /[\0\r\n]/.test(params.cwd)) throw new Error('项目根目录无效');
  // The server supplies the saved binding, never a cwd from the browsing request.
  const root = await realpath(params.cwd);
  if (root !== resolve(params.cwd)) throw new Error('项目根目录已变化，请重新绑定');
  if (root === resolve('/')) throw new Error('不能浏览文件系统根目录');
  if (sensitiveWorkspacePath(root)) throw new Error('敏感项目目录不可浏览');
  if (params.kind === 'search') return searchFiles(root, params.query);
  const path = params.path ?? '';
  if (typeof path !== 'string' || isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error('只接受项目内相对路径');
  const requested = resolve(root, path); inside(root, requested);
  const canonical = await realpath(requested); inside(root, canonical);
  const info = await lstat(canonical);
  if (params.kind === 'tree') {
    if (!info.isDirectory()) throw new Error('请选择目录');
    const children = await opendir(canonical);
    const entries = [];
    let scanned = 0, truncated = false;
    for await (const child of children) {
      if (++scanned > 2048) { truncated = true; break; }
      if (sensitiveWorkspacePath(child.name) || child.name === 'node_modules') continue;
      const candidate = resolve(canonical, child.name);
      try {
        const target = await realpath(candidate); inside(root, target);
        const value = await stat(target);
        if (!value.isDirectory() && !value.isFile()) continue;
        entries.push({ name: child.name, path: relative(root, candidate), directory: value.isDirectory() });
      } catch { continue; }
      if (entries.length === 500) { truncated = true; break; }
    }
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    return { root, path, entries, truncated };
  }
  if (!info.isFile()) throw new Error('只允许读取普通文本文件');
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text: string;
  try {
    if (process.platform === 'linux') inside(root, await realpath(`/proc/self/fd/${handle.fd}`));
    const value = await handle.stat();
    if (!value.isFile() || value.size > limit) throw new Error('文件过大，上限 256 KiB');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('文件过大，上限 256 KiB');
    const data = buffer.subarray(0, bytesRead);
    if (data.some(c => c < 32 && ![9,10,13].includes(c))) throw new Error('二进制文件不可浏览');
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Error('只支持 UTF-8 文本文件'); }
  } finally { await handle.close(); }
  if (params.kind === 'file') return { root, path, text };
  if (params.kind !== 'diff') throw new Error('浏览类型无效');
  // Git never walks to a parent repository or follows user-configured diff programs.
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const git = (args: string[]) => execute('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, timeout: 5000, maxBuffer: limit });
  const top = (await git(['rev-parse', '--show-toplevel'])).stdout.trim();
  if (await realpath(top) !== root) throw new Error('绑定目录不是 Git 项目根目录');
  const filename = relative(root, canonical);
  // --no-textconv does not disable clean/process filters. Suppress these too: browsing
  // an imported repository must never run programs configured in its .git/config.
  let keys = '';
  try { keys = (await git(['config','--local','--includes','--name-only','--get-regexp','^filter\\..*\\.(clean|smudge|process|required)$'])).stdout; }
  catch (error) { if ((error as {code?:number}).code !== 1) throw error; }
  const filters = [...new Set(keys.trim().split('\n').filter(Boolean).map(k => k.replace(/\.(clean|smudge|process|required)$/,'')))];
  const overrides = filters.flatMap(key => ['-c',`${key}.clean=`, '-c',`${key}.smudge=`, '-c',`${key}.process=`, '-c',`${key}.required=false`]);
  const output = await git([...overrides,'diff', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--', filename]);
  if (output.stdout.includes('GIT binary patch') || /^Binary files /m.test(output.stdout)) throw new Error('二进制差异不可浏览');
  return { root, path, text: output.stdout, note: '相对 HEAD 的已跟踪文件差异；未跟踪文件请查看文本。' };
};

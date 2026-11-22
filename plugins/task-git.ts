import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sensitiveWorkspacePath } from './workspace-code.ts';
import { execFile, execFileSync } from 'node:child_process';
import { commitChanges, type Json, type JsonObject } from '../packages/protocol/src/index.ts';

// Only inspect local commit objects. Ignore inherited repository overrides and avoid
// optional network fetches, external diff programs, hooks and working-tree filters.
const gitArgs = ['--no-pager', '--no-replace-objects', '--literal-pathspecs', '-c', 'core.hooksPath=/dev/null'];
function gitOptions(cwd: string) {
  return { cwd, env: { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8' as const, timeout: 1500, maxBuffer: 256 * 1024 };
}
function git(cwd: string, args: string[]) {
  try {
    return execFileSync('git', [...gitArgs, ...args], { ...gitOptions(cwd), stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return undefined; }
}

export function taskHead(cwd: string) {
  return git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])?.trim();
}

export function taskCommitChanges(cwd: string, base: string) {
  const head = taskHead(cwd);
  if (!head) return;
  let files = 0, added = 0, deleted = 0;
  if (base !== head) {
    const stats = git(cwd, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--ignore-submodules=none', base, head, '--', '.']);
    if (stats === undefined) return;
    for (const entry of stats.split('\0')) {
      if (!entry) continue;
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(entry);
      if (!match) return;
      files++;
      if (match[1] !== '-') added += Number(match[1]);
      if (match[2] !== '-') deleted += Number(match[2]);
    }
  }
  return commitChanges({ base, head, files, added, deleted });
}

const execute = promisify(execFile);
export async function readCommitDiff(params: JsonObject): Promise<Json> {
  const { cwd, path } = params;
  const range = commitChanges(params.range);
  if (!range || typeof cwd !== 'string' || !isAbsolute(cwd) || cwd === '/' || sensitiveWorkspacePath(cwd)
    || await realpath(cwd) !== resolve(cwd)) throw new Error('执行目录或历史提交不可用');
  const safePath = (name: string) => !!name && !isAbsolute(name) && !/[\x00-\x1f\x7f]/.test(name)
    && !name.split('/').some(part => !part || part === '..' || part === '.') && !sensitiveWorkspacePath(name);
  if (path !== undefined && (typeof path !== 'string' || !safePath(path))) throw new Error('文件不可浏览');
  const diff = async (mode: string[], file: string) => {
    try {
      const result = await execute('git', [...gitArgs, 'diff', '--relative', '--no-ext-diff', '--no-textconv',
        '--no-color', '--no-renames', '--submodule=short', '--ignore-submodules=none', ...mode, range.base, range.head, '--', file], gitOptions(cwd));
      return result.stdout;
    } catch { throw new Error('历史提交不可读或差异超过读取上限'); }
  };
  const names = (await diff(['--name-only', '-z'], '.')).split('\0').filter(Boolean);
  const files = names.filter(safePath);
  if (path === undefined) return { files, hidden: names.length - files.length };
  if (!files.includes(path)) throw new Error('文件不在此次执行的可查看差异中');
  const text = await diff(['--patch'], path);
  if (/^Binary files /m.test(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(text)) throw new Error('仅支持 UTF-8 文本差异');
  return { path, text };
}

const runGit = async (dir: string, args: string[]) => (await execute('git', [...gitArgs, ...args], {
  ...gitOptions(dir), timeout: 30000,
})).stdout;

export async function worktreeBase({ cwd, base }: JsonObject): Promise<string> {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd === '/' || sensitiveWorkspacePath(cwd)
    || await realpath(cwd) !== cwd || (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trimEnd() !== cwd)
    throw new Error('请将项目绑定到 Git 仓库根目录');
  if (base !== undefined && (typeof base !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)))
    throw new Error('起始提交无效');
  const resolved = (await runGit(cwd, ['rev-parse', '--verify', (base ?? 'HEAD') + '^{commit}'])).trim();
  if (base !== undefined && base !== resolved) throw new Error('工作树起始提交不匹配');
  return resolved;
}

// Only the saved project binding and a server-generated run ID determine the destination.
export async function prepareRunWorktree(params: JsonObject): Promise<Json> {
  const { cwd, id } = params;
  if (typeof cwd !== 'string' || typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
    throw new Error('工作树来源或执行标识无效');
  const base = await worktreeBase(params);
  const parent = cwd + '-worktrees';
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) throw new Error('工作树父目录已重定向');
  const target = resolve(parent, id), branch = 'super-mario/' + id;
  await mkdir(target, { mode: 0o700 }); // Exclusive claim, including against an existing empty directory.
  await runGit(cwd, ['worktree', 'add', '--no-checkout', '-b', branch, target, base]);
  // Checkout must not invoke repository-supplied filter processes. Resolve conditional
  // config in the new worktree before populating it. Preserve the branch on partial failure.
  const overrides = await filterOverrides(target);
  await runGit(target, [...overrides, '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false',
    '--work-tree=' + target, 'read-tree', '--reset', '-u', base]);
  return { cwd: target, branch, base };
}

async function filterOverrides(target: string) {
  let keys = '';
  try { keys = await runGit(target, ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(smudge|clean|process|required)$']); }
  catch (error) { if ((error as {code?:number}).code !== 1) throw error; }
  const filters = [...new Set(keys.trim().split('\n').filter(Boolean).map(key => key.replace(/\.(smudge|clean|process|required)$/, '')))];
  return filters.flatMap(key => ['-c', key + '.smudge=', '-c', key + '.clean=', '-c', key + '.process=', '-c', key + '.required=false']);
}

export async function inspectRunWorktree({ source, id }: JsonObject) {
  if (typeof source !== 'string' || typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
    throw new Error('工作树来源或执行标识无效');
  const sourceHead = await worktreeBase({ cwd: source });
  const target = resolve(source + '-worktrees', id);
  const records = await runGit(source, ['worktree', 'list', '--porcelain', '-z']);
  const record = records.split('\0\0').map(row => row.split('\0')).find(row => row[0] === 'worktree ' + target);
  if (!record || await realpath(target) !== target || (await runGit(target, ['rev-parse', '--show-toplevel'])).trimEnd() !== target)
    throw new Error('执行目录已移动或工作树登记失效');
  const commonDir = async (cwd: string) => realpath((await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trimEnd());
  if (await commonDir(target) !== await commonDir(source)) throw new Error('执行目录已不属于原仓库');
  const head = await worktreeBase({ cwd: target });
  const unmerged = Number((await runGit(target, ['rev-list', '--count', sourceHead + '..' + head])).trim());
  const overrides = await filterOverrides(target);
  const raw = await runGit(target, [...overrides, '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z',
    '--no-renames', '--untracked-files=all', '--ignore-submodules=none']);
  const files: { path: string; index: string; worktree: string }[] = [];
  let total = 0, hidden = 0;
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    total++;
    const path = entry.slice(3);
    if (sensitiveWorkspacePath(path) || /[\x00-\x1f\x7f]/.test(path)) { hidden++; continue; }
    if (files.length < 250) files.push({ path, index: entry[0]!, worktree: entry[1]! });
  }
  return { cwd: target, branch: record.find(field => field.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null,
    head, sourceHead, unmerged, files, total, hidden, truncated: total > hidden + files.length };
}

export async function removeRunWorktree(params: JsonObject): Promise<Json> {
  const snapshot = await inspectRunWorktree(params);
  const source = String(params.source);
  if (snapshot.branch !== 'super-mario/' + params.id || snapshot.head !== params.head)
    return { removed: false, reason: '分支或提交已经变化，请刷新后再核对。' };
  if (snapshot.total) return { removed: false, reason: '仍有未提交文件，工作树已保留。' };
  const overrides = [...await filterOverrides(snapshot.cwd), '-c', 'core.fsmonitor=false'];
  // Git can consider a directory clean even when ignored files or hidden index flags exist.
  const dirty = await runGit(snapshot.cwd, [...overrides, 'status', '--porcelain=v1', '-z',
    '--ignored=matching', '--no-renames', '--untracked-files=all', '--ignore-submodules=none']);
  if (dirty) return { removed: false, reason: '存在本地修改、未跟踪或忽略文件，工作树已保留。' };
  const index = await runGit(snapshot.cwd, [...overrides, 'ls-files', '-v', '-z']);
  if (index.split('\0').some(row => /^[a-zS] /.test(row)))
    return { removed: false, reason: '索引中有跳过检查的文件，工作树已保留。' };
  // Keep the branch (including unmerged commits). Git performs its own final clean/lock check.
  await runGit(source, [...overrides, 'worktree', 'remove', '--', snapshot.cwd]);
  return { removed: true, head: snapshot.head, branch: snapshot.branch };
}

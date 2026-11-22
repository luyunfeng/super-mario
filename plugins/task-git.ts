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

// Only the saved project binding and a server-generated run ID determine the destination.
export async function prepareRunWorktree(params: JsonObject): Promise<Json> {
  const { cwd, id } = params;
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd === '/' || sensitiveWorkspacePath(cwd)
    || await realpath(cwd) !== cwd || typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
    throw new Error('工作树来源或执行标识无效');
  }
  const runGit = async (dir: string, args: string[]) => (await execute('git', [...gitArgs, ...args], {
    ...gitOptions(dir), timeout: 30000,
  })).stdout;
  if ((await runGit(cwd, ['rev-parse', '--show-toplevel'])).trimEnd() !== cwd) throw new Error('请将项目绑定到 Git 仓库根目录');
  const base = (await runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const parent = cwd + '-worktrees';
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) throw new Error('工作树父目录已重定向');
  const target = resolve(parent, id), branch = 'super-mario/' + id;
  await mkdir(target, { mode: 0o700 }); // Exclusive claim, including against an existing empty directory.
  await runGit(cwd, ['worktree', 'add', '--no-checkout', '-b', branch, target, base]);
  // Checkout must not invoke repository-supplied filter processes. Resolve conditional
  // config in the new worktree before populating it. Preserve the branch on partial failure.
  let keys = '';
  try { keys = await runGit(target, ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(smudge|clean|process|required)$']); }
  catch (error) { if ((error as {code?:number}).code !== 1) throw error; }
  const filters = [...new Set(keys.trim().split('\n').filter(Boolean).map(key => key.replace(/\.(smudge|clean|process|required)$/, '')))];
  const overrides = filters.flatMap(key => ['-c', key + '.smudge=', '-c', key + '.clean=', '-c', key + '.process=', '-c', key + '.required=false']);
  await runGit(target, [...overrides, '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false',
    '--work-tree=' + target, 'read-tree', '--reset', '-u', base]);
  return { cwd: target, branch, base };
}

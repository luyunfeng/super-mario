// The Git writes the page makes in a bound project: stage a file, unstage it, commit what is
// staged. Each is one operation, and nothing is forced. A refusal gives git's own words.
//
// Pushing is not here: it leaves the computer, and goes through the GitHub connector with the
// owner's confirmation. Branches, stashes and resets are not here either: they can lose work,
// and are the Git tools' job.
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { NodeHandler } from '../packages/plugin-sdk/src/index.ts';
import type { Json } from '../packages/protocol/src/index.ts';
import { sensitiveWorkspacePath } from './workspace-code.ts';

const execute = promisify(execFile);
const limit = 256 * 1024;

/** Git is run as the owner, with their own settings and identity, and without the one thing a
 *  repository can configure to run a program on a commit: hooks. They are turned off by the
 *  command line below, which wins over any file; signing is off too, as it can prompt. */
const gitEnv = () => ({ PATH: process.env.PATH, LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });

/** The repository's root must be the bound directory itself: Git is not run in a subdirectory
 *  of a repository, where its rules and hooks would be those of the parent. */
async function repository(cwd: unknown): Promise<string> {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || /[\0\r\n]/.test(cwd)) throw new Error('项目根目录无效');
  const root = await realpath(cwd);
  if (root !== resolve(cwd)) throw new Error('项目根目录已变化，请重新绑定');
  if (root === resolve('/') || sensitiveWorkspacePath(root)) throw new Error('这个目录不可操作');
  let top: string;
  try { top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim(); }
  catch { throw new Error('绑定目录不是 Git 仓库'); }
  if (await realpath(top) !== root) throw new Error('绑定目录不是 Git 仓库根目录');
  return root;
}

function git(root: string, args: string[]) {
  return execute('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, env: gitEnv(), timeout: 15_000, maxBuffer: limit });
}

/** A path inside the repository, relative, with nothing sensitive on the way. */
function repositoryPath(root: string, path: unknown): string {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\0\r\n]/.test(path) || path.split('/').some(part => part === '..'))
    throw new Error('只接受仓库内的相对路径');
  if (sensitiveWorkspacePath(path)) throw new Error('敏感文件不可暂存');
  const resolved = resolve(root, path);
  if (!resolved.startsWith(root + '/')) throw new Error('路径越出仓库');
  return path;
}

/** A refusal of git's, with its own words and the files it names. */
class GitRefusal extends Error {
  files: string[];
  constructor(message: string, files: string[] = []) {
    super(message);
    this.name = 'GitRefusal';
    this.files = files;
  }
}

/** Git's stderr as one message, without a stack and without more than a page. */
function refusal(error: unknown, doing: string): GitRefusal {
  const failure = error as { stderr?: string; stdout?: string; code?: number | string };
  const words = (failure.stderr ?? failure.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean).join(' ').slice(0, 500);
  // The files git names on its own lines, as conflicts and unstaged changes are listed.
  const files = (failure.stdout ?? '').split('\n').map(line => line.trim()).filter(line => line && /^[^:]+:/.test(line)).map(line => line.split(':')[0]!).slice(0, 50);
  return new GitRefusal(words ? doing + '：' + words : doing + '失败', files);
}

/** What the index and the working tree hold, as the page shows it after a write. */
async function status(root: string): Promise<{ branch: string; staged: { path: string; change: string }[]; unstaged: { path: string; change: string }[] }> {
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }))).stdout.trim();
  // Porcelain v1 with -z: one NUL-separated record per change, which no filename can break.
  const raw = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']).catch(() => ({ stdout: '' }))).stdout;
  const staged: { path: string; change: string }[] = [], unstaged: { path: string; change: string }[] = [];
  for (const record of raw.split('\0').filter(Boolean)) {
    const index = record[0]!, work = record[1]!;
    const path = record.slice(3);
    if (index !== ' ' && index !== '?') staged.push({ path, change: index });
    if (work !== ' ') unstaged.push({ path, change: work });
  }
  return { branch, staged, unstaged };
}

export function createWorkspaceGitWrite() {
  const handlers: Record<string, NodeHandler> = {
    'workspace.git.status': async params => {
      const root = await repository(params.cwd);
      return await status(root) as unknown as Json;
    },
    'workspace.git.write': async params => {
      const root = await repository(params.cwd);
      if (!['stage', 'unstage', 'commit'].includes(String(params.op))) throw new Error('不支持的 Git 操作');
      if (params.op === 'commit') {
        const message = params.message;
        if (typeof message !== 'string' || !message.trim() || message.length > 2000 || /[\0]/.test(message)) throw new Error('提交说明无效');
        // Nothing staged is a refusal with nothing done, as git itself would say.
        const before = await status(root);
        if (!before.staged.length) throw new GitRefusal('没有已暂存的改动，请先暂存文件');
        try {
          // The message is given as one argument, which no shell reads: it cannot become options.
          await git(root, ['commit', '--no-verify', '--no-edit', '--quiet', '--message', message.trim()]);
        } catch (error) { throw refusal(error, '提交'); }
        const after = await status(root);
        return { op: 'commit', committed: true, summary: (await git(root, ['log', '-1', '--format=%h %s'])).stdout.trim(), ...after } as unknown as Json;
      }
      const path = repositoryPath(root, params.path);
      // A file that is not known to git at all cannot be staged by name alone: git add would
      // take it, and it is the owner's to say whether a new file belongs in the repository.
      if (params.op === 'stage') {
        try { await git(root, ['add', '--', path]); }
        catch (error) { throw refusal(error, '暂存 ' + path); }
      } else {
        try { await git(root, ['reset', '--quiet', 'HEAD', '--', path]); }
        catch (error) { throw refusal(error, '取消暂存 ' + path); }
      }
      return { op: params.op, path, ...(await status(root)) } as unknown as Json;
    },
  };
  return { handlers };
}

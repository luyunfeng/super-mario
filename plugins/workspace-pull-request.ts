// Opening a pull request from a bound project: the branch is pushed, and the pull request is
// opened with the owner's own GitHub login. It is one operation the owner approves, and it is
// never forced: a push that would overwrite what is on the remote is refused by git.
//
// The push leaves the computer, so it is the owner's to approve: the workbench proposes it as an
// approval and carries it out only when the owner says so, as it does for a comment.
import { execFile, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { NodeHandler } from '../packages/plugin-sdk/src/index.ts';
import type { Json } from '../packages/protocol/src/index.ts';
import { sensitiveWorkspacePath } from './workspace-code.ts';

const execute = promisify(execFile);
const limit = 256 * 1024;

/** What is pushed and opened, checked before anything is sent. */
interface PullRequestInput { cwd: string; branch: string; base: string; title: string; body: string; repository: string }

/** A refusal, in words the owner can act on, with git's or gh's own when they gave any. */
export class PullRequestRefusal extends Error {
  kind: 'not_repository' | 'not_on_branch' | 'nothing_to_push' | 'remote_rejected' | 'github' | 'invalid';
  detail: string;
  constructor(kind: PullRequestRefusal['kind'], detail: string) {
    super(detail);
    this.name = 'PullRequestRefusal';
    this.kind = kind;
    this.detail = detail;
  }
}

/** A branch name as git accepts one, without the characters that could make git read options. */
const branch = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/.test(value) || value.includes('..') || value.endsWith('/') || value.endsWith('.lock'))
    throw new PullRequestRefusal('invalid', '分支名无效');
  return value;
};

/** A repository as the owner names it, and as gh takes it. */
const repository = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(value))
    throw new PullRequestRefusal('invalid', '仓库须写成 所有者/仓库名');
  return value;
};

/** Git as the file writes run it: as the owner, with hooks off, never prompting. */
function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execute('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args],
    { cwd, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env }, timeout: 60_000, maxBuffer: limit });
}

/** What the push would send: the commits on this branch that the remote does not have. A
 *  branch the remote has never seen has all of its own commits to send, so it is not nothing. */
async function outgoing(cwd: string, name: string): Promise<string[]> {
  const onRemote = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]).then(() => true, () => false);
  try {
    if (!onRemote) {
      // Compared with what the remote's default branch has, as far as this computer knows it.
      const result = await git(cwd, ['rev-list', '--oneline', `${name}`, '--not', '--remotes=origin']);
      return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
    }
    const result = await git(cwd, ['rev-list', '--oneline', `origin/${name}..${name}`]);
    return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  } catch { return []; }
}

/** Pushes the branch and opens the pull request. */
export async function openPullRequest(input: PullRequestInput, run: (args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) => Promise<string>, signal: AbortSignal): Promise<{ state: 'opened'; url: string; pushed: string[] }> {
  if (!isAbsolute(input.cwd) || /[\0\r\n]/.test(input.cwd)) throw new PullRequestRefusal('invalid', '项目根目录无效');
  const root = await realpath(input.cwd);
  if (root !== resolve(input.cwd) || root === resolve('/') || sensitiveWorkspacePath(root)) throw new PullRequestRefusal('invalid', '这个目录不可操作');
  const name = branch(input.branch), repo = repository(input.repository);
  if (typeof input.base !== 'string' || !input.base) throw new PullRequestRefusal('invalid', '请选择要合并到哪个分支');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 256) throw new PullRequestRefusal('invalid', '标题须为 1 至 256 字');
  if (typeof input.body !== 'string' || input.body.length > 65_536) throw new PullRequestRefusal('invalid', '说明最长 65536 字');
  signal.throwIfAborted();
  let top: string;
  try { top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim(); }
  catch { throw new PullRequestRefusal('not_repository', '绑定目录不是 Git 仓库'); }
  if (await realpath(top) !== root) throw new PullRequestRefusal('not_repository', '绑定目录不是 Git 仓库根目录');
  const current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }))).stdout.trim();
  if (current !== name) throw new PullRequestRefusal('not_on_branch', `项目现在在分支 ${current || '（无）'}，不是 ${name}。请先切换分支。`);
  const commits = await outgoing(root, name);
  if (!commits.length) throw new PullRequestRefusal('nothing_to_push', `分支 ${name} 没有远端还没有的提交`);
  // The push is a plain one. It is never forced, so a remote that has moved ahead is refused by
  // git, and nothing of anyone's work is overwritten.
  try { await git(root, ['push', '--set-upstream', 'origin', name]); }
  catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    const words = (failure.stderr ?? failure.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean).join(' ').slice(0, 400);
    throw new PullRequestRefusal('remote_rejected', words ? '推送被拒绝：' + words : '推送失败');
  }
  // The pull request is opened with gh, as the owner is signed in. The body is given on stdin
  // so that it never appears in an argument list.
  let url: string;
  try {
    url = (await run(['pr', 'create', '--repo', repo, '--head', name, '--base', branch(input.base), '--title', input.title.trim(), '--body-file', '-'],
      { cwd: root, env: { PATH: process.env.PATH, GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' }, input: input.body || '' })).trim();
  } catch (error) {
    // The push went through and the pull request did not. That is said plainly: the branch is on
    // the remote, and the owner can open the pull request from GitHub without pushing again.
    const words = error instanceof Error ? error.message.split('\n').map((line: string) => line.trim()).filter((line: string) => line && !line.startsWith('Command failed') && !/^gh exited/.test(line)).join(' ').slice(0, 300) : '';
    throw new PullRequestRefusal('github', `分支 ${name} 已推送到远端，但没有开出 PR：${words || 'GitHub 拒绝了'}`);
  }
  if (!/^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(url)) throw new PullRequestRefusal('github', '分支已推送，但 GitHub 没有给出 PR 地址');
  return { state: 'opened', url, pushed: commits };
}

/** The handler a machine offers for opening a pull request. */
export function createWorkspacePullRequestNode(options: { run?: (args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) => Promise<string> } = {}) {
  /** gh as it is run here, with the owner's own login: a token in the environment would
   *  silently pick another account, so it is taken out, as the GitHub connector does. */
  const runGh = async (args: string[], runOptions?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }): Promise<string> => {
    const env: NodeJS.ProcessEnv = { ...(runOptions?.env ?? process.env) };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    return await new Promise<string>((resolve, reject) => {
      const child = spawn('gh', args, { cwd: runOptions?.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [], err: Buffer[] = [];
      let size = 0;
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= limit) out.push(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { if (err.reduce((sum, part) => sum + part.length, 0) <= limit) err.push(chunk); });
      child.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT' ? new PullRequestRefusal('github', '这台电脑没有安装 gh') : error));
      child.once('close', code => code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(Buffer.concat(err).toString('utf8') || 'gh exited ' + code)));
      child.stdin.on('error', () => { /* gh closing its stdin is reported by the exit code. */ });
      child.stdin.end(runOptions?.input ?? '');
    });
  };
  const handlers: Record<string, NodeHandler> = {
    'workspace.pullRequest': async (params, emit) => {
      const keys = ['cwd', 'branch', 'base', 'title', 'body', 'repository'];
      if (!params || Object.keys(params).some(key => !keys.includes(key))) throw new PullRequestRefusal('invalid', '开出 PR 的参数无效');
      const controller = new AbortController();
      const signal = controller.signal;
      const run = options.run ?? runGh;
      return await openPullRequest(params as unknown as PullRequestInput, run, signal) as unknown as Json;
    },
  };
  return { handlers };
}

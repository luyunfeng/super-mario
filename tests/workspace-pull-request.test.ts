import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { createWorkspacePullRequestNode, openPullRequest, PullRequestRefusal } from '../plugins/workspace-pull-request.ts';

const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).then(result => result.stdout.trim());

/** A project whose origin is a bare repository beside it, so that a push goes to the disk and
 *  not to GitHub. gh is replaced; only git is real. */
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-pull-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.git'), root = join(dir, 'project');
  await git(dir, 'init', '-q', '--bare', '--initial-branch', 'main', remote);
  await git(dir, 'init', '-q', '-b', 'main', 'project');
  await writeFile(join(root, 'README.md'), 'first\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-qm', 'first');
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '-q', '-u', 'origin', 'main');
  await git(root, 'checkout', '-qb', 'feature');
  await writeFile(join(root, 'README.md'), 'second\n');
  await git(root, 'commit', '-qam', 'second');
  return { dir, root, remote };
}

/** What gh was asked, standing where GitHub would answer. */
function fakeGh(answer = 'https://github.com/owner/repo/pull/7\n') {
  const asked: { args: string[]; cwd?: string; input?: string }[] = [];
  const run = async (args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) => {
    asked.push({ args, cwd: options?.cwd, input: options?.input });
    return answer;
  };
  return { asked, run };
}

test('the branch is pushed to origin and the pull request is opened with gh, as the owner is signed in', async t => {
  const f = await fixture(t);
  const gh = fakeGh();
  const result = await openPullRequest({ cwd: f.root, branch: 'feature', base: 'main', title: 'Add a second line', body: 'This adds a line.', repository: 'owner/repo' }, gh.run, new AbortController().signal);
  assert.deepEqual(result, { state: 'opened', url: 'https://github.com/owner/repo/pull/7', pushed: [(await git(f.root, 'log', '-1', '--format=%h %s', 'feature'))] });
  // The remote now has the branch, with the commit on it.
  assert.equal(await git(f.remote, 'rev-parse', 'feature'), await git(f.root, 'rev-parse', 'feature'));
  assert.deepEqual(gh.asked, [{ args: ['pr', 'create', '--repo', 'owner/repo', '--head', 'feature', '--base', 'main', '--title', 'Add a second line', '--body-file', '-'], cwd: f.root, input: 'This adds a line.' }]);
});

test('what is refused before anything is sent: another branch, nothing to push, a bad name, a directory that is not a repository', async t => {
  const f = await fixture(t);
  const gh = fakeGh();
  const base = { cwd: f.root, base: 'main', title: 't', body: '', repository: 'owner/repo' };
  await assert.rejects(openPullRequest({ ...base, branch: 'main' }, gh.run, new AbortController().signal), (error: unknown) => error instanceof PullRequestRefusal && error.kind === 'not_on_branch');
  await assert.rejects(openPullRequest({ ...base, branch: '../escape' }, gh.run, new AbortController().signal), (error: unknown) => error instanceof PullRequestRefusal && error.kind === 'invalid');
  await assert.rejects(openPullRequest({ ...base, branch: 'feature', repository: 'not a repo' }, gh.run, new AbortController().signal), (error: unknown) => error instanceof PullRequestRefusal && error.kind === 'invalid');
  await assert.rejects(openPullRequest({ ...base, branch: 'feature', title: ' ' }, gh.run, new AbortController().signal), (error: unknown) => error instanceof PullRequestRefusal && error.kind === 'invalid');
  await assert.rejects(openPullRequest({ ...base, cwd: f.dir, branch: 'feature' }, gh.run, new AbortController().signal), (error: unknown) => error instanceof PullRequestRefusal && (error.kind === 'not_repository' || error.kind === 'invalid'));
  assert.deepEqual(gh.asked, [], 'nothing was asked of GitHub');
  // A branch with nothing the remote lacks is refused too, after its first push.
  await git(f.root, 'push', '-q', '-u', 'origin', 'feature');
  await assert.rejects(openPullRequest({ ...base, branch: 'feature' }, gh.run, new AbortController().signal), (error: unknown) => error instanceof PullRequestRefusal && error.kind === 'nothing_to_push');
  assert.deepEqual(gh.asked, []);
});

test('a push git refuses is refused with git\'s own words, and gh is not asked', async t => {
  const f = await fixture(t);
  const gh = fakeGh();
  // The remote's branch moves ahead, so a plain push of the local one is refused.
  await git(f.root, 'push', '-q', 'origin', 'feature');
  await git(f.dir, 'init', '-q', '-b', 'other', 'other');
  await writeFile(join(f.dir, 'other', 'README.md'), 'elsewhere\n');
  await git(join(f.dir, 'other'), 'add', 'README.md');
  await git(join(f.dir, 'other'), 'commit', '-qm', 'elsewhere');
  await git(join(f.dir, 'other'), 'remote', 'add', 'origin', f.remote);
  await git(join(f.dir, 'other'), 'push', '-q', '--force', 'origin', 'other:feature');
  await writeFile(join(f.root, 'README.md'), 'third\n');
  await git(f.root, 'commit', '-qam', 'third');
  await assert.rejects(openPullRequest({ cwd: f.root, branch: 'feature', base: 'main', title: 't', body: '', repository: 'owner/repo' }, gh.run, new AbortController().signal),
    (error: unknown) => error instanceof PullRequestRefusal && error.kind === 'remote_rejected' && /rejected|non-fast-forward|fetch first/.test(error.message));
  assert.deepEqual(gh.asked, []);
});

test('when the push goes through and GitHub does not open the pull request, that is said plainly', async t => {
  const f = await fixture(t);
  const refusing = async () => { throw new Error('gh exited 1\nHTTP 422: Validation Failed'); };
  await assert.rejects(openPullRequest({ cwd: f.root, branch: 'feature', base: 'main', title: 't', body: '', repository: 'owner/repo' }, refusing, new AbortController().signal),
    (error: unknown) => error instanceof PullRequestRefusal && error.kind === 'github' && /已推送到远端/.test(error.message) && /422/.test(error.message));
  // The branch is on the remote, so the owner need not push again.
  assert.equal(await git(f.remote, 'rev-parse', 'feature'), await git(f.root, 'rev-parse', 'feature'));
});

test('the handler checks its parameters and passes them through', async t => {
  const f = await fixture(t);
  const gh = fakeGh();
  const node = createWorkspacePullRequestNode({ run: gh.run });
  const handler = node.handlers['workspace.pullRequest']!;
  await assert.rejects(handler({ cwd: f.root, branch: 'feature', base: 'main', title: 't', body: '', repository: 'owner/repo', force: true }, () => {}), /参数无效/);
  const result = await handler({ cwd: f.root, branch: 'feature', base: 'main', title: 't', body: '', repository: 'owner/repo' }, () => {}) as { state: string; url: string };
  assert.equal(result.state, 'opened');
  assert.equal(result.url, 'https://github.com/owner/repo/pull/7');
});

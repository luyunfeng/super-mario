import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createWorkspaceGitWrite } from '../plugins/workspace-git-write.ts';
import type { Json } from '../packages/plugin-sdk/src/index.ts';

const run = (cwd: string, ...args: string[]) => promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: process.env.HOME } }).then(result => result.stdout.trim());
import { promisify } from 'node:util';

interface GitStatus { branch: string; staged: { path: string; change: string }[]; unstaged: { path: string; change: string }[] }

/** A repository with one committed file, and the node that writes to it. */
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-git-write-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  await run(dir, 'init', '-q', '-b', 'main', 'repo');
  // The owner's identity, as it would be in the repository's own configuration.
  await run(root, 'config', 'user.name', 'Fixture');
  await run(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'README.md'), 'first\n');
  await run(root, 'add', 'README.md');
  await run(root, 'commit', '-qm', 'first');
  const node = createWorkspaceGitWrite();
  const call = (method: 'workspace.git.status' | 'workspace.git.write', params: object, cwd = root) =>
    node.handlers[method]!({ cwd, ...params }, () => {}) as Promise<Json>;
  const write = (params: object, cwd = root) => call('workspace.git.write', params, cwd) as Promise<Json & GitStatus & { op: string; path?: string; committed?: boolean; summary?: string }>;
  const status = (cwd = root) => call('workspace.git.status', {}, cwd) as Promise<Json & GitStatus>;
  return { root, dir, write, status };
}

test('a change is staged, the status says so, and it is committed with the owner\'s own identity', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'README.md'), 'second\n');
  assert.deepEqual((await f.status()).unstaged, [{ path: 'README.md', change: 'M' }]);
  const staged = await f.write({ op: 'stage', path: 'README.md' });
  assert.equal(staged.op, 'stage');
  assert.deepEqual(staged.staged, [{ path: 'README.md', change: 'M' }]);
  assert.deepEqual(staged.unstaged, []);
  // The commit is the owner's: the name and email are the ones git is configured with here.
  const committed = await f.write({ op: 'commit', message: 'say what changed' });
  assert.equal(committed.committed, true);
  assert.match(committed.summary!, /^[0-9a-f]+ say what changed$/);
  assert.equal(committed.staged.length, 0);
  assert.equal(await run(f.root, 'log', '-1', '--format=%an <%ae>'), 'Fixture <fixture@example.invalid>');
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'second\n');
  assert.equal((await run(f.root, 'status', '--porcelain')).length, 0);
});

test('a staged change is unstaged, and nothing is lost', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'README.md'), 'second\n');
  await f.write({ op: 'stage', path: 'README.md' });
  const unstaged = await f.write({ op: 'unstage', path: 'README.md' });
  assert.equal(unstaged.op, 'unstage');
  assert.deepEqual(unstaged.staged, []);
  assert.deepEqual(unstaged.unstaged, [{ path: 'README.md', change: 'M' }]);
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'second\n', 'the change itself is kept');
});

test('committing with nothing staged is refused, and so is a bad message, an unknown operation and a path out of the repository', async t => {
  const f = await fixture(t);
  await assert.rejects(f.write({ op: 'commit', message: 'nothing to commit' }), /没有已暂存的改动/);
  await writeFile(join(f.root, 'README.md'), 'second\n');
  await f.write({ op: 'stage', path: 'README.md' });
  for (const message of ['', '   ', 'x'.repeat(2001), 'bad\0message']) await assert.rejects(f.write({ op: 'commit', message }), /提交说明无效/);
  await assert.rejects(f.write({ op: 'push' }), /不支持/);
  await assert.rejects(f.write({ op: 'stage', path: '../outside.txt' }), /相对路径|越出/);
  await assert.rejects(f.write({ op: 'stage', path: '.git/config' }), /敏感/);
  await assert.rejects(f.write({ op: 'stage', path: '/etc/passwd' }), /相对路径/);
  // Nothing was committed by the refusals.
  assert.equal(await run(f.root, 'log', '--oneline', '|', 'wc', '-l').catch(() => ''), '');
  assert.equal((await run(f.root, 'rev-list', '--count', 'HEAD')), '1');
});

test('a directory that is not a repository, or is a subdirectory of one, is refused', async t => {
  const f = await fixture(t);
  await assert.rejects(f.write({ op: 'stage', path: 'README.md' }, f.dir), /不是 Git 仓库/);
  await assert.rejects(f.write({ op: 'stage', path: 'README.md' }, '/'), /根目录|不可操作/);
});

test('a file git refuses is refused with git\'s own words', async t => {
  const f = await fixture(t);
  // A path git knows nothing of, with a wildcard that matches no file.
  await assert.rejects(f.write({ op: 'stage', path: 'no-such-file.txt' }), /暂存|did not match/);
});

test('a commit is the owner\'s: with no identity configured, it is refused and nothing is made up', async t => {
  const f = await fixture(t);
  // The identity the fixture configured is taken away, as a computer with none would have it.
  await run(f.root, 'config', '--unset', 'user.name');
  await run(f.root, 'config', '--unset', 'user.email');
  await writeFile(join(f.root, 'README.md'), 'second\n');
  await f.write({ op: 'stage', path: 'README.md' });
  await assert.rejects(f.write({ op: 'commit', message: 'who am I' }), /提交.*identity|Author identity unknown/);
  // Nothing was committed, and the change is still staged for when the owner has an identity.
  assert.equal(await run(f.root, 'rev-list', '--count', 'HEAD'), '1');
  assert.deepEqual((await f.status()).staged, [{ path: 'README.md', change: 'M' }]);
});

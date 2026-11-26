import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRunWorktree, removeRunWorktree } from '../plugins/task-git.ts';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';

const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** A repository with one baseline commit, and a run's worktree on its own branch beside it. */
async function fixture(t: test.TestContext, label: string) {
  const root = await mkdtemp(join(tmpdir(), 'mario-worktree-cleanup-' + label + '-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'repo');
  await mkdir(source);
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8', env: gitEnv }).trim();
  git(source, 'init', '-q');
  await writeFile(join(source, 'base.txt'), 'baseline\n');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'baseline');
  const id = '9f1c4a52-3f7e-4b8a-9c1d-2e5b7a8f4c60';
  const prepared = await prepareRunWorktree({ cwd: source, id } as JsonObject) as { cwd: string; branch: string };
  const head = git(prepared.cwd, 'rev-parse', 'HEAD');
  const params = { id, source, head };
  const exists = async (path: string) => { try { await readFile(path); return true; } catch { return false; } };
  return { root, source, git, prepared, head, params, exists };
}

test('干净的工作树可以清理，分支和提交保留，目录已移除', async t => {
  const { source, git, prepared, params, exists } = await fixture(t, 'clean');
  assert.equal(await exists(join(prepared.cwd, 'base.txt')), true);
  assert.deepEqual(await removeRunWorktree(params as JsonObject), { removed: true, head: params.head, branch: prepared.branch });
  assert.equal(await exists(join(prepared.cwd, 'base.txt')), false, 'the worktree directory is gone');
  // The branch and its commit stay, so nothing that was committed is lost.
  assert.equal(git(source, 'rev-parse', prepared.branch), params.head);
  assert.equal(git(source, 'worktree', 'list', '--porcelain').includes(prepared.cwd), false);
  // Asking again is answered, and does not fail, because there is nothing left to remove.
  await assert.rejects(removeRunWorktree(params as JsonObject), /工作树登记失效|执行目录/);
});

test('有未提交修改、未跟踪文件或忽略文件时拒绝清理，目录原样保留', async t => {
  for (const [label, make, expected] of [
    ['modified', async (dir: string) => { await writeFile(join(dir, 'base.txt'), 'changed\n'); }, '仍有未提交文件'],
    ['untracked', async (dir: string) => { await writeFile(join(dir, 'new.txt'), 'new\n'); }, '仍有未提交文件'],
    ['ignored', async (dir: string) => { await writeFile(join(dir, '.gitignore'), 'cache/\n'); await mkdir(join(dir, 'cache')); await writeFile(join(dir, 'cache', 'x.bin'), 'x'); }, '存在忽略文件'],
    ['nested', async (dir: string) => { await mkdir(join(dir, 'a', 'b'), { recursive: true }); await writeFile(join(dir, 'a', 'b', 'c.txt'), 'c'); }, '仍有未提交文件'],
  ] as const) {
    const { prepared, params, exists } = await fixture(t, label);
    await make(prepared.cwd);
    const result = await removeRunWorktree(params as JsonObject) as { removed: boolean; reason?: string };
    assert.equal(result.removed, false, label);
    assert.ok(result.reason && result.reason.includes(expected), label + ': ' + result.reason);
    assert.equal(await exists(join(prepared.cwd, 'base.txt')), true, label + ': the directory is kept');
  }
});

test('提交已变化时拒绝清理，提示重新核对，不会删掉新的工作', async t => {
  const { git, prepared, params, exists } = await fixture(t, 'moved');
  // A commit lands on the branch after the owner looked at it. The head they confirmed is stale.
  await writeFile(join(prepared.cwd, 'later.txt'), 'later\n');
  git(prepared.cwd, 'add', '.');
  git(prepared.cwd, 'commit', '-qm', 'later work');
  const result = await removeRunWorktree(params as JsonObject) as { removed: boolean; reason?: string };
  assert.equal(result.removed, false);
  assert.match(result.reason ?? '', /提交已经变化/);
  assert.equal(await exists(join(prepared.cwd, 'later.txt')), true, 'the later work is kept');
  // With the current head, the same clean worktree can be removed.
  const current = git(prepared.cwd, 'rev-parse', 'HEAD');
  assert.deepEqual(await removeRunWorktree({ ...params, head: current } as JsonObject), { removed: true, head: current, branch: prepared.branch });
});

test('工作树被 Git 锁定时拒绝清理', async t => {
  const { source, git, prepared, params, exists } = await fixture(t, 'locked');
  git(source, 'worktree', 'lock', '--', prepared.cwd);
  const result = await removeRunWorktree(params as JsonObject) as { removed: boolean; reason?: string };
  assert.equal(result.removed, false);
  assert.match(result.reason ?? '', /已锁定/);
  assert.equal(await exists(join(prepared.cwd, 'base.txt')), true);
});

test('索引里有跳过检查的文件时拒绝清理', async t => {
  const { git, prepared, params, exists } = await fixture(t, 'skip');
  await writeFile(join(prepared.cwd, 'secret.txt'), 'do not lose\n');
  git(prepared.cwd, 'add', '.');
  // assume-unchanged hides a change from an ordinary status, so it is checked on its own.
  git(prepared.cwd, 'update-index', '--assume-unchanged', 'secret.txt');
  await writeFile(join(prepared.cwd, 'secret.txt'), 'changed after the flag\n');
  const result = await removeRunWorktree(params as JsonObject) as { removed: boolean; reason?: string };
  assert.equal(result.removed, false);
  assert.equal(await exists(join(prepared.cwd, 'secret.txt')), true, 'the file is kept');
  assert.match(await readFile(join(prepared.cwd, 'secret.txt'), 'utf8'), /changed after the flag/);
});

test('执行标识或来源无效时在动任何目录之前就拒绝', async () => {
  for (const params of [
    { id: '../escape', source: '/tmp', head: 'a'.repeat(40) },
    { id: '9f1c4a52-3f7e-4b8a-9c1d-2e5b7a8f4c60', source: 7, head: 'a'.repeat(40) },
    { id: '9f1c4a52-3f7e-4b8a-9c1d-2e5b7a8f4c60', source: '/tmp/does-not-exist', head: 'a'.repeat(40) },
  ]) {
    await assert.rejects(removeRunWorktree(params as unknown as JsonObject), /标识无效|ENOENT|执行目录/);
  }
});

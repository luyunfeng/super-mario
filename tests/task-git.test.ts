import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCommitDiff, taskCommitChanges, taskHead } from '../plugins/task-git.ts';

test('commit evidence covers only committed changes under the run directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mario-run-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'sub');
  await mkdir(cwd);
  assert.equal(taskHead(cwd), undefined);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: root, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  git('init', '-q');
  await writeFile(join(cwd, 'old.txt'), 'deleted line\n');
  await writeFile(join(cwd, 'edited.txt'), 'before\n');
  git('add', '.');
  git('commit', '--allow-empty', '-qm', 'base');
  const base = taskHead(cwd)!;
  await writeFile(join(cwd, 'two\tlines'), 'first\nsecond\n');
  await writeFile(join(cwd, 'binary'), Buffer.from([0, 1, 2]));
  await writeFile(join(root, 'outside'), 'outside\n');
  assert.deepEqual(taskCommitChanges(cwd, base), { base, head: base, files: 0, added: 0, deleted: 0 });
  await rm(join(cwd, 'old.txt'));
  await writeFile(join(cwd, 'edited.txt'), 'after\n');
  await writeFile(join(cwd, '.env'), 'synthetic\n');
  await writeFile(join(cwd, '[example]'), 'literal path\n');
  git('add', '.');
  git('commit', '-qm', 'changes');
  const head = taskHead(cwd);
  await writeFile(join(cwd, 'two\tlines'), 'uncommitted\n');
  const range = taskCommitChanges(cwd, base)!;
  assert.deepEqual(range, { base, head, files: 6, added: 5, deleted: 2 });
  const params = { cwd, range };
  assert.deepEqual(await readCommitDiff(params), { files: ['[example]', 'binary', 'edited.txt', 'old.txt'], hidden: 2, changes: [
    { path: '[example]', status: 'A', binary: false, added: 1, deleted: 0 },
    { path: 'binary', status: 'A', binary: true, added: null, deleted: null },
    { path: 'edited.txt', status: 'M', binary: false, added: 1, deleted: 1 },
    { path: 'old.txt', status: 'D', binary: false, added: 0, deleted: 1 },
  ] });
  assert.match(JSON.stringify(await readCommitDiff({ ...params, path: 'old.txt' })), /-deleted line/);
  assert.match(JSON.stringify(await readCommitDiff({ ...params, path: '[example]' })), /\+literal path/);
  await assert.rejects(readCommitDiff({ ...params, path: 'binary' }), /文本/);
  for (const path of ['.env', '../outside', 'outside']) await assert.rejects(readCommitDiff({ ...params, path }));

});

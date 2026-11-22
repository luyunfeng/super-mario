import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskCommitChanges, taskHead } from '../plugins/task-git.ts';

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
  git('commit', '--allow-empty', '-qm', 'base');
  const base = taskHead(cwd)!;
  await writeFile(join(cwd, 'two\tlines'), 'first\nsecond\n');
  await writeFile(join(cwd, 'binary'), Buffer.from([0, 1, 2]));
  await writeFile(join(root, 'outside'), 'outside\n');
  assert.deepEqual(taskCommitChanges(cwd, base), { base, head: base, files: 0, added: 0, deleted: 0 });
  git('add', '.');
  git('commit', '-qm', 'changes');
  const head = taskHead(cwd);
  await writeFile(join(cwd, 'two\tlines'), 'uncommitted\n');
  assert.deepEqual(taskCommitChanges(cwd, base), { base, head, files: 2, added: 2, deleted: 0 });
});

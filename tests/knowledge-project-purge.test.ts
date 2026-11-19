import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbench } from '../packages/core/src/workbench.ts';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-knowledge-purge-'));
  const app = await createWorkbench({ dataDir, host: '127.0.0.1', port: 0, demo: true });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const root = join(dataDir, 'plugins', 'knowledge-local');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const a = app.projects.create({ name: 'A' }), b = app.projects.create({ name: 'B' });
  const job = app.knowledgeCurator.addSource({ layer: 'project', projectId: a.id, text: 'target raw' });
  await app.knowledgeCurator.index();
  const snapshot = join(root, 'raw', job.id + '.md');
  await writeFile(snapshot, 'target raw');
  const page = await app.knowledge().put({ layer: 'project', projectId: a.id, title: 'A title', content: 'A v1' });
  await app.knowledgeCurator.rebuildIndex();
  return { app, a, b, job, page, root, git, snapshot, dataDir };
}

test('private history removes historical and current project blobs while preserving each other version', async t => {
  const { app, a, b, job, page, root, git, snapshot } = await fixture(t);
  const parentPage = await app.knowledge().put({ layer: 'project', projectId: b.id, title: 'B', content: 'B v1' });
  const personal = await app.knowledge().put({ layer: 'personal', title: 'P', content: 'P v1' });
  const addVersion = async (version: number) => {
    await app.knowledge().put({ ...parentPage, content: 'B v' + version });
    await app.knowledge().put({ ...personal, content: 'P v' + version });
    await app.knowledgeCurator.rebuildIndex();
  };
  await addVersion(1);
  const paths = [page.id, parentPage.id, personal.id].map(id => 'knowledge/' + id + '.md');
  const forbidden = [git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD:' + paths[0]), git('rev-parse', 'HEAD:raw/' + job.id + '.md'), git('rev-parse', 'HEAD:wiki/index.md')];
  await app.knowledge().remove(page.id); // Ownership of this old version now exists only in Git.
  const second = await app.knowledge().put({ layer: 'project', projectId: a.id, title: 'A v2', content: 'A v2' });
  await addVersion(2);
  forbidden.push(git('rev-parse', 'HEAD:knowledge/' + second.id + '.md'));
  function versions() {
    return git('rev-list', '--reverse', 'HEAD').split('\n').map(commit =>
      git('ls-tree', '-r', commit, '--', ...paths.slice(1)));
  }
  const expected = versions();
  await app.knowledgeCurator.purgeProject(a.id);
  assert.deepEqual(versions(), expected);
  for (const oid of forbidden) assert.throws(() => git('cat-file', '-e', oid));
  assert.doesNotMatch(git('rev-list', '--objects', '--all'), new RegExp(page.id + '|' + second.id + '|' + job.id));
  assert.ok(!app.store.get('knowledge.sources', job.id));
  await assert.rejects(readFile(snapshot), { code: 'ENOENT' });
  const map = await readFile(join(root, 'wiki/index.md'), 'utf8');
  assert.ok(!map.includes(a.id) && map.includes(b.id) && map.includes(personal.id));
  await app.knowledgeCurator.purgeProject(a.id);
  assert.deepEqual(versions(), expected);
});

test('custom Git metadata conflicts before raw, wiki or canonical files change', async t => {
  const { app, a, root, git, snapshot, page, job } = await fixture(t);
  const before = git('rev-parse', 'HEAD');
  const map = await readFile(join(root, 'wiki/index.md'));
  for (const [apply, undo] of [
    [() => git('branch', 'user-copy'), () => git('branch', '-D', 'user-copy')],
    [() => git('remote', 'add', 'user', 'https://example.invalid/repo'), () => git('remote', 'remove', 'user')],
    [() => writeFile(join(root, '.git/branches/backup'), 'keep'), () => rm(join(root, '.git/branches/backup'))],
  ]) {
    await apply!();
    await assert.rejects(app.knowledgeCurator.purgeProject(a.id), { status: 409 });
    assert.equal(git('rev-parse', 'HEAD'), before);
    assert.deepEqual(await readFile(join(root, 'wiki/index.md')), map);
    assert.equal(await readFile(snapshot, 'utf8'), 'target raw');
    assert.ok(app.store.get('knowledge.sources', job.id));
    assert.ok((await readFile(join(root, 'knowledge', page.id + '.md'), 'utf8')).includes('A v1'));
    await undo!();
  }
});

test('ambient Git overrides and redirected raw paths cannot modify another repository', async t => {
  const { app, a, root, dataDir, snapshot, job } = await fixture(t);
  const outside = join(dataDir, 'unrelated');
  await mkdir(outside);
  execFileSync('git', ['-C', outside, 'init', '--quiet']);
  const marker = join(outside, job.id + '.md');
  await writeFile(marker, 'external source file');
  await rm(snapshot);
  await symlink(marker, snapshot);
  await assert.rejects(app.knowledgeCurator.purgeProject(a.id), { status: 409 });
  await rm(snapshot);
  const original = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = join(outside, '.git');
    await app.knowledgeCurator.purgeProject(a.id);
  } finally {
    if (original === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = original;
  }
  assert.equal(await readFile(marker, 'utf8'), 'external source file');
  assert.throws(() => execFileSync('git', ['-C', outside, 'rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' }));
  assert.ok((await readFile(join(root, 'wiki/index.md'), 'utf8')).includes('知识地图'));
});

test('project coordinator retries only unacknowledged knowledge machines, preserving local ownership evidence', async t => {
  const { app, a, job, root, page } = await fixture(t);
  const calls: string[] = [];
  let online = new Set(['other-node', 'node-1']), loseReply = true;
  for (const id of ['node-1','node-2']) app.store.put('knowledge.worker-locations', JSON.stringify([a.id,id]), { projectId: a.id, machineId: id });
  app.setMachineClient({
    list: () => ['node-1','node-2','other-node'].map(id => ({ id, name: id, online: online.has(id), connectedAt: '', platform: 'linux', capabilities: ['workspace.knowledge.purge'] })),
    async call(id, method, input) {
      assert.equal(method, 'workspace.knowledge.purge');
      assert.deepEqual(input, { projectId: a.id });
      calls.push(id);
      if (id === 'node-2' && loseReply) throw new Error('lost acknowledgement');
      return { projectId: a.id, purged: true };
    },
  });
  const purge = () => app.purgeProject(a.id, { confirmName: a.name });
  await assert.rejects(purge(), { status: 409 });
  assert.deepEqual(calls, []);
  online.add('node-2');
  await assert.rejects(purge(), { status: 409 });
  assert.deepEqual(calls, ['node-1','node-2']);
  assert.ok(app.store.get('knowledge.sources', job.id));
  assert.ok(app.store.get('knowledge', page.id));
  assert.ok((await readFile(join(root, 'knowledge', page.id + '.md'), 'utf8')).includes('A v1'));
  loseReply = false;
  online = new Set(['node-2']);
  await purge();
  assert.deepEqual(calls, ['node-1','node-2','node-2']);
  assert.equal(app.store.get('knowledge.sources', job.id), undefined);
  assert.equal(app.store.get('knowledge', page.id), undefined);
  assert.deepEqual(app.store.list('knowledge.worker-locations'), []);
  assert.equal(app.store.get('knowledge.curator','purge-workers:' + a.id), undefined);
});

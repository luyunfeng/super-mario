import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createProjectFolders } from '../packages/core/src/project-folders.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

test('HTTP creates one new directory on the selected node without overwriting or following links', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-create-'));
  const parent = join(dir, 'parent');
  await mkdir(parent);
  await writeFile(join(parent, 'keep'), 'original');
  await symlink(parent, join(dir, 'alias'));
  const token = 'test-folder-create';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token });
  const node = startAgentNode({ url: server.url, token, machineId: 'fixture', name: 'fixture', dataDir: join(dir, 'node'), handlers: createProjectDiscovery({ home: dir }).handlers });
  t.after(async () => { await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100 && !server.machines.list().some(m => m.online); i++) await delay(20);
  const create = (parent: string | undefined, name: string) => fetch(server.url + '/api/v1/machines/fixture/directories', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent, name }),
  });
  const attempts: string[] = [];
  const disconnected = createProjectFolders({
    list: () => server.machines.list(),
    async call(_machine, method) {
      attempts.push(method);
      throw Object.assign(new Error('connection lost'), { delivery: 'unknown' });
    },
  });
  await assert.rejects(disconnected.createDirectory('fixture', { name: 'new' }), { status: 502, message: /结果未知/ });
  assert.deepEqual(attempts, ['workspace.directory.create']);
  for (const [location, name] of [[undefined, 'in-home'], ['parent', 'in-subdir']] as const) {
    const result = await create(location, name);
    assert.equal(result.status, 201);
    const cwd = join(dir, location ?? '', name);
    assert.deepEqual(await result.json(), { cwd, exists: true });
    assert.ok((await lstat(cwd)).isDirectory());
  }
  await symlink(tmpdir(), join(dir, 'outside'));
  assert.equal((await create('outside', 'nested')).status, 400);
  const responses = await Promise.all([create(join(dir, 'alias'), '新项目'), create(join(dir, 'alias'), '新项目')]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.deepEqual(await responses.find(r => r.ok)!.json(), { cwd: join(parent, '新项目'), exists: true });
  assert.ok((await lstat(join(parent, '新项目'))).isDirectory());
  for (const name of ['..', '.', '', '../escape', 'a/b', 'a\\b']) assert.equal((await create(parent, name)).status, 400);
  const existing = await create(parent, 'keep');
  assert.equal(existing.status, 409);
  assert.match(await existing.text(), /已存在/);
  for (const path of [ join(dir, 'missing'), parent + '/../parent', join(parent, 'keep')]) assert.equal((await create(path, 'nested')).status, 400);
  assert.deepEqual((await readdir(parent)).sort(), ['in-subdir', 'keep', '新项目']);
  assert.equal(await readFile(join(parent, 'keep'), 'utf8'), 'original');
});

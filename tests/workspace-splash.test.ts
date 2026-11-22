import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import type { Snapshot } from '../packages/protocol/src/index.ts';

test('presentation contribution follows plugin disable, restart and re-enable', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-splash-plugin-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, demo: true };
  let server = await startServer(config);
  const state = async () => await (await fetch(`${server.url}/api/v1/state`)).json() as Snapshot;
  const toggle = async (enabled: boolean) => {
    const response = await fetch(`${server.url}/api/v1/plugins/workspace-splash`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
    assert.equal(response.status, 200);
  };
  try {
    for (const asset of ['css/pages.css', 'js/features/splash.js']) assert.equal((await fetch(`${server.url}/${asset}`)).status, 200, asset);
    const initial = await state();
    assert.equal(initial.webExtensions?.[0]?.value.renderer, 'brand-splash');
    assert.equal(initial.plugins.find(plugin => plugin.id === 'workspace-splash')?.status, 'active');
    await toggle(false);
    assert.deepEqual((await state()).webExtensions, []);
    await server.close(); server = await startServer(config);
    assert.deepEqual((await state()).webExtensions, []);
    assert.equal((await state()).plugins.find(plugin => plugin.id === 'workspace-splash')?.enabled, false);
    await toggle(true);
    assert.equal((await state()).webExtensions?.length, 1);
    assert.equal((await state()).webExtensions?.[0]?.id, 'workspace-splash');
  } finally { await server.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('启动页设置在重启后保留，过期版本和未注册页面不会覆盖选择', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-start-page-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, demo: true, token: 'fixture-start-page' };
  let server = await startServer(config);
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const save = (key: string, revision: number, authenticated = true) => fetch(server.url + '/api/v1/start-page', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer ' + config.token } : {}) },
    body: JSON.stringify({ key, revision }),
  });
  assert.equal((await save('inbox', 0, false)).status, 401);
  assert.equal((await save('inbox', 0)).status, 200);
  assert.equal((await save('chat', 0)).status, 409);
  assert.equal((await save('https://invalid.example', 1)).status, 400);
  await server.close(); server = await startServer(config);
  const res = await fetch(server.url + '/api/v1/state', { headers: { authorization: 'Bearer ' + config.token } });
  assert.deepEqual((await res.json()).startPage, { key: 'inbox', revision: 1 });
});

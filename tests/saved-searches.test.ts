import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';

test('saved searches survive restart and reject stale writes and unauthorized requests', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-saved-searches-'));
  const config = { host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token: 'synthetic-workspace-token' };
  let server = await startServer(config);
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });

  function request(input?: object, authorized = true) {
    return fetch(server.url + '/api/v1/saved-searches', {
      method: input ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(authorized && { authorization: 'Bearer ' + config.token }) },
      body: input && JSON.stringify(input),
    });
  }

  assert.equal((await request(undefined, false)).status, 401);
  const add = { action: 'add', name: '验收', query: '待确认', revision: 0 };
  assert.equal((await request(add, false)).status, 401);
  const empty = await request();
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { revision: 0, searches: [], canUndo: false });
  const attempts = await Promise.all([request(add), request({ ...add, name: '进展' })]);
  assert.deepEqual(attempts.map(response => response.status).sort(), [200, 409]);
  const saved = await attempts.find(response => response.ok)!.json();
  assert.equal(saved.searches.length, 1);
  const id = saved.searches[0].id;
  assert.equal((await request({ action: 'update', revision: 1, id, name: '报告', query: 'x'.repeat(1025) })).status, 400);
  assert.equal((await request({ action: 'delete', revision: 1, id: 'absent' })).status, 404);

  await server.close();
  server = await startServer(config);
  assert.deepEqual(await (await request()).json(), saved);
  const removed = await request({ action: 'delete', id, revision: 1 });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { revision: 2, searches: [], canUndo: true });
  const undo = await request({ action: 'undo', revision: 2 });
  assert.deepEqual(await undo.json(), { ...saved, revision: 3 });
  assert.equal((await request({ action: 'undo', revision: 2 })).status, 409);
});

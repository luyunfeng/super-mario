import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../apps/server/src/index.ts';

test('收藏通过服务鉴权、跨重启保留，超出普通请求大小的备份可以预览', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'favorites-api-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, demo: true, token: 'synthetic-local-access' };
  let server = await startServer(config);
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const post = (path: string, body: object, auth = true) => fetch(server.url + '/api/v1/' + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(auth && { authorization: 'Bearer ' + config.token }) },
    body: JSON.stringify(body),
  });
  const endpoint = 'message-favorites';
  assert.equal((await post(endpoint, { action: 'list' }, false)).status, 401);
  server.app.store.put('messages', 'local', { id: 'local', conversationId: 'main', role: 'user',
    text: '合成消息', createdAt: '2026-01-12T10:00:00.000Z' });
  assert.equal((await post(endpoint, { action: 'add', messageId: 'local' })).status, 200);
  await server.close();
  server = await startServer(config);
  const favorites = await (await post(endpoint, { action: 'list' })).json();
  assert.equal(favorites.items[0].text, '合成消息');
  const backup = await (await post(endpoint, { action: 'backup' })).json();
  const record = backup.messages[0];
  backup.messages = Array.from({ length: 100 }, () => ({
    ...record, key: crypto.randomUUID(), text: '收藏内容'.repeat(1000),
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(backup)) > 1024 * 1024);
  const preview = await post(endpoint, { action: 'preview', backup });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).toAdd, 100);
  assert.equal((await post('plugins/message-favorites', { enabled: false })).status, 200);
  assert.equal((await post(endpoint, { action: 'list' })).status, 503);
  assert.equal((await post('plugins/message-favorites', { enabled: true })).status, 200);
  const current = await (await post(endpoint, { action: 'list' })).json();
  assert.deepEqual(current, favorites);
});

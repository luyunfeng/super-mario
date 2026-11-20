import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';

test('丢弃模型草稿保留历史，重复请求幂等，已提交或旧版本不能丢弃', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-discard-'));
  const server = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, token: 'fixture' });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { app } = server;
  await app.inbox.ingest('test', [{ thread: 'one', last: 'msg', title: '来信', text: '原文' }]);
  const inbox = app.inbox.list();
  const ref = { kind: 'personal' as const, id: inbox[0]!.id };
  const handling = app.inboxHandling;
  const initial = handling.read(ref);
  handling.saveModelDrafts(ref, initial.conversationId, 'model-request', '拟定建议', [
    { kind: 'reply', text: '未发送的回复' }, { kind: 'conclusion', text: '候选结论' },
  ]);
  const [draft, next] = handling.read(ref).suggestions;
  assert.ok(draft && next);
  const path = server.url + '/api/v1/inbox-handling/personal/' + ref.id + '/suggestions';
  const post = (suffix: string, body: unknown) => fetch(path + suffix, {
    method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const version = { version: draft.version, sourceVersion: draft.sourceVersion };
  const discard = '/' + draft.id + '/discard';
  assert.equal((await post(discard, { ...version, version: draft.version + 1 })).status, 409);
  const response = await post(discard, version);
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.deepEqual(saved, { ...draft, status: 'discarded', updatedAt: saved.updatedAt });
  assert.deepEqual(await (await post(discard, version)).json(), saved);
  assert.equal((await post('/' + draft.id + '/confirm', version)).status, 409);
  assert.equal((await post('', { ...version, id: draft.id, action: draft.action })).status, 409);
  assert.deepEqual(handling.read(ref).suggestions, [saved, next]);
  assert.deepEqual(app.inbox.list(), inbox);
  assert.equal(app.background.outbox.list().length, 0);
  assert.equal(app.approvals.list().length, 0);
  assert.equal((await post('/' + next.id + '/confirm', version)).status, 201);
  assert.equal((await post('/' + next.id + '/discard', version)).status, 409);
});

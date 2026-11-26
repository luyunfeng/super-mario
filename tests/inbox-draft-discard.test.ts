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

test('新一轮的同类草稿替换此前未提交的草稿，已提交审批的不受影响', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-draft-replace-'));
  const server = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, token: 'fixture' });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { app } = server;
  await app.inbox.ingest('test', [{ thread: 'one', last: 'msg', title: '来信', text: '原文' }]);
  const ref = { kind: 'personal' as const, id: app.inbox.list()[0]!.id };
  const handling = app.inboxHandling;
  const conversationId = handling.read(ref).conversationId;
  const path = server.url + '/api/v1/inbox-handling/personal/' + ref.id + '/suggestions';
  const post = (suffix: string, body: unknown) => fetch(path + suffix, {
    method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  // First turn: a reply draft and a conclusion. The conclusion is then handed in.
  handling.saveModelDrafts(ref, conversationId, 'turn-1', '先这样回', [
    { kind: 'reply', text: '第一版回复' }, { kind: 'conclusion', text: '候选结论' },
  ]);
  const [firstReply, firstConclusion] = handling.read(ref).suggestions;
  assert.ok(firstReply && firstConclusion);
  const confirmed = await post('/' + firstConclusion.id + '/confirm', { version: firstConclusion.version, sourceVersion: firstConclusion.sourceVersion });
  assert.equal(confirmed.status, 201, await confirmed.text());

  // Second turn: the owner asks for a friendlier reply and a new conclusion. The first
  // conclusion is already handed in, so it stays. The reply draft is replaced.
  handling.saveModelDrafts(ref, conversationId, 'turn-2', '改得客气一点', [
    { kind: 'reply', text: '客气一点的回复' }, { kind: 'conclusion', text: '新的候选结论' },
  ]);
  const rows = handling.read(ref).suggestions;
  const byId = (id: string) => rows.find(row => row.id === id)!;
  assert.equal(byId(firstConclusion.id).status, 'submitted', 'a conclusion already handed in is not replaced');
  assert.equal(byId(firstReply.id).status, 'discarded', 'a draft of the same kind is replaced');
  assert.deepEqual(rows.filter(row => row.status === 'draft').map(row => row.action), [
    { kind: 'reply', text: '客气一点的回复' }, { kind: 'conclusion', text: '新的候选结论' },
  ]);

  // A kind that this turn does not mention is left alone.
  handling.saveModelDrafts(ref, conversationId, 'turn-3', '只改结论', [{ kind: 'conclusion', text: '最终结论' }]);
  const after = handling.read(ref).suggestions;
  assert.deepEqual(after.filter(row => row.status === 'draft').map(row => row.action), [
    { kind: 'reply', text: '客气一点的回复' }, { kind: 'conclusion', text: '最终结论' },
  ]);

  // A draft the owner wrote by hand is the owner's own. A later model turn of the same
  // kind must not discard it.
  const mine = handling.save(ref, { sourceVersion: handling.read(ref).source.version, action: { kind: 'conclusion', text: '主人自己写的结论' } });
  assert.equal(mine.status, 'draft');
  handling.saveModelDrafts(ref, conversationId, 'turn-4', '再给一版结论', [{ kind: 'conclusion', text: '模型又给的结论' }]);
  const last = handling.read(ref).suggestions;
  assert.equal(last.find(row => row.id === mine.id)!.status, 'draft', 'the owner\'s own draft survives');
  const conclusionsOfOwnerTurn = last.filter(row => row.status === 'draft' && row.action.kind === 'conclusion');
  assert.deepEqual(conclusionsOfOwnerTurn.map(row => (row.action as { text: string }).text), ['主人自己写的结论', '模型又给的结论']);

  // Once the owner edits a model draft, the next model turn of that kind leaves it alone.
  const edited = handling.save(ref, { sourceVersion: handling.read(ref).source.version, id: mine.id, version: mine.version,
    action: { kind: 'conclusion', text: '主人改过的结论' } });
  assert.equal(edited.origin, 'owner');
  handling.saveModelDrafts(ref, conversationId, 'turn-5', '再来一版', [{ kind: 'conclusion', text: '模型第三版结论' }]);
  const kept = handling.read(ref).suggestions.find(row => row.id === mine.id)!;
  assert.equal(kept.status, 'draft');
  assert.equal((kept.action as { text: string }).text, '主人改过的结论');
  assert.equal(app.background.outbox.list().length, 0, 'nothing was sent');
});

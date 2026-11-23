import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('独立对话只接收来自同一持久化输入的只读协作回报', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-thread-result-'));
  const app = await createWorkbench({ dataDir, port: 0, host: '127.0.0.1', demo: true });
  t.after(async () => { try { await app.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const scope = { kind: 'global' } as const;
  const bot = { id: 'fixture-bot', appId: 'fixture-app', scope, enabled: true, paired: true };
  const first = 'a'.repeat(64), other = 'b'.repeat(64);
  app.setBotsStatus(() => [bot]);
  app.setBotScopeAccess((_scope, id, _input, thread) => id === bot.id && [first, other].includes(thread ?? ''));

  const source = await app.postScoped('合成协作请求', scope, bot.id, first);
  const route = { channel: 'feishu', accountId: bot.appId, target: 'fixture-chat', botId: bot.id, scope, inputId: source.id,
    conversationThreadId: first, threadId: other };
  app.store.put('message.routes', source.id, route);
  await t.waitFor(() => assert.equal(app.store.get<Message>('messages', source.id)?.status, 'done'));
  const report = { botId: bot.id, scope, text: '合成结果' };
  await assert.rejects(app.postScopedResult({ ...report, sourceMessageId: source.id, threadId: other }), { status: 403 });
  await assert.rejects(app.postScopedResult({ ...report, threadId: first }), { status: 403 });
  await assert.rejects(app.postScopedResult({ ...report, sourceMessageId: 'missing', threadId: first }), { status: 409 });
  app.store.put('message.routes', source.id, { ...route, conversationThreadId: other });
  await assert.rejects(app.postScopedResult({ ...report, sourceMessageId: source.id, threadId: other }), { status: 403 });
  assert.equal(app.store.list<Message>('messages').filter(row => row.origin === 'result').length, 0);

  app.store.put('message.routes', source.id, route);
  const accepted = await app.postScopedResult({ ...report, sourceMessageId: source.id, threadId: first });
  app.store.put('message.routes', accepted.id, { ...route, resultRelayEntryId: 'fixture-relay' });
  assert.equal(accepted.conversationId, source.conversationId);
  assert.equal(accepted.origin, 'result');
  assert.equal(accepted.readOnly, true);
  assert.equal(accepted.replyTo, source.id);
  await t.waitFor(() => assert.equal(app.store.get<Message>('messages', accepted.id)?.status, 'done'));
});

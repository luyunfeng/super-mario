import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { botConversationId } from '../packages/core/src/bot-agent-routing.ts';
import { createWorkbench } from '../packages/core/src/workbench.ts';

test('话题决定保留真实入站来源，拒绝伪造、跨范围与未确认投递', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-topic-decision-'));
  const config = { dataDir, host: '127.0.0.1', port: 0, demo: true };
  let app = await createWorkbench(config);
  t.after(async () => { try { await app.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const scope = { kind: 'global' as const };
  const botId = 'bot-fixture', accountId = 'app-fixture', inputId = 'input-fixture', envelopeId = 'inbox-fixture';
  const target = 'group-fixture', sourceMessageId = 'event-fixture', threadId = 'topic-fixture', todoId = 'todo-fixture';
  const text = '选用第二版并保留回退步骤', now = new Date().toISOString();
  const todo = { id: todoId, notes: '', title: '话题待办', createdAt: now, updatedAt: now };
  app.store.put('todos', todoId, todo);
  const msg = { id: inputId, role: 'user', conversationId: botConversationId({ id: botId, scope }), todoId,
    createdAt: now, status: 'pending', text };
  app.store.put('messages', inputId, msg);
  const group = { chatType: 'group', chatId: target, senderType: 'user', senderId: 'owner-fixture', messageId: sourceMessageId, threadId };
  const stamp = { topic: { grant: 'enrollment-fixture', todoId, opening: false }, group, revision: 1, threadId, platformReplyTo: sourceMessageId };
  const route = { ...stamp, channel: 'feishu', scope, botId, accountId, target, sourceMessageId, inputId, envelopeId };
  const entry = { id: envelopeId, scope, botId, text, direction: 'inbox', status: 'processing', sourceMessageId, target,
    eventKey: 'feishu-in:' + JSON.stringify([botId, accountId, sourceMessageId]), origin: { kind: 'group', chatId: target } };
  const receiptKey = [botId, accountId, envelopeId].join(':');
  app.store.put('event.mailboxes', envelopeId, entry);
  app.store.put('feishu.bot.envelopes', envelopeId, stamp);
  app.store.put('message.routes', inputId, route);
  assert.throws(() => app.recordTopicDecision(inputId));
  app.store.put('feishu.bot.dispatch', receiptKey, { status: 'completed', id: inputId });
  for (const bad of [{ topic: { ...stamp.topic, opening: true } }, { topic: { ...stamp.topic, grant: 'other-grant' } },
    { group: { ...group, senderId: 'other-user' } }, { threadId: 'other-topic' }, { group: { ...group, senderType: 'bot' } }]) {
    app.store.put('message.routes', inputId, { ...route, ...bad });
    assert.throws(() => app.recordTopicDecision(inputId));
  }
  app.store.put('message.routes', inputId, route);
  app.store.put('projects', 'p', { id: 'p' });
  app.store.put('todos', todoId, { ...todo, projectId: 'p' });
  assert.throws(() => app.recordTopicDecision(inputId));
  app.store.put('todos', todoId, todo);
  assert.equal(app.store.list('work.decisions').length, 0);
  app.recordTopicDecision(inputId);
  app.recordTopicDecision(inputId);
  const [decision] = app.todoDecisions.list(todoId);
  assert.deepEqual(app.todoDecisions.list(todoId), [{ id: decision!.id, source: 'topic', sourceId: inputId, active: true, text }]);
  await app.close();
  app = await createWorkbench(config);
  assert.deepEqual(app.todoDecisions.list(todoId), [decision]);
  app.store.put('feishu.bot.dispatch', receiptKey, { status: 'unknown', id: inputId });
  assert.throws(() => app.todoDecisions.list(todoId));
});

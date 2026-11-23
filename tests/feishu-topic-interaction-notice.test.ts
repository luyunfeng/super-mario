import assert from 'node:assert/strict';
import test from 'node:test';
import { topicInteractionNotice } from '../apps/server/src/feishu-topic-interaction-notice.ts';
import { mailboxEntryId } from '../packages/core/src/event-mailboxes.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createInteractions } from '../packages/core/src/interactions.ts';
import { createStore } from '../packages/core/src/store.ts';

test('only a current owner-required host interaction for the exact assigned run qualifies', async (t) => {
  const store = createStore(':memory:');
  const cards = createInteractions({
    store,
    events: createEventBus(store),
    decide: () => ({ handler: 'user', layer: 'default' }),
    answer: async () => {},
  });
  t.after(async () => {
    await cards.close();
    store.close();
  });
  const run = {
    id: 'run',
    todoId: 'todo',
    sessionId: 'session',
    machineId: 'machine',
    executorId: 'machine/codex',
    status: 'running',
    executionMode: 'interactive',
    cwd: '/fixture',
    sourceMessageId: 'source',
  };
  const owner = { runId: run.id, sessionId: run.sessionId, machineId: run.machineId };
  const todo = { id: 'todo', responsibleSession: owner };
  const source = { id: 'source', todoId: 'todo' };
  const card = cards.open({
    kind: 'question',
    title: '仅在 Web 显示',
    body: '合成私密问题',
    runId: run.id,
    executorId: run.executorId,
    cwd: run.cwd,
  });
  const noticeId = 'interaction-notice:' + card.id;
  const notice = {
    id: noticeId,
    replyTo: 'source',
    role: 'assistant',
    origin: 'notification',
    status: 'done',
    conversationId: 'main',
    createdAt: card.createdAt,
    text: '合成私密提示',
  };
  const origin = { inputId: 'source' };
  const opening = {
    channel: 'feishu',
    botId: 'bot',
    accountId: 'app',
    revision: 1,
    inputId: 'opening',
    target: 'chat',
    threadId: 'thread',
    topic: { opening: true, grant: 'grant', todoId: 'todo' },
  };
  const route = { ...opening, inputId: 'source', topic: { ...opening.topic, opening: false } };
  store.put('runs', 'run', run);
  store.put('todos', 'todo', todo);
  store.put('messages', 'source', source);
  store.put('interaction-origins', card.id, origin);
  store.put('message.routes', 'opening', opening);
  store.put('message.routes', 'source', route);
  const qualify = () => topicInteractionNotice(store, card.id, 'opening');
  const expected = { todoId: 'todo', runId: 'run', interactionId: card.id };
  assert.equal(qualify(), undefined);
  store.put('interactions', card.id, { ...card, userNotifiedAt: card.createdAt });
  assert.equal(qualify(), undefined);
  store.put('messages', noticeId, notice);
  assert.deepEqual(qualify(), expected);
  store.put('runs', 'run', { ...run, todoId: undefined, sourceMessageId: undefined });
  store.put('interaction-origins', card.id, {});
  store.put('messages', noticeId, { ...notice, replyTo: undefined });
  assert.deepEqual(qualify(), expected);
  store.put('todos', 'ambiguous', { id: 'ambiguous', responsibleSession: owner });
  assert.equal(qualify(), undefined);
  store.remove('todos', 'ambiguous');
  store.put('runs', 'run', { ...run, todoId: 'other' });
  assert.equal(qualify(), undefined);
  store.put('runs', 'run', { ...run, executionMode: 'task' });
  store.put('interaction-origins', card.id, origin);
  store.put('messages', noticeId, notice);
  const notified = { ...card, userNotifiedAt: card.createdAt };
  for (const kind of ['plan', 'review']) {
    store.put('interactions', card.id, { ...notified, kind });
    assert.deepEqual(qualify(), expected);
  }
  store.put('interactions', card.id, notified);
  store.put('runs', 'run', run);
  store.remove('messages', 'source');
  assert.equal(qualify(), undefined);
  store.put('messages', 'source', source);
  function exclude(collection: string, id: string, patches: Record<string, unknown>[]) {
    const row = store.get<Record<string, unknown>>(collection, id)!;
    for (const patch of patches) {
      store.put(collection, id, { ...row, ...patch });
      assert.equal(qualify(), undefined);
    }
    store.put(collection, id, row);
  }
  exclude('todos', 'todo', [
    { completedAt: card.createdAt },
    { projectId: 'project' },
    { responsibleSession: undefined },
    ...['runId', 'sessionId', 'machineId'].map((field) => ({ responsibleSession: { ...owner, [field]: 'other' } })),
  ]);
  exclude('runs', 'run', [
    { status: 'completed' },
    { executionMode: 'task' },
    { projectId: 'project' },
    { todoId: 'other' },
    { sourceMessageId: 'other' },
  ]);
  exclude('interactions', card.id, [
    { expiresAt: 'invalid' },
    { expiresAt: '2000-01-01' },
    { handler: 'main_agent' },
    { status: 'answered' },
    { projectId: 'project' },
    { runId: 'other' },
    { cwd: '/other' },
    { executorId: 'other' },
    { userNotifiedAt: undefined },
  ]);
  exclude('messages', noticeId, [
    { replyTo: undefined },
    { origin: 'result' },
    { status: 'pending' },
    { role: 'user' },
    { createdAt: 'other' },
  ]);
  exclude('messages', 'source', [{ projectId: 'project' }, { todoId: 'other' }]);
  exclude('interaction-origins', card.id, [{ inputId: 'other' }]);
  exclude('message.routes', 'opening', [{ threadId: '' }, { topic: { ...opening.topic, opening: false } }]);
  const key = 'feishu-reply:' + JSON.stringify(['bot', 'app', 'source', noticeId]);
  const id = mailboxEntryId('bot', 'outbox', key);
  const receipt = { id, eventKey: key, botId: 'bot', direction: 'outbox', replyTo: 'source', target: 'chat', status: 'unknown' };
  for (const status of ['ready', 'processing', 'completed', 'unknown']) {
    store.put('event.mailboxes', id, { ...receipt, status });
    assert.equal(qualify(), undefined);
  }
  store.put('message.routes', 'source', { ...route, threadId: 'other' });
  assert.deepEqual(qualify(), expected);
  store.put('message.routes', 'source', route);
  store.put('event.mailboxes', id, { ...receipt, status: 'failed' });
  assert.deepEqual(qualify(), expected);
  cards.withdraw(card.id, card.version);
  assert.equal(qualify(), undefined);
});

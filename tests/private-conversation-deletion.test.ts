import assert from 'node:assert/strict';
import test from 'node:test';
import { botConversationId } from '../packages/core/src/bot-agent-routing.ts';
import { createStore } from '../packages/core/src/store.ts';
import { forgetPrivateConversation } from '../packages/core/src/private-conversation-deletion.ts';

test('删除独立对话逐一核对真实工作关联，保留独立业务记录', t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const conversationId = botConversationId({ id: 'sample-bot', scope: { kind: 'global' } }, 'a'.repeat(64));
  const m = { id: 'input', conversationId, role: 'user', text: '样例正文', status: 'done', createdAt: '2026-01-01' };
  store.put('messages', m.id, m);
  store.put('knowledge', 'page', { id: 'page', content: '已独立确认的结论' });
  store.put('plan-origins', 'p', { conversationId, sourceMessageId: m.id });
  store.put('interaction-origins', 'question', { inputId: m.id });
  store.put('todo.origins', 'todo', { conversationId, sourceMessageId: m.id });
  const remove = () => store.transaction(() => forgetPrivateConversation(store, conversationId));
  for (const [collection, row] of [
    ['plans', { id: 'p', status: 'pending' }], ['interactions', { id: 'question', status: 'open' }],
    ['approvals', { id: 'approval', status: 'pending', params: { sourceMessageId: m.id } }],
    ['todos', { id: 'todo' }], ['runs', { id: 'run', conversationId, status: 'unknown' }],
    ['agent.followups', { id: 'follow', status: 'active', sourceConversationId: conversationId }],
    ['knowledge.sources', { id: 'source', status: 'running', sourceMessageId: m.id }],
    ['scheduled-work.requests', { id: 'schedule', status: 'active', sourceMessage: m }],
  ] as const) {
    store.put(collection, row.id, row);
    assert.throws(remove, { status: 409 }, collection);
    assert.deepEqual(store.get('messages', m.id), m);
    store.remove(collection, row.id);
  }
  store.put('agent.traces', 'trace', { id: 'trace', conversationId, toolCalls: [
    { name: 'todo_create', result: JSON.stringify({ details: { created: true, id: 'older' } }) },
  ] });
  store.put('todos', 'older', { id: 'older' });
  assert.throws(remove, { status: 409 });
  store.put('todos', 'older', { id: 'older', completedAt: '2026-01-02' });
  store.put('scheduled-work.requests', 'old', { id: 'old', status: 'cancelled', sourceMessage: m });
  store.put('conversation.question-continuations', m.id, 'earlier-input');
  store.put('conversation.last-direct-input', 'audience', m.id);
  store.put('conversation.last-direct-input', 'other-audience', 'other-input');
  remove();
  assert.equal(store.get('conversation.question-continuations', m.id), undefined);
  assert.equal(store.get('conversation.last-direct-input', 'audience'), undefined);
  assert.equal(store.get('conversation.last-direct-input', 'other-audience'), 'other-input');
  assert.equal(store.get('messages', m.id), undefined);
  assert.equal(store.get('agent.traces', 'trace'), undefined);
  assert.doesNotMatch(JSON.stringify(store.list('scheduled-work.requests')), /样例正文/);
  assert.ok(store.get('todos', 'older'));
  assert.ok(store.get('knowledge', 'page'));
  assert.throws(() => forgetPrivateConversation(store, 'main'), { status: 400 });
});

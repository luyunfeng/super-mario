import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createWorkDecisionService } from '../packages/core/src/work-decision-service.ts';
import { createTodoDecisions } from '../packages/core/src/todo-decisions.ts';
import { webTopicDecision } from '../apps/server/src/feishu-topic-web-decision.ts';
import type { AppEvent, Message } from '../packages/protocol/src/index.ts';

test('only the original Web task decision qualifies from the live ledger event and current scope', (t) => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  for (const id of ['todo', 'other']) store.put('todos', id, { id });
  store.put('projects', 'project', { id: 'project' });
  store.put('todos', 'assigned', { id: 'assigned', projectId: 'project' });
  const events = createEventBus(store);
  const current: Message = {
    id: 'chat',
    conversationId: 'main',
    origin: 'user',
    role: 'user',
    status: 'done',
    todoId: 'todo',
    text: '模型收到的普通聊天',
    createdAt: new Date().toISOString(),
  };
  store.put('messages', current.id, current);
  const service = createWorkDecisionService({ store, events, currentInput: () => current, assertCurrentInput() {} });
  const todos = createTodoDecisions(store, service);
  const received: AppEvent[] = [];
  events.subscribe((event) => {
    if (event.type === 'work.decision.recorded') received.push(event);
  });
  const lookup = (event: AppEvent) => webTopicDecision(store, service.ledger.get, event);
  const recorded = todos.add('todo', '明确提交的合成决定');
  assert.deepEqual(lookup(received[0]), { todoId: 'todo', decisionId: recorded.id });
  todos.add('todo', '明确提交的合成决定');
  assert.equal(received.length, 1);
  service.recordFromWeb({ key: 'global', text: '全局' });
  todos.add('assigned', '项目');
  service.recordFromAgent({ key: 'agent', text: current.text, todoId: 'todo' });
  for (const event of received.slice(1)) assert.equal(lookup(event), undefined);
  const fact = service.ledger.get(recorded.id)!;
  store.put('message.routes', fact.source.messageId, { channel: 'feishu' });
  assert.equal(lookup(received[0]), undefined);
  store.remove('message.routes', fact.source.messageId);
  store.put('todos', 'todo', { id: 'todo', projectId: 'project' });
  assert.equal(lookup(received[0]), undefined);
  store.put('todos', 'todo', { id: 'todo' });
  service.changeFromWeb({ id: fact.id, version: 1, text: '更正' });
  assert.equal(lookup(received[0]), undefined);
  const corrected = events.since(0).find((e) => e.type === 'work.decision.corrected')!;
  assert.equal(lookup(corrected), undefined);
  todos.withdraw('todo', fact.id);
  assert.equal(lookup(received[0]), undefined);
});

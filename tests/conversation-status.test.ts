import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import { conversationSearch } from '../plugins/conversation-search.ts';
import { readConversationStatus } from '../plugins/conversation-status.ts';

const at = '2026-11-23T09:00:00Z';
const later = '2026-11-23T09:01:00Z';
const conversationId = 'project:one:work';
const scope = { conversationId, projectId: 'one', todoId: 'task', excludeId: 'current' };
const message = { id: 'input', conversationId, projectId: 'one', todoId: 'task', text: '最近\n发言', role: 'user', status: 'done', createdAt: at };
const run = { id: 'run', conversationId, projectId: 'one', todoId: 'task', sourceMessageId: 'input', status: 'running', prompt: '执行目标', updatedAt: at };
const card = { id: 'direct', projectId: 'one', kind: 'question', status: 'open', handler: 'user', title: '等待确认', createdAt: at };

test('status is pinned to a conversation and task; pending requires the exact originating message or run', t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  const status = () => readConversationStatus(store, scope);
  assert.equal(status().phase, 'no_records');
  for (const row of [{ ...message, id: 'other-thread', conversationId: 'bot:other', text: 'private' },
    { ...message, id: 'other-task', todoId: 'other', text: 'private' },
    { ...message, id: 'bad-project', projectId: 'other', text: 'private' },
    { ...message, id: 'current', status: 'pending', text: '状态如何' },
    { ...message, id: 'current-answer', replyTo: 'current', status: 'pending', text: 'working' },
    { ...message, id: 'notice', origin: 'notification', text: 'private' }]) store.put('messages', row.id, row);
  assert.equal(status().phase, 'no_records');
  store.put('messages', message.id, message);
  const idle = status();
  assert.equal(idle.phase, 'idle');
  assert.deepEqual(idle.lastMessage, { role: 'user', text: '最近 发言', truncated: false, at });
  for (const queueState of ['withdrawn', 'cancelled']) {
    store.put('messages', 'removed', { ...message, id: 'removed', queueState, status: 'failed', text: '已移除的草稿', createdAt: later });
    assert.equal(status().phase, 'idle');
    assert.deepEqual(status().lastMessage, idle.lastMessage);
  }
  store.put('runs', run.id, run);
  assert.equal(status().phase, 'working');
  assert.equal(status().goal, '执行目标');
  store.put('runs', 'other-run', { ...run, id: 'other-run', conversationId: 'bot:other', prompt: 'private' });
  for (const row of [{ ...card }, { ...card, id: 'by-run', runId: run.id }, { ...card, id: 'unowned' },
    { ...card, id: 'foreign', runId: 'other-run' }, { ...card, id: 'foreign-input' },
    { ...card, id: 'auto', runId: run.id, handler: 'main_agent' }, { ...card, id: 'wrong-project', projectId: 'other', runId: run.id },
    { ...card, id: 'expired', runId: run.id, expiresAt: '2000-01-01T00:00:00Z' }]) store.put('interactions', row.id, row);
  store.put('interaction-origins', card.id, { inputId: message.id });
  store.put('interaction-origins', 'foreign-input', { inputId: 'other-thread' });
  const waiting = status();
  assert.equal(waiting.phase, 'waiting');
  assert.equal(waiting.pending.total, 2);
  assert.equal(waiting.pending.truncated, false);
  assert.doesNotMatch(JSON.stringify(waiting), /private/);
  for (let i = 0; i < 5; i++) store.put('interactions', String(i), { ...card, id: String(i), runId: run.id });
  assert.deepEqual([status().pending.total, status().pending.items.length, status().pending.truncated], [7, 5, true]);
});

test('service and tool share the projection, hide scope selectors and unload together', async t => {
  const store = createStore(':memory:');
  const contributions = createContributions();
  const host = new PluginHost({ store, dataDir: ':memory:', events: createEventBus(store), contributions });
  t.after(async () => { await host.close(); store.close(); });
  host.register(conversationSearch(async () => { throw Error('unrelated'); }));
  await host.start();
  const tool = contributions.list('tools').find(row => row.value.name === 'conversation_status')!.value;
  assert.deepEqual(tool.parameters.properties, {});
  await assert.rejects(tool.execute({}, new AbortController().signal), { status: 400 });
  await assert.rejects(host.invocations.use('conversation-search.status', { conversationId, extra: 1 }), { status: 400 });
  store.put('messages', message.id, { ...message, conversationId: 'main', text: '龟'.repeat(200) });
  const context = { conversationId: 'main', projectId: 'one' };
  const read = () => readConversationStatus(store, context);
  assert.equal(read().lastMessage?.text.length, 160);
  assert.equal(read().lastMessage?.truncated, true);
  assert.equal(readConversationStatus(store, { ...context, projectId: 'other' }).phase, 'no_records');
  store.put('runs', run.id, { ...run, conversationId: 'main', status: 'failed', updatedAt: later });
  assert.equal(read().phase, 'failed');
  store.put('runs', run.id, { ...run, conversationId: 'main', status: 'unknown', updatedAt: later });
  assert.equal(read().phase, 'unknown');
  assert.equal(read().goal, null);
  assert.deepEqual(await tool.execute(context, new AbortController().signal), await host.invocations.use('conversation-search.status', context));
  await host.setEnabled('conversation-search', false);
  await assert.rejects(host.invocations.use('conversation-search.status', context), /unavailable/);
  await assert.rejects(tool.execute(context, new AbortController().signal), { status: 503 });
});

test('old project turns remain visible and an interrupted assistant placeholder cannot revive its failed input', t => {
  const store = createStore(':memory:'); t.after(() => store.close());
  const legacy = { ...message, projectId: undefined, status: 'failed' };
  store.put('messages', legacy.id, legacy);
  store.put('messages', 'placeholder', { ...legacy, id: 'placeholder', replyTo: legacy.id, role: 'assistant', status: 'pending', text: '', createdAt: later });
  assert.equal(readConversationStatus(store, scope).phase, 'failed');
  assert.equal(readConversationStatus(store, scope).lastMessage?.text, '最近 发言');
  assert.equal(readConversationStatus(store, { ...scope, projectId: 'other' }).phase, 'no_records');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Todo } from '../packages/protocol/src/index.ts';
import type { OutboxItem } from '../packages/plugin-sdk/src/index.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createTodoReporting } from '../packages/core/src/todo-reporting.ts';
import { createOutbox } from '../packages/core/src/outbox.ts';
import { createEventbox } from '../packages/core/src/eventbox.ts';
import { createEffects } from '../packages/core/src/effects.ts';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'todo-reporting-'));
  const path = join(dir, 'test.sqlite');
  const store = createStore(path), events = createEventBus(store);
  const reporting = createTodoReporting({ store, events });
  const old = '2026-01-01T00:00:00.000Z';
  const todo: Todo = { id: 't1', title: '交付', notes: '', projectId: 'p1', createdAt: old, updatedAt: old };
  store.put('todos', todo.id, todo);
  function message(patch: Partial<Message> = {}) {
    const value: Message = { id: 'm1', conversationId: 'c1', todoId: todo.id, projectId: 'p1',
      role: 'assistant', status: 'done', text: '工作已完成，验证通过。', createdAt: old, ...patch };
    store.put('messages', value.id, value);
    return value;
  }
  function outbox(patch: Partial<OutboxItem> = {}) {
    const value: OutboxItem = { id: 'o1', owner: 'core', version: 1, contentHash: 'outbox-owned-hash',
      dedupKey: 'reply-1', channel: 'feishu.bot', target: 'chat-1', content: { text: '工作已完成，验证通过。' },
      relatedTo: { kind: 'todo', id: todo.id }, status: 'queued', attempt: 0, createdAt: old, updatedAt: old, ...patch };
    store.put('outbox.items', value.id, value);
    return value;
  }
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, events, reporting, message, outbox, todo, path };
}

test('legacy todos remain unconstrained and missing todos fail', t => {
  const { reporting, store } = fixture(t);
  assert.deepEqual(reporting.get('t1'), { todoId: 't1', required: false, requireDelivery: false, cycle: 1, version: 0 });
  reporting.assertCanComplete('t1');
  assert.equal(store.list('todo.reporting').length, 0);
  assert.throws(() => reporting.get('missing'), /不存在/);
  assert.throws(() => reporting.assertCanComplete('missing'), /不存在/);
});

test('configuration requires exact versions and explicit user disable', t => {
  const { reporting } = fixture(t);
  assert.throws(() => reporting.configure({ todoId: 't1', required: true, version: 1 }), /版本/);
  const first = reporting.configure({ todoId: 't1', required: true, version: 0 });
  assert.equal(first.version, 1);
  assert.throws(() => reporting.assertCanComplete('t1'), { message: '当前周期尚未记录有效答复', status: 409 });
  for (const version of [undefined, 0, -1, NaN, 1.5]) {
    assert.throws(() => reporting.configure({ todoId: 't1', required: false, version }), /版本/);
  }
  assert.equal(reporting.get('t1').required, true);
  reporting.configure({ todoId: 't1', required: false, version: 1 });
  reporting.assertCanComplete('t1');
});

test('done assistant reply records actual body hash and traceable immutable history', t => {
  const { reporting, message, store, events } = fixture(t);
  const msg = message();
  reporting.configure({ todoId: 't1', required: true });
  const state = reporting.report({ todoId: 't1', version: 1, messageId: msg.id });
  assert.equal(state.version, 2);
  assert.equal(state.report?.contentHash, createHash('sha256').update(msg.text).digest('hex'));
  assert.equal(state.report?.messageId, msg.id);
  assert.deepEqual(store.get('todo.reporting.reports', state.report!.id), state.report);
  reporting.assertCanComplete('t1');
  assert.throws(() => reporting.report({ todoId: 't1', version: 1, messageId: msg.id }), /版本/);
  assert.equal(events.since(0).at(-1)?.type, 'todo.reporting.reported');
  state.report!.contentHash = 'caller modification';
  reporting.assertCanComplete('t1');
});

test('rejects missing, non-assistant, pending, blank and incorrectly scoped messages', t => {
  const { reporting, message, store } = fixture(t);
  reporting.configure({ todoId: 't1', required: true });
  for (const patch of [{ role: 'user' }, { status: 'pending' }, { status: 'failed' },
    { status: undefined }, { text: ' \n ' }, { todoId: 'other' }, { projectId: 'other' }, { projectId: undefined }] as Partial<Message>[]) {
    message(patch);
    assert.throws(() => reporting.report({ todoId: 't1', version: 1, messageId: 'm1' }), /无效/);
  }
  store.remove('messages', 'm1');
  assert.throws(() => reporting.report({ todoId: 't1', version: 1, messageId: 'm1' }), /不存在/);
  assert.throws(() => reporting.report({ todoId: 't1', version: 1 }), /真实/);
  assert.equal(reporting.get('t1').version, 1);
  assert.equal(store.list('todo.reporting.reports').length, 0);
});

test('completion rereads message body, role, status and ownership', t => {
  const { reporting, message, store } = fixture(t);
  const original = message();
  reporting.configure({ todoId: 't1', required: true });
  reporting.report({ todoId: 't1', version: 1, messageId: 'm1' });
  for (const patch of [{ text: '替换结果' }, { role: 'user' }, { status: 'failed' },
    { todoId: 'other' }, { projectId: 'other' }, { conversationId: 'other' }] as Partial<Message>[]) {
    message({ ...original, ...patch });
    assert.throws(() => reporting.assertCanComplete('t1'));
  }
  store.remove('messages', 'm1');
  assert.throws(() => reporting.assertCanComplete('t1'), /不存在/);
  message(original);
  reporting.assertCanComplete('t1');
});

test('local reply and caller supplied delivered flag never prove remote delivery', t => {
  const { reporting, message } = fixture(t);
  message();
  reporting.configure({ todoId: 't1', required: true, requireDelivery: true });
  const malicious = { todoId: 't1', version: 1, messageId: 'm1', delivered: true, text: '已送达' };
  reporting.report(malicious);
  assert.throws(() => reporting.assertCanComplete('t1'), /sent/);
});

test('only sent delivery satisfies requirement; unknown is never changed or retried', t => {
  const { reporting, outbox, store } = fixture(t);
  outbox();
  reporting.configure({ todoId: 't1', required: true, requireDelivery: true });
  reporting.report({ todoId: 't1', version: 1, outboxId: 'o1' });
  for (const status of ['queued', 'failed', 'unknown', 'sending', 'held', 'needs_approval', 'expired', 'cancelled'] as const) {
    const record = outbox({ status });
    assert.throws(() => reporting.assertCanComplete('t1'), /sent/);
    assert.deepEqual(store.get('outbox.items', 'o1'), record);
  }
  outbox({ status: 'sent' });
  reporting.assertCanComplete('t1');
});

test('outbox must have a real Todo reference or a matching scoped Message reference', t => {
  const { reporting, outbox, message } = fixture(t);
  message();
  reporting.configure({ todoId: 't1', required: true, requireDelivery: true });
  for (const relatedTo of [undefined, { kind: 'todo', id: 'other' }, { kind: 'message', id: 'other' }]) {
    outbox({ status: 'sent', relatedTo });
    assert.throws(() => reporting.report({ todoId: 't1', version: 1, messageId: 'm1', outboxId: 'o1' }), /不匹配/);
  }
  outbox({ status: 'sent', relatedTo: { kind: 'message', id: 'm1' } });
  assert.throws(() => reporting.report({ todoId: 't1', version: 1, outboxId: 'o1' }), /不匹配/);
  reporting.report({ todoId: 't1', version: 1, messageId: 'm1', outboxId: 'o1' });
  reporting.assertCanComplete('t1');
});

test('delivery body must exactly match Message and later outbox changes invalidate evidence', t => {
  const { reporting, message, outbox, store } = fixture(t);
  message();
  reporting.configure({ todoId: 't1', required: true, requireDelivery: true });
  outbox({ status: 'sent', content: { text: '另一份内容' } });
  assert.throws(() => reporting.report({ todoId: 't1', version: 1, messageId: 'm1', outboxId: 'o1' }), /不匹配/);
  const original = outbox({ status: 'sent' });
  reporting.report({ todoId: 't1', version: 1, messageId: 'm1', outboxId: 'o1' });
  for (const patch of [{ content: { text: '被替换' } }, { relatedTo: { kind: 'todo', id: 'other' } },
    { target: 'other' }, { owner: 'other' }, { version: 2 }, { contentHash: 'changed' }] as Partial<OutboxItem>[]) {
    outbox({ ...original, ...patch });
    assert.throws(() => reporting.assertCanComplete('t1'));
  }
  store.remove('outbox.items', 'o1');
  assert.throws(() => reporting.assertCanComplete('t1'), /不存在/);
});

test('reopen increments cycle and version atomically and rejects all old-cycle evidence', t => {
  const { reporting, message, outbox, store } = fixture(t);
  message(); outbox({ status: 'sent' });
  reporting.configure({ todoId: 't1', required: true });
  reporting.report({ todoId: 't1', version: 1, messageId: 'm1' });
  assert.throws(() => store.transaction(() => { reporting.onReopen('t1'); throw new Error('rollback'); }), /rollback/);
  reporting.assertCanComplete('t1');
  const next = store.transaction(() => reporting.onReopen('t1'));
  assert.equal(next.cycle, 2); assert.equal(next.version, 3); assert.equal(next.report, undefined);
  assert.throws(() => reporting.assertCanComplete('t1'), /尚未/);
  assert.throws(() => reporting.report({ todoId: 't1', version: 2, messageId: 'm1' }), /版本/);
  assert.throws(() => reporting.report({ todoId: 't1', version: 3, messageId: 'm1' }), /旧周期/);
  assert.throws(() => reporting.report({ todoId: 't1', version: 3, outboxId: 'o1' }), /旧周期/);
  const newTime = new Date(Date.parse(next.cycleStartedAt!) + 1).toISOString();
  message({ id: 'm2', createdAt: newTime });
  reporting.report({ todoId: 't1', version: 3, messageId: 'm2' });
  reporting.assertCanComplete('t1');
  assert.equal(store.list('todo.reporting.reports').length, 2);
});

test('configuration changes require a new report and project moves invalidate previous evidence', t => {
  const { reporting, message, store, todo } = fixture(t);
  message();
  reporting.configure({ todoId: 't1', required: true });
  reporting.report({ todoId: 't1', version: 1, messageId: 'm1' });
  reporting.configure({ todoId: 't1', required: true, version: 2 });
  assert.throws(() => reporting.assertCanComplete('t1'), /尚未/);
  reporting.report({ todoId: 't1', version: 3, messageId: 'm1' });
  store.put('todos', todo.id, { ...todo, projectId: 'p2' });
  assert.throws(() => reporting.assertCanComplete('t1'), /归属/);
});

test('rules, reports and cycles survive closing and reopening SQLite', t => {
  const f = fixture(t);
  f.message(); f.reporting.configure({ todoId: 't1', required: true });
  f.reporting.report({ todoId: 't1', version: 1, messageId: 'm1' });
  f.store.close();
  const reopened = createStore(f.path);
  try {
    const reporting = createTodoReporting({ store: reopened, events: createEventBus(reopened) });
    reporting.assertCanComplete('t1');
    assert.equal(reporting.get('t1').version, 2);
    reporting.onReopen('t1');
    const anotherInstance = createTodoReporting({ store: reopened, events: createEventBus(reopened) });
    assert.equal(anotherInstance.get('t1').cycle, 2);
    assert.throws(() => anotherInstance.assertCanComplete('t1'), /尚未/);
  } finally { reopened.close(); }
});

test('real outbox service with local fake sender advances recorded queued evidence to sent', async t => {
  const { store, events, reporting } = fixture(t);
  const box = createEventbox({ store, events }), effects = createEffects({ store, events });
  const outbox = createOutbox({ store, effects, eventbox: box, propose: () => { throw new Error('unexpected approval'); } });
  let calls = 0;
  outbox.registerChannel('feishu.bot', async (_target, text) => { assert.equal(text, '真实发件本地验证'); calls++; }, () => 'local-test-owner');
  outbox.grant('report-test', 'feishu.bot', true);
  try {
    const queued = outbox.enqueue('report-test', { dedupKey: 'test-delivery', channel: 'feishu.bot',
      target: 'owner', content: { text: '真实发件本地验证' }, relatedTo: { kind: 'todo', id: 't1' } });
    reporting.configure({ todoId: 't1', required: true, requireDelivery: true });
    reporting.report({ todoId: 't1', version: 1, outboxId: queued.id });
    assert.throws(() => reporting.assertCanComplete('t1'), /sent/);
    await outbox.send(queued.id);
    reporting.assertCanComplete('t1');
    assert.equal(calls, 1);
  } finally { await outbox.close(); await effects.close(); await box.close(); }
});

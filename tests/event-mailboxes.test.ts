import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createEventMailboxes } from '../packages/core/src/event-mailboxes.ts';
import type { BotScope, MailboxEntry } from '../packages/protocol/src/index.ts';

function fixture(t: test.TestContext) {
  const store = createStore(':memory:');
  const events = createEventBus(store);
  const mailboxes = createEventMailboxes({ store, events });
  t.after(async () => { await mailboxes.close(); store.close(); });
  return { store, events, mailboxes };
}
function input(scope: BotScope = { kind: 'global' }) {
  return { botId: 'bot-a', direction: 'inbox' as const, eventKey: 'message-1', scope, title: '需要处理', text: '整理项目资料' };
}

test('inbox confirmation is version-bound, deduplicated and claimed before dispatch', async t => {
  const { mailboxes } = fixture(t);
  let calls = 0;
  let release!: () => void;
  mailboxes.setHandlers({ inbox: async () => { calls++; await new Promise<void>(resolve => release = resolve); return { id: 'accepted-input' }; } });
  const first = mailboxes.put(input());
  assert.equal(first.status, 'pending');
  assert.deepEqual(mailboxes.put(input()), first);
  await assert.rejects(mailboxes.process(first.id, first.version), /确认/);
  const pending = mailboxes.confirm(first.id, first.version);
  await assert.rejects(mailboxes.confirm(first.id, first.version), /已更新/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); release();
  const completed = await pending;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.resultId, 'accepted-input');
  assert.equal((await mailboxes.process(first.id)).status, 'completed');
  assert.equal(calls, 1);
});

test('unmarked mail never runs until explicitly assigned and confirmed', async t => {
  const { mailboxes, store } = fixture(t);
  let actual: MailboxEntry | undefined;
  mailboxes.setHandlers({ inbox: async entry => { actual = entry; } });
  const first = mailboxes.put({ ...input({ kind: 'unmarked' }), requiresConfirmation: false });
  assert.equal(first.status, 'pending');
  await assert.rejects(mailboxes.confirm(first.id, first.version), /分配/);
  store.put('projects', 'p1', { id: 'p1', name: 'Project One' });
  const assigned = mailboxes.assign(first.id, first.version, { kind: 'project', projectId: 'p1' });
  assert.equal(assigned.version, first.version + 1);
  assert.equal(assigned.status, 'pending');
  await assert.rejects(mailboxes.confirm(first.id, first.version), /已更新/);
  await mailboxes.confirm(assigned.id, assigned.version);
  assert.deepEqual(actual?.scope, { kind: 'project', projectId: 'p1' });
});

test('outbox drafts require confirmation; uncertain sends are not replayed', async t => {
  const { mailboxes } = fixture(t); let calls = 0;
  mailboxes.setHandlers({ outbox: async () => { calls++; throw new Error('network stopped after request'); } });
  const entry = mailboxes.put({ ...input(), direction: 'outbox', target: 'paired-chat' });
  assert.equal(calls, 0);
  const result = await mailboxes.confirm(entry.id, entry.version);
  assert.equal(result.status, 'unknown');
  await assert.rejects(mailboxes.confirm(result.id, result.version), /已经处理/);
  await assert.rejects(mailboxes.process(result.id), /确认/);
  assert.equal(calls, 1);
});

test('global and unmarked mail remain separate, project/task filters use stored ownership', async t => {
  const { store, mailboxes } = fixture(t);
  store.put('projects', 'p1', { id: 'p1', name: 'Project One' });
  store.put('todos', 't1', { id: 't1', projectId: 'p1' });
  for (const [key, scope] of [['a', { kind: 'global' }], ['b', { kind: 'unmarked' }], ['c', { kind: 'project', projectId: 'p1' }], ['d', { kind: 'task', todoId: 't1' }]] as const) {
    mailboxes.put({ ...input(scope), eventKey: key });
  }
  assert.equal(mailboxes.list({ scope: 'global' }).length, 1);
  assert.equal(mailboxes.list({ scope: 'unmarked' }).length, 1);
  assert.equal(mailboxes.list({ projectId: 'p1' }).length, 2);
  assert.equal(mailboxes.list({ todoId: 't1' }).length, 1);
  assert.throws(() => mailboxes.put({ ...input({ kind: 'task', todoId: 't1', projectId: 'p-other' }), eventKey: 'bad' }), /不属于/);
});

test('restart marks an in-flight action unknown and does not dispatch it again', async () => {
  const store = createStore(':memory:'); const events = createEventBus(store);
  store.put('event.mailboxes', 'in-flight', { ...input(), id: 'in-flight', version: 2, status: 'processing', requiresConfirmation: true, createdAt: '', updatedAt: '' });
  const mailboxes = createEventMailboxes({ store, events });
  try {
    assert.equal(mailboxes.get('in-flight').status, 'unknown');
    await assert.rejects(mailboxes.process('in-flight'), /确认/);
  } finally { await mailboxes.close(); store.close(); }
});

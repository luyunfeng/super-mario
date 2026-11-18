import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createSupervision } from '../packages/core/src/supervision.ts';
import { createWaitingReplies } from '../packages/core/src/waiting-replies.ts';
import type { EventBus } from '../packages/plugin-sdk/src/index.ts';
import type { Todo } from '../packages/protocol/src/index.ts';
import type { ArmWaitingReply, NormalizedReplyEvidence } from '../packages/protocol/src/waiting-replies.ts';

const at = (seconds: number) => new Date(Date.parse('2026-11-17T00:00:00Z') + seconds * 1000).toISOString();
const anchor: NormalizedReplyEvidence = {
  source: 'feishu:account-a', chatId: 'chat', messageId: 'anchor', senderId: 'me', senderIdType: 'open_id', createdAt: at(0), threadId: 'thread',
};
const input: ArmWaitingReply = { todoId: 'todo', key: 'request-1', anchor, expectedSenderId: 'other', expectedSenderIdType: 'open_id' };
const reply: NormalizedReplyEvidence = { ...anchor, messageId: 'reply', senderId: 'other', parentId: 'anchor', createdAt: at(20) };

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'mario-waiting-replies-'));
  const path = join(dir, 'data.sqlite');
  let store = createStore(path);
  let events = createEventBus(store);
  let time = 10;
  const now = () => new Date(at(time));
  let service = createWaitingReplies({ store, events, now });
  const todo: Todo = { id: 'todo', title: '请回复', notes: '保留备注', projectId: 'project',
    dueAt: at(900), waitingOn: '同事', reminderAt: at(5), createdAt: at(0), updatedAt: at(0) };
  store.put('todos', todo.id, todo);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get store() { return store; }, get events() { return events; }, get service() { return service; }, todo, now,
    advance(seconds = 30) { time = seconds; },
    restart() {
      store.close(); store = createStore(path); events = createEventBus(store);
      service = createWaitingReplies({ store, events, now });
    },
  };
}

test('direct reply stops real SQLite Todo reminders without completing or changing unrelated fields', t => {
  const f = fixture(t);
  const supervision = createSupervision({ store: f.store, events: f.events, now: f.now });
  t.after(() => supervision.close());
  const wait = f.service.arm({ ...input, scope: { projectId: 'forged' } } as ArmWaitingReply);
  assert.deepEqual(wait.scope, { projectId: 'project' });
  assert.deepEqual(f.store.get('todos', 'todo'), f.todo); // arm does not send or change manual reminders
  supervision.tick();
  assert.ok(f.store.get<Todo>('todos', 'todo')!.remindedAt);
  f.advance();
  const result = f.service.consume(reply);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].hit!.reason, 'direct_reply');
  assert.deepEqual(result.matched[0].hit!.evidence, reply);
  const { waitingOn: _, reminderAt: __, ...unchanged } = f.todo;
  assert.deepEqual(f.store.get('todos', 'todo'), { ...unchanged, reminderVersion: 2, updatedAt: at(30) });
  assert.equal(f.store.get<Todo>('todos', 'todo')!.completedAt, undefined);
  supervision.tick();
  assert.ok(supervision.signals().every(s => s.resolvedAt));
  assert.equal(f.events.since(0).filter(e => e.type === 'todos.changed').length, 1);
});

test('same group, same thread and nearby time cannot substitute for a direct parent', t => {
  const f = fixture(t); f.service.arm(input); f.advance();
  for (const [messageId, patch] of [
    ['group-only', { parentId: undefined, threadId: undefined }],
    ['thread-only', { parentId: undefined, rootId: anchor.messageId }],
    ['wrong-parent', { parentId: 'different', createdAt: at(11) }],
  ] as const) assert.equal(f.service.consume({ ...reply, ...patch, messageId }).matched.length, 0);
  assert.equal(f.service.get('todo')!.status, 'waiting');
  assert.deepEqual(f.store.get('todos', 'todo'), f.todo);
});

test('account, conversation, sender id and id type isolate matching, regardless of display names', t => {
  const f = fixture(t); f.service.arm(input); f.advance();
  for (const [index, patch] of [{ source: 'feishu:account-b' }, { chatId: 'elsewhere' }, { senderId: 'impostor' }, { senderIdType: 'user_id' }].entries()) {
    const candidate = { ...reply, ...patch, messageId: `isolated-${index}`, senderName: '同事' };
    assert.equal(f.service.consume(candidate).matched.length, 0);
  }
  assert.deepEqual(f.store.get('todos', 'todo'), f.todo);
  assert.equal(f.service.consume(reply).matched.length, 1);
});

test('edits, deletions and messages at or before anchor/start are not fresh replies', t => {
  const f = fixture(t); f.service.arm(input); f.advance();
  for (const [index, patch] of [{ edited: true }, { deleted: true }, { createdAt: at(0) }, { createdAt: at(10) }, { createdAt: at(9) }, { createdAt: at(31) }].entries()) {
    assert.equal(f.service.consume({ ...reply, ...patch, messageId: `reject-${index}` }).matched.length, 0);
  }
  assert.deepEqual(f.store.get('todos', 'todo'), f.todo);
  assert.equal(f.service.consume({ ...reply, messageId: 'reject-0' }).duplicate, true);
  assert.equal(f.service.consume(reply).matched.length, 1);
});

test('arm and consumption are durable and idempotent across SQLite reopen', t => {
  const f = fixture(t);
  const first = f.service.arm(input);
  f.advance(); f.restart();
  assert.deepEqual(f.service.arm(input), first);
  assert.equal(f.service.list('todo').length, 1);
  assert.equal(f.service.consume(reply).matched.length, 1);
  const hit = f.service.get('todo');
  f.restart();
  assert.deepEqual(f.service.get('todo'), hit);
  assert.deepEqual(f.service.consume(reply), { duplicate: true, matched: [] });
  assert.deepEqual(f.service.arm(input), hit);
  assert.equal(f.events.since(0).filter(e => e.type === 'todos.changed').length, 1);
});

test('new cycle supersedes old wait; delayed old anchor replies cannot stop it', t => {
  const f = fixture(t); f.service.arm(input); f.advance(30);
  assert.throws(() => f.service.arm({ ...input, key: 'new-key' }), /fresh anchor/);
  assert.throws(() => f.service.arm({ ...input, expectedSenderId: 'changed' }), /different input/);
  const second = f.service.arm({ ...input, key: 'request-2', anchor: { ...anchor, messageId: 'anchor-2', createdAt: at(25) } });
  assert.equal(second.cycle, 2);
  assert.equal(f.service.list('todo')[0].status, 'superseded');
  f.advance(50);
  assert.equal(f.service.consume({ ...reply, createdAt: at(40) }).matched.length, 0);
  assert.equal(f.service.consume({ ...reply, messageId: 'reply-2', parentId: 'anchor-2', createdAt: at(40) }).matched.length, 1);
  // Reopen the Todo after a successful hit. Historical duplicates stay harmless.
  f.store.put('todos', 'todo', { ...f.todo, reminderAt: at(90) });
  const third = f.service.arm({ ...input, key: 'request-3', anchor: { ...anchor, messageId: 'anchor-3', createdAt: at(45) } });
  assert.equal(third.cycle, 3);
  f.advance(80);
  assert.equal(f.service.consume(reply).duplicate, true);
  assert.equal(f.service.consume({ ...reply, messageId: 'late-old', createdAt: at(70) }).matched.length, 0);
  assert.equal(f.store.get<Todo>('todos', 'todo')!.reminderAt, at(90));
  assert.equal(f.service.consume({ ...reply, messageId: 'reply-3', parentId: 'anchor-3', createdAt: at(70) }).matched.length, 1);
});

test('manual waiting/reminder/scope change or completion invalidates the old snapshot', t => {
  const f = fixture(t);
  for (const [index, patch] of [{ waitingOn: '换人' }, { reminderAt: at(100) }, { projectId: 'other-project' }, { completedAt: at(25) }].entries()) {
    const todoId = `manual-${index}`;
    const todo = { ...f.todo, id: todoId };
    f.store.put('todos', todoId, todo);
    f.service.arm({ ...input, todoId });
    const changed = { ...todo, ...patch, updatedAt: at(25) };
    f.store.put('todos', todoId, changed);
    f.advance();
    assert.equal(f.service.consume({ ...reply, messageId: `reply-${index}`, createdAt: at(30) }).matched.length, 0);
    assert.deepEqual(f.store.get('todos', todoId), changed);
    assert.equal(f.service.get(todoId)!.status, 'invalidated');
  }
});

test('manual reminders without explicit arm are preserved; invalid or missing Todo cannot arm', t => {
  const f = fixture(t); f.advance();
  assert.equal(f.service.consume(reply).matched.length, 0);
  assert.deepEqual(f.store.get('todos', 'todo'), f.todo);
  for (const patch of [{ waitingOn: undefined }, { reminderAt: undefined }, { completedAt: at(1) }, { reminderAt: 'invalid' }]) {
    f.store.put('todos', 'todo', { ...f.todo, ...patch });
    assert.throws(() => f.service.arm(input));
  }
  assert.throws(() => f.service.arm({ ...input, todoId: 'missing' }), /does not exist/);
  assert.equal(f.service.list('todo').length, 0);
});

test('event persistence failure rolls back Todo, wait, evidence and event cursor atomically', t => {
  const f = fixture(t); f.service.arm(input); f.advance();
  const before = f.service.get('todo');
  const brokenEvents: EventBus = { ...f.events, publish(type, data) { f.events.publish(type, data); throw new Error('event failure'); } };
  const broken = createWaitingReplies({ store: f.store, events: brokenEvents, now: f.now });
  assert.throws(() => broken.consume(reply), /event failure/);
  assert.deepEqual(f.store.get('todos', 'todo'), f.todo);
  assert.deepEqual(f.service.get('todo'), before);
  assert.deepEqual(f.events.since(0), []);
  assert.equal(f.service.consume(reply).matched.length, 1); // evidence insert also rolled back
  assert.equal(f.events.since(0)[0].id, 1);
});

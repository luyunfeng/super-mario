import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { referenceCurrent } from '../packages/core/src/eventbox.ts';
import type { Todo } from '../packages/protocol/src/index.ts';

// Independent review: local SQLite + demo runtime only; no real channel or model.
async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-reply-review-'));
  const app = await createWorkbench({ dataDir, host: '127.0.0.1', port: 0, demo: true });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const source = 'feishu:review-app:review-account';
  const base = { source, chatId: 'chat', senderIdType: 'open_id', createdAt: new Date(Date.now() - 60000).toISOString() };
  app.waitingReplies.observeSource(source, [
    { ...base, messageId: 'ask', senderId: 'me' },
    { ...base, messageId: 'person-history', senderId: 'person' },
  ]);
  const todo = app.createTodo({ title: '等待', waitingOn: '对方', reminderAt: new Date(Date.now() + 60000).toISOString() });
  const anchor = app.waitingReplies.sources(todo.id).items.find(row => row.messageId === 'ask')!;
  const arm = () => app.waitingReplies.arm(todo.id, { key: 'cycle', anchorId: anchor.id, expectedSenderId: 'person', expectedSenderIdType: 'open_id' });
  const reply = async () => {
    await delay(5);
    return app.waitingReplies.observeSource(source, [{ ...base, messageId: 'answer', senderId: 'person', parentId: 'ask', createdAt: new Date().toISOString() }]);
  };
  function failNextEvent() {
    const put = app.store.put.bind(app.store);
    app.store.put = (collection, id, value) => {
      if (collection === 'core.events') {
        app.store.put = put;
        throw new Error('review: event persistence failed');
      }
      put(collection, id, value);
    };
  }
  return { app, todo, arm, reply, failNextEvent };
}

test('review: failed arm event must roll back the newly armed waiting cycle', async t => {
  const f = await fixture(t);
  f.failNextEvent();
  assert.throws(f.arm, /event persistence failed/);
  assert.equal(f.app.waitingReplies.get(f.todo.id), null, 'failed arm left a durable active wait without its event');
  const first = f.arm();
  const cursor = f.app.events.since(0).at(-1)!.id;
  f.failNextEvent();
  assert.deepEqual(f.arm(), first, 'duplicate key must not re-arm or publish');
  assert.deepEqual(f.app.events.since(cursor), []);
  // Consume the unused fault to avoid leaking it into shutdown.
  assert.throws(() => f.app.events.publish('review.fault', {}), /event persistence failed/);
});

test('review: manual waiting change with event failure must not revive the old cycle after restore', async t => {
  const f = await fixture(t);
  f.arm();
  const before = f.app.store.get('todos', f.todo.id);
  const wait = f.app.waitingReplies.get(f.todo.id);
  const cursor = f.app.events.since(0).at(-1)!.id;
  f.failNextEvent();
  assert.throws(() => f.app.updateTodo(f.todo.id, { waitingOn: '另一个人' }), /event persistence failed/);
  assert.deepEqual(f.app.store.get('todos', f.todo.id), before);
  assert.deepEqual(f.app.waitingReplies.get(f.todo.id), wait);
  assert.deepEqual(f.app.events.since(cursor), []);
  const put = f.app.store.put.bind(f.app.store);
  f.app.store.put = (collection, id, value) => {
    if (collection === 'todo.waiting-replies') {
      f.app.store.put = put;
      throw new Error('review: invalidation persistence failed');
    }
    put(collection, id, value);
  };
  assert.throws(() => f.app.updateTodo(f.todo.id, { waitingOn: '另一个人' }), /invalidation persistence failed/);
  assert.deepEqual(f.app.store.get('todos', f.todo.id), before);
  assert.deepEqual(f.app.waitingReplies.get(f.todo.id), wait);
  assert.deepEqual(f.app.events.since(cursor), []);
  const unchanged = f.app.updateTodo(f.todo.id, { title: '新标题', notes: '新备注', waitingOn: f.todo.waitingOn, reminderAt: f.todo.reminderAt, reminderVersion: 999 });
  assert.equal(unchanged.reminderVersion, 1, 'clients cannot assign the generation');
  assert.equal(f.app.waitingReplies.get(f.todo.id)!.status, 'waiting');
  f.app.updateTodo(f.todo.id, { waitingOn: '另一个人' });
  assert.equal(f.app.waitingReplies.get(f.todo.id)!.status, 'invalidated');
  const restored = f.app.updateTodo(f.todo.id, { waitingOn: '对方' });
  assert.equal(restored.reminderVersion, 3);
  assert.equal((await f.reply()).matched, 0, 'old-cycle reply cleared the restored manual wait');
});

test('review: restoring the same reminder time must not resurrect a notification from a matched cycle', async t => {
  const f = await fixture(t);
  f.arm();
  const staleIf = { ref: 'reminder:' + JSON.stringify([f.todo.id, f.todo.reminderAt]), version: 1 };
  const queued = f.app.background.outbox.enqueue('reminders', {
    dedupKey: 'review-old-cycle', channel: 'feishu.bot', target: 'owner', content: { text: 'old reminder' }, staleIf,
  });
  assert.equal((await f.reply()).matched, 1);
  assert.equal(referenceCurrent(f.app.store, staleIf), false);
  f.app.updateTodo(f.todo.id, { waitingOn: '重新等待', reminderAt: f.todo.reminderAt });
  let localSends = 0;
  f.app.background.outbox.registerChannel('feishu.bot', async () => { localSends++; }, () => 'offline-owner');
  f.app.background.outbox.grant('reminders', 'feishu.bot', true);
  const result = await f.app.background.outbox.send(queued.id);
  assert.equal(result.status, 'cancelled', `old queued notification became eligible again; local fake channel calls: ${localSends}`);
  assert.equal(localSends, 0);
  assert.equal(f.app.store.get<Todo>('todos', f.todo.id)!.reminderVersion, 3);
  // Generate a real core reminder in a later generation, then restore the same
  // due timestamp again. Each generation must get its own durable event.
  const due = new Date(Date.now() - 1000).toISOString();
  const current = f.app.updateTodo(f.todo.id, { reminderAt: due });
  f.app.supervision.tick();
  const reminders = () => f.app.background.eventbox.events().filter(event => event.type === 'todo.reminder_due' && (event.data as { todoId?: string }).todoId === f.todo.id);
  const first = reminders().at(-1)!;
  assert.equal(first.staleIf!.version, current.reminderVersion);
  assert.equal(referenceCurrent(f.app.store, first.staleIf), true);
  f.app.updateTodo(f.todo.id, { waitingOn: '又一轮', reminderVersion: 999 });
  f.app.supervision.tick();
  assert.equal(reminders().length, 2);
  const fresh = reminders().find(event => event.id !== first.id)!;
  assert.equal(fresh.staleIf!.version, current.reminderVersion! + 1);
  assert.equal(referenceCurrent(f.app.store, first.staleIf), false);
  assert.equal(referenceCurrent(f.app.store, fresh.staleIf), true);
});

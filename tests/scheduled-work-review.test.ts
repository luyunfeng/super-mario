import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createEventbox } from '../packages/core/src/eventbox.ts';
import { createSchedules } from '../packages/core/src/schedules.ts';
import { createApprovalService } from '../packages/core/src/approvals.ts';
import { createScheduledWork, scheduledWorkApprovalKind } from '../packages/core/src/scheduled-work.ts';
import type { Approval, Json, Message } from '../packages/protocol/src/index.ts';
import type { ScheduledWorkInput, ScheduledWorkOccurrence } from '../packages/protocol/src/scheduled-work.ts';

const dispatch: ScheduledWorkInput['action'] = { kind: 'dispatch', executorId: 'fake', prompt: 'check', doneWhen: 'report', expectMinutes: 1 };
function fixture(t: test.TestContext, options: {
  authorize?: Parameters<typeof createScheduledWork>[0]['authorize'];
  brief?: Parameters<typeof createScheduledWork>[0]['brief'];
} = {}) {
  const store = createStore(':memory:');
  const events = createEventBus(store);
  let time = Date.parse('2026-01-01T00:00:00Z');
  const eventbox = createEventbox({ store, events, now: () => time });
  const schedules = createSchedules({ store, eventbox, now: () => time });
  const approvals = createApprovalService({ store, events, execute: async a => {
    if (a.kind === scheduledWorkApprovalKind) return work.approveCreation(a);
    work.assertDispatchCurrent(a);
    return { runId: 'fake-run' };
  } });
  let calls = 0;
  const work = createScheduledWork({ store, events, schedules, proposeApproval: a => approvals.propose(a), enabled: () => true,
    authorize: options.authorize ?? (() => true), brief: options.brief ?? (() => { calls++; return { text: 'facts' }; }),
  });
  store.put<Message>('messages', 'u', { id: 'u', role: 'user', origin: 'user', conversationId: 'main', text: 'original instruction', createdAt: '2026-01-01T00:00:00Z', status: 'pending' });
  function propose(patch: Partial<ScheduledWorkInput> = {}) {
    return work.propose({ key: 'review', title: 'review', schedule: { kind: 'interval', everySec: 60 }, action: { kind: 'brief' }, ...patch }, 'u');
  }
  async function activate(patch: Partial<ScheduledWorkInput> = {}) {
    const a = propose(patch);
    const done = await approvals.approve(a.id, a.version);
    assert.equal(done.status, 'completed', done.error);
    return done;
  }
  function due(minute: number) { time = Date.parse('2026-01-01T00:00:00Z') + minute * 60000; schedules.tick(); return eventbox.events()[0]; }
  function source(patch: Partial<Message>) { store.put('messages', 'u', { ...store.get<Message>('messages', 'u')!, ...patch }); }
  t.after(async () => { work.close(); await approvals.close(); schedules.close(); await eventbox.close(); store.close(); });
  return { store, events, eventbox, schedules, approvals, work, propose, activate, due, source, get calls() { return calls; } };
}

test('review: pending→done survives sync, creation approval and dispatch execution guards', async t => {
  const f = fixture(t);
  const a = f.propose({ action: dispatch });
  f.source({ status: 'done' });
  f.work.sync();
  assert.equal(f.work.list()[0].status, 'pending');
  assert.equal((await f.approvals.approve(a.id, a.version)).status, 'completed');
  f.work.sync();
  assert.equal(f.work.list()[0].status, 'active');
  assert.equal((await f.work.handle(f.due(1))).status, 'done');
  const next = f.approvals.list().find(a => a.kind === 'dispatch')!;
  assert.ok(f.work.assertDispatchCurrent(next));
  assert.equal((await f.approvals.approve(next.id, next.version)).status, 'completed');
});

test('review: content, identity and routing edits revoke both original and replacement previews', async t => {
  for (const patch of [{ text: 'rewrite' }, { conversationId: 'other' }, { projectId: 'other' }, { todoId: 'other' }, { origin: 'result' as const }, { readOnly: true }, { role: 'assistant' as const }]) {
    const f = fixture(t);
    const a = f.propose();
    f.source(patch);
    assert.throws(() => f.propose({ title: 'replacement' }), /来源/);
    assert.equal((await f.approvals.approve(a.id, a.version)).status, 'failed');
    assert.equal(f.schedules.list().length, 0);
  }
});

test('review: promise-returning authorize fails closed and rolls back all previews', t => {
  for (const authorize of [async () => false, () => Promise.resolve(false), () => Promise.reject(new Error('revoked'))]) {
    const f = fixture(t, { authorize: authorize as unknown as Parameters<typeof createScheduledWork>[0]['authorize'] });
    assert.throws(() => f.propose(), /同步/);
    assert.equal(f.approvals.list().length, 0);
    assert.equal(f.schedules.list().length, 0);
  }
});

test('review: invented earlier due with plausible sourceId cannot create an occurrence', async t => {
  const f = fixture(t); await f.activate();
  const e = f.due(10);
  const data = e.data as Record<string, Json>;
  const scheduledFor = '2026-01-01T00:03:13.000Z';
  const forged = { ...e, data: { ...data, scheduledFor }, sourceId: `schedule:${data.scheduleId}:v${data.scheduleVersion}:${scheduledFor}` };
  assert.equal((await f.work.handle(forged)).status, 'skip');
  assert.equal(f.calls, 0);
  assert.equal((await f.work.handle({ ...e, attempt: 1 } as typeof e)).status, 'done');
});

test('review: in-flight and unknown brief block later due and plan revisions', async t => {
  let release!: (value: Json) => void;
  let calls = 0;
  const f = fixture(t, { brief: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  await f.activate();
  const pending = f.work.handle(f.due(1));
  assert.equal((await f.work.handle(f.due(2))).status, 'skip');
  await f.activate({ title: 'new revision' });
  assert.equal((await f.work.handle(f.due(3))).status, 'skip');
  release({ text: 'late' });
  assert.equal((await pending).status, 'failed');
  assert.equal((await f.work.handle(f.due(4))).status, 'skip');
  assert.equal(calls, 1);
});

test('review: cancellation/close/archive/revocation during brief await prevents guarded message commit', async t => {
  for (const mode of ['cancel', 'close', 'archive', 'source'] as const) {
    let release!: () => void;
    const f = fixture(t, { brief: async input => {
      await new Promise<void>(resolve => { release = resolve; });
      input.assertCurrent();
      f.store.put('messages', 'late', { text: 'must not publish' });
      return { messageId: 'late' };
    } });
    f.store.put('projects', 'p', { id: 'p' });
    await f.activate({ projectId: 'p' });
    const pending = f.work.handle(f.due(1));
    if (mode === 'cancel') f.work.cancel(f.work.list()[0].id);
    if (mode === 'close') f.work.close();
    if (mode === 'archive') f.store.put('projects', 'p', { id: 'p', archivedAt: 'now' });
    if (mode === 'source') f.source({ text: 'changed' });
    release();
    assert.equal((await pending).status, 'failed');
    assert.equal(f.store.get('messages', 'late'), undefined);
    assert.equal(f.store.list<ScheduledWorkOccurrence>('scheduled-work.occurrences')[0].status, 'unknown');
  }
});

test('review: unguarded late brief return still cannot report successful completion', async t => {
  let release!: (value: Json) => void;
  const f = fixture(t, { brief: () => new Promise(resolve => { release = resolve; }) });
  await f.activate();
  const pending = f.work.handle(f.due(1));
  f.work.cancel(f.work.list()[0].id);
  release({ text: 'late' });
  assert.equal((await pending).status, 'failed');
  assert.equal(f.store.list<ScheduledWorkOccurrence>('scheduled-work.occurrences')[0].status, 'unknown');
});

test('review: expired or edited creation evidence cannot create schedule; unknown without schedule cannot activate', async t => {
  for (const status of ['expired', 'unknown'] as const) {
    const f = fixture(t); const a = f.propose();
    const changed = { ...a, status } as unknown as Approval;
    f.store.put('approvals', a.id, changed);
    assert.throws(() => f.work.approveCreation(changed));
    assert.equal(f.schedules.list().length, 0);
  }
  const f = fixture(t); const a = f.propose();
  const edited = f.approvals.edit(a.id, a.version, { title: 'edited' });
  assert.equal((await f.approvals.approve(edited.id, edited.version)).status, 'failed');
});

test('review: expired creation evidence invalidates active due and old dispatch approval', async t => {
  const f = fixture(t); const creation = await f.activate({ action: dispatch });
  await f.work.handle(f.due(1));
  const a = f.approvals.list().find(a => a.kind === 'dispatch')!;
  f.store.put('approvals', creation.id, { ...creation, status: 'expired' });
  assert.throws(() => f.work.assertDispatchCurrent(a));
  assert.equal((await f.work.handle(f.due(2))).status, 'skip');
  assert.equal((await f.approvals.approve(a.id, a.version)).status, 'failed');
});

test('review: unknown creation receipt with durable schedule remains usable without recreation', async t => {
  const f = fixture(t); const creation = await f.activate();
  f.store.put('approvals', creation.id, { ...creation, status: 'unknown' });
  assert.equal((await f.work.handle(f.due(1))).status, 'done');
  assert.equal(f.propose().status, 'unknown');
  assert.equal(f.schedules.list().length, 1);
});

test('review: active Run and unknown approval block dispatch even after plan revision', async t => {
  for (const mode of ['run', 'unknown', 'missing-run'] as const) {
    const f = fixture(t); await f.activate({ action: dispatch });
    await f.work.handle(f.due(1));
    const a = f.approvals.list().find(a => a.kind === 'dispatch')!;
    if (mode === 'unknown') f.store.put('approvals', a.id, { ...a, status: 'unknown' });
    else {
      f.store.put('approvals', a.id, { ...a, status: 'completed', result: { runId: 'prior-run' } });
      if (mode === 'run') f.store.put('runs', 'prior-run', { id: 'prior-run', status: 'running' });
    }
    await f.activate({ title: 'replacement', action: dispatch });
    assert.equal((await f.work.handle(f.due(2))).status, 'skip');
    assert.equal(f.approvals.list().filter(a => a.kind === 'dispatch').length, 1);
  }
});

test('review: changed original instruction cannot be laundered by a different key', t => {
  const f = fixture(t); f.propose();
  f.source({ text: 'rewritten instruction' });
  assert.throws(() => f.propose({ key: 'other' }), /来源/);
  assert.equal(f.approvals.list().length, 1);
});

test('review: closing before database shutdown leaves late callbacks safe', async t => {
  let release!: (value: Json) => void;
  const f = fixture(t, { brief: () => new Promise(resolve => { release = resolve; }) });
  await f.activate();
  const pending = f.work.handle(f.due(1));
  f.work.close();
  f.store.close();
  release({ text: 'late' });
  assert.equal((await pending).status, 'failed');
});

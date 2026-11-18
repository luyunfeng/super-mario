import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Approval, Json } from '../packages/protocol/src/index.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { ApprovalError, createApprovalService } from '../packages/core/src/approvals.ts';

const input = { kind: 'dispatch' as const, title: '执行检查', details: '确认后执行', params: { prompt: 'check', nested: { value: 1 } }, todoId: 'todo-1' };
function status(code: number) { return (error: unknown) => error instanceof ApprovalError && error.status === code; }
function deferred() {
  let resolve!: (value: Json) => void;
  const promise = new Promise<Json>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: { after(fn: () => Promise<void>): void }, execute: (item: Approval) => Promise<Json> = async () => ({ accepted: true })) {
  const dir = mkdtempSync(join(tmpdir(), 'super-mario-approvals-'));
  const path = join(dir, 'data.sqlite');
  const store = createStore(path);
  const events = createEventBus(store);
  const service = createApprovalService({ store, events, execute });
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, events, service, path };
}

test('first concurrent decision wins, executes its JSON snapshot once, accepted leaves todo untouched', async t => {
  const gate = deferred();
  let calls = 0;
  const f = fixture(t, async item => {
    calls++;
    assert.equal(item.params.prompt, 'check');
    item.params.prompt = 'executor mutation';
    return gate.promise;
  });
  f.store.put('todos', 'todo-1', { id: 'todo-1', title: 'still open' });
  const request = structuredClone(input);
  const item = f.service.propose(request);
  request.params.prompt = 'caller mutation';
  item.params.prompt = 'returned mutation';
  const job = f.service.approve(item.id, 1);
  assert.equal(f.service.list()[0].status, 'running');
  await assert.rejects(f.service.approve(item.id, 1), status(409));
  assert.throws(() => f.service.reject(item.id, 1), status(409));
  assert.throws(() => f.service.edit(item.id, 1, { title: 'late' }), status(409));
  assert.equal(calls, 1);
  gate.resolve({ accepted: true });
  const completed = await job;
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, { accepted: true });
  assert.equal(completed.params.prompt, 'check');
  assert.deepEqual(f.store.get('todos', 'todo-1'), { id: 'todo-1', title: 'still open' });
  await assert.rejects(f.service.approve(item.id, 1), status(409));
  assert.equal(calls, 1);
  assert.equal(f.events.since(0).filter(event => event.type === 'approvals.changed').length, 3);
});

test('edits increment version, reject stale cards, validate fields and preserve snapshots', async t => {
  const f = fixture(t);
  const item = f.service.propose(input);
  const patch = { title: 'edited', params: { text: 'new' } };
  const edited = f.service.edit(item.id, 1, patch);
  patch.params.text = 'mutated';
  assert.equal(edited.version, 2);
  assert.deepEqual(f.service.list()[0].params, { text: 'new' });
  assert.throws(() => f.service.edit(item.id, 1, { title: 'stale' }), status(409));
  await assert.rejects(f.service.approve(item.id, 1), status(409));
  assert.throws(() => f.service.reject(item.id, 1), status(409));
  assert.throws(() => f.service.edit(item.id, 2, { status: 'completed' } as never), status(400));
  assert.equal(f.service.list()[0].version, 2);
  assert.equal(f.service.reject(item.id, 2).status, 'rejected');
  await assert.rejects(f.service.approve(item.id, 2), status(409));
});

test('input validation and missing ids use explicit HTTP statuses without writes', async t => {
  const f = fixture(t);
  const invalid = [null, { ...input, kind: 'other' }, { ...input, title: '' }, { ...input, details: 1 },
    { ...input, todoId: '' }, { ...input, params: [] }, { ...input, params: { n: NaN } },
    { ...input, params: { missing: undefined } }, { ...input, params: { date: new Date() } }];
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  invalid.push({ ...input, params: cycle } as never);
  for (const value of invalid) assert.throws(() => f.service.propose(value as never), status(400));
  assert.deepEqual(f.service.list(), []);
  for (const version of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.service.approve('missing', version), status(400));
  }
  await assert.rejects(f.service.approve('missing', 1), status(404));
  assert.throws(() => f.service.edit('missing', 1, {}), status(404));
  assert.throws(() => f.service.reject('missing', 1), status(404));
  for (const kind of ['dispatch', 'input', 'feishu-reply'] as const) assert.equal(f.service.propose({ ...input, kind }).kind, kind);
});

test('failed and deliveryunknown actions persist terminal results and never retry', async t => {
  let calls = 0;
  const f = fixture(t, async item => {
    calls++;
    if (item.kind === 'dispatch') throw new Error('execution failed');
    throw Object.assign(new Error('delivery uncertain'), { deliveryunknown: true });
  });
  for (const kind of ['dispatch', 'feishu-reply'] as const) {
    const item = f.service.propose({ ...input, kind });
    const result = await f.service.approve(item.id, 1);
    assert.equal(result.status, kind === 'dispatch' ? 'failed' : 'unknown');
    assert.match(result.error!, /failed|uncertain/);
    await assert.rejects(f.service.approve(item.id, 1), status(409));
  }
  assert.equal(calls, 2);
});

test('restart marks persisted running unknown, preserves pending and terminal cards, never replays', async t => {
  const f = fixture(t);
  const running = f.service.propose(input);
  const pending = f.service.propose(input);
  const completed = await f.service.approve(f.service.propose(input).id, 1);
  f.store.put('approvals', running.id, { ...running, status: 'running' });
  await f.service.close();
  f.store.close();
  const store = createStore(f.path);
  let calls = 0;
  const restored = createApprovalService({ store, events: createEventBus(store), execute: async () => { calls++; return null; } });
  try {
    assert.equal(restored.list().find(item => item.id === running.id)?.status, 'unknown');
    assert.equal(restored.list().find(item => item.id === pending.id)?.status, 'pending');
    assert.deepEqual(restored.list().find(item => item.id === completed.id), completed);
    await assert.rejects(restored.approve(running.id, 1), status(409));
    assert.equal(calls, 0);
  } finally { await restored.close(); store.close(); }
});

test('close waits for started jobs, blocks every new mutation and remains idempotent', async t => {
  const gate = deferred();
  const f = fixture(t, () => gate.promise);
  const first = f.service.propose(input);
  const pending = f.service.propose(input);
  const job = f.service.approve(first.id, 1);
  let finished = false;
  const closing = f.service.close().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.throws(() => f.service.propose(input), status(503));
  assert.throws(() => f.service.edit(pending.id, 1, { title: 'closed' }), status(503));
  assert.throws(() => f.service.reject(pending.id, 1), status(503));
  await assert.rejects(f.service.approve(pending.id, 1), status(503));
  gate.resolve(null);
  await Promise.all([job, closing, f.service.close()]);
  assert.equal(finished, true);
  assert.equal(f.service.list().find(item => item.id === first.id)?.status, 'completed');
});

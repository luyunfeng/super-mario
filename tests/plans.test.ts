import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createPlans, PlansError } from '../packages/core/src/plans.ts';

const task = { prompt: '执行检查', doneWhen: '检查通过', expectMinutes: 5 };
const input = { title: '批量检查', tasks: [task] };
const status = (code: number) => (error: unknown) => error instanceof PlansError && error.status === code;
function fixture(t: { after(fn: () => void): void }, dispatch: (input: Record<string, unknown>, key?: string) => { id: string } = () => ({ id: 'run-1' })) {
  const dir = mkdtempSync(join(tmpdir(), 'super-mario-plans-'));
  const path = join(dir, 'data.sqlite');
  const store = createStore(path);
  const events = createEventBus(store);
  const plans = createPlans({ store, events, dispatch });
  t.after(() => { plans.close(); store.close(); rmSync(dir, { force: true, recursive: true }); });
  return { store, events, plans, path };
}

test('validates every task and the 1–8 limit before storing or dispatching', t => {
  let calls = 0;
  const { plans, events } = fixture(t, () => ({ id: String(++calls) }));
  const invalid: unknown[] = [null, [], { ...input, title: ' ' }, { ...input, tasks: [] },
    { ...input, tasks: Array(9).fill(task) }, { ...input, tasks: Array(2) }];
  for (const patch of [{ prompt: '' }, { doneWhen: ' ' }, { doneWhen: undefined },
    { expectMinutes: 0 }, { expectMinutes: -1 }, { expectMinutes: Infinity }, { expectMinutes: NaN },
    { expectMinutes: '5' }, { executorId: '' }, { cwd: 1 }, { projectId: '' }, { todoId: '' }, { executionMode: 'other' }]) {
    invalid.push({ ...input, tasks: [task, { ...task, ...patch }] });
  }
  for (const value of invalid) assert.throws(() => plans.propose(value as never), status(400));
  assert.deepEqual(plans.list(), []);
  assert.equal(events.since(0).length, 0);
  assert.equal(calls, 0);
  const eight = plans.propose({ ...input, tasks: Array(8).fill(task) });
  assert.equal(eight.status, 'pending');
  assert.equal(eight.version, 1);
  assert.equal(plans.start(eight.id, 1).tasks.length, 8);
  assert.equal(calls, 8);
});

test('simultaneous starts and reentrant observers dispatch only once with stable keys', async t => {
  const keys: string[] = [];
  const f = fixture(t, (request, key) => {
    keys.push(key!);
    assert.equal(f.plans.get(plan.id).status, 'running');
    assert.throws(() => f.plans.start(plan.id, 1), status(409));
    request.prompt = 'dispatch mutation';
    return { id: `run-${keys.length}` };
  });
  const request = { ...input, tasks: [{ ...task, executorId: 'demo', cwd: '/tmp', projectId: 'p', todoId: 't', executionMode: 'task' as const }, { ...task }] };
  const plan = f.plans.propose(request);
  request.tasks[0]!.prompt = 'caller mutation';
  plan.tasks[0]!.doneWhen = 'return mutation';
  f.store.put('todos', 't', { status: 'open' });
  f.events.subscribe(event => {
    if (event.type === 'plans.changed') assert.throws(() => f.plans.reject(plan.id, 1), status(409));
  });
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => Promise.resolve().then(() => f.plans.start(plan.id, 1))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') assert.ok(status(409)(result.reason));
  assert.deepEqual(keys, [`plan:${plan.id}:1:0`, `plan:${plan.id}:1:1`]);
  const saved = f.plans.get(plan.id);
  assert.equal(saved.status, 'started');
  assert.equal(saved.tasks[0]!.prompt, task.prompt);
  assert.equal(saved.tasks[0]!.doneWhen, task.doneWhen);
  assert.deepEqual(saved.tasks.map(task => task.runId), ['run-1', 'run-2']);
  assert.deepEqual(f.store.get('todos', 't'), { status: 'open' });
});

test('partial failure preserves receipts, records errors and cannot replay', t => {
  let calls = 0;
  const f = fixture(t, () => {
    calls++;
    if (calls === 2) throw new Error('执行机不可用');
    return { id: `run-${calls}` };
  });
  const plan = f.plans.propose({ ...input, tasks: [task, task, task] });
  const result = f.plans.start(plan.id, 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.tasks[0]!.runId, 'run-1');
  assert.equal(result.tasks[1]!.error, '执行机不可用');
  assert.equal(result.tasks[2]!.runId, 'run-3');
  assert.deepEqual(f.plans.get(plan.id), result);
  assert.throws(() => f.plans.start(plan.id, 1), status(409));
  assert.equal(calls, 3);
});

test('restart marks running unknown while retaining known receipts and never redispatches', t => {
  const f = fixture(t);
  const plan = f.plans.propose({ ...input, tasks: [task, task] });
  const pending = f.plans.propose(input);
  const started = f.plans.start(f.plans.propose(input).id, 1);
  f.store.put('plans', plan.id, { ...plan, status: 'running', tasks: [{ ...task, runId: 'saved-run' }, task] });
  f.plans.close();
  f.store.close();
  const store = createStore(f.path);
  let calls = 0;
  const restored = createPlans({ store, events: createEventBus(store), dispatch: () => ({ id: String(++calls) }) });
  try {
    assert.equal(restored.get(plan.id).status, 'unknown');
    assert.match(restored.get(plan.id).error!, /不自动重试/);
    assert.equal(restored.get(plan.id).tasks[0]!.runId, 'saved-run');
    assert.equal(restored.get(pending.id).status, 'pending');
    assert.deepEqual(restored.get(started.id), started);
    assert.throws(() => restored.start(plan.id, 1), status(409));
    assert.equal(calls, 0);
  } finally { restored.close(); store.close(); }
});

test('reject, stale versions, missing ids and close have explicit statuses', t => {
  const { plans } = fixture(t);
  const plan = plans.propose(input);
  assert.throws(() => plans.start(plan.id, 2), status(409));
  assert.throws(() => plans.reject(plan.id, 2), status(409));
  for (const version of [0, -1, 1.5, NaN]) assert.throws(() => plans.start(plan.id, version), status(400));
  assert.throws(() => plans.get('missing'), status(404));
  assert.throws(() => plans.start('missing', 1), status(404));
  assert.equal(plans.reject(plan.id, 1).status, 'rejected');
  assert.throws(() => plans.start(plan.id, 1), status(409));
  assert.throws(() => plans.reject(plan.id, 1), status(409));
  const pending = plans.propose(input);
  plans.close();
  plans.close();
  assert.throws(() => plans.propose(input), status(503));
  assert.throws(() => plans.start(pending.id, 1), status(503));
  assert.throws(() => plans.reject(pending.id, 1), status(503));
  assert.equal(plans.get(pending.id).status, 'pending');
  assert.equal(plans.list().length, 2);
});

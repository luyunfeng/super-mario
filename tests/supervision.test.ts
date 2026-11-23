import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createRunScopes } from '../packages/core/src/run-scope.ts';
import { createSupervision } from '../packages/core/src/supervision.ts';
import type { Approval, Run, Todo } from '../packages/protocol/src/index.ts';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'mario-supervision-'));
  const path = join(dir, 'data.sqlite');
  const store = createStore(path);
  const events = createEventBus(store);
  let time = Date.parse('2026-01-01T12:00:00Z');
  let enabled = true;
  const service = createSupervision({ store, events, now: () => new Date(time), enabled: () => enabled });
  t.after(() => { service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const old = new Date(time - 60 * 60000).toISOString();
  const todo: Todo = { id: 'todo', title: '测试待办', notes: '', createdAt: old, updatedAt: old, reminderAt: old };
  const run: Run = { id: 'run', executorId: 'fake', conversationId: 'c', prompt: 'fake', output: '', status: 'running', createdAt: old, updatedAt: old };
  return { store, events, service, path, old, todo, run, advance(ms: number) { time += ms; }, disable() { enabled = false; }, enable() { enabled = true; } };
}

test('SQLite reminder claim precedes publish, survives restart and permits no duplicate across services', t => {
  const f = fixture(t);
  f.store.put('todos', f.todo.id, f.todo);
  const second = createSupervision({ store: f.store, events: f.events });
  t.after(() => second.close());
  f.events.subscribe(() => {
    assert.ok(f.store.get<Todo>('todos', 'todo')?.remindedAt);
    second.tick();
  });
  f.service.tick();
  f.service.tick();
  assert.equal(f.events.since(0).length, 1);
  assert.equal(f.service.signals()[0].kind, 'reminder');
  f.service.close();
  f.store.close();
  const store = createStore(f.path);
  const events = createEventBus(store);
  const restarted = createSupervision({ store, events });
  try {
    restarted.tick();
    assert.equal(events.since(0).length, 1);
    assert.equal(restarted.signals().length, 1);
  } finally { restarted.close(); store.close(); }
});

test('run and approval signals resolve, reopen once and invalidate old versions', t => {
  const f = fixture(t);
  const approval: Approval = { id: 'approval', version: 1, title: '确认', details: '', kind: 'input', params: {}, status: 'pending', createdAt: f.old, updatedAt: f.old };
  f.store.put('runs', 'run', { ...f.run, machineId: 'machine' });
  f.store.put('machines', 'machine', { id: 'machine', online: false });
  f.store.put('approvals', approval.id, approval);
  f.service.tick();
  assert.deepEqual(f.service.signals().map(s => s.kind).sort(), ['needs_you', 'orphaned', 'stalled']);
  f.service.tick();
  assert.equal(f.events.since(0).length, 3);
  const stalledId = f.service.signals().find(s => s.kind === 'stalled')!.id;
  f.store.put('runs', 'run', { ...f.run, status: 'completed' });
  f.store.put('approvals', approval.id, { ...approval, status: 'completed' });
  f.service.tick();
  assert.equal(f.service.signals().filter(s => !s.resolvedAt).length, 1);
  assert.equal(f.service.signals().find(s => s.id === stalledId)?.resolvedAt !== undefined, true);
  f.store.put('runs', 'run', f.run);
  f.store.put('approvals', approval.id, { ...approval, version: 2 });
  f.advance(1000);
  f.service.tick();
  assert.equal(f.service.signals().find(s => s.id === stalledId)?.resolvedAt, undefined);
  const count = f.events.since(0).length;
  f.service.tick();
  assert.equal(f.events.since(0).length, count);
  f.store.put('runs', 'run', { ...f.run, status: 'failed', updatedAt: '2026-01-01T12:00:01Z' });
  f.service.tick();
  assert.ok(f.service.signals().some(s => s.kind === 'review' && !s.resolvedAt && s.text.includes('失败')));
});

test('configuration is validated atomically and persisted in SQLite', t => {
  const f = fixture(t);
  assert.deepEqual(f.service.settings(), { tickSeconds: 30, stalledMinutes: 20, stalledFactorOfEstimate: 1.5, needsYouMinutes: 3, remindersEnabled: true });
  f.service.configure({ tickSeconds: 5, stalledMinutes: 90, stalledFactorOfEstimate: 2.25, remindersEnabled: false });
  for (const patch of [{ tickSeconds: 0 }, { tickSeconds: 3601 }, { stalledMinutes: 43201 }, { needsYouMinutes: 0 },
    { stalledFactorOfEstimate: 0.99 }, { stalledFactorOfEstimate: 10.01 },
    { stalledFactorOfEstimate: NaN }, { stalledFactorOfEstimate: Infinity }, { stalledFactorOfEstimate: -Infinity },
    { stalledFactorOfEstimate: '2' }, { stalledFactorOfEstimate: null }, { stalledFactorOfEstimate: undefined },
    { stalledMinutes: 1.5 }, { needsYouMinutes: NaN }, { remindersEnabled: 'true' }, { bogus: 1 }, null]) {
    assert.throws(() => f.service.configure(patch as never), TypeError);
  }
  assert.equal(f.service.settings().stalledFactorOfEstimate, 2.25);
  const store = createStore(f.path);
  const restarted = createSupervision({ store, events: createEventBus(store) });
  try { assert.deepEqual(restarted.settings(), f.service.settings()); }
  finally { restarted.close(); store.close(); }
  f.store.put('runs', 'run', f.run);
  f.store.put('todos', 'todo', f.todo);
  f.service.tick();
  assert.deepEqual(f.service.signals(), []);
  f.service.configure({ stalledMinutes: 20, remindersEnabled: true });
  f.service.tick();
  assert.equal(f.service.signals().length, 2);
});

test('disabled plugin does not claim reminders, emit signals or generate brief; close stops work', t => {
  const f = fixture(t);
  f.store.put('todos', 'todo', f.todo);
  f.disable();
  f.service.tick();
  assert.equal(f.service.brief(), null);
  assert.equal(f.store.get<Todo>('todos', 'todo')?.remindedAt, undefined);
  assert.deepEqual(f.events.since(0), []);
  f.enable();
  f.service.tick();
  assert.equal(f.events.since(0).length, 1);
  f.service.close();
  f.store.put('runs', 'run', f.run);
  f.service.tick();
  assert.equal(f.events.since(0).length, 1);
  assert.equal(f.service.brief(), null);
});

test('brief partitions todos and counts actual run states without modifying records', t => {
  const f = fixture(t);
  for (const [id, fields] of Object.entries({ overdue: { dueAt: f.old }, waiting: { waitingOn: '同事' }, upcoming: {}, completed: { completedAt: f.old } })) {
    f.store.put('todos', id, { ...f.todo, id, ...fields });
  }
  f.store.put('runs', 'run', f.run);
  f.store.put('briefing.settings', 'default', {timezone:'Pacific/Kiritimati'});
  f.store.put('todos', 'local-day', {...f.todo, id:'local-day', dueDay:'2026-01-02', dueAt:'2026-01-02T09:59:59Z'});
  f.store.put('todos', 'previous-day', {...f.todo, id:'previous-day', dueDay:'2026-01-01', dueAt:'2026-01-02T11:59:59.999Z'});
  const brief = f.service.brief()!;
  assert.equal(brief.timezone, 'Pacific/Kiritimati');
  assert.ok((brief.sections as unknown as Record<string, Todo[]>)['今天'].some(row => row.id === 'local-day'));
  assert.deepEqual((brief.runs as Record<string, number>).running, 1);
  const todos = brief.todos as unknown as Record<string, Todo[]>;
  assert.ok(todos.overdue.some(row => row.id === 'previous-day'));
  for (const key of ['overdue', 'waiting', 'upcoming', 'completed']) assert.equal(todos[key][0].id, key);
  assert.deepEqual(JSON.parse(JSON.stringify(brief)), brief);
  assert.deepEqual(f.events.since(0), []);
});

test('start is idempotent, changed tick period takes effect and close clears timer', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t);
  f.store.put('runs', 'run', f.run);
  f.service.start();
  f.service.start();
  t.mock.timers.tick(29000);
  assert.equal(f.events.since(0).length, 0);
  f.service.configure({ tickSeconds: 1 });
  t.mock.timers.tick(1000);
  assert.equal(f.events.since(0).length, 1);
  f.service.close();
  // A surviving timer would touch the closed SQLite store and log a failure.
  const log = t.mock.method(console, 'error');
  f.store.close();
  t.mock.timers.tick(60000);
  assert.equal(log.mock.callCount(), 0);
});

test('failed notification publishing retains reminder claim rather than retrying an uncertain action', t => {
  const f = fixture(t);
  f.store.put('todos', 'todo', f.todo);
  const publish = f.events.publish;
  f.events.publish = () => { throw new Error('uncertain publish'); };
  assert.throws(() => f.service.tick(), /uncertain publish/);
  assert.ok(f.store.get<Todo>('todos', 'todo')?.remindedAt);
  f.events.publish = publish;
  f.service.tick();
  assert.equal(f.events.since(0).length, 0);
});


test('future, completed and invalid reminders are skipped; completing a reminded todo resolves its signal', t => {
  const f = fixture(t);
  for (const [id, fields] of Object.entries({ future: { reminderAt: '2026-01-02T00:00:00Z' },
    completed: { completedAt: f.old }, invalid: { reminderAt: 'invalid' }, due: {} })) {
    f.store.put('todos', id, { ...f.todo, id, ...fields });
  }
  f.service.tick();
  assert.equal(f.events.since(0).length, 1);
  assert.equal(f.service.signals()[0].todoId, 'due');
  f.store.put('todos', 'due', { ...f.store.get<Todo>('todos', 'due')!, completedAt: f.old });
  f.service.tick();
  assert.ok(f.service.signals()[0].resolvedAt);
  f.advance(24 * 60 * 60000);
  f.service.tick();
  assert.equal(f.events.since(0).length, 2);
  assert.equal(f.service.signals().filter(s => !s.resolvedAt)[0].todoId, 'future');
});


test('long runs use total elapsed time and estimate factor despite recent output, emitting once', t => {
  const f = fixture(t);
  const createdAt = '2026-01-01T12:00:00Z';
  f.store.put('runs', 'run', { ...f.run, expectMinutes: 120, createdAt, updatedAt: createdAt });
  f.advance(20 * 60000);
  f.service.tick();
  assert.deepEqual(f.service.signals(), []);
  f.advance(159 * 60000);
  f.service.tick();
  assert.deepEqual(f.service.signals(), []);
  f.advance(2 * 60000);
  f.store.put('runs', 'run', { ...f.run, expectMinutes: 120, createdAt, updatedAt: '2026-01-01T15:01:00Z', output: 'still working' });
  f.service.tick();
  f.service.tick();
  assert.equal(f.service.signals()[0].kind, 'stalled');
  assert.equal(f.events.since(0).length, 1);
  assert.equal(f.store.get<Run>('runs', 'run')?.status, 'running');
});

test('configured estimate factor changes threshold and preserves the minimum duration', t => {
  const f = fixture(t);
  f.service.configure({ stalledFactorOfEstimate: 2 });
  const createdAt = '2026-01-01T12:00:00Z';
  f.store.put('runs', 'run', { ...f.run, expectMinutes: 120, createdAt });
  f.advance(181 * 60000);
  f.service.tick();
  assert.deepEqual(f.service.signals(), []);
  f.advance(59 * 60000);
  f.service.tick();
  assert.equal(f.service.signals()[0].kind, 'stalled');
  f.store.put('runs', 'short', { ...f.run, id: 'short', expectMinutes: 1, createdAt: '2026-01-01T16:00:00Z' });
  f.advance(19 * 60000);
  f.service.tick();
  assert.equal(f.service.signals().some(s => s.runId === 'short'), false);
  f.advance(60000);
  f.service.tick();
  assert.equal(f.service.signals().some(s => s.runId === 'short' && s.kind === 'stalled'), true);
});

test('missing estimate falls back to elapsed minimum; unknown and offline runs remain unconfirmed', t => {
  const f = fixture(t);
  const createdAt = '2026-01-01T12:00:00Z';
  f.store.put('runs', 'run', { ...f.run, createdAt, machineId: 'machine' });
  f.store.put('runs', 'unknown', { ...f.run, id: 'unknown', status: 'unknown', machineId: 'machine' });
  f.store.put('machines', 'machine', { id: 'machine', online: false });
  f.advance(19 * 60000);
  f.service.tick();
  assert.deepEqual(f.service.signals().map(s => s.kind), ['orphaned', 'orphaned']);
  f.advance(60000);
  f.store.put('runs', 'run', { ...f.store.get<Run>('runs', 'run')!, updatedAt: '2026-01-01T12:20:00Z' });
  f.service.tick();
  assert.equal(f.service.signals().filter(s => s.kind === 'stalled').length, 1);
  assert.equal(f.service.signals().some(s => s.kind === 'review'), false);
  assert.equal(f.store.get<Run>('runs', 'run')?.status, 'running');
  assert.equal(f.store.get<Run>('runs', 'unknown')?.status, 'unknown');
});


test('legacy SQLite settings gain the default factor and configured factor survives a full restart', t => {
  const f = fixture(t);
  f.store.put('supervision.settings', 'automation', { tickSeconds: 30, stalledMinutes: 20, needsYouMinutes: 3, remindersEnabled: true });
  assert.equal(f.service.settings().stalledFactorOfEstimate, 1.5);
  f.service.configure({ stalledFactorOfEstimate: 2.5 });
  f.store.put('runs', 'run', { ...f.run, expectMinutes: 30 });
  f.service.close();
  f.store.close();
  const store = createStore(f.path);
  const events = createEventBus(store);
  const restarted = createSupervision({ store, events, now: () => new Date('2026-01-01T12:00:00Z') });
  try {
    assert.equal(restarted.settings().stalledFactorOfEstimate, 2.5);
    restarted.tick();
    assert.deepEqual(restarted.signals(), []);
    restarted.configure({ stalledFactorOfEstimate: 1 });
    restarted.tick();
    assert.equal(restarted.signals()[0].kind, 'stalled');
    restarted.configure({ stalledFactorOfEstimate: 10 });
    restarted.tick();
    assert.ok(restarted.signals()[0].resolvedAt);
  } finally { restarted.close(); store.close(); }
});


test('验收标准修订后从生效时间重新督办，同一版本的输出和重试不会延长预计时限', t => {
  const f = fixture(t);
  f.store.put('todos',f.todo.id,{...f.todo,reminderAt:undefined});
  f.store.put('runs',f.run.id,{...f.run,todoId:f.todo.id,doneWhen:'核对甲列',expectMinutes:10});
  f.service.tick();
  const first = f.service.signals()[0]!;
  assert.equal(first.kind,'stalled');
  const scopes = createRunScopes(f.store);
  const args = {expectedVersion:0,expectedDoneWhen:'核对甲列',doneWhen:'核对乙列',reason:'主人调整'};
  const revised = scopes.revise(f.run.id,args,{kind:'web'});
  const clock = revised.history[0]!.createdAt;
  f.service.resolvePreviousStall(f.run.id,0,clock);
  assert.equal(f.service.signals()[0]?.resolvedAt,clock);
  f.advance(Date.parse(clock) - Date.parse('2026-01-01T12:00:00Z') + 19 * 60000);
  f.service.tick();
  assert.ok(f.service.signals().every(s => s.resolvedAt));
  f.store.put('runs',f.run.id,{...f.store.get<Run>('runs',f.run.id)!,updatedAt:new Date(Date.parse(clock)+19*60000).toISOString()});
  scopes.revise(f.run.id,args,{kind:'web'});
  f.advance(60000);
  f.service.tick();
  const next = f.service.signals().filter(s => !s.resolvedAt);
  assert.equal(next.length,1);
  assert.notEqual(next[0]!.id,first.id);
  f.service.tick();
  assert.equal(f.events.since(0).filter(e => e.type === 'notifications.created').length,2);
});

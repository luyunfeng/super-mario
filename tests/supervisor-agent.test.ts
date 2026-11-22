import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createSupervisorAgent } from '../packages/core/src/supervisor-agent.ts';
import type { Message, Run, SupervisionSignal } from '../packages/protocol/src/index.ts';

const answer = (): Message => ({ id: 'answer', conversationId: 'supervisor', role: 'assistant', text: '需核对验收输出，等待用户审批。', createdAt: new Date().toISOString(), status: 'done' });
const signal = (id: string, kind: SupervisionSignal['kind'] = 'review'): SupervisionSignal => ({ id, kind, text: `复核 ${id}`, runId: 'run', createdAt: new Date().toISOString() });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'mario-supervisor-'));
  const path = join(dir, 'data.sqlite');
  const store = createStore(path);
  const events = createEventBus(store);
  let available = true;
  let enabled = true;
  let respond: () => Promise<Message> = async () => answer();
  const calls: { text: string; context?: { projectId?: string } }[] = [];
  const agent = {
    status: () => available ? { available: true } : { available: false, reason: '缺少模型凭证' },
    async ask(text: string, context?: { projectId?: string }) { calls.push({ text, context }); return respond(); },
  };
  const signals = () => store.list<SupervisionSignal>('supervision.signals');
  const service = createSupervisorAgent({ store, events, agent, signals, enabled: () => enabled });
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  function add(value: SupervisionSignal, notify = true) {
    store.put('supervision.signals', value.id, value);
    if (notify) events.publish('notifications.created', { ...value });
  }
  return { store, path, events, service, agent, signals, calls, add,
    setAvailable(value: boolean) { available = value; }, setEnabled(value: boolean) { enabled = value; },
    respondWith(fn: () => Promise<Message>) { respond = fn; } };
}

test('batches notification and open signals with actual Run evidence; only suggestions are written', async t => {
  const f = fixture(t);
  const run: Run = { id: 'run', conversationId: 'external', executorId: 'fake', projectId: 'project',
    prompt: '执行', doneWhen: '测试通过且人工验收', output: 'terminal idle', resultSource: 'terminal',
    status: 'unknown', error: '断线', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  f.store.put('runs', run.id, run);
  f.store.put('todos', 'todo', { id: 'todo', title: '待验收' });
  f.store.put('approvals', 'approval', { id: 'approval', status: 'pending' });
  for (const kind of ['review', 'stalled', 'orphaned', 'needs_you'] as const) f.add(signal(kind, kind), kind !== 'orphaned');
  for (const kind of ['reminder', 'waiting'] as const) f.add(signal(kind, kind));
  f.add({ ...signal('resolved'), resolvedAt: new Date().toISOString() });
  const result = await f.service.flush();
  assert.equal(f.calls.length, 1);
  const evidence = JSON.parse(f.calls[0].text.split('\n').at(-1)!);
  assert.deepEqual(evidence.runs, [run]);
  assert.deepEqual(f.calls[0].context, { projectId: 'project' });
  assert.match(f.calls[0].text, /不要批准权限，不要自动完成 todo/);
  assert.equal(result?.status, 'suggestion');
  assert.deepEqual(result?.signalIds.toSorted(), ['needs_you', 'orphaned', 'review', 'stalled']);
  assert.deepEqual(result?.runIds, ['run']);
  assert.deepEqual(f.service.reviews(), [result]);
  assert.deepEqual(f.events.since(0).filter(e => e.type === 'supervisor.review').map(e => e.data), [result]);
  assert.deepEqual(f.store.get('runs', 'run'), run);
  assert.deepEqual(f.store.get('todos', 'todo'), { id: 'todo', title: '待验收' });
  assert.deepEqual(f.store.get('approvals', 'approval'), { id: 'approval', status: 'pending' });
});

test('deduplication, settings, reviews and minGap persist across a real SQLite reopen', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const f = fixture(t);
  f.service.configure({ batchSeconds: 2, minGapMinutes: 1 });
  f.add(signal('first'));
  await f.service.flush();
  await f.service.close();
  f.store.close();
  const store = createStore(f.path);
  const events = createEventBus(store);
  const restarted = createSupervisorAgent({ store, events, agent: f.agent, signals: () => store.list('supervision.signals') });
  try {
    assert.deepEqual(restarted.settings(), { batchSeconds: 2, minGapMinutes: 1, available: true, state:'idle',lastError:undefined,canResume:false });
    assert.equal(restarted.reviews().length, 1);
    events.publish('notifications.created', { ...signal('first') });
    store.put('supervision.signals', 'second', signal('second'));
    await restarted.flush();
    assert.equal(f.calls.length, 1);
    t.mock.timers.tick(60000);
    const result = await restarted.flush();
    assert.deepEqual(result?.signalIds, ['second']);
    t.mock.timers.tick(60000);
    await restarted.flush();
    assert.equal(f.calls.length, 2);
  } finally { await restarted.close(); store.close(); }
});

test('concurrent flushes share one request and retain new signals for the next round', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture(t);
  const waiting = deferred<Message>();
  f.respondWith(() => waiting.promise);
  f.add(signal('first'));
  const first = f.service.flush();
  const second = f.service.flush();
  assert.equal(first, second);
  await Promise.resolve();
  f.add(signal('second'));
  assert.equal(f.calls.length, 1);
  waiting.resolve(answer());
  assert.deepEqual((await first)?.signalIds, ['first']);
  await second;
  t.mock.timers.tick(10 * 60000);
  assert.deepEqual((await f.service.flush())?.signalIds, ['second']);
  assert.equal(f.calls.length, 2);
});

test('unavailable model exposes reason without fabricated advice; disabled loop does no work', async t => {
  const f = fixture(t);
  f.add(signal('first'));
  f.setAvailable(false);
  assert.equal(await f.service.flush(), undefined);
  assert.equal(f.service.settings().reason, '缺少模型凭证');
  assert.equal(f.service.reviews().length, 0);
  assert.equal(f.calls.length, 0);
  f.setAvailable(true);
  f.setEnabled(false);
  await f.service.flush();
  assert.equal(f.calls.length, 0);
  f.setEnabled(true);
  assert.deepEqual((await f.service.flush())?.signalIds, ['first']);
});

test('failed read-only model calls wait for explicit retry without losing signals', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const f = fixture(t);
  const errorLog = t.mock.method(console, 'error', () => {});
  f.add(signal('first'));
  f.respondWith(async () => { throw new Error('model offline'); });
  f.service.configure({ batchSeconds: 1 });
  f.service.start();
  t.mock.timers.tick(1000);
  // Drain the complete asynchronous timer request, including its error handler.
  await assert.rejects(f.service.flush(), /model offline/);
  await Promise.resolve();
  assert.equal(errorLog.mock.callCount(), 1);
  t.mock.timers.tick(10000);
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.reviews().length, 0);
  f.respondWith(async () => answer());
  assert.deepEqual((await f.service.flush())?.signalIds, ['first']);
  assert.equal(f.calls.length, 2);
});

test('failed or empty model messages are not claimed as successful suggestions', async t => {
  const f = fixture(t);
  f.add(signal('first'));
  for (const invalid of [{ ...answer(), status: 'failed' as const }, { ...answer(), text: '  ' }]) {
    f.respondWith(async () => invalid);
    await assert.rejects(f.service.flush(), /未返回有效建议/);
    assert.equal(f.service.reviews().length, 0);
  }
  f.respondWith(async () => answer());
  assert.deepEqual((await f.service.flush())?.signalIds, ['first']);
});

test('close clears timers, unsubscribes and waits for inflight without storing late results', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t);
  const waiting = deferred<Message>();
  f.respondWith(() => waiting.promise);
  f.add(signal('first'));
  f.service.start();
  const flush = f.service.flush();
  await Promise.resolve();
  let finished = false;
  const closing = f.service.close().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  waiting.resolve(answer());
  await closing;
  assert.equal(await flush, undefined);
  assert.equal(f.service.reviews().length, 0);
  f.events.publish('notifications.created', { ...signal('after-close') });
  f.store.close();
  // Ticking after shutdown must not touch SQLite.
  const log = t.mock.method(console, 'error', () => {});
  t.mock.timers.tick(60000);
  await f.service.flush();
  await f.service.close();
  assert.equal(f.calls.length, 1);
  assert.equal(log.mock.callCount(), 0);
});

test('configuration validates atomically, reschedules timer, and start is idempotent', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  const f = fixture(t);
  assert.deepEqual(f.service.settings(), { batchSeconds: 15, minGapMinutes: 10, available: true, state:'idle',lastError:undefined,canResume:false });
  for (const patch of [null, [], { batchSeconds: 0 }, { batchSeconds: 3601 }, { minGapMinutes: 43201 },
    { minGapMinutes: 0 }, { minGapMinutes: 1.1 }, { batchSeconds: NaN }, { unknown: 1 }]) {
    assert.throws(() => f.service.configure(patch as never), TypeError);
  }
  assert.equal(f.service.settings().batchSeconds, 15);
  f.add(signal('first'));
  f.service.start();
  f.service.start();
  t.mock.timers.tick(14000);
  await Promise.resolve();
  assert.equal(f.calls.length, 0);
  f.service.configure({ batchSeconds: 1, minGapMinutes: 1 });
  t.mock.timers.tick(1000);
  await f.service.flush();
  assert.equal(f.calls.length, 1);
  await f.service.close();
  assert.throws(() => f.service.configure({ batchSeconds: 2 }), /已关闭/);
});

test('bounded batches drain overflow and skip notifications resolved before flush', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = fixture(t);
  for (let i = 0; i < 270; i++) f.add(signal(`signal-${i}`));
  const resolved = { ...signal('signal-0'), resolvedAt: new Date().toISOString() };
  f.store.put('supervision.signals', resolved.id, resolved);
  const first = await f.service.flush();
  assert.equal(first?.signalIds.length, 256);
  assert.ok(!first?.signalIds.includes(resolved.id));
  t.mock.timers.tick(10 * 60000);
  const second = await f.service.flush();
  assert.equal(second?.signalIds.length, 13);
  assert.equal(new Set([...first!.signalIds, ...second!.signalIds]).size, 269);
});

test('missing runs are explicitly unknown and mixed projects do not choose an arbitrary context', async t => {
  const f = fixture(t);
  f.add(signal('missing'));
  for (const id of ['a', 'b']) {
    f.add({ ...signal(id), runId: id });
    f.store.put('runs', id, { id, projectId: id, doneWhen: 'test', output: '' });
  }
  await f.service.flush();
  assert.equal(f.calls[0].context, undefined);
  assert.deepEqual(JSON.parse(f.calls[0].text.split('\n').at(-1)!).runs[0], { id: 'run', missing: true });
});

test('needs_you signals include actual runs associated with their todo', async t => {
  const f = fixture(t);
  const { runId: _, ...approvalSignal } = signal('approval', 'needs_you');
  f.add({ ...approvalSignal, todoId: 'todo' });
  const run: Run = { id: 'related', todoId: 'todo', projectId: 'project', executorId: 'fake',
    conversationId: 'external', prompt: '执行', doneWhen: '人工验收', output: '等待批准',
    status: 'running', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  f.store.put('runs', run.id, run);
  f.store.put('todos', 'todo', { id: 'todo', title: '核验交付', notes: '保留审批回执', waitingOn: '验收人' });
  f.store.put('runs', 'unrelated', { ...run, id: 'unrelated', todoId: 'other' });
  const review = await f.service.flush();
  assert.deepEqual(review?.runIds, ['related']);
  const evidence = JSON.parse(f.calls[0].text.split('\n').at(-1)!);
  assert.deepEqual(evidence.todos, [{ id: 'todo', title: '核验交付', notes: '保留审批回执', waitingOn: '验收人' }]);
  assert.match(f.calls[0].text, /不同执行的产物不可相互代证/);
  assert.deepEqual(JSON.parse(f.calls[0].text.split('\n').at(-1)!).runs, [run]);
  assert.deepEqual(f.calls[0].context, { projectId: 'project' });
});

test('SILENT supervisor reply marks signal processed without emitting review event', async t => {
  const f = fixture(t);
  const emitted: unknown[] = [];
  f.events.subscribe(e => { if (e.type === 'supervisor.review') emitted.push(e); });
  f.respondWith(async () => ({ ...answer(), text: 'SILENT: 误报，任务已正常完成' }));
  f.add(signal('false-alarm'));
  const review = await f.service.flush();
  assert.equal(review?.status, 'silent');
  assert.equal(emitted.length, 0);
  // Second flush should not re-process the silently absorbed signal.
  assert.equal(await f.service.flush(), undefined);
});

test('a similar word or a missing reason cannot silently close a review', async t => {
  for (const text of ['SILENTLY waiting', 'SILENT:   ']) {
    const f = fixture(t);
    f.respondWith(async () => ({ ...answer(), text }));
    f.add(signal('needs-review'));
    assert.equal((await f.service.flush())?.status, 'suggestion');
  }
});

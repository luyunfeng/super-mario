import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createRunReview, RunReviewError, type RunReview, type RunReviewDecision } from '../packages/core/src/run-review.ts';
import type { Message, Run, Todo } from '../packages/protocol/src/index.ts';

function fixture(t: { after(fn: () => void): void }, maxReworks?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'super-mario-review-'));
  const path = join(dir, 'data.sqlite');
  const store = createStore(path);
  const events = createEventBus(store);
  const now = new Date().toISOString();
  const todo: Todo = { id: 'todo', title: '用户验收', notes: '', projectId: 'project', createdAt: now, updatedAt: now };
  const original: Run = { id: 'original', todoId: todo.id, projectId: todo.projectId, conversationId: 'main', executorId: 'generic-plugin',
    cwd: '/tmp/work', prompt: '实现功能', doneWhen: '检查通过且按钮可用', expectMinutes: 5, executionMode: 'task',
    status: 'completed', resultSource: 'plugin-result', nativeResultSources: ['plugin-result'], output: '检查通过，文件已保存', createdAt: now, updatedAt: now };
  store.put('todos', todo.id, todo);
  store.put('runs', original.id, original);
  const calls: { input: Record<string, unknown>; key: string }[] = [];
  let completeCalls = 0;
  let onDispatch: ((input: Record<string, unknown>, key: string) => Run) | undefined;
  let onComplete: (() => unknown) | undefined;
  const options = { store, events, maxReworks,
    dispatch(input: Record<string, unknown>, key: string): Run {
      calls.push({ input: structuredClone(input), key });
      if (onDispatch) return onDispatch(input, key);
      const next = { ...input, id: `rework-${calls.length}`, status: 'queued', output: '', createdAt: now, updatedAt: now } as unknown as Run;
      store.put('runs', next.id, next);
      return next;
    },
    completeTodo(id: string): unknown {
      completeCalls++;
      if (onComplete) return onComplete();
      store.put('todos', id, { ...store.get<Todo>('todos', id)!, completedAt: now });
    },
  };
  const review = createRunReview(options);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, events, path, original, todo, review, calls, options,
    completeCalls: () => completeCalls,
    setDispatch(fn: typeof onDispatch) { onDispatch = fn; }, setComplete(fn: typeof onComplete) { onComplete = fn; },
    patch(patch: Partial<Run>, id = original.id) { store.put('runs', id, { ...store.get<Run>('runs', id)!, ...patch }); },
  };
}
function decision(item: RunReview, action: 'accept' | 'rework' = 'accept'): RunReviewDecision {
  return { todoId: item.todoId, version: item.version, runId: item.runId, evidenceVersion: item.evidenceVersion,
    action, ...(action === 'rework' ? { defects: '按钮点击后没有保存文件，请修复并验证' } : {}) };
}
const conflict = (error: unknown) => error instanceof RunReviewError && error.status === 409;

test('attach validates Todo/project/doneWhen/source and requires exact existing version', t => {
  const f = fixture(t);
  for (const patch of [{ todoId: 'other' }, { projectId: 'other' }, { doneWhen: '' }, { sourceMessageId: 'missing' }]) {
    f.patch({ ...f.original, ...patch });
    assert.throws(() => f.review.attach({ todoId: 'todo', runId: 'original' }));
    assert.deepEqual(f.review.list(), []);
  }
  f.store.put('runs', 'original', f.original);
  assert.throws(() => f.review.attach({ todoId: 'todo', runId: 'original', version: 1 }), conflict);
  const attached = f.review.attach({ todoId: 'todo', runId: 'original', version: 0 });
  assert.equal(attached.round, 0);
  assert.equal(attached.version, 1);
  assert.deepEqual(f.review.attach({ todoId: 'todo', runId: 'original', version: 1 }), attached);
  assert.throws(() => f.review.attach({ todoId: 'todo', runId: 'original' }));
  assert.throws(() => f.review.attach({ todoId: 'todo', runId: 'original', version: 0 }), conflict);
});

test('accept atomically records explicit acceptance and completes Todo exactly once', t => {
  const f = fixture(t);
  const input = decision(f.review.attach({ todoId: 'todo', runId: 'original' }));
  const result = f.review.decide(input);
  assert.equal(result.status, 'accepted');
  assert.ok(f.store.get<Todo>('todos', 'todo')?.completedAt);
  assert.deepEqual(f.review.decide(input), result);
  assert.equal(f.completeCalls(), 1);
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.review.decide({ ...input, action: '模型说通过' } as never));
});

test('cleanup leaves the pinned acceptance evidence intact', t => {
  const f = fixture(t);
  const worktree = { source: '/tmp/source', branch: 'fixture', base: 'a'.repeat(40) };
  f.patch({ worktree });
  const request = decision(f.review.attach({ todoId: 'todo', runId: 'original' }));
  f.patch({ worktree: { ...worktree, name: '交付核对', removedAt: new Date().toISOString() } });
  assert.equal(f.review.decide(request).status, 'accepted');
  f.review.assertCanComplete('todo');
});

test('completion guard failure rolls back both acceptance and Todo writes', t => {
  const f = fixture(t);
  const before = f.review.attach({ todoId: 'todo', runId: 'original' });
  f.setComplete(() => {
    assert.equal(f.review.get('todo').status, 'accepted');
    f.store.put('todos', 'todo', { ...f.todo, completedAt: 'wrong' });
    throw new Error('统一完成守卫拒绝');
  });
  assert.throws(() => f.review.decide(decision(before)), /完成守卫/);
  assert.deepEqual(f.review.get('todo'), before);
  assert.deepEqual(f.store.get('todos', 'todo'), f.todo);
  assert.deepEqual(f.store.list('run-review.intents'), []);
  f.setComplete(undefined);
  assert.equal(f.review.decide(decision(before)).status, 'accepted');
});

test('accept rejects invalid evidence, undeclared vendors and mismatched native identity', t => {
  const f = fixture(t);
  f.review.attach({ todoId: 'todo', runId: 'original' });
  const patches: Partial<Run>[] = [ { resultSource: 'demo' }, { resultSource: undefined }, { resultSource: 'terminal-idle' },
    { resultSource: 'codex-json', nativeResultSources: undefined }, { resultSource: 'claude-stream-json', nativeResultSources: undefined },
    { output: ' ' }, { status: 'failed' }, { status: 'unknown' }, { status: 'running' },
    { nativeResume: { executorId: 'generic-plugin', nativeSessionId: 'expected' }, nativeSessionId: 'different' },
    { nativeResume: { executorId: 'other-plugin', nativeSessionId: 'same' }, nativeSessionId: 'same' },
    { executorId: 'other/generic-plugin', machineId: 'machine', nativeResume: { executorId: 'generic-plugin', nativeSessionId: 'thread' }, nativeSessionId: 'thread' },
    { executorId: 'undefined/generic-plugin', machineId: undefined, nativeResume: { executorId: 'generic-plugin', nativeSessionId: 'thread' }, nativeSessionId: 'thread' },
    { nativeResume: { executorId: 'generic-plugin', nativeSessionId: '' }, nativeSessionId: '' } ];
  for (const patch of patches) {
    f.store.put('runs', 'original', { ...f.original, ...patch });
    assert.throws(() => f.review.decide(decision(f.review.get('todo'))), conflict);
  }
  assert.equal(f.completeCalls(), 0);
  assert.equal(f.review.get('todo').status, 'pending');
});

test('get hashes live evidence; stale evidence, changed doneWhen and source scope cannot be accepted', t => {
  const f = fixture(t);
  const initial = f.review.attach({ todoId: 'todo', runId: 'original' });
  for (const patch of [{ output: '新证据' }, { status: 'running' as const }, { error: '发生变化' }, { resultSource: 'real' }]) {
    f.store.put('runs', 'original', { ...f.original, ...patch });
    assert.notEqual(f.review.get('todo').evidenceVersion, initial.evidenceVersion);
    assert.throws(() => f.review.decide(decision(initial)), conflict);
  }
  for (const patch of [{ doneWhen: '偷偷改变标准' }, { projectId: 'elsewhere' }, { todoId: 'other' }, { sourceMessageId: 'missing' }]) {
    f.store.put('runs', 'original', { ...f.original, ...patch });
    assert.throws(() => f.review.decide(decision(f.review.get('todo'))), conflict);
  }
  assert.equal(f.completeCalls(), 0);
});

test('rework preserves scoped parameters, commits unique intent first and omits nativeResume', t => {
  const f = fixture(t);
  f.store.put('messages', 'source', { id: 'source', role: 'user', origin: 'user', conversationId: 'main', projectId: 'project' });
  f.patch({ sourceMessageId: 'source', nativeResume: { executorId: 'codex', nativeSessionId: 'thread' } });
  const input = decision(f.review.attach({ todoId: 'todo', runId: 'original' }), 'rework');
  f.setDispatch((params, key) => {
    assert.equal(f.review.get('todo').status, 'dispatching');
    assert.ok(f.store.get('run-review.intents', key));
    assert.equal(params.sourceMessageId, 'source');
    assert.equal('nativeResume' in params, false);
    assert.equal('approved' in params, false);
    for (const field of ['projectId', 'cwd', 'executorId', 'doneWhen', 'expectMinutes'] as const) assert.equal(params[field], f.original[field]);
    assert.match(String(params.prompt), /按钮点击后没有保存文件/);
    const next = { ...params, id: 'new', status: 'queued', output: '', createdAt: 'now', updatedAt: 'now' } as unknown as Run;
    f.store.put('runs', next.id, next);
    return next;
  });
  const result = f.review.decide(input);
  assert.equal(result.runId, 'new');
  assert.equal(result.round, 1);
  assert.equal(result.status, 'pending');
  assert.equal(f.store.get<Todo>('todos', 'todo')!.completedAt, undefined);
});

test('concurrent duplicates and synchronous reentry launch one Run; old late results never change current round', async t => {
  const f = fixture(t);
  const input = decision(f.review.attach({ todoId: 'todo', runId: 'original' }), 'rework');
  f.setDispatch(params => {
    assert.equal(f.review.decide(input).status, 'dispatching');
    const next = { ...params, id: 'new', status: 'queued', output: '', createdAt: 'now', updatedAt: 'now' } as unknown as Run;
    f.store.put('runs', 'new', next);
    return next;
  });
  const results = await Promise.all(Array.from({ length: 5 }, () => Promise.resolve().then(() => f.review.decide(input))));
  assert.equal(f.calls.length, 1);
  for (const item of results) assert.deepEqual(item, results[0]);
  const current = f.review.get('todo');
  f.patch({ output: '旧轮晚到' });
  assert.deepEqual(f.review.get('todo'), current);
  assert.throws(() => f.review.decide({ ...input, action: 'accept' }), conflict);
  assert.throws(() => f.review.attach({ todoId: 'todo', runId: 'original', version: current.version }), conflict);
  assert.deepEqual(f.review.decide(input), results[0]);
});

test('rework validates defects and terminal state before creating intent', t => {
  const f = fixture(t);
  f.review.attach({ todoId: 'todo', runId: 'original' });
  const input = decision(f.review.get('todo'), 'rework');
  for (const defects of [undefined, '', '   ']) assert.throws(() => f.review.decide({ ...input, defects }));
  for (const state of ['queued', 'running', 'unknown', 'cancelled'] as const) {
    f.patch({ status: state });
    assert.throws(() => f.review.decide(decision(f.review.get('todo'), 'rework')), conflict);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.list('run-review.intents').length, 0);
  f.patch({ status: 'failed', resultSource: undefined, output: '' });
  assert.equal(f.review.decide(decision(f.review.get('todo'), 'rework')).round, 1);
});

test('default limit allows exactly two reworks, zero forbids any and invalid dynamic limits fail closed', t => {
  const f = fixture(t);
  f.review.attach({ todoId: 'todo', runId: 'original' });
  for (let i = 1; i <= 2; i++) {
    const next = f.review.decide(decision(f.review.get('todo'), 'rework'));
    assert.equal(next.round, i);
    assert.ok(String(f.calls.at(-1)?.input.prompt).includes(`第 ${i} 轮，上限 2 轮`));
    f.patch({ status: 'completed', resultSource: 'real', output: '已修复' }, next.runId);
  }
  assert.throws(() => f.review.decide(decision(f.review.get('todo'), 'rework')), /上限/);
  assert.equal(f.calls.length, 2);
  let value = 0;
  const zero = fixture(t, () => value);
  zero.review.attach({ todoId: 'todo', runId: 'original' });
  assert.throws(() => zero.review.decide(decision(zero.review.get('todo'), 'rework')), /上限/);
  for (value of [-1, 11, 1.5, NaN, Infinity]) {
    assert.throws(() => zero.review.decide(decision(zero.review.get('todo'), 'rework')), /0到10/);
    assert.throws(() => createRunReview(zero.options), /0到10/);
  }
  assert.equal(zero.calls.length, 0);
});

test('unknown dispatch and malformed receipts persist and never automatically resend, including after restart', t => {
  const f = fixture(t);
  const input = decision(f.review.attach({ todoId: 'todo', runId: 'original' }), 'rework');
  f.setDispatch(() => { throw new Error('connection lost'); });
  const result = f.review.decide(input);
  assert.equal(result.status, 'unknown');
  assert.match(result.error!, /不自动重试/);
  assert.deepEqual(f.review.decide(input), result);
  f.store.close();
  const store = createStore(f.path);
  try {
    const restored = createRunReview({ ...f.options, store, events: createEventBus(store) });
    assert.equal(restored.get('todo').status, 'unknown');
    assert.deepEqual(restored.decide(input), result);
    assert.equal(f.calls.length, 1);
    assert.throws(() => restored.decide(decision(restored.get('todo'), 'rework')), conflict);
  } finally { store.close(); }
  const bad = fixture(t);
  bad.setDispatch(() => ({ id: 'missing' } as Run));
  const badInput = decision(bad.review.attach({ todoId: 'todo', runId: 'original' }), 'rework');
  assert.equal(bad.review.decide(badInput).status, 'unknown');
  bad.review.decide(badInput);
  assert.equal(bad.calls.length, 1);
});

test('crash after durable intent recovers dispatching as unknown without sending', t => {
  const f = fixture(t);
  const input = decision(f.review.attach({ todoId: 'todo', runId: 'original' }), 'rework');
  f.review.decide(input);
  const receipt = f.store.list<{ key: string; result: RunReview }>('run-review.intents')[0]!;
  const interrupted = { ...receipt.result, status: 'dispatching' as const };
  f.store.put('run-reviews', 'todo', interrupted);
  f.store.put('run-review.intents', receipt.key, { ...receipt, result: interrupted });
  f.store.close();
  const store = createStore(f.path);
  try {
    const restored = createRunReview({ ...f.options, store, events: createEventBus(store) });
    assert.equal(restored.get('todo').status, 'unknown');
    assert.equal(restored.decide(input).status, 'unknown');
    assert.equal(f.calls.length, 1);
  } finally { store.close(); }
});

test('accept publishes after commit; unchanged evidence hashes survive key reordering and restart', t => {
  const f = fixture(t);
  const before = f.review.attach({ todoId: 'todo', runId: 'original' });
  const reordered = Object.fromEntries(Object.entries(f.original).reverse());
  f.store.put('runs', 'original', reordered);
  assert.equal(f.review.get('todo').evidenceVersion, before.evidenceVersion);
  let notices = 0;
  f.events.subscribe(event => {
    if (event.type !== 'run-review.changed') return;
    notices++;
    assert.equal(f.review.get('todo').status, 'accepted');
    assert.ok(f.store.get<Todo>('todos', 'todo')!.completedAt);
  });
  const input = decision(before);
  f.review.decide(input);
  f.review.decide(input);
  assert.equal(notices, 1);
  assert.equal(f.review.list()[0]!.evidenceVersion, before.evidenceVersion);
});

test('host scope rejection is retained as unknown and never grants old message approval', t => {
  const f = fixture(t);
  f.store.put('messages', 'source', { id: 'source', role: 'user', conversationId: 'main', projectId: 'project' });
  f.patch({ sourceMessageId: 'source' });
  const attached = f.review.attach({ todoId: 'todo', runId: 'original' });
  const input = decision(attached, 'rework');
  for (const defects of ['坏了', '请重新做', '需要返工']) assert.throws(() => f.review.decide({ ...input, defects }), /具体缺陷/);
  f.setDispatch(params => {
    assert.equal(params.sourceMessageId, 'source');
    assert.equal('nativeApproved' in params, false);
    throw new Error('来源scope已撤销');
  });
  assert.match(f.review.decide(input).error!, /scope已撤销/);
  f.review.decide(input);
  assert.equal(f.calls.length, 1);
});

test('declared generic native results and real results accept identifiers containing demo', t => {
  for (const source of ['plugin-result', 'real']) {
    const f = fixture(t);
    f.patch({ executorId: 'demo-tools-production', resultSource: source,
      nativeResultSources: source === 'real' ? undefined : [source],
      nativeResume: { executorId: 'demo-tools-production', nativeSessionId: 'demo-session' }, nativeSessionId: 'demo-session' });
    const attached = f.review.attach({ todoId: 'todo', runId: 'original' });
    assert.equal(f.review.decide(decision(attached)).status, 'accepted');
    assert.doesNotThrow(() => f.review.assertCanComplete('todo'));
  }
});

test('declarations never authorize demo or observation sources as completion evidence', t => {
  const f = fixture(t);
  f.review.attach({ todoId: 'todo', runId: 'original' });
  for (const source of ['demo', 'screen', 'runner', 'terminal-idle', 'idle', 'unknown', 'SCREEN', ' runner ', '']) {
    f.patch({ resultSource: source, nativeResultSources: [source] });
    assert.throws(() => f.review.decide(decision(f.review.get('todo'))), conflict);
  }
  assert.equal(f.completeCalls(), 0);
});

test('legacy native result needs an explicit host declaration, without vendor inference', t => {
  const f = fixture(t);
  f.patch({ nativeResultSources: undefined,
    nativeResume: { executorId: 'generic-plugin', nativeSessionId: 'session' }, nativeSessionId: 'session' });
  const attached = f.review.attach({ todoId: 'todo', runId: 'original' });
  assert.throws(() => f.review.decide(decision(attached)), conflict);
  f.patch({ nativeResultSources: ['plugin-result'] });
  assert.throws(() => f.review.decide(decision(attached)), conflict);
  assert.equal(f.review.decide(decision(f.review.get('todo'))).status, 'accepted');
});

test('验收匹配绑定电脑、执行器与原生会话的完成证据', t => {
  const f = fixture(t);
  f.patch({ machineId: 'fixture', executorId: 'fixture/generic-plugin', nativeSessionId: 'thread',
    nativeResume: { executorId: 'generic-plugin', nativeSessionId: 'thread' } });
  const review = f.review.attach({ todoId: 'todo', runId: 'original' });
  assert.equal(f.review.decide(decision(review)).status, 'accepted');
});

test('global main user requests can delegate into projects but explicit scope cannot be crossed', t => {
  const f = fixture(t);
  const source: Message = { id: 'source', conversationId: 'main', role: 'user', origin: 'user', text: '执行项目任务', createdAt: 'now' };
  f.store.put('messages', source.id, source);
  f.patch({ sourceMessageId: source.id });
  const attached = f.review.attach({ todoId: 'todo', runId: 'original' });
  for (const patch of [{ projectId: 'other' }, { todoId: 'other' }, { conversationId: 'other' },
    { readOnly: true }, { role: 'assistant' as const }, { origin: 'result' as const }, { origin: 'notification' as const }]) {
    f.store.put('messages', source.id, { ...source, ...patch });
    assert.throws(() => f.review.decide(decision(attached)), conflict);
  }
  f.store.put('messages', source.id, source);
  assert.equal(f.review.decide(decision(attached)).status, 'accepted');
  assert.doesNotThrow(() => f.review.assertCanComplete('todo'));
  f.store.put('messages', source.id, { ...source, projectId: 'other' });
  assert.throws(() => f.review.assertCanComplete('todo'), conflict);
  const other = fixture(t);
  other.patch({ conversationId: 'project-chat', sourceMessageId: source.id });
  other.store.put('messages', source.id, { ...source, conversationId: 'project-chat' });
  assert.throws(() => other.review.attach({ todoId: 'todo', runId: 'original' }), conflict);
});

test('completion guard permits unreviewed Todos and checks accepted evidence even after completion', t => {
  const f = fixture(t);
  assert.equal(f.review.assertCanComplete('unreviewed'), undefined);
  const attached = f.review.attach({ todoId: 'todo', runId: 'original' });
  assert.throws(() => f.review.assertCanComplete('todo'), conflict);
  f.setComplete(() => {
    f.review.assertCanComplete('todo');
    f.store.put('todos', 'todo', { ...f.todo, completedAt: 'now' });
    f.review.assertCanComplete('todo');
  });
  f.review.decide(decision(attached));
  for (const patch of [{ output: 'changed' }, { status: 'failed' as const }, { resultSource: 'screen' },
    { doneWhen: 'changed' }, { todoId: 'other' }, { projectId: 'other' }, { nativeResultSources: [] }]) {
    f.patch({ ...f.original, ...patch });
    assert.throws(() => f.review.assertCanComplete('todo'), conflict);
  }
  f.store.put('runs', 'original', f.original);
  f.store.put('todos', 'todo', { ...f.todo, projectId: 'other', completedAt: 'now' });
  assert.throws(() => f.review.assertCanComplete('todo'), conflict);
  f.store.put('todos', 'todo', { ...f.todo, completedAt: 'now' });
  assert.equal(f.review.assertCanComplete('todo'), undefined);
});

test('reopening shares the Todo transaction, invalidates acceptance and only attaches unseen Runs', t => {
  const f = fixture(t, () => 1);
  const initial = f.review.attach({ todoId: 'todo', runId: 'original' });
  const reworked = f.review.decide(decision(initial, 'rework'));
  f.patch({ status: 'completed', resultSource: 'real', output: '已修复' }, reworked.runId);
  const acceptInput = decision(f.review.get('todo'));
  const accepted = f.review.decide(acceptInput);
  assert.equal(accepted.round, 1);
  assert.throws(() => f.store.transaction(() => {
    f.store.put('todos', 'todo', f.todo);
    assert.equal(f.review.onReopen('todo'), undefined);
    assert.equal(f.review.get('todo').status, 'reopened');
    throw new Error('outer rollback');
  }), /outer rollback/);
  assert.equal(f.review.get('todo').status, 'accepted');
  assert.ok(f.store.get<Todo>('todos', 'todo')!.completedAt);
  f.store.transaction(() => {
    f.review.onReopen('todo');
    f.store.put('todos', 'todo', f.todo);
  });
  const reopened = f.review.get('todo');
  assert.equal(reopened.status, 'reopened');
  assert.equal(reopened.version, accepted.version + 1);
  assert.deepEqual(reopened.runIds, ['original', reworked.runId]);
  assert.throws(() => f.review.assertCanComplete('todo'), conflict);
  f.review.decide(acceptInput); // Old idempotent receipt cannot complete again.
  assert.equal(f.completeCalls(), 1);
  assert.equal(f.store.get<Todo>('todos', 'todo')!.completedAt, undefined);
  assert.throws(() => f.review.decide(decision(reopened)), conflict);
  assert.throws(() => f.review.onReopen('todo'), conflict);
  for (const runId of reopened.runIds) {
    assert.throws(() => f.review.attach({ todoId: 'todo', runId, version: reopened.version }), conflict);
  }
  f.store.put('runs', 'fresh', { ...f.original, id: 'fresh', resultSource: 'real' });
  assert.throws(() => f.review.attach({ todoId: 'todo', runId: 'fresh', version: accepted.version }), conflict);
  const fresh = f.review.attach({ todoId: 'todo', runId: 'fresh', version: reopened.version });
  assert.equal(fresh.round, 0);
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.version, reopened.version + 1);
  assert.deepEqual(fresh.runIds, ['original', reworked.runId, 'fresh']);
  assert.throws(() => f.review.assertCanComplete('todo'), conflict);
  const next = f.review.decide(decision(fresh, 'rework'));
  assert.equal(next.round, 1);
  f.patch({ status: 'completed', resultSource: 'real', output: '新交付' }, next.runId);
  f.review.decide(decision(f.review.get('todo')));
  assert.equal(f.completeCalls(), 2);
  assert.equal(f.review.assertCanComplete('todo'), undefined);
});

test('pending, dispatching and unknown cannot reopen or bypass the rework limit', t => {
  const f = fixture(t, () => 1);
  assert.equal(f.review.onReopen('unreviewed'), undefined);
  const attached = f.review.attach({ todoId: 'todo', runId: 'original' });
  assert.throws(() => f.review.onReopen('todo'), conflict);
  f.setDispatch(() => {
    assert.equal(f.review.get('todo').status, 'dispatching');
    assert.throws(() => f.review.onReopen('todo'), conflict);
    assert.throws(() => f.review.assertCanComplete('todo'), conflict);
    throw new Error('unknown dispatch');
  });
  const unknown = f.review.decide(decision(attached, 'rework'));
  assert.equal(unknown.status, 'unknown');
  assert.throws(() => f.review.onReopen('todo'), conflict);
  assert.throws(() => f.review.assertCanComplete('todo'), conflict);
  assert.equal(f.review.get('todo').round, 1);
  assert.throws(() => f.review.decide(decision(unknown, 'rework')), conflict);
  assert.equal(f.calls.length, 1);
});

test('native resumed remote executors keep their machine-qualified identity during acceptance', t => {
  const f = fixture(t);
  f.store.put('runs', f.original.id, { ...f.original, executorId: 'node/generic-plugin', machineId: 'node',
    nativeResume: { executorId: 'generic-plugin', nativeSessionId: 'original-thread' }, nativeSessionId: 'original-thread' });
  const current = f.review.attach({ todoId: f.todo.id, runId: f.original.id });
  const accepted = f.review.decide({ todoId: f.todo.id, version: current.version, runId: current.runId, evidenceVersion: current.evidenceVersion, action: 'accept' });
  assert.equal(accepted.status, 'accepted');
  assert.equal(f.completeCalls(), 1);
});

test('project memory gets only a matching review and detects changed acceptance evidence', t => {
  const f = fixture(t);
  const read = () => f.review.evidenceForRun(f.store.get<Run>('runs', f.original.id)!);
  assert.equal(read(), undefined);
  const attached = f.review.attach({ todoId: f.todo.id, runId: f.original.id });
  assert.equal(read()?.status, 'pending');
  f.review.decide(decision(attached));
  assert.equal(read()?.status, 'accepted');
  assert.equal(f.review.evidenceForRun({ ...f.original, projectId: 'other' }), undefined);
  assert.equal(f.review.evidenceForRun({ ...f.original, id: 'other' }), undefined);
  f.patch({ output: '更新后的执行结果' });
  assert.equal(read()?.status, 'invalidated');
  assert.equal(f.review.get('todo').status, 'accepted');
  assert.equal(f.review.get('todo').evidenceInvalidated, true);
  f.review.onReopen(f.todo.id);
  assert.equal(read()?.status, 'reopened');
});

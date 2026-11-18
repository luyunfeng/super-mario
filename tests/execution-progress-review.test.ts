import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createRunMonitor } from '../packages/core/src/run-monitor.ts';
import { buildWorkContext } from '../packages/core/src/work-context.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { ExecutionResult, Run } from '../packages/protocol/src/index.ts';

// All evidence comes from temporary SQLite databases and a local RPC stub.
const observedAt = '2026-11-17T00:00:00Z';
const progress = { phase: 'tool' as const, toolName: 'Read', detail: '原生工具调用', observedAt };
const run: Run = { id: 'review-run', executorId: 'fixture/codex', machineId: 'fixture',
  sessionId: 'rpc-session', nativeSessionId: 'thread-a', nativeResultSources: ['codex-json'],
  executionMode: 'task', conversationId: 'main', projectId: 'project-a', status: 'running',
  prompt: 'review fixture', output: '', createdAt: observedAt, updatedAt: observedAt };

async function monitorFixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-progress-review-'));
  const store = createStore(join(dir, 'data.sqlite'));
  store.put('runs', run.id, run);
  let reply: unknown;
  const results: ExecutionResult[] = [];
  const monitor = createRunMonitor({ store, events: createEventBus(store), machines: () => ({
    list: () => [{ id: 'fixture', name: 'fixture', online: true, platform: 'linux', connectedAt: observedAt, capabilities: ['executor.result'] }],
    call: async () => reply as any,
  }), onResult: (current, result) => {
    results.push(result);
    store.put('runs', current.id, { ...current, status: result.state === 'completed' ? 'completed' : 'failed' });
  } });
  t.after(async () => { await monitor.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, monitor, results, reply(value: unknown) { reply = value; } };
}

test('review: an undeclared source cannot finish a fresh native task', async t => {
  const f = await monitorFixture(t);
  f.reply({ state: 'completed', text: 'screen says done', source: 'screen', nativeSessionId: 'thread-a', progress });
  await f.monitor.poll();
  assert.equal(f.results.length, 0, 'untrusted completion must not reach finishRun');
  assert.notEqual(f.store.get<Run>('runs', run.id)!.status, 'completed');
});

test('review: a fresh task with an established thread cannot accept another thread progress', async t => {
  const f = await monitorFixture(t);
  f.reply({ state: 'running', text: '', source: 'codex-json', nativeSessionId: 'thread-b', progress });
  await f.monitor.poll();
  const current = f.store.get<Run>('runs', run.id)!;
  assert.equal(current.nativeSessionId, 'thread-a', 'established native identity must remain pinned');
  assert.equal(current.progress, undefined);
});

test('review: undeclared progress source cannot rewrite native identity or result provenance', async t => {
  const f = await monitorFixture(t);
  f.reply({ state: 'running', text: '', source: 'screen', nativeSessionId: 'thread-b', progress });
  await f.monitor.poll();
  const current = f.store.get<Run>('runs', run.id)!;
  assert.equal(current.nativeSessionId, 'thread-a');
  assert.equal(current.resultSource, undefined);
});

test('review: late completed RPC cannot overwrite cancellation', async t => {
  const f = await monitorFixture(t);
  let resolve!: (value: unknown) => void;
  f.reply(new Promise(done => { resolve = done; }));
  const polling = f.monitor.poll();
  f.store.put('runs', run.id, { ...run, status: 'cancelled' });
  resolve({ state: 'completed', text: 'done', source: 'codex-json', nativeSessionId: 'thread-a', progress });
  await polling;
  assert.equal(f.results.length, 0);
  assert.equal(f.store.get<Run>('runs', run.id)!.status, 'cancelled');
});

test('review: input approval is the same real blocker in HTTP and scoped work context', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-progress-review-http-'));
  const server = await startServer({ dataDir: dir, host: '127.0.0.1', port: 0, demo: true, token: 'fixture' });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  server.app.store.put('runs', run.id, run);
  const approval = server.app.approvals.propose({ kind: 'input', title: '确认继续', details: '', params: { id: run.id, text: 'continue' } });
  const response = await fetch(`${server.url}/api/v1/runs/${run.id}/observations`, { headers: { authorization: 'Bearer fixture' } });
  assert.equal(response.status, 200);
  const observation = await response.json();
  assert.deepEqual(observation.blockedBy.map((item: any) => item.id), [approval.id]);
  const context = buildWorkContext(server.app.store, { kind: 'project', projectId: 'project-a' });
  assert.deepEqual(context.runs!.items[0].blockedBy.map(item => item.id), [approval.id]);
  assert.deepEqual(context.needsYou!.items.map(item => item.id), [approval.id]);
});

test('review: full server restart preserves last progress and blocker, makes active outcome unknown', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-progress-review-restart-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await server?.close(); await rm(dir, { recursive: true, force: true }); });
  server = await startServer({ dataDir: dir, host: '127.0.0.1', port: 0, demo: true });
  server.app.store.put('runs', run.id, { ...run, progress });
  const card = server.app.interactions.open({ kind: 'permission', title: '确认目录', body: '', runId: run.id });
  await server.close();
  server = undefined;
  server = await startServer({ dataDir: dir, host: '127.0.0.1', port: 0, demo: true });
  const observation = server.app.runObservations(run.id);
  assert.equal(observation.status, 'unknown');
  assert.deepEqual(observation.progress, progress);
  assert.deepEqual(observation.blockedBy.map(item => item.id), [card.id]);
  assert.equal(server.app.store.get('messages', `run-result:${run.id}`), undefined, 'restart cannot invent a completion message');
});

test('review: rejected sources cannot mutate any evidence for any result state', async t => {
  const f = await monitorFixture(t);
  const before = { ...run, progress, resultSource: 'codex-json', output: 'trusted output' };
  f.store.put('runs', run.id, before);
  for (const source of ['screen', 'text', 'unknown', 'other-parser']) {
    for (const state of ['running', 'completed', 'failed', 'unknown']) {
      f.reply({ state, source, text: 'untrusted output', nativeSessionId: 'thread-b',
        progress: { ...progress, phase: 'responding' } });
      await f.monitor.poll();
      assert.deepEqual(f.store.get('runs', run.id), before, `${source}/${state}`);
    }
  }
  assert.equal(f.results.length, 0);
});

test('review: the first trusted native identity pins subsequent output, progress and outcomes', async t => {
  const f = await monitorFixture(t);
  f.store.put('runs', run.id, { ...run, nativeSessionId: undefined });
  f.reply({ state: 'running', source: 'screen', text: 'forged', nativeSessionId: 'thread-b', progress });
  await f.monitor.poll();
  assert.equal(f.store.get<Run>('runs', run.id)!.nativeSessionId, undefined);
  f.reply({ state: 'running', source: 'codex-json', text: 'trusted', nativeSessionId: 'thread-a', progress });
  await f.monitor.poll();
  const pinned = f.store.get<Run>('runs', run.id)!;
  assert.equal(pinned.nativeSessionId, 'thread-a');
  assert.deepEqual(pinned.progress, progress);
  for (const nativeSessionId of ['thread-b', undefined, '']) {
    for (const state of ['running', 'completed', 'failed', 'unknown']) {
      f.reply({ state, source: 'codex-json', text: 'wrong thread', nativeSessionId,
        progress: { ...progress, phase: 'responding' } });
      await f.monitor.poll();
      assert.deepEqual(f.store.get('runs', run.id), pinned, `${nativeSessionId}/${state}`);
    }
  }
  assert.equal(f.results.length, 0);
  f.reply({ state: 'completed', source: 'codex-json', text: 'done', nativeSessionId: 'thread-a', progress });
  await f.monitor.poll();
  assert.equal(f.results.length, 1);
  assert.equal(f.store.get<Run>('runs', run.id)!.status, 'completed');
});

test('review: legacy explicit parser outcomes remain compatible without inventing native capabilities', async t => {
  const f = await monitorFixture(t);
  const legacy = { ...run, nativeResultSources: undefined, nativeSessionId: undefined };
  for (const source of ['codex-json', 'claude-result', 'claude-stream-json']) {
    for (const state of ['completed', 'failed'] as const) {
      f.store.put('runs', run.id, legacy);
      const count = f.results.length;
      f.reply({ state, source, text: 'explicit native outcome', nativeSessionId: 'legacy-thread', progress });
      await f.monitor.poll();
      assert.equal(f.results.length, count + 1, `${source}/${state}`);
      const current = f.store.get<Run>('runs', run.id)!;
      assert.equal(current.status, state);
      assert.equal(current.nativeSessionId, 'legacy-thread');
      assert.equal(current.resultSource, source);
      assert.equal(current.nativeResultSources, undefined);
      assert.equal(current.progress, undefined, 'old agents did not declare progress support');
    }
  }
  for (const nativeResultSources of [undefined, []]) {
    for (const source of ['screen', 'text', 'unknown', 'other-parser', ...(nativeResultSources ? ['codex-json'] : [])]) {
      const before = { ...legacy, nativeResultSources };
      f.store.put('runs', run.id, before);
      const count = f.results.length;
      f.reply({ state: 'completed', source, text: 'unverified', nativeSessionId: 'forged', progress });
      await f.monitor.poll();
      assert.equal(f.results.length, count);
      assert.deepEqual(f.store.get('runs', run.id), JSON.parse(JSON.stringify(before)));
    }
  }
});

test('review: input blocker scope follows its run and todo before supplied labels', async t => {
  const f = await monitorFixture(t);
  f.store.put('todos', 'todo-a', { id: 'todo-a', projectId: 'project-a', title: 'A', createdAt: observedAt });
  f.store.put('todos', 'todo-b', { id: 'todo-b', projectId: 'project-b', title: 'B', createdAt: observedAt });
  f.store.put('runs', run.id, { ...run, projectId: 'stale-project', todoId: 'todo-a' });
  f.store.put('runs', 'foreign-run', { ...run, id: 'foreign-run', projectId: 'project-b', todoId: 'todo-b' });
  f.store.put('runs', 'global-run', { ...run, id: 'global-run', projectId: undefined });
  for (const [id, runId, projectId, todoId] of [
    ['own', run.id, 'project-b', 'todo-b'],
    ['foreign', 'foreign-run', 'project-a', 'todo-a'],
    ['global', 'global-run', 'project-a', 'todo-a'],
  ]) {
    f.store.put('approvals', id, { id, kind: 'input', status: 'pending', title: `${id}-blocker`, todoId,
      params: { id: runId, projectId, todoId }, version: 1, createdAt: observedAt });
  }
  for (const scope of [
    { kind: 'project' as const, projectId: 'project-a' },
    { kind: 'task' as const, projectId: 'project-a', todoId: 'todo-a' },
  ]) {
    const context = buildWorkContext(f.store, scope);
    assert.deepEqual(context.needsYou!.items.map(item => item.id), ['own']);
    assert.equal(context.needsYou!.items[0].runId, run.id);
    assert.doesNotMatch(JSON.stringify(context), /foreign-blocker|global-blocker/);
  }
});

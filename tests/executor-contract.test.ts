import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import type { Executor, MachineClient } from '../packages/plugin-sdk/src/index.ts';
import type { ExecutionResult, Json, JsonObject, Run } from '../packages/protocol/src/index.ts';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-executor-contract-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, demo: false };
  let app = await createWorkbench(config);
  t.after(async () => { try { await app.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  return {
    get app() { return app; },
    async restart() { await app.close(); app = await createWorkbench(config); },
    async install(execute: Executor['execute']) {
      app.plugins.register({ id: 'custom-plugin', name: 'Custom', capabilities: ['executors'], activate(ctx) {
        ctx.contribute('executors', 'custom', {
          id: 'custom', name: 'Custom', kind: 'custom', machineId: 'plugin-owned', mode: 'real', available: true,
          description: 'Local contract fixture; no machine client or CLI', execute,
        });
      } });
      await app.plugins.setEnabled('custom-plugin', true);
    },
  };
}
async function waitRun(app: Awaited<ReturnType<typeof createWorkbench>>, id: string, check: (run: Run) => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const run = app.store.get<Run>('runs', id)!;
    if (check(run)) return run;
    await delay(10);
  }
  assert.fail('Executor contract state timeout');
}
const task = { executorId: 'custom', prompt: 'contract task', doneWhen: 'return result', expectMinutes: 1 };

// These executors are registered through the existing plugin lifecycle, without MachineClient.
test('real custom executor completes without cwd, streams output and claims Effects before execution once', async t => {
  const f = await fixture(t);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  await f.install(async request => {
    calls++;
    assert.equal(request.cwd, undefined);
    assert.equal(request.executionMode, 'task');
    assert.equal(request.signal.aborted, false);
    assert.equal(f.app.effects.list()[0].status, 'sent');
    request.onOutput?.('first chunk');
    request.onOutput?.(' + second chunk');
    await gate;
    return { text: 'custom final result' };
  });
  const run = f.app.dispatch(task, 'custom-complete');
  assert.equal(f.app.dispatch(task, 'custom-complete').id, run.id);
  try {
    const streaming = await waitRun(f.app, run.id, value => Boolean(value.output));
    assert.equal(streaming.output, 'first chunk + second chunk');
    assert.equal(streaming.status, 'running');
    assert.equal(calls, 1);
  } finally { release(); }
  const completed = await waitRun(f.app, run.id, value => value.status === 'completed');
  assert.equal(completed.output, 'custom final result');
  assert.equal(completed.resultSource, 'real');
  assert.equal(f.app.effects.list()[0].status, 'confirmed');
  assert.deepEqual(f.app.effects.list()[0].result, { text: 'custom final result' });
  assert.equal(f.app.store.list('messages').length, 1);
  await f.restart();
  await f.install(async () => { calls++; throw new Error('must not replay'); });
  assert.equal(f.app.dispatch(task, 'custom-complete').id, run.id);
  assert.equal(calls, 1);
  assert.equal(f.app.store.get<Run>('runs', run.id)?.status, 'completed');
});

for (const definite of [true, false]) {
  test(`real custom executor preserves ${definite ? 'definite failure' : 'uncertain delivery'} and never replays`, async t => {
    const f = await fixture(t);
    let calls = 0;
    const execute: Executor['execute'] = async () => {
      calls++;
      throw definite ? Object.assign(new Error('custom rejected'), { delivery: 'no' }) : new Error('custom receipt lost');
    };
    await f.install(execute);
    const run = f.app.dispatch(task, 'custom-failure');
    const status = definite ? 'failed' : 'unknown';
    const failed = await waitRun(f.app, run.id, value => value.status === status);
    assert.equal(failed.error, definite ? 'custom rejected' : 'custom receipt lost');
    assert.equal(f.app.effects.list()[0].status, status);
    assert.equal(f.app.dispatch(task, 'custom-failure').id, run.id);
    await f.restart();
    await f.install(execute);
    assert.equal(f.app.dispatch(task, 'custom-failure').id, run.id);
    assert.equal(f.app.store.get<Run>('runs', run.id)?.status, status);
    assert.equal(calls, 1);
  });
}

test('real custom executor receives cancel signal and cancellation stays unknown without a result message', async t => {
  const f = await fixture(t);
  let signal: AbortSignal | undefined;
  await f.install(async request => {
    signal = request.signal;
    request.onOutput?.('started');
    await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
    return { text: 'interrupted' };
  });
  const run = f.app.dispatch({ ...task, executionMode: 'interactive' });
  await waitRun(f.app, run.id, value => value.output === 'started');
  await f.app.cancel(run.id);
  assert.equal(signal?.aborted, true);
  await waitRun(f.app, run.id, value => value.status === 'unknown');
  assert.deepEqual(f.app.store.list('messages'), []);
});

test('real custom pending result preserves session and text without claiming completion or replaying on restart', async t => {
  const f = await fixture(t);
  let calls = 0;
  const execute: Executor['execute'] = async ({ executionMode }) => {
    calls++;
    assert.equal(executionMode, 'interactive');
    return { text: 'custom pending', pending: true, sessionId: 'custom-session' };
  };
  await f.install(execute);
  const input = { ...task, executionMode: 'interactive' };
  const run = f.app.dispatch(input, 'custom-pending');
  const pending = await waitRun(f.app, run.id, value => Boolean(value.sessionId));
  assert.equal(pending.status, 'running');
  assert.equal(pending.output, 'custom pending');
  assert.equal(pending.sessionId, 'custom-session');
  assert.deepEqual(f.app.store.list('messages'), []);
  await f.restart();
  await f.install(execute);
  assert.equal(f.app.dispatch(input, 'custom-pending').status, 'unknown');
  assert.equal(calls, 1);
});

function machineClient(call: MachineClient['call']): MachineClient {
  return { list: () => [{ id: 'remote', name: 'Fake remote', online: true, platform: 'linux', connectedAt: new Date().toISOString(),
    capabilities: ['executor.start', 'executor.result'], executors: [{ id: 'codex', name: 'Fake Codex', kind: 'cli', machineId: 'remote',
      available: true, mode: 'real', description: 'No real machine or CLI' }],
  }], call };
}
for (const [executionMode, nativeState] of [['task', 'completed'], ['task', 'failed'], ['interactive', 'completed']] as const) {
  test(`remote adapter forwards ${executionMode} once and retains native ${nativeState} result semantics`, async t => {
    const f = await fixture(t);
    const launches: JsonObject[] = [];
    let resultReads = 0;
    const native: ExecutionResult = { state: nativeState, text: 'native task result', source: 'codex-json', nativeSessionId: 'native-id', exitCode: nativeState === 'failed' ? 1 : 0 };
    const client = machineClient(async (id, method, params): Promise<Json> => {
      assert.equal(id, 'remote');
      if (method === 'executor.start') { launches.push(params); return { sessionId: 'remote-session' }; }
      assert.equal(method, 'executor.result');
      assert.deepEqual(params, { sessionId: 'remote-session' });
      resultReads++;
      return { ...native };
    });
    f.app.setMachineClient(client);
    const input = { ...task, executorId: 'remote/codex', cwd: '/fake/work', executionMode };
    const run = f.app.dispatch(input, 'remote-start');
    assert.equal(f.app.dispatch(input, 'remote-start').id, run.id);
    const pending = await waitRun(f.app, run.id, value => Boolean(value.sessionId));
    assert.equal(pending.status, 'running');
    assert.equal(pending.machineId, 'remote');
    assert.equal(launches.length, 1);
    const { prompt, ...target } = launches[0]!;
    assert.deepEqual(target, { executorId: 'codex', cwd: '/fake/work', mode: executionMode });
    if (executionMode === 'interactive') assert.equal(prompt, task.prompt);
    else {
      assert.ok(typeof prompt === 'string' && prompt.startsWith(task.prompt));
      assert.ok(prompt.includes('本次任务的验收标准：' + JSON.stringify(task.doneWhen)));
    }
    assert.deepEqual(f.app.store.list('messages'), []);
    await f.app.monitor.poll();
    const current = f.app.store.get<Run>('runs', run.id)!;
    assert.equal(current.status, executionMode === 'task' ? nativeState : 'running');
    if (executionMode === 'task') {
      assert.equal(current.output, native.text);
      assert.equal(current.resultSource, native.source);
      assert.equal(f.app.store.list('messages').length, 1);
    } else assert.equal(resultReads, 0);
    await f.restart();
    f.app.setMachineClient(client);
    assert.equal(f.app.dispatch(input, 'remote-start').id, run.id);
    await f.app.monitor.poll();
    assert.equal(launches.length, 1);
    assert.equal(f.app.effects.list().length, 1);
    assert.equal(f.app.effects.list()[0].status, 'confirmed');
  });
}

test('remote adapter rejects missing cwd before RPC with a definite failure', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.app.setMachineClient(machineClient(async () => { calls++; return { sessionId: 'unexpected' }; }));
  const run = f.app.dispatch({ ...task, executorId: 'remote/codex' });
  const failed = await waitRun(f.app, run.id, value => value.status === 'failed');
  assert.match(failed.error!, /远端工作目录/);
  assert.equal(f.app.effects.list()[0].status, 'failed');
  assert.equal(calls, 0);
});

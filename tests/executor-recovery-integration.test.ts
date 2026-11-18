import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExecutionServices } from '../plugins/executors.ts';
import { createTerminalHost } from '../plugins/terminal-host.ts';
import type { TerminalHost } from '../packages/plugin-sdk/src/index.ts';
import type { JsonObject, SessionBinding } from '../packages/protocol/src/index.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-recovery-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const calls: string[] = [];
  const host: TerminalHost = {
    status: async () => ({ available: true }),
    list: async () => { calls.push('list'); return [{ id: 'same-pane', cwd: dir, title: 'same' }]; },
    create: async spec => ({ id: 'same-pane', cwd: spec.cwd, title: spec.name }),
    read: async () => { calls.push('read'); return { text: 'current', ansi: 'current' }; },
    input: async () => { calls.push('input'); }, keys: async () => { calls.push('keys'); },
    close: async () => { calls.push('close'); },
    watch: async () => { calls.push('watch'); return () => { calls.push('dispose'); }; },
  };
  const options = { host, dataDir: dir, machineId: 'machine', agentInstanceId: 'agent-1', hasCommand: () => true };
  const service = createExecutionServices(options);
  t.after(() => service.close());
  const call = (method: string, params: JsonObject = {}) => service.handlers[method]!(params, () => {});
  const start = async (mode = 'interactive') => await call('executor.start', { executorId: 'codex', cwd: dir, prompt: 'fake', mode }) as unknown as SessionBinding;
  return { dir, host, calls, options, service, call, start };
}

test('services restart refuses all historical observe/control paths even with same agent/pane/cwd', async t => {
  const { dir, calls, options, call, start } = await fixture(t);
  const b = await start();
  const before = await readFile(join(dir, 'executor-sessions.json'), 'utf8');
  const recovered = createExecutionServices(options); // Even an accidentally reused diagnostic agent ID grants no ownership.
  t.after(() => recovered.close());
  const rpc = (method: string, params: JsonObject = {}) => recovered.handlers[method]!(params, () => {});
  const recovery = await rpc('executor.recovery', { sessionId: b.sessionId }) as unknown as {
    machineId: string; agentInstanceId: string; host: { identity: { state: string }; atomicControl: { state: string } };
    sessions: { origin: string; canObserve: boolean; canControl: boolean; reason: string }[];
  };
  assert.equal(recovery.machineId, 'machine');
  assert.equal(recovery.agentInstanceId, 'agent-1');
  assert.equal(recovery.host.identity.state, 'unknown');
  assert.equal(recovery.host.atomicControl.state, 'unsupported');
  assert.equal(recovery.sessions[0]!.origin, 'restored');
  assert.equal(recovery.sessions[0]!.canObserve, false);
  assert.equal(recovery.sessions[0]!.canControl, false);
  for (const method of ['executor.input', 'executor.interrupt', 'executor.read']) {
    await assert.rejects(rpc(method, { sessionId: b.sessionId, text: 'no' }), /ownership is unknown/);
  }
  for (const method of ['terminal.input', 'terminal.keys', 'terminal.close', 'terminal.read', 'terminal.watch']) {
    await assert.rejects(rpc(method, { paneId: b.paneId, text: 'no', keys: ['C-c'] }), /ownership is unknown/);
  }
  const result = await rpc('executor.result', { sessionId: b.sessionId }) as { state: string; text: string };
  assert.equal(result.state, 'unknown');
  assert.match(result.text, /no native task result/);
  assert.deepEqual(calls, []); // Not even a pane list/read is used as recovery proof.
  assert.equal(await readFile(join(dir, 'executor-sessions.json'), 'utf8'), before);
  assert.deepEqual(await rpc('executor.sessions'), await call('executor.sessions'));
  await assert.rejects(rpc('executor.recovery', { sessionId: 'missing' }), /not bound/);
  await assert.rejects(rpc('executor.recovery', { command: 'unsafe' }), /Invalid recovery/);
});

test('restored task native file stays readable without contacting its old pane', async t => {
  const { dir, calls, options, start } = await fixture(t);
  const b = await start('task');
  const recovered = createExecutionServices({ ...options, agentInstanceId: 'agent-2' });
  t.after(() => recovered.close());
  const rpc = (method: string, params: JsonObject) => recovered.handlers[method]!(params, () => {});
  const params = { sessionId: b.sessionId };
  assert.match((await rpc('executor.result', params) as { text: string }).text, /ownership is unknown/);
  const path = join(dir, 'task-results', b.sessionId + '.json');
  const native = { state: 'completed', text: 'real persisted native result', source: 'codex-json', nativeSessionId: 'native', exitCode: 0 };
  await writeFile(path, JSON.stringify(native));
  // Result file suffices even if its historical config is no longer present.
  await rm(join(dir, 'task-results', b.sessionId + '.config.json'));
  assert.deepEqual(await rpc('executor.result', params), native);
  await assert.rejects(rpc('executor.read', params), /ownership is unknown/);
  await assert.rejects(rpc('terminal.read', { paneId: b.paneId }), /ownership is unknown/);
  assert.deepEqual(calls, []);
});

test('disconnect preserves current-agent authority; unbound explicit terminal observation remains usable', async t => {
  const { calls, service, call, start } = await fixture(t);
  const b = await start();
  await call('terminal.watch', { paneId: b.paneId });
  await service.disconnect();
  const recovery = await call('executor.recovery') as unknown as { sessions: { origin: string; canObserve: boolean; canControl: boolean }[] };
  assert.deepEqual(recovery.sessions, [{ sessionId: b.sessionId, paneId: b.paneId, origin: 'current-agent', canObserve: true, canControl: true }]);
  await call('executor.input', { sessionId: b.sessionId, text: 'current' });
  await call('executor.read', { sessionId: b.sessionId });
  await call('terminal.watch', { paneId: b.paneId });
  await call('terminal.read', { paneId: 'explicit-unbound' });
  await call('terminal.watch', { paneId: 'explicit-unbound' });
  await service.disconnect();
  assert.ok(calls.includes('input'));
  assert.ok(calls.includes('keys'));
  assert.equal(calls.filter(c => c === 'read').length, 2);
  assert.equal(calls.filter(c => c === 'dispose').length, 3);
  assert.ok(!calls.includes('close'));
});

test('new bindings persist only genuine host fields; described identity never restores atomic control', async t => {
  const { dir, host, options, start } = await fixture(t);
  host.describeInstance = async scope => ({
    ...scope, hostKind: 'test-host',
    identity: { state: 'known', id: 'genuine-test-instance', source: 'explicit-test-double' },
    atomicControl: { state: 'supported', source: 'explicit-test-double' },
  });
  const b = await start();
  const stored = JSON.parse(await readFile(join(dir, 'executor-sessions.json'), 'utf8'))[0];
  assert.equal(stored.machineId, 'machine');
  assert.equal(stored.agentInstanceId, 'agent-1');
  assert.equal(stored.hostInstanceId, 'genuine-test-instance');
  assert.equal(stored.hostKind, 'test-host');
  assert.equal(stored.terminalId, undefined);
  const recovered = createExecutionServices(options);
  t.after(() => recovered.close());
  const report = await recovered.handlers['executor.recovery']!({}, () => {}) as unknown as { sessions: { canControl: boolean }[] };
  assert.equal(report.sessions[0]!.canControl, false);
  await assert.rejects(recovered.handlers['executor.interrupt']!({ sessionId: b.sessionId }, () => {}), /ownership is unknown/);
});

test('legacy binding is kept unchanged, and describe failures expose no private upstream details', async t => {
  const { dir, host, options, service } = await fixture(t);
  const legacy = { sessionId: 'legacy', paneId: 'same-pane', executorId: 'codex', cwd: dir, createdAt: 'old' };
  await writeFile(join(dir, 'executor-sessions.json'), JSON.stringify([legacy]));
  host.describeInstance = async () => { throw new Error('SECRET /private/launcher stderr'); };
  const recovered = createExecutionServices(options);
  t.after(() => recovered.close());
  const result = await recovered.handlers['executor.recovery']!({}, () => {});
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.deepEqual(await recovered.handlers['executor.sessions']!({}, () => {}), [legacy]);
  // A host description error must not break creation on the running services.
  await service.handlers['executor.start']!({ executorId: 'codex', cwd: dir, prompt: 'new' }, () => {});
  const fresh = JSON.parse(await readFile(join(dir, 'executor-sessions.json'), 'utf8'))[0];
  assert.equal(fresh.agentInstanceId, 'agent-1');
  assert.equal(fresh.hostInstanceId, undefined);
  assert.equal(fresh.terminalId, undefined);
});

test('terminal describe uses only read-only status and returns safe unknown on upstream errors', async t => {
  const { dir } = await fixture(t);
  const log = join(dir, 'describe-calls');
  const command = join(dir, 'fake-status.cjs');
  await writeFile(command, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAIL_STATUS) { console.error('SECRET private launcher'); process.exit(1); }
console.log(JSON.stringify({running:true, compatible:true, daemon_id:'not-a-real-field', session:'not-an-instance'}));
`);
  await chmod(command, 0o700);
  const scope = { machineId: 'machine', agentInstanceId: 'agent' };
  const host = createTerminalHost({ command });
  const description = await host.describeInstance!(scope);
  assert.equal(description.identity.state, 'unknown');
  assert.equal(description.atomicControl.state, 'unsupported');
  const failed = await createTerminalHost({ command, env: { FAIL_STATUS: '1' } }).describeInstance!(scope);
  assert.equal(failed.identity.state, 'unknown');
  assert.ok(!JSON.stringify(failed).includes('SECRET'));
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [
    ['status', 'server', '--json'], ['status', 'server', '--json'],
  ]);
});

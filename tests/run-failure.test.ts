import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { buildInfo } from '../packages/core/src/build-info.ts';
import { MachineError } from '../packages/core/src/machines.ts';
import { failureKind, failureStage, withoutHome, type RunDiagnostics } from '../packages/core/src/run-failure.ts';
import type { NodeHandler, TerminalHost } from '../packages/plugin-sdk/src/index.ts';
import type { Run } from '../packages/protocol/src/index.ts';
import { createExecutionServices } from '../plugins/executors.ts';

test('失败的类别按错误的类型来定，不看错误里写了什么', () => {
  // The machine channel: not reachable, timed out, refused by the machine, and failed on it.
  assert.equal(failureKind(new MachineError('Machine is offline', 503, 'no')), 'network');
  assert.equal(failureKind(new MachineError('Machine RPC timed out; execution outcome is unknown', 504, 'unknown')), 'network');
  assert.equal(failureKind(new MachineError('unsupported method', 400, 'no')), 'refused');
  assert.equal(failureKind(new MachineError('Invalid RPC parameters', 400, 'no')), 'refused');
  assert.equal(failureKind(new MachineError('handler failed', 502, 'unknown')), 'machine');
  // The same status as a handler that failed, but the connection was what went away.
  assert.equal(failureKind(new MachineError('Machine disconnected; execution outcome is unknown', 502, 'unknown', true)), 'network');
  // The words of an error do not decide it: an offline machine that says something else is
  // still offline, and an executor's failure does not become a network failure by saying so.
  assert.equal(failureKind(new MachineError('网络断了', 503, 'no')), 'network');
  assert.equal(failureKind(new MachineError('Machine is offline', 502, 'unknown')), 'machine');
  assert.equal(failureKind(new MachineError('网络断了', 502, 'unknown', true)), 'network');
  // The workbench itself, with its own named refusal and with any other error.
  const refusal = Object.assign(new Error('目录不能为空'), { name: 'InputError', status: 400 });
  assert.equal(failureKind(refusal), 'refused');
  assert.equal(failureKind(new Error('执行记录保存失败')), 'server');
  assert.equal(failureKind(new TypeError('cannot read properties')), 'server');
  assert.equal(failureKind('a string'), 'unknown');
  assert.equal(failureKind(undefined), 'unknown');
});

test('失败的阶段看执行走到了哪一步', () => {
  const base = { status: 'failed' as const, createdAt: '2026-11-27T10:00:00.000Z' };
  // No session: it never started. Cancelled before it left the queue: still being dispatched.
  assert.equal(failureStage({ ...base }), 'start');
  assert.equal(failureStage({ ...base, status: 'cancelled' }), 'dispatch');
  // A session: it was running.
  assert.equal(failureStage({ ...base, sessionId: 's1' }), 'run');
  // Marked when the server came back up: a recovery.
  assert.equal(failureStage({ ...base, status: 'unknown', error: '服务重启，执行结果尚未确认' }), 'recover');
  assert.equal(failureStage({ ...base, sessionId: 's1', error: '服务重启，执行结果尚未确认' }), 'recover');
});

/** `beforeStart` may replace a handler before the node takes its snapshot of them. */
async function fixture(t: TestContext, beforeStart?: (handlers: Record<string, NodeHandler>) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-run-failure-'));
  const token = 'offline-run-failure';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token });
  const machineId = 'fixture-failing-machine', agentInstanceId = 'fixture-failing-instance';
  // The executor is the real one, and reports itself available because a command is said to be
  // present. Starting it goes through the terminal host, which here refuses. No process runs.
  const host: TerminalHost = {
    async status() { return { available: true }; }, async list() { return []; },
    async create() {
      throw new Error('合成启动失败');
    },
    async read() { return { text: '', ansi: '' }; }, async input() { assert.fail('不应向终端输入'); },
    async keys() { assert.fail('不应发送按键'); }, async close() {}, async watch() { return () => {}; },
  };
  const agentDir = join(dir, 'agent');
  const services = createExecutionServices({ host, machineId, agentInstanceId, dataDir: agentDir, hasCommand: () => true });
  beforeStart?.(services.handlers);
  const node = startAgentNode({ url: server.url, token, machineId, agentInstanceId, name: '合成失败电脑', dataDir: agentDir,
    executors: await services.describe(machineId), handlers: services.handlers });
  t.after(async () => { await node.close(); await services.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await t.waitFor(() => assert.ok(server.machines.list().some(row => row.id === machineId && row.online)));
  const web = async <T>(path: string, method = 'GET', body?: object): Promise<T> => {
    const answer = await fetch(server.url + '/api/v1/' + path, { method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!answer.ok) throw new Error(path + ' ' + answer.status + ' ' + (await answer.text()).slice(0, 200));
    return await answer.json() as T;
  };
  const read = async (id: string) => (await web<{ runs: Run[] }>('state')).runs.find(row => row.id === id)!;
  return { server, machineId, web, read, node };
}

test('派工时记下服务端和执行机当时的构建；启动失败时记下类别和时间', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const todo = await f.web<{ id: string }>('todos', 'POST', { title: '合成执行任务' });
  const run = await f.web<Run>('runs', 'POST', { executorId: f.machineId + '/pi', executionMode: 'task', todoId: todo.id, doneWhen: '有明确的合成结果', expectMinutes: 5, prompt: '合成的启动失败', cwd: tmpdir() });
  const done = await t.waitFor(async () => {
    const row = await f.read(run.id);
    assert.ok(row.status === 'failed' || row.status === 'unknown', row.status);
    return row;
  });
  // What was running when the run was made. The server's build is its own; the machine's is
  // what it said when it came online, which is the real agent node started here.
  // The server's own record also says when it was built; the run keeps only what tells builds apart.
  assert.equal(done.build?.server.commit, buildInfo().commit);
  assert.equal(done.build?.server.dirty, buildInfo().dirty ? true : undefined);
  const machine = f.server.machines.list().find(row => row.id === f.machineId)!;
  assert.deepEqual(done.build?.machine, machine.build);
  assert.match(done.build!.machine!.commit, /^(?:unknown|[0-9a-f]{40})$/);
  // The start never got a session, and the failure says what kind of thing went wrong and when.
  assert.equal(done.sessionId, undefined);
  assert.equal(done.failure?.kind, 'machine');
  assert.equal(Number.isNaN(Date.parse(done.failure!.at)), false);
  assert.equal(failureStage(done), 'start');
});

test('插件在派工前拒绝：类别是拒绝，阶段是派发，执行机没有被叫到', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  let asked = 0;
  f.server.app.contributions.add('hooks', 'fixture-refusal', { name: 'work.dispatch', phase: 'before',
    handler: () => ({ action: 'deny', reason: '合成插件拒绝派工' }) });
  // This one runs first, so that it is reached before the refusal stops the dispatch.
  f.server.app.contributions.add('hooks', 'fixture-count', { name: 'work.dispatch', phase: 'before', order: -1,
    handler: () => { asked++; return undefined; } });
  const todo = await f.web<{ id: string }>('todos', 'POST', { title: '合成执行任务' });
  const run = await f.web<Run>('runs', 'POST', { executorId: f.machineId + '/pi', executionMode: 'task', todoId: todo.id, doneWhen: '有明确的合成结果', expectMinutes: 5, prompt: '合成的参数被拒', cwd: tmpdir() });
  const done = await t.waitFor(async () => {
    const row = await f.read(run.id);
    assert.ok(row.status === 'failed' || row.status === 'unknown');
    return row;
  });
  assert.equal(done.failure?.kind, 'refused');
  assert.equal(failureStage(done), 'start');
  // The hooks ran, and the machine was never asked to start anything.
  assert.equal(asked, 1);
  assert.equal(f.server.machines.list().find(row => row.id === f.machineId)?.online, true);
});

test('执行机收到启动请求后断线：结果是未知，类别是网络，阶段是启动', { timeout: 30000 }, async t => {
  let cut!: () => void;
  const f = await fixture(t, handlers => {
    // The node answers the start by closing its own connection and never answering. The request
    // was sent, so what the executor did with it is not known.
    handlers['executor.start'] = async () => { cut(); return new Promise<never>(() => {}); };
  });
  cut = () => { void f.node.close(); };
  const todo = await f.web<{ id: string }>('todos', 'POST', { title: '合成执行任务' });
  const run = await f.web<Run>('runs', 'POST', { executorId: f.machineId + '/pi', executionMode: 'task', todoId: todo.id, doneWhen: '有明确的合成结果', expectMinutes: 5, prompt: '合成断线', cwd: tmpdir() });
  const done = await t.waitFor(async () => {
    const row = await f.read(run.id);
    assert.ok(row.status === 'failed' || row.status === 'unknown', row.status);
    return row;
  });
  assert.equal(done.status, 'unknown');
  assert.equal(done.failure?.kind, 'network');
  assert.equal(failureStage(done), 'start');
  assert.equal(f.server.machines.list().find(row => row.id === f.machineId)?.online, false);
  // The start is an effect. Its own record says the outcome is unknown, so nothing is resent.
  const effect = f.server.app.store.list<{ key: string; status: string }>('effects').find(row => row.key === 'run:' + run.id + ':start');
  assert.equal(effect?.status, 'unknown');
});

test('诊断报告有编号、电脑、构建、失败类别和阶段，没有提示词、输出和错误原文', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const todo = await f.web<{ id: string }>('todos', 'POST', { title: '合成执行任务' });
  const prompt = '合成的诊断报告任务，内容不应出现在报告里';
  const run = await f.web<Run>('runs', 'POST', { executorId: f.machineId + '/pi', executionMode: 'task', todoId: todo.id, doneWhen: '有明确的合成结果', expectMinutes: 5, prompt, cwd: tmpdir() });
  await t.waitFor(async () => {
    const row = await f.read(run.id);
    assert.ok(row.status === 'failed' || row.status === 'unknown', row.status);
  });
  const done = await f.read(run.id);
  // A directory under a home directory is written with ~ in place of the user's name.
  const homeRun = await f.web<Run>('runs', 'POST', { executorId: f.machineId + '/pi', executionMode: 'task', prompt: '合成', doneWhen: '有结果', expectMinutes: 1, cwd: '/home/synthetic-person/project' });
  void homeRun;
  const report = await f.web<RunDiagnostics>(`runs/${run.id}/diagnostics`);
  assert.equal(report.format, 'super-mario.run-diagnostics');
  assert.equal(report.version, 1);
  assert.equal(Number.isNaN(Date.parse(report.exportedAt)), false);
  assert.equal(report.run.id, run.id);
  assert.equal(report.run.executorId, f.machineId + '/pi');
  assert.equal(report.run.machineId, f.machineId);
  assert.equal(report.run.status, done.status);
  assert.equal(report.run.todoId, todo.id);
  assert.equal(report.run.executionMode, 'task');
  assert.equal(typeof report.run.durationMs, 'number');
  assert.equal(report.run.build?.server.commit, buildInfo().commit);
  // The prompt, the output and the error's words are the person's own content and stay out.
  const text = JSON.stringify(report);
  assert.equal(text.includes(prompt), false);
  if (done.error) assert.equal(text.includes(done.error), false);
  if (done.output) assert.equal(text.includes(done.output), false);
  assert.equal('prompt' in report.run, false);
  assert.equal('output' in report.run, false);
  assert.equal('error' in report.run, false);
  assert.equal(report.run.failure && typeof report.run.failure === 'object', true);
  const homeReport = await f.web<RunDiagnostics>(`runs/${homeRun.id}/diagnostics`);
  assert.equal(homeReport.run.cwd, '~/project');
  assert.equal(JSON.stringify(homeReport).includes('synthetic-person'), false);
});

test('报告里的路径不带走家目录里的用户名', () => {
  assert.equal(withoutHome('/data00/home/someone/project'), '~/project');
  assert.equal(withoutHome('/home/alice/code'), '~/code');
  assert.equal(withoutHome('/Users/bob/dev'), '~/dev');
  assert.equal(withoutHome('/root/work'), '~/work');
  assert.equal(withoutHome('C:\\Users\\carol\\dev'), '~\\dev');
  // Not a home directory: left as it is.
  assert.equal(withoutHome('/tmp/runner'), '/tmp/runner');
  assert.equal(withoutHome('/srv/app'), '/srv/app');
  // The same pattern is used more than once, so it must start from the beginning each time.
  assert.equal(withoutHome('/home/a/x'), '~/x');
  assert.equal(withoutHome('/home/b/y'), '~/y');
});

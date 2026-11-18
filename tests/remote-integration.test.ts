import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createExecutionServices } from '../plugins/executors.ts';
import type { TerminalHost } from '../packages/plugin-sdk/src/index.ts';
import type { InboxItem, JsonObject, MachineInfo, PaneInfo, Run, SessionBinding, Snapshot, TerminalFrame } from '../packages/protocol/src/index.ts';

async function eventually<T>(read: () => T | Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await delay(10);
  }
  throw new Error('Local integration state did not arrive');
}

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'super-mario-remote-integration-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, token: 'local-integration-token', demo: true };
  const running = await startServer(config);
  t.after(async () => { await running.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`${running.url}/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const state = async () => await (await request('/state')).json() as Snapshot;
  return { dataDir, config, running, request, state };
}

test('remote dispatch and terminal observation preserve running state and never replay writes', async t => {
  const f = await fixture(t);
  const machineId = 'fake-terminal-node';
  const nodeDir = join(f.dataDir, 'node');
  const panes: PaneInfo[] = [];
  const creates: Parameters<TerminalHost['create']>[0][] = [];
  const inputs: Array<[string, string]> = [];
  const keys: Array<[string, string[]]> = [];
  const closedPanes: string[] = [];
  const watchers = new Map<string, (frame: TerminalFrame) => void>();
  let watchCount = 0, disposed = 0;
  let holdInput = false;
  let releaseInput: (() => void) | undefined;
  const host: TerminalHost = {
    async status() { return { available: true }; },
    async list() { return structuredClone(panes); },
    async create(spec) {
      creates.push(spec);
      const pane = { id: 'fake-pane', title: spec.name, cwd: spec.cwd };
      panes.push(pane);
      return pane;
    },
    async read(paneId) { assert.equal(paneId, 'fake-pane'); return { text: 'fake screen: idle', ansi: '\x1b[32mfake screen: idle' }; },
    async input(paneId, text) {
      inputs.push([paneId, text]);
      if (holdInput) await new Promise<void>(resolve => { releaseInput = resolve; });
    },
    async keys(paneId, value) { keys.push([paneId, value]); },
    async close(paneId) { closedPanes.push(paneId); },
    async watch(paneId, onFrame) {
      assert.equal(paneId, 'fake-pane');
      const epoch = `fake-epoch-${++watchCount}`;
      watchers.set(epoch, onFrame);
      // Emit before watch resolves, hence before the node can send the RPC result.
      onFrame({ epoch, seq: 1, full: true, width: 80, height: 24, data: Buffer.from('首帧').toString('base64') });
      await delay(20);
      return () => { watchers.delete(epoch); disposed++; };
    },
  };
  const services = createExecutionServices({ host, dataDir: nodeDir, hasCommand: () => true });
  const metadata = await services.describe(machineId);
  const nodeOptions = {
    url: f.running.url, token: f.config.token, machineId, name: 'Local fake terminal', dataDir: nodeDir,
    handlers: services.handlers, executors: metadata, onDisconnect: () => services.disconnect(), reconnectMs: 20,
  };
  let node = startAgentNode(nodeOptions);
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); releaseInput?.(); await node.close(); await services.disconnect(); });
  const tool = (name: string, args: JsonObject) => {
    const entry = f.running.app.contributions.list('tools').find(entry => entry.value.name === name);
    assert.ok(entry, `Missing tool ${name}`);
    return entry.value.execute(args, new AbortController().signal);
  };
  const terminal = () => {
    const query = new URLSearchParams({ token: f.config.token, machineId, paneId: 'fake-pane' });
    const ws = new WebSocket(`${f.running.url.replace('http:', 'ws:')}/api/v1/terminal?${query}`);
    sockets.push(ws);
    const frames: TerminalFrame[] = [];
    ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
    return { ws, frames };
  };

  const registered = await eventually(f.state, value => value.machines.some(m => m.id === machineId && m.online));
  assert.deepEqual(registered.machines.find(m => m.id === machineId)!.executors, metadata);
  assert.ok(registered.executors.some(e => e.id === `${machineId}/codex` && e.kind === 'cli' && e.available));
  const dispatch = { executorId: `${machineId}/codex`, prompt: 'fake prompt; no CLI executes', executionMode: 'interactive' };
  assert.equal((await f.request('/runs', 'POST', { ...dispatch, cwd: 42 })).status, 400);
  assert.equal(creates.length, 0);
  const response = await f.request('/runs', 'POST', { ...dispatch, cwd: f.dataDir });
  assert.equal(response.status, 202);
  const run = await response.json() as Run;
  const started = await eventually(f.state, value => Boolean(value.runs.find(r => r.id === run.id)?.sessionId));
  const active = started.runs.find(r => r.id === run.id)!;
  assert.equal(active.status, 'running');
  assert.equal(active.machineId, machineId);
  assert.deepEqual(f.running.app.store.get<Run>('runs', run.id), active);
  assert.equal(f.running.app.store.get<MachineInfo>('machines', machineId)!.online, true);
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].argv, ['codex', '--', dispatch.prompt]);
  const sessions = JSON.parse(await readFile(join(nodeDir, 'executor-sessions.json'), 'utf8')) as SessionBinding[];
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, active.sessionId);
  assert.equal(sessions[0].cwd, f.dataDir);
  assert.deepEqual(await tool('work_read', { id: run.id }), {
    text: 'fake screen: idle', ansi: '\x1b[32mfake screen: idle', state: 'unknown', source: 'screen',
  });

  // Independent knowledge worker status may tick while the terminal is observed.
  const observationEvents = () => f.running.app.events.since(0).filter(event => event.type !== 'knowledge.curator.changed');
  const beforeStream = observationEvents();
  const first = terminal();
  await eventually(() => first.frames, frames => frames.length > 0);
  assert.deepEqual(first.frames[0], { epoch: 'fake-epoch-1', seq: 1, full: true, width: 80, height: 24, data: Buffer.from('首帧').toString('base64') });
  watchers.get('fake-epoch-1')!({ epoch: 'fake-epoch-1', seq: 2, full: false, width: 80, height: 24, data: Buffer.from('增量').toString('base64') });
  await eventually(() => first.frames, frames => frames.length === 2);
  first.ws.close();
  await eventually(() => disposed, value => value === 1);
  assert.deepEqual(closedPanes, []);
  const second = terminal();
  await eventually(() => second.frames, frames => frames.length > 0);
  assert.equal(second.frames[0].full, true);
  assert.notEqual(second.frames[0].epoch, first.frames[0].epoch);
  assert.deepEqual(observationEvents(), beforeStream, 'terminal frames must not enter durable events');
  second.ws.close();
  await eventually(() => disposed, value => value === 2);
  await tool('work_input', { id: run.id, text: 'explicit input' });
  await tool('work_interrupt', { id: run.id });
  assert.deepEqual(inputs, [['fake-pane', 'explicit input']]);
  assert.deepEqual(keys, [['fake-pane', ['Enter']], ['fake-pane', ['C-c']]]);
  assert.equal((await f.state()).runs.find(r => r.id === run.id)!.status, 'running');

  // Disconnect after a write is accepted but before its result. Reconnection must not retry it.
  holdInput = true;
  const pending = f.request(`/machines/${machineId}/call`, 'POST', {
    method: 'executor.input', params: { sessionId: active.sessionId, text: 'uncertain input' },
  });
  await eventually(() => releaseInput, value => Boolean(value));
  await node.close();
  const failed = await pending;
  assert.equal(failed.status, 502);
  assert.match((await failed.json() as { error: string }).error, /unknown/i);
  await eventually(f.state, value => value.machines.some(m => m.id === machineId && !m.online));
  releaseInput!();
  holdInput = false;
  node = startAgentNode(nodeOptions);
  await eventually(f.state, value => value.machines.some(m => m.id === machineId && m.online));
  await tool('work_read', { id: run.id }); // A round trip after reconnect fences the old response.
  assert.deepEqual(inputs, [['fake-pane', 'explicit input'], ['fake-pane', 'uncertain input']]);
  assert.equal(creates.length, 1);
  assert.deepEqual(keys, [['fake-pane', ['Enter']], ['fake-pane', ['C-c']], ['fake-pane', ['Enter']]]);
  assert.deepEqual(closedPanes, []);
  assert.equal((await f.state()).runs.find(r => r.id === run.id)!.status, 'running');

  assert.equal((await f.request('/plugins/terminal-host', 'POST', { enabled: false })).status, 200);
  assert.equal((await f.request('/runs', 'POST', { ...dispatch, cwd: f.dataDir })).status, 503);
  const disabled = terminal();
  const [code] = await once(disabled.ws, 'close');
  assert.equal(code, 1008);
  assert.equal(watchCount, 2);
  assert.equal(creates.length, 1);
  await f.request('/plugins/terminal-host', 'POST', { enabled: true });
  const sessionResponse = await f.request(`/machines/${machineId}/sessions`);
  assert.equal(sessionResponse.status, 200);
  assert.deepEqual(await sessionResponse.json(), sessions);
});

test('HTTP inbox confirmation rejects stale versions and creates one todo; unconfigured Feishu stays private', async t => {
  const f = await fixture(t);
  const thing = { thread: 'local-thread', last: 'message-1', title: '检查报告', text: '请检查报告' };
  await f.running.app.inbox.ingest('local-fixture', [thing]);
  const inbox = async () => await (await f.request('/inbox')).json() as InboxItem[];
  const [first] = await inbox();
  assert.equal(first.version, 1);
  await f.running.app.inbox.ingest('local-fixture', [{ ...thing, last: 'message-2' }]);
  const confirm = (version: number) => f.request(`/inbox/${first.id}/confirm`, 'POST', { version });
  assert.equal((await confirm(first.version)).status, 409);
  assert.equal((await f.state()).todos.length, 0);
  const [current] = await inbox();
  const attempts = await Promise.all([confirm(current.version), confirm(current.version)]);
  assert.deepEqual(attempts.map(r => r.status).sort(), [201, 409]);
  const success = attempts.find(r => r.status === 201)!;
  const result = await success.json() as { todoId: string };
  assert.deepEqual((await f.state()).todos.map(todo => todo.id), [result.todoId]);
  await f.running.app.inbox.ingest('local-fixture', [{ ...thing, last: 'message-3' }]);
  const [updated] = await inbox();
  assert.equal(updated.todoId, result.todoId);
  assert.equal((await confirm(updated.version)).status, 409);
  assert.equal((await f.state()).todos.length, 1);

  const response = await f.request('/feishu');
  assert.equal(response.status, 200);
  const status = await response.json() as Record<string, unknown>;
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.equal(status.enabled, false);
  assert.equal(typeof status.reason, 'string');
  assert.equal(Object.hasOwn(status, 'appSecret'), false);
  assert.equal(Object.hasOwn(status, 'pairingCode'), false);
  assert.ok(!JSON.stringify(status).includes(f.config.token));
  assert.equal((await fetch(`${f.running.url}/api/v1/feishu`)).status, 401);
});

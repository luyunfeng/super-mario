import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import type { Approval, AutomationSettings, ExecutionResult, JsonObject, Message, Run, Snapshot, SupervisionSignal, Todo } from '../packages/protocol/src/index.ts';

async function eventually<T>(read: () => T | Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await delay(10);
  }
  throw new Error('Final acceptance state timeout');
}
async function fixture(t: TestContext, install?: (dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-final-acceptance-'));
  await install?.(dataDir);
  const config = { host: '127.0.0.1', port: 0, dataDir, token: 'local-final-acceptance', demo: true };
  let running = await startServer(config);
  t.after(async () => {
    try { await running.close(); }
    finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`${running.url}/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  async function json<T>(path: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
    const response = await request(path, method, body);
    assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
    return await response.json() as T;
  }
  return { dataDir, config, get running() { return running; }, request, json,
    state: () => json<Snapshot>('/state'),
    async restart() { await running.close(); running = await startServer(config); },
  };
}

test('HTTP approval preview/version fence launches one fake task and returns exactly one result without completing its todo', async t => {
  const f = await fixture(t);
  const machineId = 'acceptance-node';
  const launches: JsonObject[] = [];
  let result: ExecutionResult = { state: 'running', text: 'fake task still running', source: 'local-fixture' };
  let resultReads = 0;
  const node = startAgentNode({ url: f.running.url, token: f.config.token, machineId, name: 'Local fake executor', dataDir: f.dataDir,
    executors: [{ id: 'codex', machineId, name: 'Fake Codex', nativeResultSources: ['local-fixture'], kind: 'cli', available: true, mode: 'real', description: 'Local fixture only' }],
    handlers: {
      'executor.start': async params => { launches.push(params); return { sessionId: 'fake-task-session' }; },
      'executor.result': async params => { assert.equal(params.sessionId, 'fake-task-session'); resultReads++; return { ...result }; },
    },
  });
  t.after(() => node.close());
  await eventually(f.state, state => state.executors.some(item => item.id === `${machineId}/codex` && item.available));
  assert.equal((await fetch(f.running.url)).status, 200);
  const project = f.running.app.projects.create({ name: '验收项目' });
  const todo = await f.json<Todo>('/todos', 'POST', { title: '验收任务', projectId: project.id }, 201);
  const source = await f.json<Message>('/messages', 'POST', { text: '本地验收上下文', projectId: todo.projectId }, 202);
  const params = { executorId: `${machineId}/codex`, prompt: 'old preview', cwd: f.dataDir, executionMode: 'task',
    doneWhen: '返回结构化测试结果', expectMinutes: 1, projectId: todo.projectId, sourceMessageId: source.id };
  const card = await f.json<Approval>('/approvals', 'POST', { kind: 'dispatch', title: '派发预览', details: '确认任务参数', todoId: todo.id, params }, 201);
  assert.equal(launches.length, 0, 'preview must not dispatch');
  assert.equal((await f.state()).runs.length, 0);
  const edited = await f.json<Approval>(`/approvals/${card.id}`, 'PATCH', { version: card.version, params: { ...params, prompt: 'approved edited preview' } });
  assert.equal(edited.version, card.version + 1);
  assert.equal((await f.request(`/approvals/${card.id}/approve`, 'POST', { version: card.version })).status, 409);
  assert.equal(launches.length, 0);
  const approvals = await Promise.all(Array.from({ length: 4 }, () => f.request(`/approvals/${card.id}/approve`, 'POST', { version: edited.version })));
  assert.deepEqual(approvals.map(item => item.status).sort(), [200, 409, 409, 409]);
  const accepted = await approvals.find(item => item.status === 200)!.json() as Approval;
  assert.equal(accepted.status, 'completed');
  const active = await eventually(f.state, state => state.runs.length === 1 && state.runs[0].status === 'running' && Boolean(state.runs[0].sessionId));
  const run = active.runs[0];
  assert.equal(run.todoId, todo.id);
  assert.equal(run.projectId, todo.projectId);
  assert.deepEqual(launches, [{ executorId: 'codex', prompt: 'approved edited preview', cwd: f.dataDir, mode: 'task' }]);
  await f.running.app.monitor.poll();
  assert.ok(resultReads > 0);
  assert.equal((await f.state()).messages.filter(item => item.origin === 'result').length, 0);
  result = { state: 'completed', text: 'fake native task result', source: 'local-fixture', exitCode: 0 };
  await Promise.all(Array.from({ length: 5 }, () => f.running.app.monitor.poll()));
  const completed = await eventually(f.state, state => state.runs[0].status === 'completed');
  assert.equal(completed.runs[0].output, result.text);
  assert.equal(completed.runs[0].resultSource, result.source);
  const replies = completed.messages.filter(item => item.origin === 'result');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, `run-result:${run.id}`);
  assert.equal(replies[0].replyTo, source.id);
  assert.equal(replies[0].projectId, todo.projectId);
  assert.match(replies[0].text, /fake native task result/);
  assert.equal(completed.todos[0].completedAt, undefined);
  await f.running.app.monitor.poll();
  assert.equal(f.running.app.events.since(0).filter(item => item.type === 'runs.result').length, 1);
  await node.close();
  await f.restart();
  await f.running.app.monitor.poll();
  const restored = await f.state();
  assert.deepEqual(restored.messages.filter(item => item.origin === 'result'), replies);
  assert.equal(restored.runs[0].status, 'completed');
  assert.equal(restored.todos[0].completedAt, undefined);
  assert.equal(launches.length, 1);
  assert.equal((await f.json<Array<{ status: string }>>('/effects'))[0].status, 'confirmed');
});

test('HTTP todo delegation preserves project on the queued input and assistant reply', async t => {
  const f = await fixture(t);
  const todo = await f.json<Todo>('/todos', 'POST', { title: '项目委派', notes: '保持项目上下文', projectId: 'isolated-project' }, 201);
  const input = await f.json<Message>(`/todos/${todo.id}/delegate`, 'POST', {}, 202);
  assert.equal(input.projectId, todo.projectId);
  assert.match(input.text, new RegExp(todo.id));
  const state = await eventually(f.state, state => state.messages.some(item => item.replyTo === input.id && item.status === 'done'));
  assert.equal(state.messages.find(item => item.replyTo === input.id)!.projectId, todo.projectId);
  assert.equal(state.todos[0].completedAt, undefined);
});

test('HTTP automation settings, reminder claim and brief survive server restart without duplicate notification', async t => {
  const f = await fixture(t);
  const settings = { tickSeconds: 3600, stalledMinutes: 45, stalledFactorOfEstimate: 1.5, needsYouMinutes: 5, remindersEnabled: true };
  assert.deepEqual(await f.json<AutomationSettings>('/automation', 'PUT', settings), settings);
  assert.equal((await f.request('/automation', 'PUT', { tickSeconds: 0 })).status, 400);
  const past = new Date(Date.now() - 60000).toISOString();
  const todo = await f.json<Todo>('/todos', 'POST', { title: '到期提醒', dueAt: past, reminderAt: past, projectId: 'reminder-project' }, 201);
  type Brief = { todos: { overdue: Todo[] }; signals: SupervisionSignal[]; window: {from:string;to:string;projects:unknown[]} };
  const brief = await f.json<Brief>('/brief');
  assert.equal(brief.todos.overdue[0].id, todo.id);
  assert.equal(brief.signals.filter(item => item.kind === 'reminder' && item.todoId === todo.id).length, 1);
  const reminded = (await f.state()).todos[0].remindedAt;
  assert.ok(reminded);
  const notifications = () => f.running.app.events.since(0).filter(item => item.type === 'notifications.created');
  assert.equal(notifications().length, 1);
  await f.restart();
  assert.deepEqual(await f.json<AutomationSettings>('/automation'), settings);
  const restored = await f.json<Brief>('/brief');
  const {window: beforeWindow,...beforeFacts}=brief;
  const {window: afterWindow,...afterFacts}=restored;
  assert.deepEqual(afterFacts,beforeFacts);
  assert.deepEqual(afterWindow.projects,beforeWindow.projects);
  assert.ok(Date.parse(afterWindow.to)>=Date.parse(beforeWindow.to));
  assert.equal(Date.parse(afterWindow.to)-Date.parse(afterWindow.from),86400000);
  assert.equal((await f.state()).todos[0].remindedAt, reminded);
  assert.equal(notifications().length, 1);
  await f.json('/brief');
  assert.equal(notifications().length, 1);
});

test('HTTP custom plugin loads real JS and disabling revokes contributions, event listeners and deferred resources', async t => {
  const f = await fixture(t, async dataDir => {
    const dir = join(dataDir, 'extensions', 'acceptance-plugin');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(dir, 'super-mario.extension.json'), JSON.stringify({ id: 'acceptance-plugin', version: '1.0.0', apiVersion: 1, main: 'index.js' }));
    await writeFile(join(dir, 'index.js'), `export default { id: 'acceptance-plugin', name: 'Acceptance fixture', capabilities: ['tools'], activate(ctx) {
      ctx.store.put('acceptance', 'activations', (ctx.store.get('acceptance', 'activations') ?? 0) + 1);
      ctx.contribute('tools', 'acceptance_probe', { name: 'acceptance_probe', description: 'Local probe', parameters: {}, async execute() { return 'loaded-real-js'; } });
      ctx.onEvent(event => { if (event.type === 'todos.changed') ctx.store.put('acceptance', 'events', (ctx.store.get('acceptance', 'events') ?? 0) + 1); });
      ctx.defer(() => ctx.store.put('acceptance', 'disposed', (ctx.store.get('acceptance', 'disposed') ?? 0) + 1));
    } };`);
  });
  const probe = () => f.running.app.contributions.list('tools').find(item => item.value.name === 'acceptance_probe');
  assert.equal((await f.state()).plugins.find(item => item.id === 'acceptance-plugin')?.status, 'active');
  assert.equal(await probe()!.value.execute({}, new AbortController().signal), 'loaded-real-js');
  await f.json('/todos', 'POST', { title: 'listener active' }, 201);
  assert.equal(f.running.app.store.get('acceptance', 'events'), 1);
  await f.json('/plugins/acceptance-plugin', 'POST', { enabled: false });
  assert.equal(probe(), undefined);
  assert.equal(f.running.app.store.get('acceptance', 'disposed'), 1);
  await f.json('/todos', 'POST', { title: 'listener revoked' }, 201);
  assert.equal(f.running.app.store.get('acceptance', 'events'), 1);
  await f.restart();
  assert.equal(probe(), undefined, 'disabled state must persist');
  assert.equal(f.running.app.store.get('acceptance', 'activations'), 1);
  await f.json('/plugins/acceptance-plugin', 'POST', { enabled: true });
  assert.ok(probe());
  await f.json('/todos', 'POST', { title: 'one restored listener' }, 201);
  assert.equal(f.running.app.store.get('acceptance', 'events'), 2);
  await f.json('/plugins/acceptance-plugin', 'POST', { enabled: false });
  assert.equal(f.running.app.store.get('acceptance', 'disposed'), 2);
});

test('incomplete optional Feishu environment keeps the Web available and reports missing configuration', async () => {
  const { readServerOptions } = await import('../packages/core/src/config.ts');
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-missing-connector-'));
  const config = readServerOptions(['--demo', '--port', '0', '--data-dir', dataDir], { SUPER_MARIO_FEISHU_ENABLED: '1' });
  const running = await startServer(config);
  try {
    assert.equal((await fetch(running.url)).status, 200);
    const status = await (await fetch(`${running.url}/api/v1/feishu`)).json() as { connected: boolean; configured: boolean; reason: string };
    assert.equal(status.connected, false); assert.equal(status.configured, false); assert.match(status.reason, /appId|appSecret|配置|格式/);
  } finally { await running.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('a minimal demo approval returns a JSON receipt without optional undefined run fields', async t => {
  const f = await fixture(t);
  const card = await f.json<Approval>('/approvals', 'POST', {kind:'dispatch', title:'最小派发', details:'仅必要字段', params:{executorId:'demo',prompt:'demo approval'}}, 201);
  const accepted = await f.json<Approval>(`/approvals/${card.id}/approve`, 'POST', {version:card.version});
  assert.equal(accepted.status, 'completed');
  assert.equal((accepted.result as JsonObject).accepted, true);
  assert.equal(typeof (accepted.result as JsonObject).runId, 'string');
});

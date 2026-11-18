import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createProjects } from '../packages/core/src/projects.ts';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import type { JsonObject, MachineInfo, Run } from '../packages/protocol/src/index.ts';

const binding = { machineId: 'computer-a', cwd: '/work/repo' };
const status = (expected: number) => (error: unknown) => (error as { status?: number }).status === expected;

test('folder imports deduplicate by normalized machine/path, retain archived data and persist across restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-folders-store-'));
  let store = createStore(join(dir, 'db.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const projects = createProjects({ store, events: createEventBus(store) });
  const old = projects.create({ name: '旧项目', description: '保留' });
  const first = projects.create({ name: '原名称', description: '原资料', workspace: { ...binding, cwd: '/work/other/../repo/' } });
  assert.deepEqual(first.workspace, binding);
  const eventCount = store.list('core.events').length;
  const duplicate = projects.create({ name: '不要覆盖', description: '新资料', workspace: binding, memoryEnabled: true });
  assert.deepEqual(duplicate, first);
  assert.equal(store.list('core.events').length, eventCount);
  assert.equal(projects.list().length, 2);
  const otherMachine = projects.create({ name: '另一电脑', workspace: { ...binding, machineId: 'computer-b' } });
  assert.notEqual(otherMachine.id, first.id);
  assert.throws(() => projects.update(old.id, { workspace: binding, name: '不可覆盖' }), status(409));
  assert.equal(projects.list().find(p => p.id === old.id)?.name, '旧项目');
  const updated = projects.update(old.id, { workspace: { ...binding, cwd: '/work/new/./' } });
  assert.deepEqual(updated.workspace, { ...binding, cwd: '/work/new' });
  const archived = projects.archive(first.id);
  store.put('project.memory', first.id, { summary: '独立记忆仍保留' });
  assert.deepEqual(projects.create({ name: '再次导入', workspace: binding }), archived);
  assert.deepEqual(store.get('project.memory', first.id), { summary: '独立记忆仍保留' });
  store.close(); store = createStore(join(dir, 'db.sqlite'));
  const restarted = createProjects({ store, events: createEventBus(store) });
  assert.deepEqual(restarted.list().find(p => p.id === first.id), archived);
  assert.deepEqual(restarted.list().find(p => p.id === old.id), updated);
  assert.deepEqual(restarted.create({ name: '重启再导入', workspace: binding }), archived);
});

test('workspace objects are strict, reject relative paths and never enable memory via PATCH', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-folders-validation-'));
  const store = createStore(join(dir, 'db.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const projects = createProjects({ store, events: createEventBus(store) });
  const old = projects.create({ name: '旧项目', memoryEnabled: false });
  for (const workspace of [null, undefined, [], {}, { machineId: 'a' }, { cwd: '/work' }, { ...binding, machineId: '' }, { ...binding, machineId: 1 }, { ...binding, cwd: 'relative/path' }, { ...binding, cwd: '/work/\0bad' }, { ...binding, extra: true }, new Date()]) {
    assert.throws(() => projects.create({ name: '无效', workspace } as never), status(400));
    assert.throws(() => projects.update(old.id, { workspace } as never), status(400));
  }
  assert.throws(() => projects.update(old.id, { memoryEnabled: true }), /未知项目字段/);
  assert.deepEqual(projects.list(), [old]);
});

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-folders-dispatch-'));
  const config = { host: '127.0.0.1', port: 0, dataDir: dir, demo: false };
  let app = await createWorkbench(config);
  const computers: MachineInfo[] = ['computer-b', 'computer-a'].map(id => ({
    id, name: id, online: true, platform: 'linux', connectedAt: new Date().toISOString(), capabilities: ['executor.start'],
    executors: [{ id: 'codex', name: '测试执行者', kind: 'cli', machineId: id, available: true, mode: 'real', description: 'fake executor', defaultCwd: '/executor/default' }],
  }));
  const calls: Array<{ machineId: string; params: JsonObject }> = [];
  let unknown = false;
  const connect = () => app.setMachineClient({ list: () => structuredClone(computers), async call(machineId, method, params) {
    assert.equal(method, 'executor.start');
    calls.push({ machineId, params });
    if (unknown) throw Object.assign(new Error('测试：回执丢失'), { delivery: 'unknown' });
    return { sessionId: `session-${calls.length}` };
  } });
  connect();
  t.after(async () => { try { await app.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  return { get app() { return app; }, computers, calls, setUnknown() { unknown = true; }, async restart(connectMachines = true) { await app.close(); app = await createWorkbench(config); if (connectMachines) connect(); } };
}
const task = { prompt: '持续工作区中的一项工作', doneWhen: '测试证据', expectMinutes: 1 };
async function settled(app: Awaited<ReturnType<typeof createWorkbench>>, id: string) {
  for (let i = 0; i < 200; i++) {
    const run = app.store.get<Run>('runs', id)!;
    if (run.sessionId || ['failed', 'unknown', 'completed'].includes(run.status)) return run;
    await delay(10);
  }
  assert.fail('fake executor did not settle');
}

test('bound dispatch inherits folder, isolates computers, allows advanced cwd and preserves old unbound projects', async t => {
  const f = await fixture(t);
  const project = f.app.projects.create({ name: '工作区', workspace: binding });
  const input = { ...task, projectId: project.id };
  const run = f.app.dispatch(input);
  assert.equal(run.executorId, 'computer-a/codex');
  assert.equal(run.machineId, binding.machineId);
  assert.equal(run.cwd, binding.cwd);
  await settled(f.app, run.id);
  assert.deepEqual(f.calls[0], { machineId: binding.machineId, params: { executorId: 'codex', prompt: task.prompt, cwd: binding.cwd, mode: 'task' } });
  const count = f.app.store.list('runs').length;
  assert.throws(() => f.app.dispatch({ ...input, executorId: 'computer-b/codex', cwd: '/override' }), status(409));
  assert.throws(() => f.app.dispatch({ projectId: project.id, prompt: '仍需真实任务校验' }), /验收标准/);
  assert.equal(f.app.store.list('runs').length, count);
  const override = f.app.dispatch({ ...input, executorId: 'computer-a/codex', cwd: '/advanced/override' });
  await settled(f.app, override.id);
  assert.equal(f.calls[1].params.cwd, '/advanced/override');
  assert.equal(f.calls[1].machineId, binding.machineId);
  const legacy = f.app.projects.create({ name: '旧项目' });
  const oldRun = f.app.dispatch({ ...task, projectId: legacy.id });
  await settled(f.app, oldRun.id);
  assert.equal(oldRun.executorId, 'computer-b/codex');
  assert.equal(oldRun.cwd, '/executor/default');
  assert.equal(f.app.projects.list().find(p => p.id === legacy.id)?.workspace, undefined);
});

test('offline/missing/unavailable bound computers fail before writing a run and never fall back', async t => {
  const f = await fixture(t);
  const project = f.app.projects.create({ name: '工作区', workspace: binding });
  const input = { ...task, projectId: project.id };
  f.computers[1].online = false;
  assert.throws(() => f.app.dispatch(input), /电脑离线/);
  assert.throws(() => f.app.dispatch({ ...input, executorId: 'computer-a/codex' }), status(503));
  f.computers[1].online = true;
  f.computers[1].executors![0].available = false;
  assert.throws(() => f.app.dispatch(input), /没有可用执行者/);
  assert.throws(() => f.app.dispatch({ ...input, executorId: 'computer-a/codex' }), status(503));
  f.computers.pop();
  assert.throws(() => f.app.dispatch(input), status(503));
  assert.deepEqual(f.app.store.list('runs'), []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.app.effects.list(), []);
  // A saved online flag must not substitute for the current connection registry.
  f.app.store.put('machines', binding.machineId, { id: binding.machineId, online: true });
  await f.restart(false);
  assert.throws(() => f.app.dispatch(input), status(503));
  assert.deepEqual(f.app.store.list('runs'), []);
});

test('unknown dispatch keys survive defaults changes, offline and restart without replay or scope substitution', async t => {
  const f = await fixture(t);
  const project = f.app.projects.create({ name: '工作区', workspace: binding });
  const input = { ...task, projectId: project.id };
  f.setUnknown();
  const run = f.app.dispatch(input, 'folder-key');
  assert.equal((await settled(f.app, run.id)).status, 'unknown');
  f.app.projects.update(project.id, { workspace: { ...binding, cwd: '/work/moved' } });
  f.computers[1].online = false;
  assert.equal(f.app.dispatch(input, 'folder-key').cwd, binding.cwd);
  for (const patch of [{ cwd: '/work/moved' }, { executorId: 'computer-b/codex' }, { projectId: undefined }, { doneWhen: '另一验收' }, { expectMinutes: 2 }, { executionMode: 'interactive' }]) {
    assert.throws(() => f.app.dispatch({ ...input, ...patch }, 'folder-key'), status(409));
  }
  await f.restart();
  assert.equal(f.app.dispatch(input, 'folder-key').status, 'unknown');
  assert.equal(f.calls.length, 1);
  assert.equal(f.app.store.list('runs').length, 1);
});

test('approved explicit cwd stays exact when the project folder changes', async t => {
  const f = await fixture(t);
  const project = f.app.projects.create({ name: '工作区', workspace: binding });
  const params = { ...task, projectId: project.id, executorId: 'computer-a/codex', cwd: '/approved/exact' };
  const approval = f.app.approvals.propose({ kind: 'dispatch', title: '执行精确参数', details: '', params });
  f.app.projects.update(project.id, { workspace: { ...binding, cwd: '/work/moved' } });
  const approved = await f.app.approvals.approve(approval.id, approval.version);
  assert.equal(approved.status, 'completed');
  const run = f.app.store.list<Run>('runs')[0];
  await settled(f.app, run.id);
  assert.equal(run.cwd, params.cwd);
  assert.equal(f.calls[0].params.cwd, params.cwd);
});

test('project context carries the folder binding and project work conversations retain source validation', async t => {
  const f = await fixture(t);
  const project = f.app.projects.create({ name: '工作区', workspace: binding });
  const other = f.app.projects.create({ name: '其他项目', workspace: { ...binding, cwd: '/other' } });
  const context = f.app.projectWorkspace.context(project.id) as JsonObject;
  assert.deepEqual((context.project as JsonObject).workspace, binding);
  assert.doesNotMatch(JSON.stringify(context), /\/other/);
  const conversationId = `project:${project.id}:work`;
  f.app.store.put('messages', 'source', { id: 'source', role: 'user', conversationId, projectId: project.id, text: '继续项目', status: 'done', createdAt: new Date().toISOString() });
  const run = f.app.dispatch({ ...task, projectId: project.id, conversationId, sourceMessageId: 'source' });
  await settled(f.app, run.id);
  assert.equal(run.conversationId, conversationId);
  assert.throws(() => f.app.dispatch({ ...task, projectId: other.id, conversationId, sourceMessageId: 'source' }), /来源消息不匹配/);
  assert.throws(() => f.app.dispatch({ ...task, projectId: project.id, conversationId: `project:${project.id}:memory`, sourceMessageId: 'source' }), /来源消息不匹配/);
  const view = await f.app.projectWorkspace.view(project.id);
  assert.equal(view.agents.work.conversationId, conversationId);
  assert.equal(view.messages[0].id, 'source');
  f.app.projects.archive(project.id);
  assert.throws(() => f.app.dispatch({ ...task, projectId: project.id }), /已归档/);
});

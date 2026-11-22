import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import type { JsonObject, MachineInfo, Run } from '../packages/protocol/src/index.ts';

async function setup(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-todo-handoff-'));
  const app = await createWorkbench({ dataDir, host: '127.0.0.1', port: 0, demo: true });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const machines: MachineInfo[] = ['one', 'two'].map(id => ({
    id, name: id, online: true, platform: 'linux', connectedAt: '', capabilities: ['executor.start'],
    executors: [{ id: 'codex', name: '本地替身', machineId: id, kind: 'cli', mode: 'real', available: true, description: '测试' }],
  }));
  const calls: JsonObject[] = [];
  app.setMachineClient({ list: () => machines, async call(machineId, method, params) {
    assert.equal(method, 'executor.start'); assert.equal(machineId, 'one');
    calls.push(params);
    return { sessionId: 'synthetic-' + calls.length };
  } });
  const project = app.projects.create({ name: '测试项目', workspace: { machineId: 'one', cwd: '/fixture' } });
  const todo = app.createTodo({ title: '核对合成数据', notes: '生成测试报告', projectId: project.id });
  async function started(runId: string) {
    for (let i = 0; i < 150; i++) {
      const run = app.store.get<Run>('runs', runId)!;
      if (run.sessionId) return run;
      if (run.error) assert.fail(run.error);
      await delay(10);
    }
    assert.fail('执行机未收到任务');
  }
  return { app, todo, project, machines, calls, started };
}

test('显式派单复用机器、范围和验收校验；默认交给主 Agent', async t => {
  const { app, todo, machines, calls, started } = await setup(t);
  app.updateTodo(todo.id, { dueAt: '2030-04-01T09:00:00Z', waitingOn: '等待合成样本', reminderAt: '2030-03-31T08:00:00Z' });
  const intent = await app.delegateTodo(todo.id);
  assert.equal(intent.conversationId, 'main'); assert.equal(intent.todoId, todo.id);
  await assert.rejects(app.delegateTodo(todo.id, 'two/codex', '提供报告', 5), /绑定的电脑/);
  await assert.rejects(app.delegateTodo(todo.id, 'one/codex'), /验收标准/);
  await assert.rejects(app.delegateTodo(todo.id, 'one/codex', '提供报告', 0), /预计时长/);
  machines[0].online = false;
  await assert.rejects(app.delegateTodo(todo.id, 'one/codex', '提供报告', 5), /离线/);
  machines[0].online = true;
  assert.equal(calls.length, 0);
  app.todoDecisions.add(todo.id, '只使用合成样本');
  const run = await app.delegateTodo(todo.id, 'one/codex', '提供报告', 5);
  assert.equal(run.doneWhen, '提供报告'); assert.equal(run.expectMinutes, 5);
  assert.equal((await started(run.id)).status, 'running');
  assert.equal(calls[0].cwd, '/fixture'); assert.match(String(calls[0].prompt), /提供报告/);
  assert.match(String(calls[0].prompt), /只使用合成样本/);
  for (const text of [intent.text, String(calls[0].prompt)]) {
    assert.match(text, /2030-04-01T09:00:00Z/);
    assert.match(text, /等待合成样本/);
    assert.match(text, /缺少证据/);
    assert.doesNotMatch(text, /2030-03-31/);
  }
  assert.equal(app.todos().find(item => item.id === todo.id)?.completedAt, undefined);
});

test('执行器收到当前事项的决定，重复标识复用旧执行，返工重新读取生效决定', async t => {
  const { app, todo, calls, started } = await setup(t);
  const old = app.todoDecisions.add(todo.id, '导出 CSV');
  const other = app.createTodo({ title: '另一事项', projectId: todo.projectId });
  app.todoDecisions.add(other.id, '其他事项背景');
  const params = { todoId: todo.id, executorId: 'one/codex', prompt: '生成数据', doneWhen: '核对报告', expectMinutes: 2 };
  assert.throws(() => app.dispatch({ ...params, projectId: app.projects.create({ name: '不同项目' }).id }), /不匹配/);
  const first = app.dispatch(params, 'synthetic-handoff');
  const run = await started(first.id);
  assert.equal(run.projectId, todo.projectId);
  assert.match(String(calls[0].prompt), /导出 CSV/); assert.doesNotMatch(String(calls[0].prompt), /其他事项背景/);
  const content = { executorId: params.executorId, prompt: calls[0].prompt, cwd: '/fixture', executionMode: 'task' };
  const fingerprint = createHash('sha256').update(JSON.stringify(['executor.start', 'one', content])).digest('hex');
  assert.equal(app.effects.list().find(effect => effect.key === `run:${run.id}:start`)?.fingerprint, fingerprint);
  app.todoDecisions.withdraw(todo.id, old.id); app.todoDecisions.add(todo.id, '导出 JSON');
  assert.equal(app.dispatch(params, 'synthetic-handoff').id, run.id);
  assert.throws(() => app.dispatch({ ...params, prompt: '不同输入' }, 'synthetic-handoff'), /不同工作/);
  assert.equal(calls.length, 1);
  app.store.put('runs', run.id, { ...run, status: 'failed', error: '合成校验失败' });
  const review = app.taskClosure.review.attach({ todoId: todo.id, runId: run.id });
  const retry = app.taskClosure.review.decide({ ...review, action: 'rework', defects: '修正合成报告格式' });
  await started(retry.runId);
  assert.equal(calls.length, 2);
  assert.match(String(calls[1].prompt), /修正合成报告格式/);
  assert.match(String(calls[1].prompt), /导出 JSON/);
  assert.doesNotMatch(String(calls[1].prompt), /导出 CSV|其他事项背景/);
  assert.equal(app.todos().find(item => item.id === todo.id)?.completedAt, undefined);
});

test('派单钩子改写正文后仍按原请求重放，事项换项目后拒绝旧标识', async t => {
  const { app, todo, calls, started } = await setup(t);
  app.plugins.register({ id: 'handoff-hook', name: '合成钩子', capabilities: [], activate(context) {
    context.hook('work.dispatch', 'before', value => ({ action: 'continue', value: { ...value as JsonObject, prompt: '经过钩子的正文' } }));
  } });
  await app.plugins.start();
  app.todoDecisions.add(todo.id, '保留字段顺序');
  const params = { prompt: '检查字段', todoId: todo.id, executorId: 'one/codex', doneWhen: '字段一致', expectMinutes: 3 };
  const run = await started(app.dispatch(params, 'hook-key').id);
  assert.match(String(calls[0].prompt), /^经过钩子的正文\n\n/);
  assert.match(String(calls[0].prompt), /保留字段顺序/);
  assert.equal(app.dispatch(params, 'hook-key').id, run.id);
  assert.throws(() => app.dispatch({ ...params, prompt: run.prompt }, 'hook-key'), /不同工作/);
  app.updateTodo(todo.id, { projectId: app.projects.create({ name: '新归属' }).id });
  assert.throws(() => app.dispatch(params, 'hook-key'), /不同工作/);
  assert.equal(calls.length, 1);
});

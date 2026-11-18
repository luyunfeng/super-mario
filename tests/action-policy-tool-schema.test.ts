import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { runWithAgentInput } from '../packages/core/src/agent-input.ts';
import type { Approval, JsonObject, Message } from '../packages/protocol/src/index.ts';
import type { Plan } from '../packages/core/src/plans.ts';

const task = { prompt: '本地检查', doneWhen: '用户核对报告', expectMinutes: 0.5 };
const proposal = (kind: string, params: JsonObject): JsonObject => ({ title: '待核对动作', details: '', kind, params });

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-action-policy-schema-'));
  const app = await createWorkbench({ dataDir, host: '127.0.0.1', port: 0, demo: true });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const source: Message = { id: 'schema-input', role: 'user', conversationId: 'main', text: '提出待核对动作和计划', createdAt: new Date().toISOString() };
  app.store.put('messages', source.id, source);
  let sends = 0;
  app.setFeishuSender(async () => { sends++; });
  const find = (name: string) => {
    const tool = app.contributions.list('tools').find(entry => entry.value.name === name)?.value;
    assert.ok(tool, name);
    return tool;
  };
  // Use the SDK's coercion/validation, followed by the original registered execute.
  const validate = (name: string, args: JsonObject): JsonObject => validateToolArguments(find(name), {
    type: 'toolCall', id: 'schema-call', name, arguments: args,
  });
  async function call(name: string, args: JsonObject) {
    const validated = validate(name, args);
    assert.deepEqual(validated, args, 'valid input must reach the service unchanged');
    return runWithAgentInput(source, () => find(name).execute(validated, new AbortController().signal));
  }
  function counts() {
    return ['approvals', 'plans', 'plan-origins', 'runs', 'input-paused'].map(name => app.store.list(name).length);
  }
  function idle() {
    assert.deepEqual(app.store.list('runs'), []);
    assert.equal(sends, 0);
    assert.deepEqual(app.store.list('effects'), []);
  }
  return { app, find, validate, call, counts, idle, source };
}

test('registered action schema pairs each kind with real params; all valid proposals stay pending without execution', async t => {
  const f = await fixture(t);
  const project = f.app.projects.create({ name: 'schema project' });
  const todo = f.app.createTodo({ title: 'schema todo', projectId: project.id });
  const actions = [
    proposal('dispatch', { prompt: '自动选择执行者' }),
    { ...proposal('dispatch', { ...task, executorId: 'demo', cwd: '/tmp', projectId: project.id, todoId: todo.id, executionMode: 'task' }), todoId: todo.id },
    proposal('dispatch', { prompt: '交互工作', executionMode: 'interactive', policy: { agentModes: { main_agent: 'suggest' } } }),
    proposal('input', { id: 'existing-run', text: '继续' }),
    proposal('feishu-reply', { chatId: 'offline-chat', text: '请核对' }),
  ];
  for (const args of actions) {
    const result = await f.call('action_propose', args) as unknown as Approval;
    assert.equal(result.status, 'pending');
    assert.equal(result.kind, args.kind);
    assert.equal(result.title, args.title);
    assert.equal(result.details, '');
    assert.deepEqual(result.params, args.params);
    assert.equal(result.todoId, args.todoId);
    assert.deepEqual(f.app.store.get('approvals', result.id), result);
  }
  assert.equal(f.app.approvals.list().length, actions.length);
  assert.deepEqual(f.find('action_propose').parameters.required, ['title', 'details', 'kind', 'params']);
  assert.equal(f.find('task_plan').parameters.required, undefined);
  assert.equal(f.find('work_dispatch').parameters.required, undefined);
  assert.deepEqual(f.find('scheduled_work_propose').parameters.required, ['key', 'title', 'schedule', 'action']);
  f.idle();
});

test('SDK rejects aliases, crossed action shapes, host fields and missing arguments before saving approvals', async t => {
  const f = await fixture(t);
  const invalid = [
    proposal('input', { runId: 'run', text: '继续' }),
    proposal('input', { id: 'run', text: '继续', runId: 'run' }),
    proposal('feishu-reply', { id: 'chat', text: '回复' }),
    proposal('feishu-reply', { chatId: 'chat', content: '回复' }),
    proposal('feishuReply', { chatId: 'chat', text: '回复' }),
    proposal('dispatch', { id: 'run', text: '继续' }),
    proposal('input', { prompt: '工作' }),
    proposal('input', { chatId: 'chat', text: '回复' }),
    proposal('feishu-reply', { prompt: '工作' }),
    proposal('dispatch', { prompt: '工作', executionMode: 'shell' }),
    ...[0, -1, 10081].map(expectMinutes => proposal('dispatch', { ...task, expectMinutes })),
    ...['dispatch', 'input', 'feishu-reply'].flatMap(kind => {
      const params: JsonObject = kind === 'dispatch' ? { prompt: '工作' } : kind === 'input' ? { id: 'run', text: '继续' } : { chatId: 'chat', text: '回复' };
      return ['nativeResume', 'outboxId', 'sourceMessageId', 'conversationId', 'machineId'].map(key => proposal(kind, { ...params, [key]: 'host-owned' }));
    }),
    { ...proposal('input', { id: 'run', text: '继续' }), sourceMessageId: 'host-owned' },
    proposal('input', { id: ' ', text: '继续' }),
    proposal('feishu-reply', { chatId: 'chat', text: '' }),
    proposal('dispatch', { ...task, policy: { mode: 'auto' } }),
  ];
  for (const key of ['title', 'details', 'kind', 'params']) {
    const args = proposal('input', { id: 'run', text: '继续' });
    delete args[key];
    invalid.push(args);
  }
  for (const args of invalid) {
    const before = f.counts();
    await assert.rejects(f.call('action_propose', args), /Validation failed for tool/);
    assert.deepEqual(f.counts(), before);
  }
  f.idle();
});

test('SDK accepts policy patch structures and bounds; real workbench keeps start=true pending', async t => {
  const f = await fixture(t);
  const policies: JsonObject[] = [
    {}, { rules: [] },
    { escalateAfterMinutes: 1, userDeadlineMinutes: 43200 },
    { escalateAfterMinutes: 43200, userDeadlineMinutes: 1 },
    { ladder: ['user'], agentModes: {} },
    { ladder: ['rules', 'supervisor', 'main_agent', 'user'], agentModes: { supervisor: 'auto', main_agent: 'off' } },
    { agentModes: { supervisor: 'off', main_agent: 'auto' } },
    { agentModes: { supervisor: 'suggest', main_agent: 'suggest' } },
    { rules: [
      { id: 'q', kind: 'question', handler: 'rules', mode: 'auto', answer: '确认', executorId: 'demo', cwdUnder: '/tmp' },
      { id: 'p', kind: 'permission', handler: 'user', mode: 'suggest' },
      { id: 'plan', kind: 'plan', handler: 'main_agent', mode: 'off' },
      { id: 'r', kind: 'review', handler: 'supervisor' },
    ] },
  ];
  for (const policy of policies) {
    const result = await f.call('task_plan', { title: '策略待核对', start: true, tasks: [{ ...task, policy }] }) as unknown as Plan;
    assert.equal(result.status, 'pending');
    assert.deepEqual(result.tasks[0].policy, policy);
    assert.deepEqual(f.app.plans.get(result.id), result);
    assert.deepEqual(f.app.store.get('input-paused', f.source.id), { planId: result.id });
  }
  assert.equal(f.app.plans.list().length, policies.length);
  f.idle();
});

test('invalid policy schema is rejected by SDK before any plan or approval writes', async t => {
  const f = await fixture(t);
  const invalid: JsonObject[] = [
    { mode: 'auto' }, { agentModes: { user: 'auto' } }, { agentModes: { supervisor: 'manual' } },
    { ladder: [] }, { ladder: ['robot', 'user'] }, { ladder: ['user', 'user'] },
    ...['escalateAfterMinutes', 'userDeadlineMinutes'].flatMap(key => [0, -1, 1.5, 43201].map(value => ({ [key]: value }))),
    { rules: [{}] },
    ...['id', 'kind', 'handler'].map(key => {
      const rule: JsonObject = { id: 'rule', kind: 'question', handler: 'user' };
      delete rule[key]; return { rules: [rule] };
    }),
    { rules: [{ id: ' ', kind: 'question', handler: 'user' }] },
    { rules: [{ id: 'r', kind: 'unknown', handler: 'user' }] },
    { rules: [{ id: 'r', kind: 'question', handler: 'unknown' }] },
    { rules: [{ id: 'r', kind: 'question', handler: 'user', mode: 'unknown' }] },
    { rules: [{ id: 'r', kind: 'question', handler: 'user', extra: true }] },
    ...['answer', 'executorId', 'cwdUnder'].map(key => ({ rules: [{ id: 'r', kind: 'question', handler: 'user', [key]: '' }] })),
  ];
  for (const policy of invalid) {
    const before = f.counts();
    // A valid first task also must not be saved when a later task fails.
    await assert.rejects(f.call('task_plan', { title: '无效策略', start: true, tasks: [task, { ...task, policy }] }), /Validation failed for tool/);
    assert.deepEqual(f.counts(), before);
  }
  f.idle();
});

test('host retains semantic policy validation after SDK validation with no partial writes', async t => {
  const f = await fixture(t);
  const rule = { id: 'same', kind: 'question', handler: 'user' };
  const policies: JsonObject[] = [
    { ladder: ['user', 'supervisor'] },
    { rules: [rule, rule] },
    { rules: [{ ...rule, handler: 'rules', mode: 'auto' }] },
    { rules: [{ ...rule, mode: 'off' }] },
    { rules: [{ ...rule, cwdUnder: 'relative/path' }] },
  ];
  for (const policy of policies) {
    const args: JsonObject = { title: '宿主继续校验', start: true, tasks: [task, { ...task, policy }] };
    f.validate('task_plan', args);
    const before = f.counts();
    await assert.rejects(f.call('task_plan', args), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /Validation failed for tool/);
      return true;
    });
    assert.deepEqual(f.counts(), before);
  }
  f.idle();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { createWorkDecisionService } from '../packages/core/src/work-decision-service.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createInteractions } from '../packages/core/src/interactions.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createTodoDecisions } from '../packages/core/src/todo-decisions.ts';

function fixture(t: test.TestContext) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  store.put('todos', 'todo', { id: 'todo', projectId: 'project' });
  store.put('todos', 'other', { id: 'other', projectId: 'project' });
  store.put('runs', 'run', { id: 'run', todoId: 'todo', projectId: 'project' });
  for (const id of ['project', 'new']) store.put('projects', id, { id });
  const ledger = createWorkDecisionService({ store, events: createEventBus(store), currentInput: () => undefined, assertCurrentInput() {} });
  return { store, ledger, service: createTodoDecisions(store, ledger) };
}

test('manual decisions validate the todo, deduplicate retries and persist withdrawal per project and todo', t => {
  const { store, ledger, service } = fixture(t);
  for (const call of [() => service.list('gone'), () => service.context('gone'),
    () => service.add('gone', 'x'), () => service.withdraw('gone', 'id')]) assert.throws(call, { status: 404 });
  for (const value of [undefined, {}, '   ']) assert.throws(() => service.add('todo', value), { status: 400 });
  const decision = service.add('todo', '  先测试  ');
  assert.deepEqual(service.add('todo', '先测试'), decision);
  assert.deepEqual(service.list('todo'), [decision]);
  assert.match(service.context('todo'), /先测试/);
  assert.throws(() => service.withdraw('other', decision.id), { status: 404 });
  const withdrawn = service.withdraw('todo', decision.id);
  assert.equal(withdrawn.active, false);
  assert.deepEqual(service.withdraw('todo', decision.id), withdrawn);
  assert.equal(createTodoDecisions(store, ledger).context('todo'), '');
  assert.equal(ledger.ledger.get(decision.id)?.status, 'withdrawn');
  const prior = ledger.recordFromWeb({ todoId: 'todo', key: 'elsewhere', text: '已有决定' });
  assert.equal(service.add('todo', '已有决定').id, prior.id);
  assert.match(service.context('todo'), /已有决定/);
  store.put('todos', 'todo', { id: 'todo', projectId: 'new' });
  assert.deepEqual(service.list('todo'), []);
});

test('only on-time, direct user answers to the exact task run enter context, without credential cards', async t => {
  const { store, ledger, service } = fixture(t);
  const interactions = createInteractions({ store, events: createEventBus(store), decide: () => ({ handler: 'user', layer: 'default' }), answer: async () => {} });
  const input = { kind: 'question' as const, title: '发布顺序', body: '先发布哪一项？', runId: 'run', projectId: 'project' };
  const opened = interactions.open(input);
  const valid = await interactions.answer(opened.id, opened.version, '先发布客户端');
  await interactions.close();
  const [answer] = service.list('todo');
  assert.ok(answer);
  assert.deepEqual(answer, { id: 'answer:' + valid.id, source: 'answer', sourceId: valid.id, text: '发布顺序：先发布客户端', active: true });
  store.put('runs', 'other-run', { id: 'other-run', todoId: 'other', projectId: 'project' });
  store.put('runs', 'stale-run', { id: 'stale-run', todoId: 'todo', projectId: 'old' });
  const excluded = [{ kind: 'permission' }, { kind: 'review' }, { kind: 'plan' }, { answeredBy: 'main_agent' }, { answeredBy: 'rules' }, { answeredBy: 'user_chat' }, { answeredBy: undefined },
    { runId: 'other-run' }, { runId: 'stale-run' }, { runId: undefined }, { projectId: 'other' },
    { status: 'expired' }, { status: 'open' }, { status: 'withdrawn' }, { answer: '' },
    { answeredAt: valid.expiresAt }, { answeredAt: 'invalid' }, { title: '提供验证码' }, { body: 'Enter your API key' },
    { answer: 'Bearer fixture' }];
  excluded.forEach((patch, index) => {
    const id = 'excluded-' + index;
    store.put('interactions', id, { ...valid, ...patch, id });
  });
  assert.deepEqual(service.list('todo'), [answer]);
  assert.equal(service.list('other').length, 1); // Only the card actually linked to other-run.
  assert.throws(() => service.withdraw('other', answer.id), { status: 404 });
  const sameText = service.add('todo', answer.text);
  assert.ok(service.context('todo').includes('问答卡 ' + valid.id));
  assert.ok(service.context('todo').includes('工作决定 ' + sameText.id));
  assert.equal(service.context('todo').split(answer.text).length, 2);
  assert.equal(service.withdraw('todo', answer.id).active, false);
  assert.equal(createTodoDecisions(store, ledger).list('todo').find(item => item.source === 'answer')?.active, false);
  assert.deepEqual(store.get('interactions', valid.id), valid);
});

test('executor receives current task ledger decisions and drops withdrawn ones on the next dispatch', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'todo-decisions-'));
  const app = await createWorkbench({ host: '127.0.0.1', port: 0, dataDir, demo: true });
  t.after(async () => { try { await app.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const prompts: string[] = [];
  app.plugins.register({ id: 'decision-test', name: '本地测试', capabilities: ['executors'], activate(ctx) {
    ctx.contribute('executors', 'capture', { id: 'capture', name: '本地测试', kind: 'custom', machineId: 'fixture', mode: 'real', available: true,
      description: 'Capture executor input locally', async execute({ prompt }) { prompts.push(prompt); return { text: 'done' }; } });
  } });
  await app.plugins.setEnabled('decision-test', true);
  const project = app.projects.create({ name: '合成项目' });
  const notes = { action: 'save', projectId: project.id, revision: 0, notes: '用交付文件核对结果' };
  await app.plugins.invocations.use('project-instructions.manage', notes);
  const todo = app.createTodo({ title: '联调', projectId: project.id });
  const fact = app.workDecisions.recordFromWeb({ key: 'existing', text: '保留兼容格式', todoId: todo.id });
  const input = { executorId: 'capture', todoId: todo.id, prompt: '验证', doneWhen: '测试通过', expectMinutes: 1 };
  const run = app.dispatch(input, 'initial-guidance');
  await t.waitFor(() => assert.equal(prompts.length, 1));
  assert.ok(prompts[0]!.includes(fact.text));
  assert.ok(prompts[0]!.includes(fact.id));
  assert.ok(prompts[0]!.includes(fact.source.messageId));
  assert.ok(prompts[0]!.includes(notes.notes));
  assert.equal(app.store.get<{prompt:string}>('runs', run.id)?.prompt, input.prompt);
  await app.plugins.invocations.use('project-instructions.manage', { ...notes, revision: 1, notes: '' });
  assert.equal(app.dispatch(input, 'initial-guidance').id, run.id);
  app.todoDecisions.withdraw(todo.id, fact.id);
  app.dispatch(input);
  await t.waitFor(() => assert.equal(prompts.length, 2));
  assert.ok(prompts[1]!.startsWith(input.prompt));
  assert.ok(prompts[1]!.includes(JSON.stringify(input.doneWhen)));
  assert.ok(!prompts[1]!.includes(fact.text) && !prompts[1]!.includes(notes.notes));
});

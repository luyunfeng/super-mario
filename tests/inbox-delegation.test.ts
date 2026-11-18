import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { runWithAgentInput } from '../packages/core/src/agent-input.ts';
import type { Message, Run } from '../packages/protocol/src/index.ts';

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-inbox-delegation-'));
  const app = await createWorkbench({ dataDir, host: '127.0.0.1', port: 0, demo: true });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return app;
}

test('delegation persists its business link; inbox metadata does not expose another bot prompt', async t => {
  const app = await fixture(t);
  const todo = app.createTodo({ title: 'Business item', notes: 'Wait for explicit acceptance' });
  const accepted = await app.delegateTodo(todo.id);
  assert.equal(accepted.todoId, todo.id);
  app.store.put<Message>('messages', 'private-bot-input', { id: 'private-bot-input', todoId: todo.id, conversationId: 'bot:test', role: 'user', text: 'private prompt', status: 'pending', createdAt: '' });
  const snapshot = await app.snapshot();
  assert.equal(snapshot.agentTurns?.find(turn => turn.id === accepted.id)?.todoId, todo.id);
  const botTurn = snapshot.agentTurns?.find(turn => turn.id === 'private-bot-input');
  assert.equal(botTurn?.status, 'pending'); assert.equal(botTurn && 'text' in botTurn, false);
  assert.ok(!snapshot.messages.some(message => message.id === 'private-bot-input'));
  assert.equal(app.todos()[0].completedAt, undefined);
});

test('direct dispatch and a split plan both retain the delegated item and original input', async t => {
  const app = await fixture(t);
  const todo = app.createTodo({ title: 'Original item' });
  const accepted = await app.delegateTodo(todo.id);
  const find = (name: string) => app.contributions.list('tools').find(entry => entry.value.name === name)!.value;
  const signal = new AbortController().signal;
  const direct = await runWithAgentInput(accepted, () => find('work_dispatch').execute({ prompt: 'Direct work' }, signal)) as unknown as Run;
  assert.equal(direct.todoId, todo.id); assert.equal(direct.sourceMessageId, accepted.id);
  const plan = await runWithAgentInput(accepted, () => find('task_plan').execute({ title: 'Split work', start: true,
    tasks: [{ prompt: 'First task', doneWhen: 'First result', expectMinutes: 1 }, { prompt: 'Second task', doneWhen: 'Second result', expectMinutes: 1 }] }, signal)) as unknown as { tasks: Array<{ runId: string }> };
  assert.equal(plan.tasks.length, 2);
  for (const task of plan.tasks) {
    const run = app.store.get<Run>('runs', task.runId)!;
    assert.equal(run.todoId, todo.id); assert.equal(run.sourceMessageId, accepted.id);
  }
  assert.equal(app.todos()[0].completedAt, undefined);
});

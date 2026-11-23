import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuMessageSource, FeishuOptions } from '../plugins/feishu.ts';
import type { Run, Todo } from '../packages/protocol/src/index.ts';

test('模型在群任务私聊及登记话题只能给当前待办派工或制定计划', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'topic-work-scope-'));
  let action: { name: string; args: object } | undefined;
  const results: string[] = [], sent: string[] = [];
  let round = 0, adapter!: FeishuOptions;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.url, 'http://127.0.0.1:1/fixture/chat/completions');
    const body = await request.json();
    const last = body.messages.at(-1);
    const tool = last.role === 'user' ? action : undefined;
    if (tool) assert.ok(body.tools.some((entry: {function:{name:string}}) => entry.function.name === tool.name));
    if (last.role === 'tool') results.push(JSON.stringify(last.content));
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'tool_' + round, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: 'assistant', content: '离线验收-' + round };
    const frames = [delta, {}].map((part, i) => 'data: ' + JSON.stringify({ id: 'fixture', model: 'fixture',
      object: 'chat.completion.chunk', choices: [{ index: 0, delta: part, finish_reason: i ? (tool ? 'tool_calls' : 'stop') : null }] }));
    return new Response([...frames, 'data: [DONE]', ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  });
  const host = await startServer({ dataDir, port: 0, host: '127.0.0.1', demo: false, token: 'fixture',
    model: { provider: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/fixture', apiKey: 'offline' } }, {
    botFactory: options => { adapter = options; return { start: async () => {}, close: async () => {},
      status: () => ({ connected: true }), collect: async () => [], async send(_target, text, context) {
        context?.beforeSend?.(); sent.push(text); context?.onSent?.('om_delivered_' + sent.length);
      } }; },
  });
  t.after(async () => { try { await host.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  let launches = 0;
  host.app.contributions.add('executors', 'fixture', { id: 'fixture', name: '本地演示', machineId: 'local', kind: 'test',
    available: true, mode: 'demo', description: '仅记录合成调用', async execute() { launches++; return { text: '合成回执' }; } });
  const bot = await host.bots.create({ appId: 'cli_1111111111111111', appSecret: 'offline', name: '测试',
    scope: { kind: 'global' }, requireConfirmation: false });
  const group = (messageId: string, threadId?: string, rootId?: string): FeishuMessageSource => ({ messageId, threadId, rootId, chatId: 'oc_group',
    senderId: 'ou_owner', senderType: 'user', chatType: 'group', mentionedSelf: true });
  await adapter.onMessage(bot.pairingCode!, { messageId: 'om_pair', chatId: 'oc_private', senderId: 'ou_owner', senderType: 'user', chatType: 'p2p' });
  const step = { prompt: '核验合成样本', expectMinutes: 1, doneWhen: '产生合成回执', executorId: 'fixture' };
  const foreign = host.app.createTodo({ title: '其他合成任务', notes: '' });
  async function ask(text: string, route: ReturnType<typeof group>, name: string, args: object) {
    round++;
    action = { name, args };
    await adapter.onMessage(text, route);
    await t.waitFor(() => assert.ok(sent.includes('离线验收-' + round)), { timeout: 8000 });
    return results.at(-1)!;
  }
  host.app.store.put('runs', 'other-run', { id: 'other-run', todoId: foreign.id, status: 'completed', createdAt: new Date().toISOString() });
  const planCount = host.app.plans.list().length, runCount = host.app.store.list('runs').length;
  const badPrivate = await ask('/ai 核对外群材料', group('om_external'), 'task_plan',
    { title: '混合任务', start: true, tasks: [step, { ...step, todoId: foreign.id }] });
  assert.match(badPrivate, /不能跨出当前飞书待办/);
  assert.equal(host.app.plans.list().length, planCount);
  assert.equal(host.app.store.list('runs').length, runCount);
  await adapter.onMessage('/topics', group('om_topics'));
  const event = (id: string) => group(id, 'omt_scope', id === 'om_root' ? undefined : 'om_root');
  const badTopic = await ask('办理原话题工作', event('om_root'), 'work_dispatch', { ...step, todoId: foreign.id });
  assert.match(badTopic, /不能跨出当前飞书待办/);
  const badTree = await ask('使用原话题工作树', event('om_tree'), 'work_dispatch', { ...step, worktreeRunId: 'other-run' });
  assert.match(badTree, /工作树执行不属于当前飞书待办/);
  const badProject = await ask('只按原工作制作计划', event('om_project'), 'task_plan',
    { title: '跨项目', tasks: [{ ...step, projectId: 'other-project' }] });
  assert.match(badProject, /不能跨出当前飞书待办/);
  assert.equal(host.app.plans.list().length, planCount);
  assert.equal(host.app.store.list('runs').length, runCount);
  assert.equal(launches, 0);
  const todo = host.app.store.list<Todo>('todos').find(row => row.notes === '办理原话题工作')!;
  await ask('只准备两个步骤', event('om_plan'), 'task_plan', { title: '合成计划', tasks: [step, { ...step, todoId: todo.id }] });
  const plan = host.app.plans.list().find(row => row.title === '合成计划')!;
  assert.equal(plan.status, 'pending');
  assert.deepEqual(plan.tasks.map(task => task.todoId), [todo.id, todo.id]);
  assert.equal(launches, 0);
  await ask('使用演示执行者核对', event('om_send'), 'work_dispatch', step);
  await t.waitFor(() => assert.equal(launches, 1));
  const runs = host.app.store.list<Run>('runs');
  assert.equal(runs.length, runCount + 1);
  assert.equal(runs.at(-1)?.todoId, todo.id);
});

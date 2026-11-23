import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../packages/core/src/store.ts';
import { botConversationId } from '../packages/core/src/bot-agent-routing.ts';
import { createTopicExecutor } from '../apps/server/src/feishu-topic-executor.ts';
import type { FeishuBotSettings } from '../plugins/feishu-bot-config.ts';
import type { FeishuAgentInputTarget, MailboxEntry } from '../packages/protocol/src/bots.ts';
import type { Approval, ExecutorInfo, Message, Run } from '../packages/protocol/src/index.ts';

function fixture(t: TestContext) {
  const store = createStore(':memory:'); t.after(() => store.close());
  const now = new Date().toISOString(), bot: FeishuBotSettings = { id: 'bot', appId: 'app', appSecret: 'offline', name: '离线',
    scope: { kind: 'global' }, enabled: true, revision: 1, requireConfirmation: false, createdAt: now, updatedAt: now };
  const source = { chatId: 'group', threadId: 'thread', messageId: 'om_decision', senderId: 'owner', senderType: 'user' as const, chatType: 'group' };
  const paired = { chatId: 'private', senderId: 'owner' };
  const topic = { binding: 'binding', grant: 'grant', opening: false, todoId: 'todo' };
  const run: Run = { id: 'run', executorId: 'machine/test', machineId: 'machine', sessionId: 'session',
    conversationId: 'main', prompt: '合成任务', executionMode: 'interactive', status: 'running', output: '', todoId: 'todo', createdAt: now, updatedAt: now };
  const todo = { id: 'todo', responsibleSession: { runId: run.id, machineId: run.machineId, sessionId: run.sessionId } };
  const stamp = { revision: 1, topic, group: source, threadId: source.threadId, platformReplyTo: source.messageId };
  const msg: Message = { id: 'input', text: '只继续合成任务', role: 'user', status: 'done', todoId: todo.id, createdAt: now, conversationId: botConversationId(bot) };
  const entry: MailboxEntry = { id: 'entry', botId: bot.id, direction: 'inbox', scope: bot.scope, target: source.chatId,
    eventKey: 'feishu-in:' + JSON.stringify([bot.id, bot.appId, source.messageId]), sourceMessageId: source.messageId, text: msg.text,
    version: 1, title: '决定', status: 'processing', requiresConfirmation: false, createdAt: now, updatedAt: now };
  const route = { ...stamp, channel: 'feishu', botId: bot.id, accountId: bot.appId, inputId: msg.id, scope: bot.scope,
    target: source.chatId, sourceMessageId: source.messageId, envelopeId: entry.id };
  store.put('todos', todo.id, todo); store.put('runs', run.id, run);
  store.put('machines', 'machine', { online: true, capabilities: ['executor.input'] });
  store.put('messages', msg.id, msg); store.put('message.routes', msg.id, route);
  store.put('feishu.bot.envelopes', entry.id, stamp); store.put('feishu.bot.dispatch', 'bot:app:entry', { status: 'completed', id: msg.id });
  const executor: ExecutorInfo = { id: run.executorId, machineId: 'machine', name: '合成执行器', mode: 'real', kind: 'test', available: true, description: '仅测试' };
  const service = createTopicExecutor({ store, listExecutors: () => [executor], mailboxes: {
    list: () => [entry], put: () => { throw Error('unused'); }, process: async () => {} },
    approvals: { propose(input) { const item = { ...input, id: 'approval-' + store.list('approvals').length, status: 'pending' as const };
      store.put('approvals', item.id, item); return item; } } });
  return { service, store, todo, msg, run, entry, route, executor, bot, selected: service.select(todo.id)!,
    propose() { return service.propose(bot, paired, source, topic, msg.id, this.selected); } };
}

test('已明确登记的可用交互会话生成唯一待审批原文，重复接收和事务回滚不留下额外申请', t => {
  const f = fixture(t);
  assert.throws(() => f.store.transaction(() => { assert.ok(f.propose().approvalId); throw Error('rollback'); }), /rollback/);
  assert.equal(f.store.list('approvals').length, 0);
  const notice = f.propose();
  assert.deepEqual(f.propose(), notice);
  assert.equal(f.store.list('approvals').length, 1);
  const approval = f.store.get<Approval>('approvals', notice.approvalId!)!;
  assert.equal(approval.params.text, f.msg.text);
  const target = f.store.get<FeishuAgentInputTarget>('feishu.agent-input-targets', approval.id)!;
  assert.equal(f.service.valid(target), true);
  assert.equal(target.topic?.inputId, f.msg.id);
  f.store.put('todos', f.todo.id, { ...f.todo, responsibleSession: { ...f.todo.responsibleSession, runId: 'new-run' } });
  assert.equal(f.service.valid(target), false);
  f.store.put('todos', f.todo.id, f.todo);
  f.entry.text = '被篡改的正文';
  assert.equal(f.service.valid(target), false);
  f.store.put('messages', f.msg.id, { ...f.msg, text: f.entry.text });
  assert.equal(f.service.valid(target), false);
});

test('缺少来源回执、错误执行器或审批前目标变化时保留决定并拒绝派送', async t => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['收件回执错配', f => f.store.put('feishu.bot.dispatch', 'bot:app:entry', { status: 'completed', id: 'other' })],
    ['原群话题替换', f => f.store.put('message.routes', 'input', { ...f.route, threadId: 'other' })],
    ['项目错配', f => f.store.put('runs', 'run', { ...f.run, projectId: 'other' })],
    ['新的执行轮次复用会话', f => f.store.put('runs', 'new-run', { ...f.run, id: 'new-run' })],
    ['离线', f => f.store.put('machines', 'machine', { online: false, capabilities: ['executor.input'] })],
    ['只支持任务', f => { f.executor.taskOnly = true; }],
    ['绑定其他执行器', f => { f.bot.executorId = 'other'; }],
  ];
  for (const [name, change] of cases) await t.test(name, t => {
    const f = fixture(t); change(f);
    assert.equal(f.propose().approvalId, undefined);
    assert.deepEqual(f.store.list('approvals'), []);
  });
  const f = fixture(t);
  f.store.put('todos', f.todo.id, { id: f.todo.id });
  assert.equal(f.service.select(f.todo.id), undefined);
});

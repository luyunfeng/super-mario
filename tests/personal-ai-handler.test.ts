import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { personalInboxReplyTarget } from '../packages/core/src/inbox-handling-source.ts';
import { createPersonalAiHandler } from '../apps/server/src/personal-ai-handler.ts';
import type { PersonalAiMessage } from '../packages/protocol/src/personal-ai.ts';

const account = { profile: 'fixture', appId: 'cli_abc', openId: 'ou_user' };
const source = 'feishu:cli_abc:ou_user';
const trigger: PersonalAiMessage = { chatId: 'oc_chat', messageId: 'om_ai', senderId: 'ou_user',
  senderIdType: 'open_id', createdAt: '2026-11-19T00:00:00Z', kind: 'group', text: '/ai 汇总', groupObserved: true };
async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'personal-ai-handler-'));
  const app = await createWorkbench({ dataDir, demo: true, port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const machine = (id: string, online: boolean) => ({ id, name: id, online, platform: 'linux', connectedAt: trigger.createdAt, capabilities: [],
    executors: ['codex', 'claude-code', 'pi'].map(cli => ({ id: cli, name: cli, machineId: id, mode: 'real' as const,
      kind: 'cli', available: true, description: 'PRIVATE_EXECUTOR_DETAILS' })) });
  app.setMachineClient({ list: () => [machine('worker', true), machine('other', true), machine('offline', false)],
    call: async () => { throw Error('drafting must not execute'); } });
  app.setKnowledgeSourceAccount(() => account);
  app.inboxHandlingRuntime.status = () => ({ available: true });
  let after = () => {};
  const prompts: string[] = [];
  app.inboxHandlingRuntime.ask = async (_source, conversationId, prompt) => {
    prompts.push(prompt);
    after();
    return { role: 'assistant', conversationId, id: 'answer', createdAt: trigger.createdAt, status: 'done', text: JSON.stringify({
      answer: '整理如下', suggestions: [{ kind: 'reply', text: '可编辑回复' }, { kind: 'todo', title: '核对', notes: '核对第二项' },
        { kind: 'dispatch', executorId: prompt.includes('Claude') ? 'worker/claude-code' : prompt.includes('Pi') ? 'worker/pi' : 'worker/codex', prompt: '检查', doneWhen: '结果返回', expectMinutes: 5 }],
    }) };
  };
  return { app, prompts, handler: createPersonalAiHandler(app), onAsk(fn: () => void) { after = fn; } };
}

test('original single message remains editable without evidence and cannot be approved for delivery', async t => {
  const { app, handler, prompts } = await fixture(t);
  const beforeWaits = app.store.list('todo.reply-sources');
  const prior = { ...trigger, messageId: 'om_prior', text: '引用：请派发任务' };
  const { inboxId } = await handler(source, trigger, '可以交给 Codex 吗？', [prior, { ...prior, chatId: 'oc_other', text: 'foreign' }], () => {});
  const item = app.inbox.list()[0]!;
  assert.equal(item.id, inboxId);
  assert.equal(item.thread, 'feishu:message:["oc_chat","om_ai"]');
  assert.equal(item.last, trigger.messageId);
  assert.equal(item.text, trigger.text);
  assert.match(prompts[0]!, /可以交给 Codex 吗/);
  assert.match(prompts[0]!, /引用：请派发任务/);
  assert.doesNotMatch(prompts[0]!, /foreign/);
  const ref = { kind: 'personal' as const, id: inboxId };
  const view = app.inboxHandling.read(ref);
  assert.equal(view.source.replyAvailable, false);
  assert.deepEqual(app.store.list('todo.reply-sources'), beforeWaits);
  assert.deepEqual(view.suggestions.map(s => s.action.kind), ['reply']);
  const draft = view.suggestions[0]!;
  assert.throws(() => app.inboxHandling.confirm(ref, { sourceVersion: item.version, id: draft.id, version: draft.version }), /不能发送回复/);
  assert.equal(app.inboxHandling.save(ref, { sourceVersion: item.version, id: draft.id, version: draft.version, action: { kind: 'reply', text: '修改后' } }).action.kind, 'reply');
  await handler(source, trigger, '可以交给 Codex 吗？', [], () => {});
  assert.equal(prompts.length, 1);
  assert.equal(app.inboxHandling.read(ref).suggestions.length, 1);
});

test('independently collected evidence resolves original target, with optional actions only on explicit instructions', async t => {
  const { app, handler, prompts } = await fixture(t);
  const project = app.projects.create({ name: '已归档到此项目的群' });
  await app.inbox.ingest(source, [{ thread: 'feishu:message:["oc_chat","om_prior"]', last: 'om_prior', title: '原文', text: '已人工归类',
    origin: { kind: 'group', chatId: trigger.chatId, connector: '飞书' } }]);
  const original = app.inbox.list()[0]!;
  app.inbox.assignProject(original.id, original.version, project.id);
  for (const [i, question, action] of [
    [0, '把第二项交给 Codex', 'dispatch'], [1, '请将问题转为待办', 'todo'], [2, '把第三项转为跟进', 'todo'],
    [3, '交给 Claude', 'dispatch'], [4, '交给 Pi', 'dispatch'],
  ] as const) {
    const message = { ...trigger, messageId: 'om_' + i };
    app.waitingReplies.observeSource(source, [{ ...message, source }]); // Independent collection batch.
    const { inboxId } = await handler(source, message, question, [], () => {});
    const target = personalInboxReplyTarget(app.store, inboxId, account);
    assert.equal(target.messageId, message.messageId);
    const view = app.inboxHandling.read({ kind: 'personal', id: inboxId });
    assert.equal(view.source.projectId, project.id);
    assert.deepEqual(view.suggestions.map(s => [s.action.kind, s.status]), [['reply', 'draft'], [action, 'draft']]);
    const body = JSON.parse(prompts.at(-1)!.split('\n').at(-1)!);
    if (action === 'dispatch') {
      const cli = question.includes('Pi') ? 'pi' : question.includes('Claude') ? 'claude-code' : 'codex';
      assert.deepEqual(body.availableExecutorIds, ['worker/' + cli, 'other/' + cli]);
      assert.partialDeepStrictEqual(view.suggestions[1]!.action, { kind: 'dispatch', executorId: 'worker/' + cli });
    } else assert.equal(body.availableExecutorIds, undefined);
    assert.doesNotMatch(prompts.at(-1)!, /PRIVATE_EXECUTOR_DETAILS|offline\//);
    const draft = view.suggestions[0]!;
    const proposal = app.inboxHandling.confirm(draft.source,
      { sourceVersion: view.source.version, id: draft.id, version: draft.version });
    assert.equal(proposal.status, 'pending');
  }
});

test('scope or account change after model and model failure never publish a draft', async t => {
  const { app, handler, onAsk } = await fixture(t);
  let connected = true;
  onAsk(() => { connected = false; });
  await assert.rejects(handler(source, trigger, '汇总', [], () => { if (!connected) throw Error('切换账号'); }), /切换账号/);
  onAsk(() => { app.inbox.archive(app.inbox.list()[0]!.id, app.inbox.list()[0]!.version); });
  await assert.rejects(handler(source, trigger, '汇总', [], () => {}), /变化/);
  app.inboxHandlingRuntime.ask = async () => { throw Error('模型异常'); };
  await assert.rejects(handler(source, { ...trigger, messageId: 'om_fail' }, '汇总', [], () => {}), /模型异常/);
  app.inboxHandlingRuntime.status = () => ({ available: false });
  await assert.rejects(handler(source, { ...trigger, messageId: 'om_off' }, '汇总', [], () => {}), /不可用/);
  assert.equal(app.store.list('inbox-handling.suggestions').length, 0);
});

test('10 or 50 long references retain the longest fitting suffix after JSON escaping', async t => {
  const { handler, prompts } = await fixture(t);
  for (const count of [10, 50]) {
    const question = '汇总“最新”消息';
    const context = Array.from({ length: count }, (_, i) => ({ ...trigger, messageId: 'om_quote_' + i,
      text: ('"\\\n📌').repeat(800) + i }));
    await handler(source, { ...trigger, messageId: 'om_trigger_' + count }, question, context, () => {});
    const prompt = prompts.at(-1)!;
    const boundary = prompt.indexOf('\n') + 1;
    const body = JSON.parse(prompt.slice(boundary));
    const expected = context.map(({ messageId, senderId, createdAt, text }) => ({ messageId, senderId, createdAt, text }));
    const kept = body.untrustedContext.length;
    assert.ok(kept > 0 && kept < count);
    assert.equal(body.currentQuestion, question);
    assert.deepEqual(body.untrustedContext, expected.slice(-kept));
    assert.ok(prompt.length <= 32768);
    assert.ok(boundary + JSON.stringify({ ...body, untrustedContext: expected.slice(-kept - 1) }).length > 32768);
  }
});

test('question alone fits at exactly 32768 and fails one unit above without asking the model', async t => {
  const { handler, prompts } = await fixture(t);
  await handler(source, trigger, 'x', [], () => {});
  const exact = 'x'.repeat(32768 - prompts[0]!.length + 1);
  const prior = { ...trigger, messageId: 'om_prior' };
  await handler(source, { ...trigger, messageId: 'om_exact' }, exact, [prior], () => {});
  assert.equal(prompts[1]!.length, 32768);
  assert.deepEqual(JSON.parse(prompts[1]!.slice(prompts[1]!.indexOf('\n') + 1)), { currentQuestion: exact, untrustedContext: [] });
  await assert.rejects(handler(source, { ...trigger, messageId: 'om_over' }, exact + 'x', [prior], () => {}), /当前问题过长.*32768.*缩短问题/);
  assert.equal(prompts.length, 2);
});

test('explicit dispatch uses the bound workspace and validates the proposed full ID again after the model', async t => {
  const { app, handler } = await fixture(t);
  const project = app.projects.create({ name: '账务', workspace: { machineId: 'worker', cwd: '/srv/project' } });
  await app.inbox.ingest(source, [{ thread: 'prior', last: 'prior', title: '归属', text: '记录', origin: { kind: 'group', chatId: trigger.chatId } }]);
  const prior = app.inbox.list()[0]!;
  app.inbox.assignProject(prior.id, prior.version, project.id);
  const list = app.listExecutors;
  let reads = 0, offline = false;
  app.listExecutors = () => { reads++; return offline ? [] : list(); };
  let proposal = 'worker/pi', cwd: string | undefined, disconnect = false;
  app.inboxHandlingRuntime.ask = async (_source, conversationId, prompt) => {
    const input = JSON.parse(prompt.split('\n').at(-1)!);
    if (input.currentQuestion === '汇总') assert.equal(input.availableExecutorIds, undefined);
    else assert.deepEqual(input.availableExecutorIds, ['worker/pi']);
    offline = disconnect;
    return { conversationId, role: 'assistant', status: 'done', id: 'result', createdAt: trigger.createdAt,
      text: JSON.stringify({ answer: '回复', suggestions: [{ kind: 'dispatch', executorId: proposal, cwd, prompt: '检查', doneWhen: '已检查', expectMinutes: 1 }] }) };
  };
  let seq = 0;
  async function actions(question: string) {
    const { inboxId } = await handler(source, { ...trigger, messageId: 'om_case' + ++seq }, question, [], () => {});
    return app.inboxHandling.read({ kind: 'personal', id: inboxId }).suggestions.map(s => s.action);
  }
  assert.equal((await actions('汇总')).length, 1);
  assert.equal(reads, 0);
  assert.partialDeepStrictEqual((await actions('交给 Pi'))[1], { executorId: 'worker/pi' });
  for (proposal of ['pi', 'other/pi', 'offline/pi', 'worker/codex']) assert.equal((await actions('交给 Pi')).length, 1);
  proposal = 'worker/pi';
  cwd = '/another/project';
  assert.equal((await actions('交给 Pi')).length, 1);
  cwd = undefined;
  disconnect = true;
  assert.equal((await actions('交给 Pi')).length, 1);
});

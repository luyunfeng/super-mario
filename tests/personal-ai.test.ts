import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createStore } from '../packages/core/src/store.ts';
import { createPersonalAi } from '../packages/core/src/personal-ai.ts';
import type { PersonalAiMessage } from '../packages/protocol/src/personal-ai.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { resolve, promise };
}

const source = 'feishu:app:ou_self';
function message(id: string, changes: Partial<PersonalAiMessage> = {}): PersonalAiMessage {
  return { messageId: id, chatId: 'oc_test', kind: 'direct', senderId: 'ou_self', senderIdType: 'open_id',
    text: '/ai 问题', createdAt: new Date(Date.now() + 1000).toISOString(), ...changes };
}

test('只接受启用后、正确账号内的白名单 open_id 和完整命令', async t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const calls: string[] = [];
  const ai = createPersonalAi({ store, account: () => source, async handle(_, trigger, question) {
    calls.push(trigger.messageId); assert.equal(question, '问题'); return { inboxId: 'inbox-test' };
  } });
  assert.deepEqual(ai.status(), { enabled: false, prefix: '/ai', contextCount: 10, chatIds: [], triggerSenderIds: [], turns: [] });
  ai.observe(source, [message('off')]);
  assert.throws(() => ai.configure({ enabled: true, triggerSenderIds: ['name'] }), /triggerSenderIds/);
  ai.configure({ enabled: true, triggerSenderIds: ['ou_friend'], chatIds: ['oc_test'] });
  ai.observe('feishu:other:ou_self', [message('account')]);
  const group = { kind: 'group', groupObserved: true, groupUserCount: 50 } as const;
  ai.observe(source, [
    message('old', { createdAt: new Date(0).toISOString() }), message('type', { senderIdType: 'user_id' }),
    message('not-authorized', { senderId: 'ou_other' }), message('prefix', { text: '/aider 问题' }),
    message('empty', { text: '/ai ' }), message('self'), message('friend', { senderId: 'ou_friend' }),
    message('unknown-group', { ...group, groupUserCount: undefined }), message('large', { ...group, groupUserCount: 51 }),
    message('unobserved', { ...group, groupObserved: false }), message('other-chat', { ...group, chatId: 'oc_other' }),
    message('unauthorized-group', { ...group, senderId: 'ou_other' }), message('allowed-group', group),
  ]);
  await tick();
  assert.deepEqual(calls, ['self', 'friend', 'allowed-group']);
  assert.ok(ai.status().turns.every(turn => turn.status === 'completed' && turn.inboxId === 'inbox-test'));
});

test('最近上下文按时间排序、截断并隔离话题，采集无需等待处理完成', async t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const gate = deferred();
  const contexts: string[][] = [];
  const ai = createPersonalAi({ store, account: () => source, async handle(_, trigger, __, context) {
    contexts.push(context.map(item => item.messageId));
    await gate.promise;
    return { inboxId: trigger.messageId };
  } });
  ai.configure({ enabled: true, contextCount: 2, chatIds: ['oc_test'] });
  const base = Date.now() + 1000;
  const group = (id: string, order: number, changes: Partial<PersonalAiMessage> = {}) => message(id, {
    kind: 'group', groupObserved: true, groupUserCount: 5, threadId: 'thread', senderId: 'ou_other', text: id,
    createdAt: new Date(base + order).toISOString(), ...changes,
  });
  ai.observe(source, [group('later', 8), group('two', 2), group('one', 1), group('three', 3),
    group('other-thread', 4, { threadId: 'other' }), group('chat-level', 5, { threadId: undefined }),
    group('ask', 6, { senderId: 'ou_self', text: '/ai 汇总' })]);
  assert.equal(ai.status().turns[0].status, 'pending');
  await tick();
  assert.deepEqual(contexts, [['two', 'three']]);
  gate.resolve(); await tick();
  assert.equal(ai.status().turns[0].inboxId, 'ask');
});

test('失败和中断都保留去重记录，关闭后延迟回执不会覆盖未知结果', async t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const gate = deferred();
  const calls: string[] = [];
  const options = { store, account: () => source, async handle(_: string, trigger: PersonalAiMessage) {
    calls.push(trigger.messageId);
    if (trigger.messageId === 'fail') throw new Error('测试处理失败');
    await gate.promise;
    return { inboxId: 'late' };
  } };
  const ai = createPersonalAi(options);
  ai.configure({ enabled: true });
  const batch = [message('fail'), message('unfinished')];
  ai.observe(source, batch); ai.observe(source, batch); await tick();
  assert.equal(ai.status().turns.find(turn => turn.messageId === 'fail')?.error, '收件箱处理失败');
  const closing = ai.close();
  const restarted = createPersonalAi(options);
  restarted.configure({ enabled: false }); restarted.configure({ enabled: true });
  restarted.observe(source, batch);
  gate.resolve(); await closing;
  assert.deepEqual(calls, ['fail', 'unfinished']);
  assert.deepEqual(restarted.status().turns.map(turn => turn.status), ['unknown', 'failed']);
});

test('异步执行在退出账号或关闭设置时失效，重新启用仍使用新边界', async t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  let active = source;
  let guard: (() => void) | undefined;
  const gate = deferred();
  const ai = createPersonalAi({ store, account: () => active, async handle(_, __, ___, ____, assertCurrent) {
    guard = assertCurrent; await gate.promise; assertCurrent(); return { inboxId: 'late' };
  } });
  ai.configure({ enabled: true }); ai.observe(source, [message('first')]); await tick();
  active = 'feishu:app:ou_other';
  assert.equal(ai.status().enabled, false); assert.deepEqual(ai.status().turns, []);
  active = source;
  assert.throws(() => guard!(), /变更/);
  gate.resolve(); await tick();
  assert.equal(ai.status().turns[0].status, 'unknown');
  ai.observe(source, [message('queued')]);
  ai.configure({ enabled: false }); ai.configure({ enabled: true });
  await tick();
  assert.equal(ai.status().turns[0].status, 'unknown');
});

test('本人可以引用同一私聊的对方发言，其他私聊隔离，对方不能触发', async t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const contexts: string[][] = [];
  const ai = createPersonalAi({ store, account: () => source, async handle(_, trigger, __, context) {
    contexts.push(context.map(item => item.messageId));
    return { inboxId: trigger.messageId };
  } });
  ai.configure({ enabled: true });
  ai.observe(source, [
    message('elsewhere', { chatId: 'oc_elsewhere', senderId: 'ou_peer', text: '另一私聊' }),
    message('peer-command', { senderId: 'ou_peer' }),
    message('peer', { senderId: 'ou_peer', text: '合成引用' }),
    message('self', { text: '/ai 对方刚才说什么' }),
  ]);
  await tick();
  assert.deepEqual(contexts, [['peer-command', 'peer']]);
  assert.deepEqual(ai.status().turns.map(turn => turn.messageId), ['self']);
});

test('撤销群授权或重新启用后，先前的群引用不会进入新问题', async t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const contexts: string[][] = [];
  const ai = createPersonalAi({ store, account: () => source, async handle(_, trigger, __, context) {
    contexts.push(context.map(item => item.messageId));
    return { inboxId: trigger.messageId };
  } });
  const group = { kind: 'group', groupObserved: true, groupUserCount: 4 } as const;
  ai.configure({ enabled: true, chatIds: ['oc_test'] });
  ai.observe(source, [message('previous', { ...group, text: '旧引用' })]);
  ai.configure({ chatIds: [] }); ai.configure({ chatIds: ['oc_test'] });
  ai.observe(source, [message('after-removal', group)]);
  await tick();
  ai.configure({ enabled: false }); ai.configure({ enabled: true });
  ai.observe(source, [message('after-enabling', group)]);
  await tick();
  assert.deepEqual(contexts, [[], []]);
});

test('同账号采集授权换代会拦截旧批次、处理中及排队的指令', async t => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const gate = deferred();
  const started: string[] = [], completed: string[] = [];
  const ai = createPersonalAi({ store, account: () => source, async handle(_, trigger, __, ___, assertCurrent) {
    started.push(trigger.messageId);
    await gate.promise;
    assertCurrent();
    completed.push(trigger.messageId);
    return { inboxId: trigger.messageId };
  } });
  ai.configure({ enabled: true });
  let generation = 1;
  const original = () => { if (generation !== 1) throw new Error('合成私密异常'); };
  ai.observe(source, [message('running'), message('queued')], original);
  await tick();
  generation++;
  assert.throws(() => ai.observe(source, [message('late')], original), /采集授权已变更/);
  gate.resolve(); await tick();
  assert.deepEqual(started, ['running']);
  assert.deepEqual(completed, []);
  const turns = ai.status().turns;
  assert.deepEqual(turns.map(turn => turn.status), ['unknown', 'unknown']);
  assert.doesNotMatch(JSON.stringify(turns), /合成私密异常/);
});

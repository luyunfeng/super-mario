import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { groupTaskCommand } from '../plugins/feishu-read-command.ts';
import { createFeishuIntegration, type FeishuMessageSource } from '../plugins/feishu.ts';

test('群任务匹配独立命令与飞书真实点名，保留任务原文', () => {
  const mentions = [{ key: '@_user_1', openId: 'ou_self', self: true as const }, { key: '@_user_10', openId: 'ou_other' }];
  assert.deepEqual(groupTaskCommand('　@_user_1　／Ai　排查 /read 与 /aim 的差别　', mentions),
    { task: '排查 /read 与 /aim 的差别', addressed: true });
  assert.deepEqual(groupTaskCommand('@_user_10 /ai 整理', mentions), { task: '整理', addressed: false });
  assert.deepEqual(groupTaskCommand('/ai'), { task: '', addressed: true });
  for (const text of ['/aim', '//ai 说明', '/ai任务', '问题里带 /ai', '/read 告警']) assert.equal(groupTaskCommand(text), undefined);
});

test('读群关闭时 SDK 仍只将未登记群的真实点名任务交给主机，普通已登记群照常接入', async t => {
  let dispatcher!: EventDispatcher;
  const calls: { text: string; source: FeishuMessageSource }[] = [];
  const adapter = createFeishuIntegration({ appId: 'cli_1234567890123456', appSecret: 'fixture', readGroup: false,
    groupTasks: true, groupMessages: true, groupChatIds: ['oc_listed'], commandGroupChatId: 'oc_command',
    async onMessage(text, source) { calls.push({ text, source }); }, async onInbox() {},
    fetch: async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 3600 });
      assert.equal(path, '/open-apis/bot/v3/info');
      return Response.json({ code: 0, bot: { open_id: 'ou_self' } });
    },
    wsFactory: opts => ({ async start(spec) { dispatcher = spec.eventDispatcher; opts.onReady?.(); }, close() {},
      getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }) }),
  });
  t.after(() => adapter.close());
  await adapter.start();
  await t.waitFor(() => assert.equal(adapter.status().reason, undefined));
  async function emit(id: string, type: string, content: unknown, chat = 'oc_unlisted', mention = 'ou_self', sender = 'user') {
    await dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: id }, event: {
      sender: { sender_type: sender, sender_id: { open_id: 'ou_author' } },
      message: { chat_type: 'group', chat_id: chat, message_type: type, message_id: id, thread_id: 'omt_topic', content: JSON.stringify(content),
        mentions: mention ? [{ key: '@_user_1', id: { open_id: mention }, name: '同名机器人' }] : [] },
    } }, { needCheck: false });
  }
  const task = { text: '@_user_1 /ai 复盘' };
  const post = { zh_cn: { title: '', content: [[{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: '／AI　核对' }]] } };
  await emit('plain', 'text', task);
  await emit('post', 'post', post);
  await emit('other', 'post', post, 'oc_unlisted', 'ou_other');
  await emit('literal', 'text', { text: '@同名机器人 /ai 冒名' }, 'oc_unlisted', '');
  await emit('elsewhere', 'text', { text: '@_user_1 普通聊天' });
  await emit('disabled-read', 'text', { text: '@_user_1 /读群' });
  await emit('forward', 'merge_forward', post);
  await emit('bot', 'text', task, 'oc_unlisted', 'ou_self', 'app');
  await emit('known', 'text', { text: '普通群消息' }, 'oc_listed', '');
  await emit('known-post', 'post', post, 'oc_listed');
  await t.waitFor(() => assert.equal(calls.length, 4));
  assert.deepEqual(calls.map(row => row.source.messageId), ['plain', 'post', 'known', 'known-post']);
  for (const call of calls.filter(call => call.source.messageId !== 'known')) {
    assert.ok(call.source.mentionedSelf);
    assert.equal(call.source.senderId, 'ou_author');
    assert.equal(call.source.threadId, 'omt_topic');
    assert.ok(groupTaskCommand(call.text, call.source.mentions)?.addressed);
  }
});

test('任务引用按机器人身份只读取原群的单条父消息，撤权时拒绝交付', async t => {
  let answer: Record<string, unknown> = {}, allowed = true, invalidateDuringRead = false;
  const paths: string[] = [];
  const adapter = createFeishuIntegration({ appId: 'cli_1234567890123456', appSecret: 'fixture',
    async onMessage() {}, async onInbox() {},
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 3600 });
      paths.push(path);
      assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture');
      if (invalidateDuringRead) allowed = false;
      return Response.json({ code: 0, data: { items: [answer] } });
    },
    wsFactory: opts => ({ async start() { opts.onReady?.(); }, close() {},
      getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }) }),
  });
  t.after(() => adapter.close());
  await adapter.start();
  const quote = () => adapter.readTaskQuote('oc_original', 'om_parent', () => {
    if (!allowed) throw new Error('来源已撤销');
  });
  const plain = { message_id: 'om_parent', chat_id: 'oc_original', msg_type: 'text', body: { content: JSON.stringify({ text: '🍄'.repeat(301) }) } };
  answer = plain;
  assert.equal(await quote(), '🍄'.repeat(300));
  for (const change of [{ chat_id: 'oc_other' }, { message_id: 'om_other' }, { deleted: true }, { msg_type: 'merge_forward' }, { msg_type: 'file' },
    { body: { content: 'broken' } }]) {
    answer = { ...plain, ...change }; assert.equal(await quote(), undefined);
  }
  const mentions = [{key:'@_user_1', id:{open_id:'ou_example'}, name:'复核员'}];
  answer = { ...plain, mentions, body:{content:JSON.stringify({text:'请 @_user_1 复核'})} };
  assert.equal(await quote(), '请 @复核员 复核');
  answer = { ...plain, mentions, msg_type: 'post', body: { content: JSON.stringify({ zh_cn: { title: '标题', content: [[
    { tag: 'text', text: '附件见' }, { tag: 'a', text: '此处', href: 'https://fixture.invalid/' }, { tag: 'img', image_key: 'private-key' },
    { tag: 'at', user_id: 'ou_example' }, {tag:'code_block', language:'text', text:'样例数据'},
  ]] } }) } };
  assert.equal(await quote(), '**标题**\n附件见[此处](https://fixture.invalid/)[图片]@复核员\n```text\n样例数据\n```');
  invalidateDuringRead = true;
  await assert.rejects(quote(), /来源已撤销/);
  assert.ok(paths.length > 0 && paths.every(path => path === '/open-apis/im/v1/messages/om_parent'));
});

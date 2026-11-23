import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { topicGroupCommand } from '../plugins/feishu-read-command.ts';
import { createFeishuIntegration, type FeishuMessageSource } from '../plugins/feishu.ts';

test('话题群命令支持平台点名、全角及中英文别名', () => {
  for (const cmd of ['/topics', '/TOPICS ON', ' ／话题群　开 ']) assert.equal(topicGroupCommand(cmd), 'on');
  for (const cmd of ['/topics OFF', '/ 话题群 关', '／话题群　关闭']) assert.equal(topicGroupCommand(cmd), 'off');
  for (const cmd of ['/topics home', '／话题群 主群', '@_user_10@机器人/topics HOME'])
    assert.equal(topicGroupCommand(cmd, [{ key: '@_user_1' }, { key: '@_user_10', name: '机器人' }]), 'home');
  for (const text of ['//topics', '@任意/topics', '/topic', '/topics 开 off', '/topics other', '/topicsOn'])
    assert.equal(topicGroupCommand(text), undefined);
});

test('话题群按最新登记与严格点名收件，保留原话题与富文本，读取已确认消息的话题编号', async t => {
  let dispatcher!: EventDispatcher;
  const calls: Array<{text: string; source: FeishuMessageSource}> = [];
  const policy = new Map<string, {requireOwnerMention: boolean}>();
  let resume!: () => void;
  const pause = new Promise<void>(resolve => { resume = resolve; });
  let fetched: Record<string, unknown> = {}, invalidate = false, allowed = true;
  const adapter = createFeishuIntegration({
    appId: 'cli_1234567890123456', appSecret: 'fixture', readGroup: true, groupMessages: true, groupChatIds: ['listed'],
    commandGroupChatId: 'command', topicPolicy: id => policy.get(id),
    async onMessage(text, source) {
      calls.push({ text, source });
      if (source.messageId === 'open') { await pause; policy.set(source.chatId, { requireOwnerMention: false }); }
      if (source.messageId === 'off') policy.delete(source.chatId);
    },
    async onInbox() {},
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 3600 });
      if (path.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: 'ou_self' } });
      assert.equal(path, '/open-apis/im/v1/messages/om_sent');
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture');
      if (invalidate) allowed = false;
      return Response.json({ code: 0, data: {items: [fetched]} });
    },
    wsFactory: opts => ({ async start(spec) { dispatcher = spec.eventDispatcher; opts.onReady?.(); }, close() {},
      getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }) }),
  });
  t.after(() => adapter.close());
  await adapter.start();
  await t.waitFor(() => assert.equal(adapter.status().reason, undefined));
  const emit = (id: string, content: string | object, thread = '', chat = 'external', mention = '', type = typeof content === 'string' ? 'text' : 'post') =>
    dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: id }, event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' }, name: '合成主人' },
      message: { chat_id: chat, chat_name: '合成群', chat_type: 'group', message_type: type, message_id: id, thread_id: thread,
        root_id: 'om_root', parent_id: 'om_parent', content: JSON.stringify(typeof content === 'string' ? { text: content } : content),
        mentions: mention ? [{ key: '@_user_1', id: { open_id: mention }, name: '机器人' }] : [] },
    } }, { needCheck: false });
  const post = {zh_cn: { title: '报告', content: [[{ tag: 'text', text: '见' }, { tag: 'a', text: '详情', href: 'https://example.invalid/' }]] }};
  await emit('unlisted', '未登记', 'omt');
  await emit('link-not-command', {content: [[{tag:'a', text:'/topics', href:'https://example.invalid/'}]]});
  await emit('open', '／话题群 主群');
  await emit('first', post, 'omt');
  resume();
  await t.waitFor(() => assert.equal(calls.at(-1)?.source.messageId, 'first'));
  assert.equal(calls[1].text, '报告\n见[详情](https://example.invalid/)');
  assert.deepEqual([calls[1].source.threadId, calls[1].source.parentId, calls[1].source.rootId, calls[1].source.chatName, calls[1].source.senderName],
    ['omt', 'om_parent', 'om_root', '合成群', '合成主人']);
  await emit('root-only', '普通正文');
  await emit('merged', post, 'omt', 'external', '', 'merge_forward');
  await emit('nested', {content: [[{tag: 'merge_forward', text: '/topics'}]]}, 'omt');
  policy.set('external', {requireOwnerMention: true});
  await emit('spoof', '@机器人/topics off', 'omt');
  await emit('other', '@_user_1 /read 读取', 'omt', 'external', 'ou_other');
  await emit('strict-body', '真实点名', 'omt', 'external', 'ou_self');
  await emit('off', {content: [[{tag:'at', user_id:'@_user_1'}, {tag:'text', text:'／话题群 关闭'}]]}, '', 'external', 'ou_self');
  await emit('after-off', post, 'omt');
  await emit('read-no-at', '/读群 核对');
  await emit('read', '@_user_1 /读群 核对', '', 'external', 'ou_self');
  await emit('listed', '普通白名单群', '', 'listed');
  await emit('command-post', post, 'omt', 'command');
  await emit('command', '总指挥群', '', 'command');
  await t.waitFor(() => assert.equal(calls.at(-1)?.source.messageId, 'command'));
  assert.deepEqual(calls.map(call => call.source.messageId), ['open','first','strict-body','off','read','listed','command']);
  const guard = () => { if (!allowed) throw Error('授权已撤销'); };
  const lookup = () => adapter.topicOfMessage('home', 'om_sent', guard);
  const message = {message_id:'om_sent',chat_id:'home',thread_id:'omt_bound'};
  fetched = message;
  assert.equal(await lookup(), 'omt_bound');
  for (const changes of [{message_id:'other'}, {chat_id:'other'}, {deleted:true}, {thread_id:'',root_id:'om_sent'}]) {
    fetched = {...message, ...changes}; assert.equal(await lookup(), undefined);
  }
  invalidate = true; fetched = message;
  await assert.rejects(lookup(), /授权已撤销/);
});

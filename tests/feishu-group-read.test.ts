import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { createFeishuBotsController } from '../apps/server/src/feishu-bots.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { createFeishuIntegration } from '../plugins/feishu.ts';
import type { FeishuMessageSource, FeishuOptions, FeishuSendContext } from '../plugins/feishu.ts';

test('读群只接受已配对主人在原群的命令，同一来源仅回一次，撤权或送达未知不重发', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-group-read-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, demo: true };
  const app = await createWorkbench(config);
  let opts!: FeishuOptions, failSend = false;
  const deliveries: Array<{ target: string; text: string; context?: FeishuSendContext }> = [];
  const factory: FeishuBotFactory = options => {
    opts = options;
    return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
      async send(target, text, context) {
        deliveries.push({ target, text, context });
        if (context?.replyTo === 'long-lost' && deliveries.filter(d => d.context?.replyTo === 'long-lost').length === 2) return;
        if (failSend) throw Object.assign(new Error('测试网络回执丢失'), { delivery: 'unknown' });
        context?.onSent?.('sent-' + deliveries.length, 'text');
      } };
  };
  const calls: Array<{ botId: string; appId: string; chatId: string; messageId: string; threadId?: string; ownerId: string; task: string }> = [];
  let account = 'account-one';
  let release = () => {}, started = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  const dependencies = { factory, readGroup: {
    account: () => account,
    async run(input: typeof calls[number], assertCurrent: () => void) {
      assertCurrent(); calls.push(input);
      if (input.messageId === 'hold') { started(); await gate; }
      if (input.messageId === 'unavailable') throw new Error('fixture-private-provider-failure');
      assertCurrent();
      if (input.messageId.startsWith('long-')) return '开头依据。' + '合成摘要。'.repeat(2400) + '最后的取证范围说明。';
      return '原群可公开的结论';
    },
  } };
  let bots = createFeishuBotsController(app, config, dependencies);
  app.mailboxes.setHandlers({ inbox: entry => bots.dispatchInbox(entry),
    outbox: async entry => { await bots.send(entry.botId, entry.target!, entry.text, entry.eventKey); } });
  t.after(async () => { release(); await bots.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const bot = await bots.create({ name: '合成读群机器人', appId: 'cli_1234567890123456', appSecret: 'fixture',
    scope: { kind: 'global' }, requireConfirmation: true,
    groupChats: [{ chatId: 'oc_allowed', mentionOnly: true, allowedSenderIds: [] }] });
  const send = (text: string, id: string, change: Partial<FeishuMessageSource> = {}) => opts.onMessage(text, {
    chatType: 'group', chatId: 'oc_source', senderId: 'ou_owner', senderType: 'user', messageId: id, mentionedSelf: true, ...change,
  });
  const privateChat = { chatType: 'p2p', chatId: 'oc_owner', mentionedSelf: false };
  await send(bot.pairingCode!, 'pair', privateChat);
  deliveries.length = 0;
  await send('/read', 'disabled');
  assert.equal(calls.length, 0);
  await send('/read 旧群路由', 'disabled-allowed', { chatId: 'oc_allowed' });
  assert.ok(app.mailboxes.list().some(entry => entry.direction === 'inbox' && entry.text === '/read 旧群路由'));
  await bots.update(bot.id, { readGroup: true });
  await send('/read', 'sender', { senderId: 'ou_other' });
  await send('/read', 'bot', { senderType: 'bot' });
  await send('/read', 'mention', { mentionedSelf: false });
  await send('/reader', 'prefix');
  await send('/read', 'private', privateChat);
  assert.equal(calls.length, 0);
  assert.ok(deliveries.every(d => d.target !== 'oc_source'));
  deliveries.length = 0;
  const text = ' @_user_1 ／读群　为何出现告警？ ';
  const mention = { key: '@_user_1', openId: 'ou_bot', self: true as const };
  const inThread = { threadId: 'omt_topic', mentions: [mention] };
  await Promise.all([send(text, 'first', inThread), send(text, 'first', inThread)]);
  await t.waitFor(() => assert.equal(deliveries.length, 1));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { appId: bot.appId, botId: bot.id, chatId: 'oc_source',
    messageId: 'first', threadId: 'omt_topic', task: '为何出现告警？', ownerId: 'ou_owner' });
  assert.equal(deliveries[0].target, 'oc_source');
  assert.equal(deliveries[0].text, '原群可公开的结论');
  assert.equal(deliveries[0].context?.replyTo, 'first');
  assert.equal(deliveries[0].context?.threadId, 'omt_topic');
  assert.equal(deliveries[0].context?.card, undefined);
  await send('/ReAd', 'bare');
  await t.waitFor(() => assert.equal(calls.length, 2));
  assert.equal(calls[1].task, '');
  await send('/read 读不到时说明', 'unavailable');
  await t.waitFor(() => assert.ok(deliveries.some(d => d.context?.replyTo === 'unavailable')));
  assert.doesNotMatch(deliveries.find(d => d.context?.replyTo === 'unavailable')!.text, /fixture-private-provider-failure|原群可公开的结论/);
  failSend = true;
  await send('/read', 'unknown').catch(() => {});
  await send('/read', 'unknown').catch(() => {});
  await t.waitFor(() => assert.equal(deliveries.filter(d => d.context?.replyTo === 'unknown').length, 1));
  assert.ok(deliveries.every(d => d.target === 'oc_source' && d.context?.replyTo));
  failSend = false;
  opts.onRecall?.('oc_source', 'recalled');
  await send('/read 已撤回的请求', 'recalled');
  assert.ok(!calls.some(call => call.messageId === 'recalled'));
  const inFlight = send('/read', 'hold');
  await running; account = 'account-two'; release(); await inFlight;
  assert.ok(!deliveries.some(d => d.context?.replyTo === 'hold' && d.text === '原群可公开的结论'));
  await send('/read', 'long-ok');
  const pieces = deliveries.filter(d => d.context?.replyTo === 'long-ok');
  assert.ok(pieces.length >= 3 && pieces.length <= 5);
  assert.match(pieces[0].text, /开头依据/);
  assert.match(pieces.at(-1)!.text, /最后的取证范围说明/);
  assert.ok(pieces.every(d => d.target === 'oc_source' && !d.context?.card));
  await send('/read', 'long-lost').catch(() => {});
  await send('/read', 'long-lost');
  assert.equal(deliveries.filter(d => d.context?.replyTo === 'long-lost').length, 2);
  const before = calls.length;
  await bots.close(); bots = createFeishuBotsController(app, config, dependencies); await bots.start();
  await send(text, 'first', inThread);
  assert.equal(calls.length, before);
});

test('真实 SDK 事件解析相邻富文本提及，转发或同名的其他机器人消息不能发起读群', async t => {
  let dispatcher!: EventDispatcher;
  const received: Array<{ text: string; source: FeishuMessageSource }> = [];
  const adapter = createFeishuIntegration({ appId: 'cli_1234567890123456', appSecret: 'fixture', readGroup: true,
    async onMessage(text, source) { received.push({ text, source }); }, async onInbox() {},
    fetch: async input => {
      const path = new URL(String(input)).pathname;
      if (path.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
      assert.match(path, /bot\/v3\/info$/);
      return Response.json({ code: 0, bot: { open_id: 'ou_bot' } });
    },
    wsFactory: options => ({
      async start(spec) { dispatcher = spec.eventDispatcher; options.onReady?.(); }, close() {},
      getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }),
    }),
  });
  t.after(() => adapter.close());
  await adapter.start();
  await t.waitFor(() => assert.equal(adapter.status().reason, undefined));
  async function emit(id: string, messageType: string, mentionedId: string, localized = false) {
    const post = { title: '', content: [[{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: '／READ 复盘故障' }]] };
    await dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: id }, event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
      message: { message_type: messageType, message_id: id, chat_type: 'group', chat_id: 'oc_alert', thread_id: 'omt_topic',
        mentions: [{ key: '@_user_1', name: '同名机器人', id: { open_id: mentionedId } }],
        content: JSON.stringify(localized ? { zh_cn: post } : post) },
    } }, { needCheck: false });
  }
  await emit('other-bot', 'post', 'ou_other');
  await emit('merged', 'merge_forward', 'ou_bot');
  await emit('picture', 'image', 'ou_bot');
  await emit('valid', 'post', 'ou_bot');
  await emit('localized', 'post', 'ou_bot', true);
  await t.waitFor(() => assert.equal(received.length, 2));
  assert.deepEqual(received.map(item => item.source.messageId), ['valid', 'localized']);
  for (const { text, source } of received) {
    assert.equal(text, '／READ 复盘故障');
    assert.equal(source.mentionedSelf, true);
    assert.equal(source.senderId, 'ou_owner');
    assert.equal(source.threadId, 'omt_topic');
  }
});

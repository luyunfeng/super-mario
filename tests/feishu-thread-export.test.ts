import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('导出飞书独立对话只读取当前配对的可见发言，并按导出插件状态及删除记录应答', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-thread-export-'));
  const receivers = new Map<string, FeishuOptions>();
  const sent: string[] = [];
  const server = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, token: 'fixture-export' }, {
    botFactory(opts) {
      receivers.set(opts.appId, opts);
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
        async send(_target, text) { sent.push(text); } };
    },
  });
  t.after(async () => { try { await server.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const headers = { authorization: 'Bearer fixture-export', 'content-type': 'application/json' };
  async function api(path: string, method = 'GET', data?: object) {
    return fetch(server.url + '/api/v1/' + path, { headers, method, body: data && JSON.stringify(data) });
  }
  async function setup(appId: string, title: string) {
    const bot = await server.bots.create({ name: appId, appId, appSecret: 'fixture', scope: { kind: 'global' }, requireConfirmation: false });
    const send = (text: string, messageId: string) => receivers.get(appId)!.onMessage(text, {
      messageId, senderId: 'owner-' + appId, chatId: 'chat-' + appId, senderType: 'user', chatType: 'p2p',
    });
    await send(bot.pairingCode!, 'pair');
    await send('/new ' + title, 'create');
    await t.waitFor(() => assert.ok(sent.some(text => text.includes(title))));
    const base = 'feishu/bots/' + bot.id + '/threads';
    const [thread] = await (await api(base)).json();
    return { base, threadId: thread.threadId as string, botId: bot.id, version: thread.version as number };
  }
  const a = await setup('cli_1111111111111111', '合成发言甲');
  const b = await setup('cli_2222222222222222', '隔离标记乙');
  const target = { botId: a.botId, threadId: a.threadId };
  const run = (scope: object, includeWork = false) => api('conversation-export', 'POST', { ...scope, includeWork });
  const store = server.app.store;
  const source = store.list<Message>('messages').find(row => row.role === 'user' && row.text === '合成发言甲')!;
  const route = store.get<Record<string, string>>('message.routes', source.id)!;
  const reply = store.list<Message>('messages').find(row => row.role === 'assistant' && row.replyTo === source.id)!;
  assert.ok(source && route && reply);
  store.put('agent.traces', reply.id, { id: reply.id, conversationId: source.conversationId, userMessageId: source.id,
    toolCalls: [{ name: 'fixture_lookup', finishedAt: source.createdAt, isError: false, args: '内部参数样例' }] });
  // These messages share a conversation ID, but their stored delivery evidence excludes them from its private history.
  for (const [name, override] of Object.entries({ owner: { privateSenderId: 'other' }, old: { revision: -1 },
    relay: { relay: { id: 'other' } }, group: { group: { id: 'group' } } })) {
    const id = 'hidden-' + name;
    store.put('messages', id, { ...source, id, text: '隔离标记-' + name });
    store.put('message.routes', id, { ...route, ...override });
  }
  const path = a.base + '/' + a.threadId;
  const rename = await api(path, 'PATCH', { version: a.version, title: '已改名的合成对话' });
  assert.equal(rename.status, 200);
  const archive = await api(path, 'PATCH', { version: (await rename.json()).version, archived: true });
  assert.equal(archive.status, 200);
  for (const includeWork of [false, true]) {
    const response = await run(target, includeWork);
    assert.equal(response.status, 200);
    const { markdown, count } = await response.json();
    assert.equal(count, 2);
    assert.match(markdown, /已改名的合成对话/);
    assert.match(markdown, /合成发言甲/);
    assert.equal(markdown.includes('fixture_lookup'), includeWork);
    assert.doesNotMatch(markdown, /隔离标记|内部参数样例/);
  }
  for (const invalid of [{ botId: a.botId }, { threadId: a.threadId }, { ...target, projectId: 'x' },
    { ...target, native: {} }, { conversationId: source.conversationId }])
    assert.equal((await run(invalid)).status, 400);
  assert.equal((await run({ ...target, botId: b.botId })).status, 404);
  await server.app.plugins.setEnabled('conversation-export', false);
  assert.equal((await run(target)).status, 503);
  await server.app.plugins.setEnabled('conversation-export', true);
  assert.equal((await api(path, 'DELETE', { version: (await archive.json()).version })).status, 200);
  assert.equal((await run(target)).status, 410);
  const account = 'cli_3333333333333333';
  const rebound = await server.bots.update(b.botId, { appId: account, appSecret: 'fixture' });
  await receivers.get(account)!.onMessage(rebound.pairingCode!, { messageId: 'pair-new', senderId: 'new-owner',
    chatId: 'new-chat', chatType: 'p2p', senderType: 'user' });
  assert.equal((await run({ botId: b.botId, threadId: b.threadId })).status, 404);
});

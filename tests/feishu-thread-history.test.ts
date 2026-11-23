import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { FeishuMessageSource, FeishuOptions } from '../plugins/feishu.ts';
import { botConversationId } from '../packages/core/src/bot-agent-routing.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import { privateThreadPage, readPrivateThreadHistory, searchPrivateThreads } from '../apps/server/src/feishu-thread-history.ts';

test('独立对话记录按可见发言分页，排除其他配对、群组、协作回流和未知游标', () => {
  const row = { threadId: 'a'.repeat(64), botId: 'a', appId: 'app', revision: 3, chatId: 'chat', senderId: 'owner', createdAt: '2026-01-01' };
  const conversationId = botConversationId({ id: row.botId, scope: { kind: 'global' } }, row.threadId);
  const messages: Message[] = [], routes = new Map<string, unknown>();
  for (let i = 0; i < 48; i++) {
    const id = String(i);
    messages.push({ id, role: 'user', conversationId, createdAt: new Date(i).toISOString(), text: '发言 ' + i });
    routes.set(id, { channel: 'feishu', accountId: 'app', botId: 'a', target: 'chat', privateSenderId: 'owner',
      conversationThreadId: row.threadId, revision: 3, ...[{ privateSenderId: 'other' }, { group: {} }, { relay: {} }, { revision: 2 }][i] });
  }
  const store = { list<T>() { return messages as T[]; }, get<T>(_type: string, id: string) { return routes.get(id) as T | undefined; } };
  const rows = readPrivateThreadHistory(store, [row, { ...row, threadId: 'b'.repeat(64) }]);
  assert.deepEqual(rows, [{ threadId: row.threadId, title: '发言 4', version: 0, archived: false, latestAt: messages.at(-1)!.createdAt, count: 44 }]);
  assert.deepEqual(searchPrivateThreads(store, [row], '发言 0').items, []);
  for (const id of ['0', '1', '2', '3']) {
    assert.throws(() => privateThreadPage(store, row, null, null, id), { status: 409 });
  }
  const recent = privateThreadPage(store, row, null);
  assert.equal(recent.messages.length, 40);
  assert.equal(recent.nextBefore, '8');
  const earlier = privateThreadPage(store, row, recent.nextBefore);
  assert.deepEqual(earlier.messages.map(item => item.text), ['发言 4', '发言 5', '发言 6', '发言 7']);
  assert.equal(earlier.nextBefore, null);
  assert.throws(() => privateThreadPage(store, row, '3'), { status: 409 });
});

test('独立对话改名和归档可跨重启，旧事件不恢复归档，引用的新发言恢复原会话', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-feishu-thread-history-'));
  const receivers = new Map<string, FeishuOptions>();
  const sent: Array<{ account: string; text: string }> = [];
  const botFactory: FeishuBotFactory = opts => {
    receivers.set(opts.appId, opts);
    return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
      async send(_target, text, context) {
        sent.push({ account: opts.appId, text }); context?.onSent?.('om_' + sent.length, context.card ? 'interactive' : 'text');
      } };
  };
  const config = { host: '127.0.0.1', port: 0, demo: true, dataDir, token: 'synthetic-admin' };
  let server = await startServer(config, { botFactory });
  t.after(async () => { try { await server.close(); } finally { await rm(dataDir, { force: true, recursive: true }); } });
  async function bot(account: string) {
    const row = await server.bots.create({ name: account, appId: account, appSecret: 'offline-fixture',
      scope: { kind: 'global' }, requireConfirmation: false });
    function receive(text: string, id: string, ref?: Partial<FeishuMessageSource>) {
      return receivers.get(account)!.onMessage(text, { senderId: account, chatId: 'chat-' + account, senderType: 'user',
        chatType: 'p2p', messageId: id, ...ref });
    }
    await receive(row.pairingCode!, 'pair');
    return { receive, id: row.id, account };
  }
  async function api(botId: string, suffix = '', patch?: Record<string, unknown>) {
    return fetch(server.url + '/api/v1/feishu/bots/' + botId + '/threads' + suffix, {
      method: patch ? 'PATCH' : 'GET',
      headers: { authorization: 'Bearer synthetic-admin', 'content-type': 'application/json' },
      ...(patch ? { body: JSON.stringify(patch) } : {}),
    });
  }
  async function search(botId: string, q: string, archived: boolean) {
    const query = new URLSearchParams({ q, archived: archived ? '1' : '0' });
    const r = await api(botId, '/search?' + query);
    assert.equal(r.status, 200);
    return r.json() as Promise<{items: Array<{threadId: string; titleMatch: boolean;
      hits: Array<{id: string; role: string; excerpt: string; createdAt: string}>}>; nextBefore: string | null}>;
  }
  const a = await bot('cli_6666666666666666'), b = await bot('cli_7777777777777777');
  await a.receive('/new 第一条合成目标', 'initial');
  await t.waitFor(() => assert.ok(sent.some(row => row.account === a.account && row.text.includes('第一条合成目标'))));
  await a.receive('归档前的跟进', 'old-follow');
  await t.waitFor(() => assert.ok(sent.some(row => row.account === a.account && row.text.includes('归档前的跟进'))));
  const [initial] = await (await api(a.id)).json();
  assert.equal(initial.archived, false);
  const path = '/' + initial.threadId;
  assert.equal((await api(b.id, path, { version: initial.version, title: '错误归属' })).status, 404);
  const renamed = await api(a.id, path, { version: initial.version, title: '蓝色调查' });
  assert.equal(renamed.status, 200);
  const afterRename = await renamed.json();
  assert.equal(afterRename.title, '蓝色调查');
  assert.ok(afterRename.version > initial.version);
  assert.equal((await api(a.id, path, { version: initial.version, title: '过期修改' })).status, 409);
  await a.receive('/list', 'listed-active');
  assert.match(sent.at(-1)!.text, /蓝色调查/);
  const titleSearch = await search(a.id, '蓝色调查', false);
  assert.equal(titleSearch.items[0].threadId, initial.threadId);
  assert.equal(titleSearch.items[0].titleMatch, true);
  assert.deepEqual(titleSearch.items[0].hits, []);
  assert.equal(titleSearch.nextBefore, null);
  const bodySearch = await search(a.id, '归档前的跟进', false);
  const hit = bodySearch.items[0].hits.find(item => item.role === 'user');
  assert.ok(hit && hit.id && hit.createdAt && hit.excerpt.includes('归档前的跟进'));
  assert.equal(bodySearch.items[0].titleMatch, false);
  assert.deepEqual((await search(b.id, '归档前的跟进', false)).items, []);
  assert.equal((await api(b.id, path + '?around=' + hit.id)).status, 404);
  assert.equal((await api(a.id, '/search?q=蓝色调查&before=' + 'a'.repeat(64))).status, 409);
  assert.equal((await api(a.id, path + '?around=' + hit.id + '&before=' + hit.id)).status, 400);
  const archive = await api(a.id, path, { archived: true, version: afterRename.version });
  assert.equal(archive.status, 200);
  const saved = await archive.json();
  assert.equal(saved.archived, true);
  await server.close();
  server = await startServer(config, { botFactory });
  assert.deepEqual(await (await api(a.id)).json(), []);
  const [archived] = await (await api(a.id, '?archived=1')).json();
  assert.equal(archived.threadId, initial.threadId);
  assert.equal(archived.version, saved.version);
  assert.equal(archived.title, '蓝色调查');
  assert.deepEqual(await (await api(b.id, '?archived=1')).json(), []);
  assert.deepEqual((await search(a.id, '归档前的跟进', false)).items, []);
  assert.equal((await search(a.id, '归档前的跟进', true)).items[0].threadId, initial.threadId);
  assert.deepEqual((await search(b.id, '归档前的跟进', true)).items, []);
  const viewed = await (await api(a.id, path + '?around=' + hit.id)).json();
  assert.ok(viewed.messages.some((m: Message) => m.id === hit.id && m.role === 'user'));
  assert.equal(viewed.archived, true);
  assert.equal(viewed.title, '蓝色调查');
  assert.equal(viewed.version, saved.version);
  assert.ok(viewed.messages.some((m: Message) => m.role === 'user' && m.text === '第一条合成目标'));
  await a.receive('/new 第一条合成目标', 'initial');
  await a.receive('归档前的跟进', 'old-follow');
  await a.receive('/list', 'listed-archived');
  assert.doesNotMatch(sent.at(-1)!.text, /蓝色调查|第一条合成目标/);
  assert.equal((await (await api(a.id, path)).json()).version, saved.version);
  await a.receive('/main', 'back-main');
  await a.receive('来自旧引用的新发言', 'follow', { parentId: 'initial' });
  await t.waitFor(async () => {
    const [row] = await (await api(a.id)).json();
    assert.equal(row?.threadId, initial.threadId);
    assert.equal(row.title, '蓝色调查');
    assert.equal(row.archived, false);
    assert.ok(row.version > saved.version);
  });
  assert.equal((await api(a.id, path, { version: saved.version, archived: true })).status, 409);
  assert.deepEqual(await (await api(a.id, '?archived=1')).json(), []);
  const detail = await (await api(a.id, path)).json();
  assert.deepEqual(detail.messages.filter((m: Message) => m.role === 'user').map((m: Message) => m.text), ['第一条合成目标', '归档前的跟进', '来自旧引用的新发言']);
  const reset = await api(a.id, path, { version: detail.version, title: '' });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).title, '第一条合成目标');
  await server.app.plugins.setEnabled('conversation-search', false);
  assert.equal((await api(a.id, '/search?q=归档前')).status, 503);
  assert.equal((await api(a.id, path)).status, 200);
});


test('搜索结果游标只在可见的匹配结果间翻页，不重复返回上一页', () => {
  const messages: Message[] = [];
  const routes = new Map<string, unknown>();
  const rows = Array.from({ length: 23 }, (_, i) => {
    const threadId = i.toString(16).padStart(64, '0');
    const row = { threadId, botId: 'bot', appId: 'account', chatId: 'room', senderId: 'owner', revision: 1, createdAt: '',
      archived: i === 21 };
    const conversationId = botConversationId({ id: row.botId, scope: { kind: 'global' } }, threadId);
    messages.push({ id: threadId, role: 'user', conversationId, createdAt: new Date(i).toISOString(), text: '合成.[分组]' });
    routes.set(threadId, { channel: 'feishu', accountId: row.appId, botId: row.botId, target: row.chatId,
      privateSenderId: i === 22 ? 'former-owner' : row.senderId, conversationThreadId: threadId, revision: 1 });
    return row;
  });
  const store = { list<T>() { return messages as T[]; }, get<T>(_collection: string, id: string) { return routes.get(id) as T | undefined; } };
  const first = searchPrivateThreads(store, rows, '.[分组]');
  assert.equal(first.items.length, 20);
  assert.ok(first.nextBefore);
  const second = searchPrivateThreads(store, rows, '.[分组]', false, first.nextBefore);
  assert.equal(second.nextBefore, null);
  assert.deepEqual([...first.items, ...second.items].map(hit => hit.threadId), rows.slice(0, 21).reverse().map(row => row.threadId));
  assert.throws(() => searchPrivateThreads(store, rows, '.[分组]', true, first.nextBefore), { status: 409 });
});

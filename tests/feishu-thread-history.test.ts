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
import { privateThreadPage, readPrivateThreadHistory, searchPrivateThreadHits, searchPrivateThreadList, searchPrivateThreads } from '../apps/server/src/feishu-thread-history.ts';

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
  for (const queueState of ['withdrawn', 'cancelled'] as const) {
    messages.push({ ...messages[4], id: queueState, text: '已移出队列', queueState });
    routes.set(queueState, routes.get('4'));
  }
  const store = { list<T>() { return messages as T[]; }, get<T>(_type: string, id: string) { return routes.get(id) as T | undefined; } };
  const rows = readPrivateThreadHistory(store, [row, { ...row, threadId: 'b'.repeat(64) }]);
  assert.deepEqual(rows, [{ threadId: row.threadId, title: '发言 4', version: 0, archived: false, tags: [], latestAt: messages[47].createdAt, count: 44 }]);
  assert.deepEqual(searchPrivateThreads(store, [row], '发言 0').items, []);
  assert.deepEqual(searchPrivateThreads(store, [row], '已移出队列').items, []);
  for (const id of ['0', '1', '2', '3', 'withdrawn', 'cancelled']) {
    assert.throws(() => privateThreadPage(store, row, null, null, id), { status: 409 });
  }
  const tagged = {...row, tags:['FY[26]']};
  const byTag = searchPrivateThreadList(store, [tagged, {...tagged, threadId:'b'.repeat(64)}], 'fy[26]');
  assert.deepEqual(byTag.threads.map(item => item.threadId), [row.threadId]);
  assert.deepEqual(Object.keys(byTag.messageIds), []);
  assert.deepEqual(Object.keys(byTag.snippets), []);
  assert.deepEqual(searchPrivateThreadList(store, [{...tagged, archived:true}], 'fy[26]').threads, []);
  const [allMatches] = searchPrivateThreads(store, [row], '发言').items;
  assert.equal(allMatches.hitCount,44);
  assert.deepEqual(allMatches.hits.map(hit=>hit.id),['47','46','45']);
  assert.equal(searchPrivateThreadList(store,[row],'发言').threads[0].hitCount,44);
  const firstHits = searchPrivateThreadHits(store, row, '发言', false, null);
  assert.equal(firstHits.hits.length, 20);
  assert.equal(firstHits.nextBefore, '28');
  const secondHits = searchPrivateThreadHits(store, row, '发言', false, firstHits.nextBefore);
  assert.equal(secondHits.hits.length, 20);
  assert.equal(secondHits.nextBefore, '8');
  const finalHits = searchPrivateThreadHits(store, row, '发言', false, secondHits.nextBefore);
  assert.equal(finalHits.nextBefore, null);
  assert.deepEqual([firstHits.hitCount, secondHits.hitCount, finalHits.hitCount], [44, 44, 44]);
  assert.deepEqual([...firstHits.hits, ...secondHits.hits, ...finalHits.hits].map(hit => hit.id),
    Array.from({ length: 44 }, (_, index) => String(47 - index)));
  for (const invisible of ['0', '1', '2', '3', 'withdrawn', 'cancelled']) {
    assert.throws(() => searchPrivateThreadHits(store, row, '发言', false, invisible), { status: 409 });
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
  async function search(botId: string, q: string, archived: boolean, tag?: string) {
    const query = new URLSearchParams({ q, archived: archived ? '1' : '0' });
    if (tag !== undefined) query.set('tag', tag);
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
  await a.receive('/帮助', 'search-help');
  assert.match(sent.at(-1)!.text,/按标题、标签或发言原话搜索未归档的独立对话/);
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
  const hitsUrl = path + '/search?' + new URLSearchParams({ q: '归档前的跟进' });
  for (const endpoint of ['?role=user', path + '?role=user', '/search?q=蓝色调查&role=system',
    hitsUrl + '&role=user&role=assistant']) {
    assert.equal((await api(a.id, endpoint)).status, 400, endpoint);
  }
  const titleOnly = await api(a.id, '/search?q=蓝色调查&role=user');
  assert.equal(titleOnly.status, 200);
  assert.deepEqual((await titleOnly.json()).items, []);
  const hitPage = await api(a.id, hitsUrl);
  assert.equal(hitPage.status, 200);
  assert.deepEqual((await hitPage.json()).hits.map((item: { id: string }) => item.id),
    bodySearch.items[0].hits.map(item => item.id));
  assert.equal((await api(b.id, hitsUrl)).status, 404);
  assert.equal((await api(a.id, hitsUrl + '&before=unknown')).status, 409);
  assert.deepEqual((await search(b.id, '归档前的跟进', false)).items, []);
  assert.equal((await api(b.id, path + '?around=' + hit.id)).status, 404);
  assert.equal((await api(a.id, '/search?q=蓝色调查&before=' + 'a'.repeat(64))).status, 409);
  assert.equal((await api(a.id, path + '?around=' + hit.id + '&before=' + hit.id)).status, 400);
  const maxLabel = '📁'.repeat(32);
  const expectedTags = ['Ops', 'ops', '#核对', maxLabel];
  for (const invalid of [[42], null, '一个标签', ['📁'.repeat(33)], Array.from({ length: 11 }, (_, i) => 't' + i)]) {
    assert.equal((await api(a.id, path, { version: afterRename.version, tags: invalid })).status, 400);
  }
  const setTags = await api(a.id, path, { version: afterRename.version, tags: ['\u0085Ops\u3000', ' ', 'ops', 'Ops', '#核对', maxLabel] });
  assert.equal(setTags.status, 200);
  const tagged = await setTags.json();
  assert.deepEqual(tagged.tags, expectedTags);
  assert.ok(tagged.version > afterRename.version);
  await a.receive('/list', 'listed-tags');
  assert.match(sent.at(-1)!.text, /标签：Ops、ops、#核对/);
  const beforeSearch = server.bots.privateThreadSelection(a.id, initial.threadId);
  await a.receive('/对话 #核对', 'tag-search');
  assert.match(sent.at(-1)!.text, /独立对话 · 蓝色调查\s+标签：Ops、ops、#核对/);
  assert.deepEqual(server.bots.privateThreadSelection(a.id, initial.threadId), beforeSearch);
  await b.receive('/list #核对', 'foreign-tag-search');
  assert.match(sent.at(-1)!.text, /没有找到匹配的独立对话/);
  assert.equal(tagged.tagsUpdatedBy, 'user');
  assert.ok(Number.isFinite(Date.parse(tagged.tagsUpdatedAt)));
  const unchanged = await (await api(a.id, path, { version: tagged.version, tags: expectedTags })).json();
  assert.equal(unchanged.version, tagged.version);
  assert.equal(unchanged.tagsUpdatedAt, tagged.tagsUpdatedAt);
  assert.equal((await api(a.id, path, { version: afterRename.version, tags: [] })).status, 409);
  assert.equal((await api(b.id, path, { version: tagged.version, tags: ['侵入'] })).status, 404);
  const otherPrefs = await (await api(b.id, '/tags')).json();
  assert.deepEqual(otherPrefs.tags, []);
  assert.equal(otherPrefs.filters, null);
  const initialPrefs = await (await api(a.id, '/tags')).json();
  assert.deepEqual(new Set(initialPrefs.tags), new Set(expectedTags));
  assert.equal(initialPrefs.filters, null);
  assert.notEqual(initialPrefs.binding, otherPrefs.binding);
  assert.equal((await api(a.id, '/tags', { binding: otherPrefs.binding, version: initialPrefs.version, filters: [] })).status, 404);
  const customFilters = ['未使用', 'Ops', 'ops'];
  const prefer = await api(a.id, '/tags', { binding: initialPrefs.binding, version: initialPrefs.version, filters: [' 未使用 ', 'Ops', '', 'ops', 'Ops'] });
  assert.equal(prefer.status, 200);
  const pref = await prefer.json();
  assert.deepEqual(pref.filters, customFilters);
  assert.deepEqual(new Set(pref.tags), new Set(expectedTags));
  assert.ok(pref.version > initialPrefs.version);
  assert.equal((await api(a.id, '/tags', { binding: initialPrefs.binding, version: initialPrefs.version, filters: null })).status, 409);
  assert.equal((await api(a.id, '/tags', { binding: pref.binding, version: pref.version, filters: Array.from({ length: 51 }, (_, i) => 'f' + i) })).status, 400);
  assert.deepEqual(await (await api(b.id, '/tags')).json(), otherPrefs);
  assert.equal((await (await api(a.id, path)).json()).version, tagged.version);
  assert.equal((await (await api(a.id, '?tag=Ops')).json())[0].threadId, initial.threadId);
  assert.deepEqual(await (await api(a.id, '?tag=Op')).json(), []);
  assert.equal((await search(a.id, '归档前的跟进', false, 'Ops')).items[0].threadId, initial.threadId);
  assert.deepEqual((await search(a.id, '归档前的跟进', false, 'no-match')).items, []);
  const archive = await api(a.id, path, { archived: true, version: tagged.version });
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
  assert.deepEqual(archived.tags, expectedTags);
  assert.equal(archived.tagsUpdatedAt, tagged.tagsUpdatedAt);
  const restoredPrefs = await (await api(a.id, '/tags')).json();
  assert.deepEqual(restoredPrefs.filters, customFilters);
  assert.deepEqual(new Set(restoredPrefs.tags), new Set(expectedTags));
  const noFilters = await (await api(a.id, '/tags', { binding: restoredPrefs.binding, version: restoredPrefs.version, filters: [] })).json();
  assert.deepEqual(noFilters.filters, []);
  const automatic = await (await api(a.id, '/tags', { binding: noFilters.binding, version: noFilters.version, filters: null })).json();
  assert.equal(automatic.filters, null);
  assert.deepEqual(new Set(automatic.tags), new Set(expectedTags));
  assert.deepEqual((await search(a.id, '归档前的跟进', false, 'Ops')).items, []);
  assert.equal((await search(a.id, '归档前的跟进', true, 'Ops')).items[0].threadId, initial.threadId);
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
  await a.receive('/list #核对', 'archived-tag-search');
  assert.match(sent.at(-1)!.text, /没有找到匹配的独立对话/);
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
  const afterReset = await reset.json();
  assert.equal(afterReset.title, '第一条合成目标');
  const cleared = await api(a.id, path, { version: afterReset.version, tags: [] });
  assert.equal(cleared.status, 200);
  const clearedRow = await cleared.json();
  assert.deepEqual(clearedRow.tags, []);
  assert.equal(clearedRow.tagsUpdatedAt, undefined);
  assert.equal(clearedRow.tagsUpdatedBy, undefined);
  assert.deepEqual((await (await api(a.id, '/tags')).json()).tags, []);
  assert.deepEqual((await search(a.id, '归档前的跟进', false, 'Ops')).items, []);
  await server.app.plugins.setEnabled('conversation-search', false);
  assert.equal((await api(a.id, '/search?q=归档前')).status, 503);
  assert.equal((await api(a.id, hitsUrl)).status, 503);
  assert.equal((await api(a.id, path)).status, 200);

  const account = 'cli_8888888888888888';
  const rebound = await server.bots.update(a.id, { appId: account, appSecret: 'fixture-rebound' });
  await receivers.get(account)!.onMessage(rebound.pairingCode!, { messageId: 'new-pair', senderType: 'user',
    senderId: 'new-owner', chatType: 'p2p', chatId: 'new-private' });
  const fresh = await (await api(a.id, '/tags')).json();
  assert.notEqual(fresh.binding, initialPrefs.binding);
  assert.equal(fresh.version, initialPrefs.version);
  assert.equal((await api(a.id, '/tags', { binding: initialPrefs.binding, version: initialPrefs.version, filters: ['旧页'] })).status, 404);
  assert.equal((await (await api(a.id, '/tags')).json()).filters, null);
});


test('搜索结果游标只在可见的匹配结果间翻页，不重复返回上一页', () => {
  const messages: Message[] = [];
  const routes = new Map<string, unknown>();
  const rows = Array.from({ length: 23 }, (_, i) => {
    const threadId = i.toString(16).padStart(64, '0');
    const row = { threadId, botId: 'bot', appId: 'account', chatId: 'room', senderId: 'owner', revision: 1, createdAt: '',
      archived: i === 21, tags: i < 2 ? ['稀有'] : [] };
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
  const filtered = searchPrivateThreads(store, rows, '.[分组]', false, null, '稀有');
  assert.deepEqual(filtered.items.map(item => item.threadId), [rows[1].threadId, rows[0].threadId]);
  assert.equal(filtered.nextBefore, null);
});

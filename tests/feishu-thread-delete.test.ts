import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { FeishuOptions, FeishuMessageSource } from '../plugins/feishu.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('独立会话只能闲时删除，旧引用和旧事件无法复活，重启保留删除回执及绑定隔离', { timeout: 60000 }, async t => {
  const nativeFetch = globalThis.fetch;
  let atProvider = () => {}, release = () => {};
  const queued = new Promise<void>(resolve => { atProvider = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  let turns = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init), url = new URL(req.url);
    assert.equal(url.hostname, '127.0.0.1');
    if (url.port !== '1') return nativeFetch(req);
    assert.equal(url.pathname, '/fixture/chat/completions');
    const { model, messages } = await req.json();
    const user = JSON.stringify(messages.findLast((m: Message) => m.role === 'user')?.content);
    if (user.includes('等待本轮')) { atProvider(); await resume; }
    const answer = '合成回执-' + ++turns;
    const frames = [{ role: 'assistant', content: answer }, {}].map((delta, n) => 'data: ' + JSON.stringify({
      model, id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: n ? 'stop' : null }],
    }));
    return new Response([...frames, 'data: [DONE]', ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-delete-'));
  const config = { dataDir, demo: false, token: 'synthetic-token', port: 0, host: '127.0.0.1', model: {
    provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'http://127.0.0.1:1/fixture', apiKey: 'fixture-key' } };
  const options = new Map<string, FeishuOptions>();
  const sent: Array<{ id: string; text: string; appId: string }> = [];
  const botFactory: FeishuBotFactory = opts => {
    options.set(opts.appId, opts);
    return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
      async send(_target, text, context) {
        const id = 'om_' + sent.length;
        sent.push({ appId: opts.appId, id, text }); context?.onSent?.(id, context.card ? 'interactive' : 'text');
      } };
  };
  let server = await startServer(config, { botFactory });
  t.after(async () => { release(); try { await server.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  async function create(appId: string) {
    const bot = await server.bots.create({ name: appId, appId, appSecret: 'synthetic-secret', scope: { kind: 'global' }, requireConfirmation: false });
    const send = (text: string, messageId: string, quote?: Partial<FeishuMessageSource>) => options.get(appId)!.onMessage(text, {
      senderType: 'user', senderId: 'owner-' + appId, chatType: 'p2p', chatId: 'chat-' + appId, messageId, ...quote,
    });
    const api = (suffix: string, method = 'GET', body?: unknown) => nativeFetch(server.url + '/api/v1/feishu/bots/' + bot.id + '/threads' + suffix, {
      method, headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    await send(bot.pairingCode!, 'pair');
    return { appId, send, api };
  }
  const a = await create('cli_1111111111111111'), b = await create('cli_2222222222222222');
  await a.send('/new 不相关的保留会话', 'kept');
  await t.waitFor(() => assert.ok(sent.some(row => row.appId === a.appId && row.text.includes('合成回执-1'))));
  await a.send('/new 合成私聊删除样例', 'new-deleted');
  const originalReply = await t.waitFor(() => {
    const row = sent.find(item => item.appId === a.appId && item.text.includes('合成回执-2'));
    assert.ok(row); return row;
  });
  const entry = (await (await a.api('')).json() as Array<{threadId: string; title: string; version: number}>)
    .find(row => row.title === '合成私聊删除样例')!;
  assert.ok(entry);
  const path = '/' + entry.threadId;
  const trace = server.app.store.list<Message>('messages').find(message =>
    message.role === 'assistant' && message.text === '合成回执-2');
  assert.ok(trace);
  async function visibleMailboxText() {
    const response = await nativeFetch(server.url + '/api/v1/mailboxes', { headers: { authorization: 'Bearer synthetic-token' } });
    assert.equal(response.status, 200);
    return (await response.json() as Array<{ text: string }>).map(row => row.text).join('\n');
  }
  assert.match(await visibleMailboxText(), /合成私聊删除样例/);
  const sdkDirectory = (id: string) => join(dataDir, 'pi', 'agents', createHash('sha256').update(id).digest('hex'), 'sessions', 'conversation');
  const kept = server.app.store.list<Message>('messages').find(message => message.text === '不相关的保留会话')!;
  async function hasTranscript(id: string, marker: string) {
    const dir = sdkDirectory(id);
    const files = (await readdir(dir)).filter(file => file.endsWith('.jsonl'));
    return (await Promise.all(files.map(file => readFile(join(dir, file), 'utf8')))).some(file => file.includes(marker));
  }
  assert.ok(await hasTranscript(trace.conversationId, '合成私聊删除样例'));
  assert.ok(await hasTranscript(kept.conversationId, '不相关的保留会话'));
  await a.send('/list', 'list-that-includes-erased-title');
  await a.send('/status', 'status-that-includes-erased-reply');
  const markerCollections = () => {
    const reader = new DatabaseSync(join(dataDir, 'workbench.sqlite'), { readOnly: true });
    try {
      return reader.prepare('SELECT DISTINCT collection FROM documents WHERE instr(value, ?) > 0 OR instr(value, ?) > 0 ORDER BY collection')
        .all('合成私聊删除样例', '合成回执-2').map(row => row.collection);
    } finally { reader.close(); }
  };
  const initialCollections = markerCollections();
  t.diagnostic('删除前的合成标记出现在 ' + initialCollections.join(', '));
  assert.ok(initialCollections.includes('messages') && initialCollections.includes('event.mailboxes'));
  const version = { version: entry.version };
  const order = await (await a.api('/order')).json();
  assert.equal((await a.api('/order', 'PATCH', { ...order, order: [entry.threadId] })).status, 200);
  await a.send('等待本轮', 'hold');
  await queued;
  assert.equal((await a.api(path, 'DELETE', version)).status, 409);
  release();
  await t.waitFor(() => assert.ok(sent.some(row => row.appId === a.appId && row.text.includes('合成回执-3'))));
  assert.equal((await b.api(path, 'DELETE', version)).status, 404);
  const renamed = await (await a.api(path, 'PATCH', { ...version, title: '即将移除的标题' })).json();
  assert.equal((await a.api(path, 'DELETE', version)).status, 409);
  const confirmed = { version: renamed.version };
  const removed = await a.api(path, 'DELETE', confirmed);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true, deleted: true });
  assert.deepEqual(markerCollections(), [], '数据库仍保留已删私聊的合成原文');
  await assert.rejects(readdir(sdkDirectory(trace.conversationId)), { code: 'ENOENT' });
  assert.ok(await hasTranscript(kept.conversationId, '不相关的保留会话'));
  assert.equal((await a.api(path)).status, 410);
  assert.doesNotMatch(await visibleMailboxText(), /合成私聊删除样例|合成回执-2|等待本轮/);
  const traceResponse = await nativeFetch(server.url + '/api/v1/traces/turns/' + trace.id,
    { headers: { authorization: 'Bearer synthetic-token' } });
  assert.doesNotMatch(await traceResponse.text(), /合成私聊删除样例|合成回执-2/);
  assert.equal((await a.api(path, 'PATCH', { ...confirmed, archived: false })).status, 410);
  assert.equal((await b.api(path)).status, 404);
  assert.deepEqual((await (await a.api('/search?q=合成私聊删除样例')).json()).items, []);
  const rows = await (await a.api('')).json() as Array<{ title: string }>;
  assert.deepEqual(rows.map(row => row.title), ['不相关的保留会话']);
  assert.deepEqual((await (await a.api('/order')).json()).order, []);
  await server.close(); server = await startServer(config, { botFactory });
  assert.equal((await a.api(path)).status, 410);
  assert.equal((await a.api(path, 'DELETE', confirmed)).status, 200);
  assert.equal((await b.api(path)).status, 404);
  const before = turns;
  await a.send('/new 合成私聊删除样例', 'new-deleted');
  await a.send('引用被删的用户输入', 'quote-removed-in', { parentId: 'new-deleted' });
  await a.send('引用被删的回复', 'quote-removed-out', { parentId: originalReply.id });
  await a.send('恢复后正常处理', 'after-delete');
  await t.waitFor(() => assert.ok(server.app.store.list<Message>('messages').some(m => m.text === '恢复后正常处理' && m.status === 'done')));
  assert.equal(turns, before + 1);
  assert.deepEqual(markerCollections(), [], '重启及重放后重新出现了已删私聊正文');
  assert.deepEqual((await (await a.api('')).json() as Array<{ title: string }>).map(row => row.title), ['不相关的保留会话']);
});

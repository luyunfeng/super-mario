import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions, FeishuSendContext } from '../plugins/feishu.ts';
import type { Message } from '../packages/protocol/src/index.ts';

async function fixture(t: test.TestContext) {
  const waiting = new Map<string, ServerResponse>();
  const requests: string[] = [];
  const provider = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const { messages, model } = JSON.parse(body);
    const lastUser = messages.findLast((m: { role: string }) => m.role === 'user');
    const marker = JSON.stringify(lastUser?.content).match(/fixture-[a-z-]+/)?.[0] ?? '';
    requests.push(marker);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (delta: object, finish_reason: string | null) => 'data: ' + JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', model,
      choices: [{ delta, finish_reason, index: 0 }],
    }) + '\n\n';
    res.write(event({ role: 'assistant', content: '合成回复' }, null));
    if (marker.endsWith('-hold')) {
      waiting.set(marker, res);
      res.on('close', () => waiting.delete(marker));
      return;
    }
    res.end(event({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(r => provider.listen(0, '127.0.0.1', r));
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-turn-stop-'));
  let feishu!: FeishuOptions;
  const patches: Array<{ id: string; card: unknown }> = [];
  const sent: Array<{ id: string; text: string; context?: FeishuSendContext }> = [];
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, demo: false, token: 'fixture-token',
    model: { provider: 'openai-compatible', model: 'fixture', apiKey: 'fixture-key',
      baseUrl: 'http://127.0.0.1:' + address.port + '/v1' } }, {
    botFactory(options) {
      feishu = options;
      return { async start() {}, async close() {}, status: () => ({ connected: true }), async collect() { return []; },
        async updateCard(id, card) { patches.push({ id, card }); },
        async send(_target, text, context) {
          const id = 'outgoing-' + sent.length;
          sent.push({ id, text, context });
          context?.onSent?.(id);
        } };
    },
  });
  t.after(async () => {
    for (const res of waiting.values()) res.end('data: [DONE]\n\n');
    try { await server.close(); } finally {
      provider.closeAllConnections();
      await new Promise<void>(r => provider.close(() => r()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  async function post(path: string, input: Record<string, unknown> = {}) {
    const res = await fetch(server.url + '/api/v1' + path, { method: 'POST',
      headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return { status: res.status, body: await res.json() };
  }
  async function message(path: string, text: string) {
    const res = await post(path, { text });
    assert.equal(res.status, 202);
    return res.body.id as string;
  }
  async function status(id: string, expected: string) {
    await t.waitFor(() => assert.equal(server.app.store.get<Message>('messages', id)?.status, expected), { timeout: 15000 });
  }
  async function held(marker: string) {
    await t.waitFor(() => assert.ok(waiting.has(marker), marker), { timeout: 15000 });
  }
  return { server, held, requests, post, message, status, sent, patches, get feishu() { return feishu; } };
}

test('按消息停止当前和排队请求，项目与主会话互相隔离，过期操作不会停止后续回复', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const main = '/messages';
  const project = f.server.app.projects.create({ name: '合成中断验收项目' });
  const projectPath = '/projects/' + project.id + '/messages';
  const archivedPending: Message = { id: 'fixture-from-before-start', role: 'user', status: 'pending', createdAt: '',
    conversationId: 'main', text: '合成历史记录' };
  f.server.app.store.put('messages', archivedPending.id, archivedPending);
  const stop = (path: string, id: string) => f.post(path + '/' + id + '/stop');
  assert.deepEqual(await stop(main, archivedPending.id), { status: 200, body: { outcome: 'idle' } });
  const active = await f.message(main, 'fixture-main-hold');
  await f.held('fixture-main-hold');
  const queued = await f.message(main, 'fixture-queued');
  const next = await f.message(main, 'fixture-next-hold');
  const scoped = await f.message(projectPath, 'fixture-project-hold');
  await f.held('fixture-project-hold');
  await t.waitFor(() => assert.ok(f.server.app.store.list<Message>('messages')
    .find(row => row.replyTo === active && row.text.includes('合成回复'))), { timeout: 10000 });
  assert.equal((await stop(projectPath, active)).status, 404);
  assert.equal((await stop(main, scoped)).status, 404);
  assert.deepEqual(await stop(main, queued), { status: 200, body: { outcome: 'requested' } });
  await f.status(queued, 'failed');
  assert.equal(f.server.app.store.get<Message>('messages', active)?.status, 'pending');
  assert.deepEqual(await stop(main, active), { status: 200, body: { outcome: 'requested' } });
  await f.status(active, 'failed');
  await f.held('fixture-next-hold');
  assert.deepEqual(await stop(main, active), { status: 200, body: { outcome: 'idle' } });
  assert.equal(f.server.app.store.get<Message>('messages', next)?.status, 'pending');
  assert.deepEqual(await stop(projectPath, scoped), { status: 200, body: { outcome: 'requested' } });
  await f.status(scoped, 'failed');
  assert.equal(f.server.app.store.get<Message>('messages', next)?.status, 'pending');
  assert.deepEqual(await stop(main, next), { status: 200, body: { outcome: 'requested' } });
  await f.status(next, 'failed');
  const messages = f.server.app.store.list<Message>('messages');
  for (const input of [active, scoped, queued, next]) {
    const replies = messages.filter(message => message.role === 'assistant' && message.replyTo === input);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].status, 'failed');
    assert.match(replies[0].text, /停止|中断/);
    if (input === active) assert.match(replies[0].text, /合成回复/);
  }
  assert.ok(!f.requests.includes('fixture-queued'));
  await f.status(await f.message(main, 'fixture-new-main'), 'done');
  await f.status(await f.message(projectPath, 'fixture-new-project'), 'done');
});

test('已配对主人从进度卡和停止命令中断自己的回复，旧卡与重放命令不会停止新输入', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const bot = await f.server.bots.create({ name: '合成停止验收', appId: 'cli_5555555555555555',
    appSecret: 'fixture-application-key', scope: { kind: 'global' }, requireConfirmation: false });
  const source = { chatId: 'owner-chat', senderId: 'owner', chatType: 'p2p', senderType: 'user' } as const;
  const receive = (text: string, messageId: string) => f.feishu.onMessage(text, { ...source, messageId });
  const inputId = (text: string) => {
    const row = f.server.app.store.list<Message>('messages').find(item => item.role === 'user' && item.text === text);
    assert.ok(row); return row.id;
  };
  await receive(bot.pairingCode!, 'pair');
  await receive('fixture-bot-first-hold', 'first');
  await f.held('fixture-bot-first-hold');
  const id = inputId('fixture-bot-first-hold');
  const card = await t.waitFor(() => {
    const entry = f.sent.find(item => JSON.stringify(item.context?.card ?? {}).includes('workbench.stop'));
    assert.ok(entry);
    return entry;
  }, { timeout: 15000 });
  const body = card.context?.card?.body as { elements: Array<{ behaviors?: Array<{ value?: Record<string, unknown> }> }> };
  const value = body.elements.flatMap(el => el.behaviors ?? []).find(item => item.value?.kind === 'workbench.stop')?.value;
  assert.ok(value);
  const click = (operatorId: string, messageId = card.id) => f.feishu.onCardAction!({ operatorId, chatId: source.chatId, messageId, value });
  await click('stranger');
  await click(source.senderId, 'wrong-card-id');
  assert.equal(f.server.app.store.get<Message>('messages', id)?.status, 'pending');
  await click(source.senderId);
  await f.status(id, 'failed');
  await t.waitFor(() => {
    const patch = f.patches.findLast(item => item.id === card.id);
    assert.ok(patch);
    const { header } = patch.card as { header: { template: string; text_tag_list: Array<{ text: { content: string } }> } };
    assert.equal(header.template, 'grey');
    assert.equal(header.text_tag_list[0].text.content, '已停止本轮回复');
    assert.doesNotMatch(JSON.stringify(patch.card), /回复失败|workbench\.stop/);
  }, { timeout: 10000 });
  await receive('fixture-bot-second-hold', 'second');
  await f.held('fixture-bot-second-hold');
  const second = inputId('fixture-bot-second-hold');
  await click(source.senderId);
  assert.equal(f.server.app.store.get<Message>('messages', second)?.status, 'pending');
  await receive('/stop', 'command');
  await f.status(second, 'failed');
  await receive('fixture-bot-third-hold', 'third');
  await f.held('fixture-bot-third-hold');
  const third = inputId('fixture-bot-third-hold');
  await receive('/stop', 'command');
  assert.equal(f.server.app.store.get<Message>('messages', third)?.status, 'pending');
  await receive('/停止', 'new-command');
  await f.status(third, 'failed');
  await receive('fixture-bot-normal', 'fourth');
  await f.status(inputId('fixture-bot-normal'), 'done');
});

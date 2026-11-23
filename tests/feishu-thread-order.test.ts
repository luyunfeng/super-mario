import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('独立对话手动排序在 Web 与飞书一致，并保留归档位置、版本和绑定边界', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-order-'));
  const clients = new Map<string, FeishuOptions>();
  const sends: Array<{ appId: string; text: string }> = [];
  const botFactory: FeishuBotFactory = options => {
    clients.set(options.appId, options);
    return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
      async send(_target, text, context) {
        sends.push({ appId: options.appId, text }); context?.onSent?.('receipt-' + sends.length, context.card ? 'interactive' : 'text');
      } };
  };
  const config = { host: '127.0.0.1', port: 0, dataDir, token: 'order-fixture', demo: true };
  let server = await startServer(config, { botFactory });
  t.after(async () => { try { await server.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  async function bind(appId: string) {
    const bot = await server.bots.create({ appId, appSecret: 'fixture-key', name: appId, scope: { kind: 'global' }, requireConfirmation: false });
    const receive = (text: string, messageId: string) => clients.get(appId)!.onMessage(text, {
      messageId, senderId: 'owner-' + appId, chatId: 'chat-' + appId, chatType: 'p2p', senderType: 'user',
    });
    await receive(bot.pairingCode!, 'pair');
    const request = (suffix: string, patch?: unknown) => fetch(server.url + '/api/v1/feishu/bots/' + bot.id + '/threads' + suffix, {
      method: patch ? 'PATCH' : 'GET', headers: { authorization: 'Bearer order-fixture', 'content-type': 'application/json' },
      ...(patch ? { body: JSON.stringify(patch) } : {}),
    });
    async function create(title: string) {
      await receive('/new ' + title, title);
      await t.waitFor(() => assert.ok(sends.some(m => m.appId === appId && m.text.includes(title))));
      const rows = await (await request('')).json() as Array<{ threadId: string; title: string }>;
      const row = rows.find(item => item.title === title);
      assert.ok(row); return row.threadId;
    }
    const listed = async () => (await (await request('')).json() as Array<{ threadId: string }>).map(row => row.threadId);
    return { bot, receive, request, create, listed };
  }
  const a = await bind('cli_1111111111111111'), b = await bind('cli_2222222222222222');
  const one = await a.create('独立甲'), two = await a.create('独立乙'), other = await b.create('乙机器人私有对话');
  const initial = await (await a.request('/order')).json();
  assert.match(initial.binding, /^[0-9a-f]{64}$/);
  assert.deepEqual(initial, { binding: initial.binding, version: 0, order: [] });
  assert.equal((await a.request('/order', { ...initial, order: [other] })).status, 404);
  assert.equal((await a.request('/order', { ...initial, order: ['bad id'] })).status, 400);
  const responses = await Promise.all([[one, two], [two, one]].map(order => a.request('/order', { ...initial, order })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const winning = await responses.find(r => r.status === 200)!.json();
  const save = await a.request('/order', { ...winning, order: ['  ' + one + ' ', two, one, ''] });
  assert.equal(save.status, 200);
  const manual = await save.json();
  assert.deepEqual(manual.order, [one, two]);
  const three = await a.create('独立丙');
  assert.deepEqual(await a.listed(), [one, two, three]);
  await a.receive('/list', 'verify-list');
  const listText = sends.findLast(m => m.appId === a.bot.appId)!.text;
  const at = ['独立甲', '独立乙', '独立丙'].map(name => listText.indexOf(name));
  assert.ok(at[0] >= 0 && at[0] < at[1] && at[1] < at[2]);
  const detail = await (await a.request('/' + one)).json();
  const archived = await (await a.request('/' + one, { version: detail.version, archived: true })).json();
  assert.deepEqual(await a.listed(), [two, three]);
  assert.deepEqual((await (await a.request('/order')).json()).order, [one, two]);
  await server.close();
  server = await startServer(config, { botFactory });
  assert.deepEqual(await (await a.request('/order')).json(), manual);
  assert.equal((await a.request('/' + one, { version: archived.version, archived: false })).status, 200);
  assert.deepEqual(await a.listed(), [one, two, three]);
  const otherState = await (await b.request('/order')).json();
  assert.notEqual(otherState.binding, initial.binding);
  assert.deepEqual(otherState.order, []);
  assert.equal((await b.request('/order', { ...manual, order: [] })).status, 404);
  assert.equal((await a.request('/order', { ...manual, order: [] })).status, 200);
  assert.deepEqual(await a.listed(), [three, two, one]);
  for (let i = 0; i < 18; i++) await a.create('分页样本' + i);
  const readPage = (before: string | null) => server.bots.searchPrivateHistory(a.bot.id, undefined, false, before);
  const firstPage = readPage(null);
  assert.equal(firstPage.items.length, 20);
  assert.ok(firstPage.nextBefore);
  const secondPage = readPage(firstPage.nextBefore);
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.nextBefore, null);
  assert.deepEqual([...firstPage.items, ...secondPage.items].map(row => row.threadId), await a.listed());
  assert.throws(() => readPage(other), { status: 409 });
  await server.bots.update(a.bot.id, { scope: { kind: 'unmarked' } });
  await server.bots.update(a.bot.id, { scope: { kind: 'global' } });
  const reboundBot = server.bots.list().find(row => row.id === a.bot.id)!;
  if (!reboundBot.paired) await a.receive(reboundBot.pairingCode!, 'second-pair');
  const rebound = await (await a.request('/order')).json();
  assert.notEqual(rebound.binding, initial.binding);
  assert.deepEqual(rebound, { binding: rebound.binding, version: 0, order: [] });
  assert.equal((await a.request('/order', { ...initial, order: [] })).status, 404);
});

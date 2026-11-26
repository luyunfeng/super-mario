import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import { createFeishuIntegration } from '../plugins/feishu.ts';

const TOKEN = 'messages-page-fixture';

/** A host with two paired global bots, each with independent conversations of the owner's. */
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-messages-'));
  let dispatcher: { invoke(event: object, options: object): Promise<unknown> } | undefined;
  const host = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token: TOKEN }, {
    botFactory: options => createFeishuIntegration({ ...options,
      wsFactory: o => ({ async start(spec) { dispatcher = spec.eventDispatcher; o.onReady?.(); }, close() {}, getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }) }),
      fetch: async input => {
        const path = new URL(String(input)).pathname;
        if (path.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'synthetic', expire: 7200 });
        if (path.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: 'ou_bot' } });
        return Response.json({ code: 0, data: { message_id: 'om_sent' } });
      } }) });
  t.after(async () => { await host.close(); await rm(dir, { recursive: true, force: true }); });
  let sequence = 0;
  const event = (id: string, text: string) => dispatcher!.invoke({ schema: '2.0',
    header: { event_type: 'im.message.receive_v1', event_id: 'e' + ++sequence },
    event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
      message: { message_id: id, message_type: 'text', chat_id: 'oc_owner', chat_type: 'p2p', content: JSON.stringify({ text }) } } }, { needCheck: false });
  // One bot at a time: the owner pairs with it, opens a conversation and says something in it.
  for (const [name, appId, word] of [['助理甲', 'cli_8888888888888888', '甲的话'], ['助理乙', 'cli_7777777777777777', '乙的话']] as const) {
    const bot = await host.bots.create({ name, appId, appSecret: 'fixture', scope: { kind: 'global' }, requireConfirmation: false });
    await event('pair-' + appId, bot.pairingCode!);
    for (let tries = 0; tries < 100 && !host.bots.list().find(row => row.id === bot.id)?.paired; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    const before = host.app.store.list('feishu.private-threads').length;
    await event('new-' + appId, '/new');
    for (let tries = 0; tries < 100 && host.app.store.list('feishu.private-threads').length === before; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    const thread = host.app.store.list<{ threadId: string }>('feishu.private-threads').at(-1)!;
    await event('say-' + appId, word);
    void thread;
  }
  const read = async (query = '', credential = TOKEN) => {
    const answer = await fetch(host.url + '/api/v1/feishu/messages' + query, { headers: credential ? { authorization: 'Bearer ' + credential } : {} });
    return { status: answer.status, body: await answer.json() as { items: { threadId: string; botId: string; botName: string; title: string; latestAt: string; count: number; archived: boolean }[]; total: number; offset: number; limit: number } };
  };
  return { host, read };
}

test('消息页把主人与每个已配对机器人的独立对话排在一起，各带机器人名，最近的在最上面', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.host.app.store.list('feishu.private-threads').length, 2);
  const { status, body } = await f.read();
  assert.equal(status, 200);
  assert.equal(body.total, 2);
  assert.equal(body.limit, 30);
  assert.deepEqual(body.items.map(item => item.botName).sort(), ['助理乙', '助理甲']);
  // Each conversation says which bot it is with, and has a time and a count.
  for (const item of body.items) {
    assert.ok(item.threadId.length > 0);
    assert.equal(item.archived, false);
    assert.ok(item.count >= 1);
    assert.equal(Number.isNaN(Date.parse(item.latestAt)), false);
    assert.equal(f.host.bots.list().find(bot => bot.id === item.botId)?.name, item.botName);
  }
  // Newest first. The order is settled when two are made in the same instant.
  for (let i = 1; i < body.items.length; i++) assert.ok(body.items[i - 1]!.latestAt >= body.items[i]!.latestAt);
  // The page is paged, and says how many there are in all.
  const first = await f.read('?limit=1');
  assert.equal(first.body.items.length, 1);
  assert.equal(first.body.total, 2);
  const second = await f.read('?limit=1&offset=1');
  assert.equal(second.body.items.length, 1);
  assert.notEqual(second.body.items[0]!.threadId, first.body.items[0]!.threadId);
  // Nothing is archived yet.
  assert.equal((await f.read('?archived=1')).body.total, 0);
});

test('检索只找匹配的对话；参数不对时说明原因；没有令牌时读不到', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.read('?query=' + encodeURIComponent('甲的话'))).body.total, 1);
  assert.equal((await f.read('?query=' + encodeURIComponent('甲的话'))).body.items[0]!.botName, '助理甲');
  assert.equal((await f.read('?query=' + encodeURIComponent('不存在的话'))).body.total, 0);
  assert.equal((await f.read('?offset=-1')).status, 400);
  assert.equal((await f.read('?limit=abc')).status, 400);
  assert.equal((await f.read('?limit=0')).status, 400);
  assert.equal((await f.read('?limit=101')).status, 400);
  assert.equal((await f.read('?limit=1.5')).status, 400);
  assert.equal((await f.read('?offset=1.5')).status, 400);
  assert.equal((await f.read('?force=1')).status, 400);
  assert.equal((await f.read('', '')).status, 401);
});

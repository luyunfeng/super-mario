import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuMessageSource, FeishuOptions } from '../plugins/feishu.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';

type Action = { action: 'send' | 'pin' | 'unpin' | 'recall' | 'patch'; app: string; id: string; card?: unknown };
async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-standing-workbench-'));
  const log: Action[] = [], receivers = new Map<string, FeishuOptions>();
  let fallback = false, pinFailure: 'no' | 'unknown' | undefined;
  const factory: FeishuBotFactory = options => {
    receivers.set(options.appId, options);
    const record = (action: Action['action'], id: string, card?: unknown) => log.push({ action, app: options.appId, id, card });
    return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
      async send(_target, _text, context) {
        const id = options.appId + '-msg-' + log.length;
        if (context?.card && fallback) context.beforeTextFallback?.();
        record('send', id, !fallback && context?.card);
        context?.onSent?.(id, context.card && !fallback ? 'interactive' : 'text');
      },
      async pinMessage(id: string) {
        record('pin', id);
        if (pinFailure) throw Object.assign(new Error('synthetic-provider-detail'), { delivery: pinFailure });
      },
      async unpinMessage(id: string) { record('unpin', id); },
      async recallMessage(id: string) { record('recall', id); },
      async updateCard(id: string, card: Record<string, unknown>) { record('patch', id, card); },
    };
  };
  const config = { host: '127.0.0.1', port: 0, dataDir, token: 'fixture-standing', demo: true };
  let server = await startServer(config, { botFactory: factory });
  t.after(async () => { try { await server.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  async function bot(appId: string, owner: string) {
    const row = await server.bots.create({ name: '合成机器人 ' + owner, appId, appSecret: 'private-fixture',
      scope: { kind: 'global' }, requireConfirmation: false });
    function receive(text: string, messageId: string, extra?: Partial<FeishuMessageSource>) {
      return receivers.get(appId)!.onMessage(text, { chatId: 'chat-' + owner, senderId: owner, chatType: 'p2p',
        senderType: 'user', messageId, ...extra });
    }
    function press(messageId: string, value: Record<string, unknown>, operatorId = owner) {
      return receivers.get(appId)!.onCardAction!({ messageId, value, operatorId, chatId: 'chat-' + owner });
    }
    return { id: row.id, appId, receive, press, pair: () => receive(row.pairingCode!, 'pair') };
  }
  async function status(id: string) {
    const r = await fetch(server.url + '/api/v1/feishu/bots/' + id + '/workbench', {
      headers: { authorization: 'Bearer fixture-standing' },
    });
    assert.equal(r.status, 200);
    return r.json() as Promise<{ state: string; detail?: string }>;
  }
  return { bot, status, log, get server() { return server; },
    setFallback(value: boolean) { fallback = value; }, failPin(value?: typeof pinFailure) { pinFailure = value; },
    async restart() { await server.close(); server = await startServer(config, { botFactory: factory }); } };
}

test('主人工作台投递与置顶分别确认，重放保留原卡，替换只清理由本机器人管理的旧卡', { timeout: 60000 }, async t => {
  const f = await fixture(t), a = await f.bot('cli_1111111111111111', 'alpha'), b = await f.bot('cli_2222222222222222', 'beta');
  const unauthenticated = await fetch(f.server.url + '/api/v1/feishu/bots/' + a.id + '/workbench');
  assert.equal(unauthenticated.status, 401);
  assert.equal((await f.status(a.id)).state, 'none');
  await a.receive('/home', 'unpaired');
  await a.pair(); await b.pair();
  const afterPair = f.log.length;
  await a.receive('/home', 'wrong-owner', { senderId: 'beta' });
  await a.receive('/home', 'bot-impersonation', { senderType: 'bot' });
  await a.receive('/home', 'wrong-chat', { chatId: 'chat-beta' });
  await a.receive('/home', 'group', { chatType: 'group' });
  await b.receive('/home', 'wrong-account', { senderId: 'alpha', chatId: 'chat-alpha' });
  assert.equal(f.log.length, afterPair);
  await a.receive('/tasks', 'non-home');
  assert.equal(f.log.filter(row => row.action === 'pin').length, 0);

  const states: string[] = [];
  const unsubscribe = f.server.app.events.subscribe(event => {
    if (event.type === 'feishu.changed') states.push(f.server.bots.workbenchStatus(a.id).state);
  });
  await Promise.all([a.receive('/home', 'home-one'), a.receive('/home', 'home-one')]);
  await t.waitFor(() => assert.equal(f.log.filter(row => row.action === 'pin').length, 1));
  unsubscribe();
  assert.ok(states.includes('unconfirmed'));
  assert.equal(states.at(-1), 'pinned');
  const old = f.log.find(row => row.action === 'pin')!.id;
  assert.ok(f.log.find(row => row.action === 'send' && row.id === old)?.card);
  assert.equal((await f.status(a.id)).state, 'pinned');
  await b.receive('/home', 'home-one');
  await t.waitFor(() => assert.equal(f.log.filter(row => row.action === 'pin').length, 2));
  const secondBot = f.log.filter(row => row.action === 'pin')[1].id;
  await f.restart();
  assert.equal((await f.status(a.id)).state, 'pinned');
  assert.equal((await f.status(b.id)).state, 'pinned');
  await a.receive('/home', 'home-one');
  assert.equal(f.log.filter(row => row.action === 'pin').length, 2);
  const start = f.log.length;
  await a.receive('工作台', 'home-two');
  await t.waitFor(() => assert.ok(f.log.slice(start).some(row => row.action === 'recall' && row.id === old)));
  const changes = f.log.slice(start).filter(row => row.action !== 'patch');
  const next = changes.find(row => row.action === 'pin')!;
  assert.ok(next && next.id !== old);
  assert.deepEqual(changes.map(({ action, id }) => [action, id]), [
    ['send', next.id], ['pin', next.id], ['unpin', old], ['recall', old],
  ]);
  assert.ok(!changes.some(row => row.id === secondBot));
  assert.equal((await f.status(a.id)).state, 'pinned');

  f.server.app.projects.create({ name: '合成置顶刷新项目' });
  await t.waitFor(() => assert.ok(f.log.some(row => row.action === 'patch' && row.id === next.id &&
    JSON.stringify(row.card).includes('合成置顶刷新项目'))), { timeout: 10000 });
  assert.equal(f.log.filter(row => row.action === 'pin').length, 3);
  const failedReplace = f.log.length;
  f.failPin('unknown');
  await a.receive('/home', 'uncertain-replacement');
  await t.waitFor(() => assert.ok(f.log.slice(failedReplace).some(row => row.action === 'pin')));
  assert.ok(!f.log.slice(failedReplace).some(row => row.action === 'unpin' || row.action === 'recall'));
});

test('文本降级回执不触发置顶，平台拒绝或超时均不会因同事件重放再次置顶', { timeout: 60000 }, async t => {
  const f = await fixture(t), a = await f.bot('cli_3333333333333333', 'gamma');
  await a.pair();
  f.setFallback(true);
  await a.receive('/home', 'text-fallback');
  const fallback = f.log.at(-1)!;
  assert.equal(fallback.action, 'send');
  assert.ok(!fallback.card);
  assert.equal(f.log.filter(row => row.action === 'pin').length, 0);
  const fallbackStatus = await f.status(a.id);
  assert.equal(fallbackStatus.state, 'unconfirmed');
  assert.match(fallbackStatus.detail ?? '', /文本/);
  f.setFallback(false);
  for (const failure of ['no', 'unknown'] as const) {
    f.failPin(failure);
    const before = f.log.length;
    await a.receive('/home', failure);
    await t.waitFor(() => assert.ok(f.log.slice(before).some(row => row.action === 'pin')));
    await t.waitFor(async () => assert.equal((await f.status(a.id)).state, 'unconfirmed'));
    await a.receive('/home', failure);
    assert.equal(f.log.slice(before).filter(row => row.action === 'pin').length, 1);
    assert.ok(!f.log.slice(before).some(row => row.action === 'unpin' || row.action === 'recall'));
  }
  await f.restart();
  assert.equal((await f.status(a.id)).state, 'unconfirmed');
});


test('过期的置顶工作台只为主人续期；换卡后旧按钮失效，新卡继续导航', { timeout: 60000 }, async t => {
  const f = await fixture(t), bot = await f.bot('cli_4444444444444444', 'delta');
  await bot.pair();
  async function open(commandId: string) {
    const before = f.log.length;
    await bot.receive('/home', commandId);
    await t.waitFor(() => assert.ok(f.log.slice(before).some(row => row.action === 'pin')));
    const id = f.log.slice(before).find(row => row.action === 'pin')!.id;
    const card = f.log.slice(before).find(row => row.action === 'send' && row.id === id)!.card as {
      elements: { actions?: { value?: Record<string, unknown> }[] }[];
    };
    const value = card.elements.flatMap(element => element.actions ?? [])
      .find(action => action.value?.kind === 'workbench.navigate' && action.value.view === 'inbox')?.value;
    assert.ok(value && typeof value.navigation === 'string');
    return { id, value, navigation: value.navigation };
  }
  const first = await open('first');
  const grants = 'feishu.card.navigation';
  const cap = f.server.app.store.get<{ expiresAt: number }>(grants, first.navigation);
  assert.ok(cap);
  f.server.app.store.put(grants, first.navigation, { ...cap, expiresAt: 0 });
  assert.equal('card' in bot.press(first.id, first.value, 'other-person'), false);
  assert.equal(f.server.app.store.get<typeof cap>(grants, first.navigation)!.expiresAt, 0);
  function assertInbox(response: ReturnType<typeof bot.press>) {
    const card = response.card as { type: string; data: { header: { title: { content: string } } } };
    assert.equal(card.type, 'raw');
    assert.match(card.data.header.title.content, /收件箱$/);
  }
  assertInbox(bot.press(first.id, first.value));
  assert.ok(f.server.app.store.get<typeof cap>(grants, first.navigation)!.expiresAt > Date.now());

  const next = await open('replace');
  await t.waitFor(() => assert.ok(f.log.some(row => row.action === 'recall' && row.id === first.id)));
  assert.notEqual(next.id, first.id);
  assert.equal('card' in bot.press(first.id, first.value), false);
  assert.equal('card' in bot.press(next.id, first.value), false);
  assert.equal('card' in bot.press(first.id, next.value), false);
  assertInbox(bot.press(next.id, next.value));
  assert.equal((await f.status(bot.id)).state, 'pinned');
});

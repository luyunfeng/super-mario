import assert from 'node:assert/strict';
import { botConversationId } from '../packages/core/src/bot-agent-routing.ts';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFeishuBotsController, dashboardWebBase } from '../apps/server/src/feishu-bots.ts';
import type { FeishuBotsApp, FeishuBotFactory, FeishuMailboxInput } from '../apps/server/src/feishu-bots.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createEffects } from '../packages/core/src/effects.ts';
import { createInteractions } from '../packages/core/src/interactions.ts';
import { createEventMailboxes } from '../packages/core/src/event-mailboxes.ts';
import type { FeishuSendContext, FeishuOptions } from '../plugins/feishu.ts';
import type { BotScope, MailboxEntry } from '../packages/protocol/src/bots.ts';
import { readConversationStatus } from '../plugins/conversation-status.ts';
import { readTodayBrief } from '../plugins/today-brief.ts';
import type { Message } from '../packages/protocol/src/index.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const source = (messageId: string, chatId = 'owner', senderId = 'human', chatType = 'p2p') => ({ messageId, chatId, senderId, chatType });

function fixture(t: test.TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mario-bots-'));
  const store = createStore(join(dataDir, 'test.sqlite'));
  const events = createEventBus(store), effects = createEffects({ store, events });
  const posts: Array<{ id: string; text: string; scope: BotScope; botId: string }> = [];
  let enabled = true, denied = false, uncertain = false, postFailure = false;
  let hookCount = 0;
  const instances: Array<{ options: FeishuOptions; sent: string[][]; contexts: Array<FeishuSendContext | undefined>; closed: boolean; closeCount: number; collect: () => Promise<import('../packages/protocol/src/index.ts').InboxThing[]> }> = [];
  const factory: FeishuBotFactory = options => {
    const state = { options, sent: [] as string[][], contexts: [] as Array<FeishuSendContext | undefined>, closed: false, closeCount: 0,
      collect: async () => [{ thread: 'personal-thread', last: 'personal-message', title: '采集', text: '上下文' }] };
    instances.push(state);
    return { start: async () => {}, close: async () => { state.closed = true; state.closeCount++; },
      send: async (target, text, context) => { state.contexts.push(context); state.sent.push([target, text]); if (uncertain) throw new Error(`network ${options.appSecret}`); },
      collect: () => state.collect(), status: () => ({ connected: !state.closed }) };
  };
  let controller: ReturnType<typeof createFeishuBotsController>;
  const mailboxes: FeishuBotsApp['mailboxes'] = {
    put(input: FeishuMailboxInput) {
      const existing = mailboxes.list().find(entry => entry.botId === input.botId && entry.eventKey === input.eventKey && entry.direction === input.direction);
      if (existing) return existing;
      const entry: MailboxEntry = { ...input, id: `box-${mailboxes.list().length}`, version: 1,
        status: input.requiresConfirmation ? 'pending' : 'ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      store.put('test.mailboxes', entry.id, entry); return entry;
    },
    list: () => store.list<MailboxEntry>('test.mailboxes'),
    async process(id, version) {
      const entry = mailboxes.list().find(entry => entry.id === id)!;
      if (entry.version !== version || !['pending', 'ready'].includes(entry.status)) return;
      const processing: MailboxEntry = { ...entry, status: 'processing', version: version + 1 };
      store.put('test.mailboxes', id, processing);
      try {
        const result = entry.direction === 'inbox' ? await controller.dispatchInbox(processing)
          : await controller.send(entry.botId, entry.target!, entry.text, entry.eventKey);
        store.put('test.mailboxes', id, { ...processing, status: 'completed', ...(result ? { resultId: result.id } : {}) });
      } catch (error) {
        store.put('test.mailboxes', id, { ...processing, status: 'unknown', error: String(error) }); throw error;
      }
    },
  };
  const app: FeishuBotsApp = { store, events, effects, mailboxes,
    plugins: { list: () => [{ id: 'feishu', enabled, status: enabled ? 'active' : 'disabled' }], invocations: {
      async invoke(_name, input, action) { hookCount++; if (denied) throw Object.assign(new Error('guard denied'), { delivery: 'no' }); return action(input); },
    } },
    async postScoped(text, scope, botId) {
      if (postFailure) throw new Error('post failed');
      const id = `input-${posts.length}`; posts.push({ id, text, scope, botId });
      const message: Message = { id, text, role: 'user', conversationId: botConversationId({ id: botId, scope }), createdAt: '' };
      store.put('messages', id, message); return message;
    },
  };
  const config = { dataDir, host: '127.0.0.1', port: 0, demo: true };
  controller = createFeishuBotsController(app, config, { factory });
  t.after(async () => { await controller.close(); await effects.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  async function add(name: string, scope: BotScope = { kind: 'global' }, requireConfirmation = false, extra: Partial<import('../packages/protocol/src/bots.ts').FeishuBotInput> = {}) {
    const bot = await controller.create({ name, scope, requireConfirmation, appId: `cli_${name}`, appSecret: `private-${name}`, ...extra });
    const instance = instances.at(-1)!;
    return { bot, instance, async pair(senderId = 'human') { await instance.options.onMessage(controller.list().find(row => row.id === bot.id)!.pairingCode!, source(`pair-${name}`, 'owner', senderId)); instance.sent.length = 0; } };
  }
  function reply(replyTo: string, id = `reply-${replyTo}`, origin?: Message['origin']) {
    store.put('messages', id, { id, role: 'assistant', text: `answer-${id}`, replyTo, status: 'done', origin, createdAt: '', conversationId: '' } satisfies Message);
    events.publish('messages.changed', { messageId: id });
    if (origin === 'result') events.publish('runs.result', { messageId: id });
    if (origin === 'notification') events.publish('notifications.message', { messageId: id });
  }
  return { dataDir, store, app, events, effects, mailboxes, instances, posts, add, reply,
    get controller() { return controller; },
    async restart() { await controller.close(); controller = createFeishuBotsController(app, config, { factory }); await controller.start(); },
    disable() { enabled = false; events.publish('plugins.changed', { id: 'feishu' }); },
    deny() { denied = true; }, uncertain() { uncertain = true; }, postFail() { postFailure = true; }, hookCount: () => hookCount };
}

test('dashboard is an owner-only private global command with durable delivery deduplication', async t => {
  const f = fixture(t), a = await f.add('Dashboard', { kind: 'global' }, true);
  const receive = a.instance.options.onMessage;
  await receive('工作台', source('unpaired'));
  await a.pair();
  await receive('工作台', source('wrong-chat', 'other'));
  await receive('/dashboard', source('wrong-owner', 'owner', 'other'));
  await receive('工作台', source('group', 'owner', 'human', 'group'));
  await Promise.all([receive('工作台', source('dashboard')), receive('工作台', source('dashboard'))]);
  await receive('/dashboard', source('slash'));
  assert.equal(a.instance.sent.length, 2);
  assert.ok(a.instance.sent.every(([target]) => target === 'owner'));
  for (const context of a.instance.contexts.slice(-2)) {
    assert.ok(context?.card);
    assert.match(JSON.stringify(context.card), /workbench.navigate/);
    assert.doesNotMatch(JSON.stringify(context.card), /"url"/);
  }
  assert.equal(f.posts.length, 0);
  const entries = f.mailboxes.list().filter(entry => entry.eventKey.startsWith('feishu-dashboard:'));
  assert.deepEqual(entries.map(entry => entry.status), ['completed', 'completed']);
  await f.restart();
  const restarted = f.instances.at(-1)!;
  await restarted.options.onMessage('工作台', source('dashboard'));
  assert.equal(restarted.sent.length, 0);
  await restarted.options.onMessage('/dashboard {"card":{},"target":"other"}', source('custom'));
  assert.equal(restarted.contexts.at(-1)?.card, undefined);
  assert.equal(f.mailboxes.list().filter(entry => entry.direction === 'inbox').length, 1);
  const b = await f.add('UnmarkedDashboard', { kind: 'unmarked' });
  await b.pair();
  await b.instance.options.onMessage('/dashboard', source('ordinary'));
  assert.equal(b.instance.contexts.at(-1)?.card, undefined);
});

test('已配对主人可直接按命令查看飞书工作台分栏或帮助，重复投递不执行模型', async t => {
  const f = fixture(t), bot = await f.add('CommandHelp', { kind: 'global' }, true);
  await bot.pair();
  for (const [command, title] of [['  ／HELP  ', '工作台命令'], ['/主页', '今日工作台'], ['/TASKS', '任务进展'], ['／收件箱', '收件箱']]) {
    const message = source('command-' + title);
    await bot.instance.options.onMessage(command, message);
    await bot.instance.options.onMessage(command, message);
    const header = bot.instance.contexts.at(-1)?.card?.header as { title: { content: string } };
    assert.ok(header.title.content.endsWith(title));
  }
  assert.equal(bot.instance.sent.length, 4);
  assert.ok(bot.instance.sent[0][1].includes('/inbox'));
  assert.equal(f.posts.length, 0);
  await bot.instance.options.onMessage('/inbox 里有什么', source('ordinary-question'));
  assert.ok(f.mailboxes.list().some(row => row.direction === 'inbox' && row.text === '/inbox 里有什么'));
});

test('dashboard URL uses a configured remote HTTP origin with no credentials', () => {
  const config = { host: '0.0.0.0', port: 8080 };
  assert.equal(dashboardWebBase(config, 'https://work.example:8443/'), 'https://work.example:8443');
  for (const url of [undefined, 'https://u:p@work.example', 'https://work.example/?token=fake',
    'https://work.example/#chat?token=fake', 'http://127.1', 'http://localhost.', 'http://[::1]', 'file:///tmp/work']) {
    assert.equal(dashboardWebBase(config, url), undefined);
  }
});

test('two bots pair independently, reject arbitrary senders and route replies/results once without cross-talk', async t => {
  const f = fixture(t), a = await f.add('A'), b = await f.add('B');
  const codeA = f.controller.list()[0].pairingCode!;
  await a.instance.options.onMessage(codeA, source('group', 'owner', 'human', 'group'));
  await b.instance.options.onMessage(codeA, source('wrong-code'));
  assert.ok(f.controller.list().every(bot => !bot.paired));
  await a.pair(); await b.pair();
  await a.instance.options.onMessage('intruder', source('bad', 'another'));
  await a.instance.options.onMessage('sender mismatch', source('bad2', 'owner', 'intruder'));
  await Promise.all([a.instance.options.onMessage('one', source('same-id')), a.instance.options.onMessage('one', source('same-id'))]);
  await b.instance.options.onMessage('two', source('same-id'));
  assert.equal(f.posts.length, 2);
  assert.deepEqual(f.posts.map(post => post.botId), [a.bot.id, b.bot.id]);
  const route = f.store.get<Record<string, unknown>>('message.routes', f.posts[0].id)!;
  assert.equal(route.botId, a.bot.id); assert.equal(route.accountId, a.bot.appId); assert.equal(route.sourceMessageId, 'same-id');
  f.reply(f.posts[0].id); f.reply(f.posts[0].id);
  f.reply(f.posts[1].id, 'native', 'result'); f.reply(f.posts[1].id, 'notice', 'notification');
  f.reply('web-input', 'web'); await tick();
  assert.deepEqual(a.instance.sent, [['owner', 'answer-reply-input-0']]);
  assert.deepEqual(b.instance.sent, [['owner', 'answer-native'], ['owner', 'answer-notice']]);
  assert.equal(f.mailboxes.list().filter(entry => entry.direction === 'inbox').length, 2);
  assert.equal(f.mailboxes.list().filter(entry => entry.direction === 'outbox' && entry.replyTo).length, 3);
});

test('confirmation persists inputs before dispatch; unmarked never runs automatically', async t => {
  const f = fixture(t), a = await f.add('Confirm', { kind: 'global' }, true), b = await f.add('Unmarked', { kind: 'unmarked' });
  await a.pair(); await b.pair();
  await a.instance.options.onMessage('confirm me', source('c'));
  await b.instance.options.onMessage('unmarked', source('u'));
  assert.equal(f.posts.length, 0);
  const [inputA, inputB] = f.mailboxes.list().filter(entry => entry.direction === 'inbox');
  assert.equal(inputA.status, 'pending'); assert.equal(inputB.requiresConfirmation, true);
  await assert.rejects(f.controller.dispatchInbox(inputA), /未确认/);
  await f.mailboxes.process(inputA.id, inputA.version);
  assert.deepEqual(f.posts[0].scope, { kind: 'global' });
  await assert.rejects(async () => f.mailboxes.process(inputB.id, inputB.version), /分配作用域/);
});

test('disable/rebind invalidates pending envelopes and callbacks without reconnecting another bot', async t => {
  const f = fixture(t), a = await f.add('Rebind', { kind: 'global' }, true), b = await f.add('Stable');
  await a.pair(); await b.pair();
  await a.instance.options.onMessage('old envelope', source('old'));
  const entry = f.mailboxes.list().find(entry => entry.direction === 'inbox')!;
  await f.controller.update(a.bot.id, { scope: { kind: 'unmarked' } });
  await f.controller.update(a.bot.id, { scope: { kind: 'global' } });
  await assert.rejects(async () => f.mailboxes.process(entry.id, entry.version), /绑定已变化/);
  await a.instance.options.onMessage('stale callback', source('stale'));
  assert.equal(f.posts.length, 0); assert.equal(b.instance.closed, false); assert.equal(b.instance.closeCount, 0);
  const replacement = f.instances.at(-1)!;
  await f.controller.update(a.bot.id, { enabled: false });
  await replacement.options.onMessage('disabled callback', source('disabled'));
  assert.equal(f.posts.length, 0); assert.equal(b.instance.closed, false);
  await b.instance.options.onMessage('still active', source('stable'));
  assert.equal(f.posts.length, 1);
  await f.controller.archive(b.bot.id);
  await b.instance.options.onMessage('archived', source('archived'));
  assert.equal(f.posts.length, 1); assert.equal(f.controller.list().length, 1);
});

test('old accepted input cannot route replies after rebind, plugin disable or archive', async t => {
  const f = fixture(t), a = await f.add('OldRoute'); await a.pair();
  await a.instance.options.onMessage('first', source('one'));
  await f.controller.update(a.bot.id, { enabled: false });
  f.reply(f.posts[0].id); await tick(); assert.deepEqual(a.instance.sent, []);
  await f.controller.update(a.bot.id, { enabled: true });
  const next = f.instances.at(-1)!;
  f.reply(f.posts[0].id, 'late-result', 'result'); await tick(); assert.deepEqual(next.sent, []);
  await next.options.onMessage('second', source('two'));
  f.disable();
  await next.options.onMessage('plugin race', source('three'));
  f.reply(f.posts[1].id); await tick();
  assert.equal(f.posts.length, 2); assert.deepEqual(next.sent, []); assert.equal(next.closed, true);
});

test('project and task validation requires active projects and matching todo, never completes a task', async t => {
  const f = fixture(t);
  await assert.rejects(f.add('Missing', { kind: 'project', projectId: 'none' }), /项目不存在/);
  f.store.put('projects', 'p', { id: 'p', name: 'P' });
  f.store.put('todos', 't', { id: 't', projectId: 'p', title: 'Task', completedAt: 'already completed' });
  await assert.rejects(f.add('Mismatch', { kind: 'task', todoId: 't', projectId: 'wrong' }), /项目不存在|项目不匹配/);
  const task = await f.add('Task', { kind: 'task', todoId: 't' }); await task.pair();
  await task.instance.options.onMessage('task context', source('task'));
  assert.deepEqual(f.posts[0].scope, { kind: 'task', todoId: 't', projectId: 'p' });
  assert.equal(f.store.get<{ completedAt: string }>('todos', 't')!.completedAt, 'already completed');
  f.store.put('projects', 'p', { id: 'p', archivedAt: 'now' });
  await task.instance.options.onMessage('archived context', source('later'));
  assert.equal(f.posts.length, 1);
});

test('proactive sends require confirmation, invoke guard and effects once, unknown sends never retry and redact secrets', async t => {
  const f = fixture(t), a = await f.add('Send'); await a.pair();
  await assert.rejects(f.controller.send(a.bot.id, 'other', 'hello', 'other'), /目标未配对/);
  await assert.rejects(f.controller.send(a.bot.id, 'owner', 'hello', 'proactive'), /Web 确认/);
  const entry = f.mailboxes.list().find(entry => entry.eventKey === 'proactive')!;
  assert.equal(entry.status, 'pending');
  await f.mailboxes.process(entry.id, entry.version);
  const hooks = f.hookCount();
  await f.controller.send(a.bot.id, 'owner', 'hello', 'proactive');
  assert.equal(f.hookCount(), hooks); assert.deepEqual(a.instance.sent, [['owner', 'hello']]);
  f.uncertain();
  await a.instance.options.onMessage('trigger reply', source('trigger'));
  f.reply(f.posts[0].id); await tick();
  const out = f.mailboxes.list().find(entry => entry.replyTo)!;
  await assert.rejects(f.controller.send(a.bot.id, 'owner', out.text, out.eventKey), /unknown/);
  assert.equal(a.instance.sent.length, 2);
  const serialized = JSON.stringify({ effects: f.effects.list(), events: f.store.list('core.events'), bots: f.controller.list(), boxes: f.mailboxes.list() });
  assert.ok(!serialized.includes('private-Send')); assert.ok(serialized.includes('[redacted]'));
  await f.restart();
  const restarted = f.instances.at(-1)!;
  f.events.publish('messages.changed', { messageId: 'reply-input-0' }); await tick();
  assert.deepEqual(restarted.sent, []);
});

test('channel guard denial blocks external I/O', async t => {
  const f = fixture(t), a = await f.add('Guard'); await a.pair(); f.deny();
  await a.instance.options.onMessage('deny answer', source('guard'));
  f.reply(f.posts[0].id); await tick();
  assert.deepEqual(a.instance.sent, []);
  assert.equal(f.effects.list().at(-1)?.status, 'failed');
});

test('private atomic config survives restart, blocks duplicate new/legacy app IDs and omits secrets publicly', async t => {
  const f = fixture(t), a = await f.add('Private'); await a.pair();
  assert.equal(statSync(join(f.dataDir, 'bots.json')).mode & 0o777, 0o600);
  assert.ok(readFileSync(join(f.dataDir, 'bots.json'), 'utf8').includes('private-Private'));
  assert.ok(!JSON.stringify(f.controller.list()).includes('private-Private'));
  await assert.rejects(f.add('Private'), /appId 已被/);
  writeFileSync(join(f.dataDir, 'integrations.json'), JSON.stringify({ enabled: false, appId: 'cli_Legacy' }));
  await assert.rejects(f.add('Legacy'), /旧版飞书/);
  const other = createFeishuBotsController(f.app, { dataDir: f.dataDir, host: '', port: 0, demo: true, feishu: { appId: 'cli_Override', appSecret: '' } });
  await assert.rejects(other.create({ name: 'legacy override', appId: 'cli_Override', scope: { kind: 'global' } }), /旧版飞书/);
  await other.close();
  await f.restart();
  assert.equal(f.controller.list()[0].id, a.bot.id); assert.equal(f.controller.list()[0].paired, true);
  assert.equal(f.instances.at(-1)!.options.appSecret, 'private-Private');
});

test('collection stays tagged and pending; late collect cannot ingest after rebind', async t => {
  const f = fixture(t); f.store.put('projects', 'p', { id: 'p' });
  const a = await f.add('Collect', { kind: 'project', projectId: 'p' });
  await f.controller.collect(a.bot.id); await f.controller.collect(a.bot.id);
  const entry = f.mailboxes.list()[0];
  assert.deepEqual(entry.scope, { kind: 'project', projectId: 'p' });
  assert.equal(entry.requiresConfirmation, true); assert.equal(f.mailboxes.list().length, 1); assert.equal(f.posts.length, 0);
  let release!: (things: Awaited<ReturnType<typeof a.instance.collect>>) => void;
  a.instance.collect = () => new Promise(resolve => { release = resolve; });
  const pending = f.controller.collect(a.bot.id); const settled = assert.rejects(pending, /采集已取消/);
  await f.controller.update(a.bot.id, { scope: { kind: 'global' } });
  release([{ thread: 'late', last: 'late', title: 'late', text: 'late' }]); await settled;
  assert.equal(f.mailboxes.list().length, 1);
});

test('uncertain inbox dispatch claims survive restart and are never posted again', async t => {
  const f = fixture(t), a = await f.add('Crash', { kind: 'global' }, true); await a.pair();
  await a.instance.options.onMessage('uncertain input', source('unknown'));
  const input = f.mailboxes.list().find(entry => entry.direction === 'inbox')!;
  f.postFail(); await assert.rejects(async () => f.mailboxes.process(input.id, input.version), /post failed/);
  await f.restart();
  const retry: MailboxEntry = { ...f.mailboxes.list().find(entry => entry.id === input.id)!, status: 'processing' };
  f.store.put('test.mailboxes', retry.id, retry);
  await assert.rejects(f.controller.dispatchInbox(retry), /unknown/);
  assert.equal(f.posts.length, 0);
});


test('real durable mailboxes confirm, dispatch, reply and invalidate API drafts across rebind', async t => {
  const f = fixture(t);
  const mailboxes = createEventMailboxes({ store: f.store, events: f.events });
  f.app.mailboxes = mailboxes;
  mailboxes.setHandlers({ inbox: entry => f.controller.dispatchInbox(entry),
    outbox: async entry => { await f.controller.send(entry.botId, entry.target!, entry.text, entry.eventKey); } });
  const a = await f.add('Real', { kind: 'global' }, true); await a.pair();
  await a.instance.options.onMessage('real confirmed input', source('real-input'));
  const input = mailboxes.list({ direction: 'inbox' })[0];
  assert.equal(input.status, 'pending'); assert.equal(f.posts.length, 0);
  assert.match(a.instance.sent[0][1], /等待.*确认.*尚未执行/);
  a.instance.sent.length = 0;
  const accepted = await mailboxes.confirm(input.id, input.version);
  assert.equal(accepted.status, 'completed'); assert.equal(accepted.resultId, f.posts[0].id);
  f.reply(f.posts[0].id); await tick();
  assert.deepEqual(a.instance.sent, [['owner', 'answer-reply-input-0']]);
  const draft = mailboxes.put({ direction: 'outbox', botId: a.bot.id, scope: a.bot.scope, eventKey: 'api-draft', title: 'draft', text: 'proactive', target: 'owner' });
  await f.controller.update(a.bot.id, { scope: { kind: 'unmarked' } });
  await f.controller.update(a.bot.id, { scope: { kind: 'global' } });
  const stale = await mailboxes.confirm(draft.id, draft.version);
  assert.equal(stale.status, 'failed'); assert.match(stale.error!, /绑定已变化/);
  assert.deepEqual(f.instances.at(-1)!.sent, []);
  await mailboxes.close();
});

const groupSource = (messageId: string, extra: Partial<Parameters<FeishuOptions['onMessage']>[1]> = {}) => ({
  messageId, chatId: 'oc_team', chatType: 'group', senderId: 'ou_member', senderType: 'user' as const,
  mentionedSelf: true, threadId: 'thread-team', rootId: 'root-team', ...extra,
});
const groups = [{ chatId: 'oc_team', mentionOnly: true, allowedSenderIds: ['ou_member'] }];
async function collaborators(f: ReturnType<typeof fixture>, confirmation = false, scope: BotScope = { kind: 'global' }) {
  const a = await f.add('RelayA', scope, false, { groupChats: groups });
  const b = await f.add('RelayB', scope, confirmation, { groupChats: groups });
  await a.pair(); await b.pair();
  await f.controller.update(a.bot.id, { collaboration: { peerBotIds: [b.bot.id] } });
  await f.controller.update(b.bot.id, { collaboration: { peerBotIds: [a.bot.id] } });
  return { a, b, input: { sourceBotId: a.bot.id, targetBotId: b.bot.id, text: 'internal work', key: 'relay-1' } };
}

test('group defaults deny; only paired human allowlist and precise mention enter a confirmed threaded inbox', async t => {
  const f = fixture(t), a = await f.add('Groups', { kind: 'global' }, true);
  await a.instance.options.onMessage(a.bot.pairingCode!, groupSource('cannot-pair'));
  assert.equal(f.controller.list()[0].paired, false);
  await a.pair('ou_owner');
  await a.instance.options.onMessage('unconfigured', groupSource('no-config'));
  assert.equal(f.mailboxes.list().filter(e => e.direction === 'inbox').length, 0);
  await f.controller.update(a.bot.id, { groupChats: groups });
  const live = f.instances.at(-1)!;
  assert.equal(live.options.groupMessages, true);
  for (const extra of [{ chatId: 'oc_other' }, { senderId: 'ou_stranger' }, { mentionedSelf: false }, { senderType: 'bot' as const }, { senderType: undefined }]) {
    await live.options.onMessage('denied', groupSource(`bad-${JSON.stringify(extra)}`, extra));
  }
  assert.equal(f.mailboxes.list().filter(e => e.direction === 'inbox').length, 0);
  await Promise.all([live.options.onMessage('team input', groupSource('team-message')), live.options.onMessage('team input', groupSource('team-message'))]);
  const inbox = f.mailboxes.list().filter(e => e.direction === 'inbox');
  assert.equal(inbox.length, 1); assert.equal(inbox[0].status, 'pending'); assert.equal(f.posts.length, 0);
  assert.equal(live.sent[0][0], 'oc_team');
  assert.deepEqual(live.contexts[0], { replyTo: 'team-message', threadId: 'thread-team' });
  await f.mailboxes.process(inbox[0].id, inbox[0].version);
  await f.controller.dispatchInbox(f.mailboxes.list().find(e => e.id === inbox[0].id)!);
  assert.equal(f.posts.length, 1);
  const route = f.store.get<Record<string, unknown>>('message.routes', f.posts[0].id)!;
  assert.equal(route.platformReplyTo, 'team-message'); assert.equal(route.threadId, 'thread-team');
  f.reply(f.posts[0].id); f.reply(f.posts[0].id); await tick();
  assert.deepEqual(live.sent.at(-1), ['oc_team', 'answer-reply-input-0']);
  const { onSent, ...thread } = live.contexts.at(-1)!;
  assert.equal(typeof onSent, 'function');
  assert.deepEqual(thread, { replyTo: 'team-message', threadId: 'thread-team' });
  assert.equal(live.sent.filter(e => e[1] === 'answer-reply-input-0').length, 1);
  await live.options.onMessage('owner allowed', groupSource('owner-team', { senderId: 'ou_owner' }));
  assert.equal(f.mailboxes.list().filter(e => e.direction === 'inbox').length, 2);
  const publicBots = JSON.stringify(f.controller.list());
  assert.ok(!publicBots.includes('ou_owner')); assert.ok(!publicBots.includes('replyTarget')); assert.ok(!publicBots.includes('private-Groups'));
});

test('group revocation invalidates pending actions and late results; proactive configured groups still require confirmation', async t => {
  const f = fixture(t), a = await f.add('Revoke', { kind: 'global' }, false, { groupChats: groups }); await a.pair();
  await a.instance.options.onMessage('accepted', groupSource('before'));
  await assert.rejects(f.controller.send(a.bot.id, 'oc_team', 'proactive', 'group-draft'), /确认/);
  const draft = f.mailboxes.list().find(e => e.eventKey === 'group-draft')!;
  assert.equal(draft.status, 'pending');
  await f.controller.update(a.bot.id, { groupChats: [{ ...groups[0], allowedSenderIds: [] }] });
  const live = f.instances.at(-1)!;
  f.reply(f.posts[0].id); await tick(); assert.deepEqual(live.sent, []);
  await assert.rejects(async () => f.mailboxes.process(draft.id, draft.version), /绑定已变化/);
  await a.instance.options.onMessage('late callback', groupSource('after'));
  await live.options.onMessage('revoked', groupSource('revoked'));
  assert.equal(f.posts.length, 1);
});

test('new config persists optional fields, supports clears and rejects duplicate/self peers', async t => {
  const f = fixture(t), a = await f.add('Config', { kind: 'global' }, false, { executorId: 'external-offline', groupChats: groups, collaboration: { peerBotIds: ['other'] } });
  assert.equal(a.bot.executorId, 'external-offline');
  await assert.rejects(f.controller.update(a.bot.id, { collaboration: { peerBotIds: ['other', 'other'] } }), /重复/);
  await assert.rejects(f.controller.update(a.bot.id, { collaboration: { peerBotIds: [a.bot.id] } }), /自身/);
  await f.restart();
  assert.deepEqual(f.controller.list()[0].groupChats, groups);
  assert.equal(f.controller.list()[0].executorId, 'external-offline');
  assert.equal(statSync(join(f.dataDir, 'bots.json')).mode & 0o777, 0o600);
  await f.controller.update(a.bot.id, { executorId: '', groupChats: [], collaboration: { peerBotIds: [] } });
  await f.restart();
  const bot = f.controller.list()[0];
  assert.equal(bot.executorId, undefined); assert.deepEqual(bot.groupChats, []); assert.deepEqual(bot.collaboration, { peerBotIds: [] });
});

test('internal relay uses target mailbox and scope, deduplicates concurrent keys and never forwards to platform', async t => {
  const f = fixture(t), { a, b, input } = await collaborators(f);
  const entries = await Promise.all([f.controller.relay(input), f.controller.relay(input)]);
  assert.equal(entries[0].id, entries[1].id); assert.equal(entries[0].status, 'completed');
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].botId, b.bot.id);
  assert.equal(entries[0].target, undefined);
  const stamp = f.store.get<Record<string, any>>('feishu.bot.envelopes', entries[0].id)!;
  assert.deepEqual(stamp.relay.path, [a.bot.id, b.bot.id]); assert.equal(stamp.relay.rootId, entries[0].id);
  const again = await f.controller.relay(input); assert.equal(again.id, entries[0].id); assert.equal(f.posts.length, 1);
  f.reply(f.posts[0].id); await tick();
  assert.ok(f.instances.every(instance => instance.sent.length === 0));
  for (const changed of [{ text: 'different' }, { parentEntryId: 'forged' }, { targetBotId: a.bot.id }, { chatId: 'oc_team' }]) {
    await assert.rejects(f.controller.relay({ ...input, ...changed }), (error: any) => error.statusCode === 409);
  }
});

test('relay confirmation and optional common group share reply outbox and revalidate both bot revisions', async t => {
  const f = fixture(t), { a, b, input } = await collaborators(f, true);
  const entry = await f.controller.relay({ ...input, chatId: 'oc_team' });
  assert.equal(entry.status, 'pending'); assert.equal(f.posts.length, 0);
  await f.mailboxes.process(entry.id, entry.version);
  f.reply(f.posts[0].id); await tick();
  const liveB = f.instances.at(-1)!;
  assert.deepEqual(liveB.sent, [['oc_team', 'answer-reply-input-0']]);
  await f.controller.update(a.bot.id, { executorId: 'rebound' });
  f.reply(f.posts[0].id, 'late'); await tick(); assert.equal(liveB.sent.length, 1);
  await assert.rejects(f.controller.relay({ ...input, chatId: 'oc_team' }), /绑定已变化|印记/);
  await assert.rejects(f.controller.relay({ ...input, key: 'different', chatId: 'oc_unapproved' }), /双方明确配置/);
  assert.equal(b.bot.requireConfirmation, true);
});

test('relay rejects forged event keys, forged or unprocessed parents, loops and expired chains', async t => {
  const f = fixture(t), { a, b, input } = await collaborators(f, true);
  const forged = await f.mailboxes.put({ direction: 'inbox', botId: b.bot.id, scope: b.bot.scope, eventKey: 'feishu-a2a:forged', title: 'fake', text: 'fake', requiresConfirmation: false });
  await assert.rejects(f.controller.dispatchInbox(forged), /印记/);
  await assert.rejects(f.controller.relay({ ...input, parentEntryId: forged.id }), /真实信件/);
  const pending = await f.controller.relay(input);
  await assert.rejects(f.controller.relay({ sourceBotId: b.bot.id, targetBotId: a.bot.id, text: 'back', key: 'pending-parent', parentEntryId: pending.id }), /尚未真实派发/);
  await f.mailboxes.process(pending.id, pending.version);
  await assert.rejects(f.controller.relay({ sourceBotId: b.bot.id, targetBotId: a.bot.id, text: 'back', key: 'loop', parentEntryId: pending.id }), /路径/);
  const stamp = f.store.get<Record<string, any>>('feishu.bot.envelopes', pending.id)!;
  f.store.put('feishu.bot.envelopes', pending.id, { ...stamp, relay: { ...stamp.relay, expiresAt: Date.now() - 1 } });
  await assert.rejects(f.controller.relay(input), /过期/);
});

test('relay mutual opt-in, paired state and project/task boundaries are mandatory', async t => {
  const f = fixture(t), a = await f.add('ScopeA'), b = await f.add('ScopeB');
  const input = { sourceBotId: a.bot.id, targetBotId: b.bot.id, text: 'scope', key: 'scope' };
  await assert.rejects(f.controller.relay(input), /未配对/);
  await a.pair(); await b.pair();
  await f.controller.update(a.bot.id, { collaboration: { peerBotIds: [b.bot.id] } });
  await assert.rejects(f.controller.relay(input), /互相授权/);
  await f.controller.update(b.bot.id, { collaboration: { peerBotIds: [a.bot.id] } });
  f.store.put('projects', 'p', { id: 'p' }); f.store.put('projects', 'q', { id: 'q' });
  await f.controller.update(a.bot.id, { scope: { kind: 'project', projectId: 'p' } });
  await f.controller.update(b.bot.id, { scope: { kind: 'project', projectId: 'q' } });
  await assert.rejects(f.controller.relay(input), /作用域/);
  await f.controller.update(b.bot.id, { scope: { kind: 'project', projectId: 'p' } });
  assert.equal((await f.controller.relay(input)).status, 'completed');
  f.store.put('todos', 'one', { id: 'one', projectId: 'p' }); f.store.put('todos', 'two', { id: 'two', projectId: 'p' });
  await f.controller.update(a.bot.id, { scope: { kind: 'task', todoId: 'one', projectId: 'p' } });
  await f.controller.update(b.bot.id, { scope: { kind: 'task', todoId: 'two', projectId: 'p' } });
  await assert.rejects(f.controller.relay({ ...input, key: 'tasks' }), /作用域/);
  await f.controller.update(a.bot.id, { scope: { kind: 'unmarked' } });
  await assert.rejects(f.controller.relay({ ...input, key: 'unmarked' }), /作用域/);
});

test('relay unknown dispatch persists across restart without automatic replay', async t => {
  const f = fixture(t), { input } = await collaborators(f);
  f.postFail(); await assert.rejects(f.controller.relay(input), /post failed/);
  const entry = f.mailboxes.list().find(e => e.eventKey.startsWith('feishu-a2a:'))!;
  assert.equal(entry.status, 'unknown');
  await f.restart();
  assert.equal((await f.controller.relay(input)).status, 'unknown');
  assert.equal(f.posts.length, 0);
});

test('relay preserves root expiry across eight identities, rejects ninth hop and inherits parent scope', async t => {
  const f = fixture(t);
  const bots = [];
  for (let i = 0; i < 9; i++) { const bot = await f.add(`Hop${i}`); await bot.pair(); bots.push(bot); }
  for (const bot of bots) await f.controller.update(bot.bot.id, { collaboration: { peerBotIds: bots.filter(peer => peer !== bot).map(peer => peer.bot.id) } });
  let parent: MailboxEntry | undefined;
  let root: { rootId: string; expiresAt: number } | undefined;
  for (let i = 0; i < 7; i++) {
    parent = await f.controller.relay({ sourceBotId: bots[i].bot.id, targetBotId: bots[i + 1].bot.id, text: 'hop', key: `hop-${i}`, parentEntryId: parent?.id });
    const stamp = f.store.get<Record<string, any>>('feishu.bot.envelopes', parent.id)!;
    if (!root) root = stamp.relay;
    assert.equal(stamp.relay.rootId, root!.rootId); assert.equal(stamp.relay.expiresAt, root!.expiresAt);
    assert.equal(stamp.relay.path.length, i + 2);
  }
  assert.equal(f.posts.length, 7);
  await assert.rejects(f.controller.relay({ sourceBotId: bots[7].bot.id, targetBotId: bots[8].bot.id, text: 'too far', key: 'ninth', parentEntryId: parent!.id }), /8 个机器人/);
  f.store.put('projects', 'narrow', { id: 'narrow' });
  const sourceBot = bots[0], targetBot = bots[1];
  const collected = await f.mailboxes.put({ direction: 'inbox', botId: sourceBot.bot.id, scope: { kind: 'project', projectId: 'narrow' }, eventKey: 'feishu-collect:narrow', title: 'narrow', text: 'narrow', requiresConfirmation: false });
  // Global bot bindings cannot be used as a parent with a fabricated narrower scope.
  await assert.rejects(f.controller.dispatchInbox(collected), /绑定已变化/);
  await assert.rejects(f.controller.relay({ sourceBotId: sourceBot.bot.id, targetBotId: targetBot.bot.id, text: 'widen', key: 'widen', parentEntryId: collected.id }), /尚未真实派发/);
});

test('group pending inbox cannot run after membership removal and thread replies survive controller restart', async t => {
  const f = fixture(t), a = await f.add('PendingGroup', { kind: 'global' }, true, { groupChats: groups }); await a.pair();
  await a.instance.options.onMessage('pending team', groupSource('pending-group'));
  const first = f.mailboxes.list().find(e => e.direction === 'inbox')!;
  await f.controller.update(a.bot.id, { groupChats: [] });
  await assert.rejects(async () => f.mailboxes.process(first.id, first.version), /绑定已变化/);
  await f.controller.update(a.bot.id, { groupChats: groups });
  await f.instances.at(-1)!.options.onMessage('new team', groupSource('new-group'));
  const second = f.mailboxes.list().find(e => e.sourceMessageId === 'new-group' && e.direction === 'inbox')!;
  await f.mailboxes.process(second.id, second.version);
  await f.restart(); f.reply(f.posts[0].id); await tick();
  assert.deepEqual(f.instances.at(-1)!.sent, [['oc_team', 'answer-reply-input-0']]);
  const { onSent, ...thread } = f.instances.at(-1)!.contexts.at(-1)!;
  assert.equal(typeof onSent, 'function');
  assert.deepEqual(thread, { replyTo: 'new-group', threadId: 'thread-team' });
});

test('group-origin relay preserves the approved thread and both sides can revoke its reply', async t => {
  const f = fixture(t), { a, b, input } = await collaborators(f);
  const liveA = f.instances.find(instance => !instance.closed && instance.options.appId === a.bot.appId)!;
  await liveA.options.onMessage('group task', groupSource('relay-group-parent'));
  const parent = f.mailboxes.list().find(e => e.direction === 'inbox')!;
  const relay = await f.controller.relay({ ...input, parentEntryId: parent.id, chatId: 'oc_team' });
  const relayPost = f.posts.find(post => post.botId === b.bot.id)!;
  const liveB = f.instances.find(instance => !instance.closed && instance.options.appId === b.bot.appId)!;
  f.reply(relayPost.id); await tick();
  assert.deepEqual(liveB.sent, [['oc_team', `answer-reply-${relayPost.id}`]]);
  assert.deepEqual(liveB.contexts.at(-1), { replyTo: 'relay-group-parent', threadId: 'thread-team' });
  await f.controller.update(b.bot.id, { groupChats: [] });
  f.reply(relayPost.id, 'revoked-target'); await tick();
  assert.deepEqual(f.instances.at(-1)!.sent, []);
  assert.equal(relay.status, 'completed');
});

test('real durable inbox relay confirms once and remains internal on acceptance and run results', async t => {
  const f = fixture(t), mailboxes = createEventMailboxes({ store: f.store, events: f.events });
  f.app.mailboxes = mailboxes;
  mailboxes.setHandlers({ inbox: entry => f.controller.dispatchInbox(entry), outbox: entry => f.controller.send(entry.botId, entry.target!, entry.text, entry.eventKey) });
  const { input } = await collaborators(f, true);
  const pending = await f.controller.relay(input);
  assert.equal(pending.status, 'pending');
  const confirmed = await mailboxes.confirm(pending.id, pending.version);
  assert.equal(confirmed.status, 'completed'); assert.equal(f.posts.length, 1);
  assert.equal((await f.controller.relay(input)).id, pending.id);
  f.reply(f.posts[0].id); f.reply(f.posts[0].id, 'run-relay', 'result'); await tick();
  assert.ok(f.instances.every(instance => instance.sent.length === 0));
  assert.equal(mailboxes.list({ direction: 'outbox' }).filter(entry => entry.replyTo).length, 0);
  await mailboxes.close();
});

// Fake host enforces the readOnly boundary; the controller only supplies result context.
function resultHost(f: ReturnType<typeof fixture>) {
  const accepted: Array<Parameters<NonNullable<FeishuBotsApp['postScopedResult']>>[0] & { id: string }> = [];
  f.app.postScopedResult = async input => {
    const id = `result-input-${accepted.length}`;
    accepted.push({ ...input, id });
    const message: Message = { id, text: input.text, role: 'user', readOnly: true, origin: 'result', replyTo: input.sourceMessageId,
      conversationId: botConversationId({ id: input.botId, scope: input.scope }), createdAt: '' };
    f.store.put('messages', id, message); return message;
  };
  return accepted;
}
function originalInput(f: ReturnType<typeof fixture>, botId: string, scope: BotScope, id = 'original', conversationId = botConversationId({ id: botId, scope })) {
  const message: Message = { id, text: 'original task', role: 'user', conversationId, createdAt: '' };
  f.store.put('messages', id, message); return message;
}

test('durable pending and ready relays return readOnly results once per assistant id across native events and restart', async t => {
  for (const confirmation of [false, true]) {
    const f = fixture(t), mailboxes = createEventMailboxes({ store: f.store, events: f.events });
    f.app.mailboxes = mailboxes;
    mailboxes.setHandlers({ inbox: entry => f.controller.dispatchInbox(entry), outbox: entry => f.controller.send(entry.botId, entry.target!, entry.text, entry.eventKey) });
    const accepted = resultHost(f), { a, b, input } = await collaborators(f, confirmation);
    originalInput(f, a.bot.id, a.bot.scope);
    const entry = await f.controller.relay({ ...input, sourceMessageId: 'original' });
    assert.equal(entry.status, confirmation ? 'pending' : 'completed');
    if (confirmation) await mailboxes.confirm(entry.id, entry.version);
    f.reply(f.posts[0].id, 'first'); f.reply(f.posts[0].id, 'first', 'result'); await tick();
    assert.equal(accepted.length, 1); assert.equal(accepted[0].botId, a.bot.id);
    assert.equal(accepted[0].sourceMessageId, 'original');
    assert.equal(f.store.get<Message>('messages', accepted[0].id)!.readOnly, true);
    assert.match(accepted[0].text, /协作回报（执行结果和待办验收分开）/);
    assert.ok(accepted[0].text.includes(entry.id)); assert.ok(accepted[0].text.includes(b.bot.id));
    await f.restart(); f.reply(f.posts[0].id, 'first', 'result'); f.reply(f.posts[0].id, 'second', 'result'); await tick();
    assert.equal(accepted.length, 2);
    f.store.put('messages', 'failed', { id: 'failed', role: 'assistant', replyTo: f.posts[0].id, conversationId: '', createdAt: '', status: 'failed', text: 'x'.repeat(20000) } satisfies Message);
    f.events.publish('runs.result', { messageId: 'failed' }); await tick();
    assert.equal(accepted.length, 3); assert.ok(accepted[2].text.length < 14000);
    assert.ok(f.instances.every(instance => instance.sent.length === 0));
    assert.equal(mailboxes.list({ direction: 'outbox' }).filter(entry => entry.replyTo).length, 0);
    assert.equal(f.store.list<{ status: string }>('feishu.bot.results').filter(row => row.status === 'completed').length, 3);
    await mailboxes.close();
  }
});

test('result inherits only the initiating group thread, and target revocation blocks its later summary', async t => {
  const f = fixture(t), accepted = resultHost(f), { a, b, input } = await collaborators(f);
  const liveA = f.instances.find(instance => !instance.closed && instance.options.appId === a.bot.appId)!;
  await liveA.options.onMessage('group task', groupSource('result-origin'));
  const parent = f.mailboxes.list().find(entry => entry.direction === 'inbox')!;
  const entry = await f.controller.relay({ ...input, parentEntryId: parent.id, sourceMessageId: parent.resultId });
  f.reply(f.posts.find(post => post.botId === b.bot.id)!.id); await tick();
  assert.equal(accepted.length, 1);
  const inherited = f.store.get<Record<string, unknown>>('message.routes', accepted[0].id)!;
  assert.equal(inherited.inputId, parent.resultId); assert.equal(inherited.resultRelayEntryId, entry.id);
  assert.equal(inherited.platformReplyTo, 'result-origin'); assert.equal(inherited.threadId, 'thread-team');
  assert.equal(liveA.sent.length, 0);
  f.reply(accepted[0].id, 'summary'); await tick();
  assert.deepEqual(liveA.sent, [['oc_team', 'answer-summary']]);
  assert.deepEqual(liveA.contexts.at(-1), { replyTo: 'result-origin', threadId: 'thread-team' });
  await f.controller.update(b.bot.id, { enabled: false });
  f.reply(accepted[0].id, 'late-summary'); await tick(); assert.equal(liveA.sent.length, 1);
});

test('global to project returns follow the original delegation and internal origins never guess a recipient', async t => {
  const f = fixture(t), accepted = resultHost(f), { a, b, input } = await collaborators(f);
  f.store.put('projects', 'return-project', { id: 'return-project' });
  await f.controller.update(b.bot.id, { scope: { kind: 'project', projectId: 'return-project' } });
  originalInput(f, a.bot.id, a.bot.scope);
  await f.controller.relay({ ...input, sourceMessageId: 'original' });
  f.reply(f.posts[0].id); await tick(); assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].scope, { kind: 'global' });
  assert.equal(f.store.get('message.routes', accepted[0].id), undefined);
  await assert.rejects(f.controller.relay({ ...input, key: 'no-result-loop', sourceMessageId: accepted[0].id }), /来源/);
  f.reply(accepted[0].id); await tick(); assert.ok(f.instances.every(instance => instance.sent.length === 0));
});

test('relay validates source role, canonical conversation, global main exception, parent and key provenance', async t => {
  const f = fixture(t), { a, b, input } = await collaborators(f);
  await assert.rejects(f.controller.relay({ ...input, sourceMessageId: 'missing' }), /来源/);
  originalInput(f, b.bot.id, b.bot.scope, 'other');
  await assert.rejects(f.controller.relay({ ...input, sourceMessageId: 'other' }), /来源/);
  const bad = originalInput(f, a.bot.id, a.bot.scope, 'assistant');
  f.store.put('messages', bad.id, { ...bad, role: 'assistant' });
  await assert.rejects(f.controller.relay({ ...input, sourceMessageId: bad.id }), /来源/);
  originalInput(f, a.bot.id, a.bot.scope, 'main-source', 'main');
  await f.controller.relay({ ...input, sourceMessageId: 'main-source' });
  await assert.rejects(f.controller.relay({ ...input, sourceMessageId: 'other' }), (error: any) => error.statusCode === 409);
  f.store.put('projects', 'p-main', { id: 'p-main' });
  for (const bot of [a, b]) await f.controller.update(bot.bot.id, { scope: { kind: 'project', projectId: 'p-main' } });
  await assert.rejects(f.controller.relay({ ...input, key: 'project-main', sourceMessageId: 'main-source' }), /来源/);
  originalInput(f, a.bot.id, { kind: 'project', projectId: 'p-main' }, 'canonical');
  const live = f.instances.find(instance => !instance.closed && instance.options.appId === a.bot.appId)!;
  await live.options.onMessage('parent', groupSource('source-parent'));
  const parent = f.mailboxes.list().find(entry => entry.sourceMessageId === 'source-parent')!;
  await assert.rejects(f.controller.relay({ ...input, key: 'mismatch', parentEntryId: parent.id, sourceMessageId: 'canonical' }), /父条目不匹配/);
});

test('result rejects modified input, either rebind, revoked group and expired relay without posting', async t => {
  for (const change of ['source', 'target', 'expired', 'edited', 'group', 'mailbox'] as const) {
    const f = fixture(t), accepted = resultHost(f), { a, b, input } = await collaborators(f);
    const live = f.instances.find(instance => !instance.closed && instance.options.appId === a.bot.appId)!;
    await live.options.onMessage('task', groupSource('revocable-origin'));
    const parent = f.mailboxes.list().find(entry => entry.direction === 'inbox')!;
    const entry = await f.controller.relay({ ...input, parentEntryId: parent.id, sourceMessageId: parent.resultId });
    if (change === 'source' || change === 'target') await f.controller.update(change === 'source' ? a.bot.id : b.bot.id, { executorId: 'changed' });
    if (change === 'group') await f.controller.update(a.bot.id, { groupChats: [] });
    if (change === 'expired') {
      const stamp = f.store.get<Record<string, any>>('feishu.bot.envelopes', entry.id)!;
      f.store.put('feishu.bot.envelopes', entry.id, { ...stamp, relay: { ...stamp.relay, expiresAt: Date.now() - 1 } });
    }
    if (change === 'edited') f.store.put('messages', parent.resultId!, { ...f.store.get<Message>('messages', parent.resultId!)!, text: 'edited task' });
    if (change === 'mailbox') f.store.put('test.mailboxes', entry.id, { ...entry, text: 'edited delegation' });
    f.reply(f.posts.find(post => post.botId === b.bot.id)!.id); await tick();
    assert.equal(accepted.length, 0, change);
    assert.ok(f.instances.every(instance => instance.sent.length === 0), change);
  }
});

test('result callback uncertainty is visible and never retried after duplicate events or restart', async t => {
  const f = fixture(t), { input } = await collaborators(f);
  let calls = 0;
  f.app.postScopedResult = async () => { calls++; throw new Error('result post uncertain'); };
  await f.controller.relay(input);
  f.reply(f.posts[0].id, 'uncertain-result', 'result'); await tick();
  assert.equal(calls, 1);
  const receipt = f.store.list<{ status: string; error: string }>('feishu.bot.results')[0];
  assert.equal(receipt.status, 'unknown'); assert.match(receipt.error, /uncertain/);
  assert.ok(f.events.since(0).some(event => event.type === 'collaboration.result' && (event.data as any).status === 'unknown'));
  await f.restart(); f.reply(f.posts[0].id, 'uncertain-result', 'result'); await tick(); assert.equal(calls, 1);
});

test('legacy host publishes referenced unavailable result without claiming injection or sending', async t => {
  const f = fixture(t), { input } = await collaborators(f);
  const relay = await f.controller.relay(input);
  f.reply(f.posts[0].id, 'legacy-result', 'result'); await tick();
  const results = f.events.since(0).filter(event => event.type === 'collaboration.result');
  assert.equal(results.length, 1); assert.equal((results[0].data as any).relayEntryId, relay.id);
  assert.equal((results[0].data as any).status, 'unavailable');
  assert.equal(f.posts.length, 1); assert.ok(f.instances.every(instance => instance.sent.length === 0));
});

test('nested results climb the existing parent relay through readOnly summaries without making new requests', async t => {
  const f = fixture(t), accepted = resultHost(f), { a, b, input } = await collaborators(f);
  const c = await f.add('RelayC'); await c.pair();
  await f.controller.update(b.bot.id, { collaboration: { peerBotIds: [a.bot.id, c.bot.id] } });
  await f.controller.update(c.bot.id, { collaboration: { peerBotIds: [b.bot.id] } });
  const first = await f.controller.relay(input);
  const second = await f.controller.relay({ sourceBotId: b.bot.id, targetBotId: c.bot.id, text: 'sub work', key: 'sub', parentEntryId: first.id, sourceMessageId: first.resultId });
  f.reply(second.resultId!, 'c-result'); await tick();
  assert.equal(accepted.length, 1); assert.equal(accepted[0].botId, b.bot.id);
  f.reply(accepted[0].id, 'b-summary'); await tick();
  assert.equal(accepted.length, 2); assert.equal(accepted[1].botId, a.bot.id);
  assert.equal(f.posts.length, 2);
});

test('a source turn settling from pending to done preserves delegated result provenance', async t => {
 const f=fixture(t), accepted=resultHost(f), {a,input}=await collaborators(f);
 const source=originalInput(f,a.bot.id,a.bot.scope);f.store.put('messages',source.id,{...source,status:'pending'});
 const relay=await f.controller.relay({...input,sourceMessageId:source.id});assert.equal(relay.status,'completed');
 f.store.put('messages',source.id,{...source,status:'done'});
 f.reply(f.posts[0].id,'after-source-turn','result');await tick();assert.equal(accepted.length,1);
 assert.equal(accepted[0].sourceMessageId,source.id);
 assert.equal(f.store.list<{status:string}>('feishu.bot.results')[0].status,'completed');
});

test('accepted group input loses runtime access immediately after member or binding revocation', async t => {
  const f = fixture(t), a = await f.add('RuntimeGroup', { kind: 'global' }, false, { groupChats: groups });
  assert.equal(f.controller.canUseScope(a.bot.scope, a.bot.id), false);
  await a.pair();
  await a.instance.options.onMessage('work', groupSource('runtime-group'));
  const input = f.store.get<Message>('messages', f.posts[0].id)!;
  assert.equal(f.controller.canUseScope(a.bot.scope, a.bot.id, input), true);
  assert.equal(f.controller.canUseScope(a.bot.scope, a.bot.id, { ...input, id: 'forged' }), false);
  await f.controller.update(a.bot.id, { groupChats: [{ ...groups[0], allowedSenderIds: [] }] });
  assert.equal(f.controller.canUseScope(a.bot.scope, a.bot.id, input), false);
  // Re-granting membership cannot revive an input accepted under an old revision.
  await f.controller.update(a.bot.id, { groupChats: groups });
  assert.equal(f.controller.canUseScope(a.bot.scope, a.bot.id, input), false);
});

test('assigned unmarked input keeps its exact scope and stops when its task moves project', async t => {
  const f = fixture(t);
  f.store.put('projects', 'p', { id: 'p' }); f.store.put('projects', 'q', { id: 'q' });
  f.store.put('todos', 'task', { id: 'task', projectId: 'p' });
  const a = await f.add('Assigned', { kind: 'unmarked' }); await a.pair();
  await a.instance.options.onMessage('classify first', source('assigned'));
  const entry = f.mailboxes.list().find(row => row.direction === 'inbox')!, scope: BotScope = { kind: 'task', todoId: 'task', projectId: 'p' };
  f.store.put('test.mailboxes', entry.id, { ...entry, scope });
  await f.mailboxes.process(entry.id, entry.version);
  const input = f.store.get<Message>('messages', f.posts[0].id)!;
  assert.equal(f.controller.canUseScope(scope, a.bot.id, input), true);
  assert.equal(f.controller.canUseScope({ kind: 'global' }, a.bot.id, input), false);
  f.store.put('todos', 'task', { id: 'task', projectId: 'q' });
  assert.equal(f.controller.canUseScope(scope, a.bot.id, input), false);
  assert.equal(f.controller.canUseScope({ kind: 'task', todoId: 'task' }, a.bot.id), false);
  assert.equal(f.store.list('projects').length, 2);
});

test('internal readOnly result requires its durable receipt and the original live delegation', async t => {
  const f = fixture(t), accepted = resultHost(f), { a, b, input } = await collaborators(f);
  originalInput(f, a.bot.id, a.bot.scope, 'web-source', 'main');
  await f.controller.relay({ ...input, sourceMessageId: 'web-source' });
  f.reply(f.posts[0].id, 'runtime-return'); await tick();
  const message = f.store.get<Message>('messages', accepted[0].id)!;
  assert.equal(f.store.get('message.routes', message.id), undefined);
  assert.equal(f.controller.canUseScope(a.bot.scope, a.bot.id, message), true);
  const forged = { ...message, id: 'fake-readonly' };
  f.store.put('messages', forged.id, forged);
  assert.equal(f.controller.canUseScope(a.bot.scope, a.bot.id, forged), false);
  await f.controller.update(b.bot.id, { enabled: false });
  assert.equal(f.controller.canUseScope(a.bot.scope, a.bot.id, message), false);
});

test('owner card buttons page current facts, survive restart and reject forwarding, expiry and rebinding', async t=>{
 const f=fixture(t),a=await f.add('CardNavigation',{kind:'global'},true);await a.pair();
 for(let n=0;n<7;n++)f.store.put('inbox','card-inbox-'+n,{id:'card-inbox-'+n,title:'待处理来信'+n,text:'本地内容'+n,source:'controlled',tier:'action',updatedAt:'2026-11-20'});
 await a.instance.options.onMessage('工作台',source('navigate'));
 const card=a.instance.contexts.at(-1)!.card as any;
 const actions=card.elements.filter((e:any)=>e.tag==='action').flatMap((e:any)=>e.actions);
 const value=actions.find((a:any)=>a.value?.view==='inbox').value;
 const press=(patch:Record<string,unknown>={})=>f.instances.at(-1)!.options.onCardAction!({operatorId:'human',chatId:'owner',messageId:'platform-card',value,...patch});
 const response=press() as any;assert.equal(response.card.type,'raw');
 await f.restart();assert.equal((press() as any).card.type,'raw','navigation grant survives controller restart');
 assert.match(JSON.stringify(response.card),/待处理来信0/);assert.doesNotMatch(JSON.stringify(response.card),/待处理来信6/);
 const next=response.card.data.elements.filter((e:any)=>e.tag==='action').flatMap((e:any)=>e.actions).find((a:any)=>a.text.content==='下一页').value;
 assert.match(JSON.stringify(press({value:next})),/待处理来信6/);
 f.store.remove('inbox','card-inbox-6');assert.doesNotMatch(JSON.stringify(press({value:next})),/待处理来信6/);
 for(const patch of [{operatorId:'intruder'},{chatId:'forwarded-chat'},{messageId:''},{value:{...value,page:-1}},{value:{...value,view:'approve'}},{value:{...value,navigation:'forged'}}])assert.equal('card' in press(patch),false);
 assert.equal(f.posts.length,0);assert.equal(f.mailboxes.list().filter(e=>e.direction==='outbox').length,2,'pairing and initial dashboard only; navigation never sends a new message');
 await f.controller.update(a.bot.id,{name:'RenamedCardNavigation'});assert.equal('card' in press(),false);
 const latest=f.instances.at(-1)!;await latest.options.onMessage('工作台',source('fresh-nav'));
 const latestCard=latest.contexts.at(-1)!.card as any;
 const fresh=latestCard.elements.filter((e:any)=>e.tag==='action').flatMap((e:any)=>e.actions).find((a:any)=>a.value?.view==='home').value;
 const cap=f.store.get<any>('feishu.card.navigation',fresh.navigation)!;f.store.put('feishu.card.navigation',fresh.navigation,{...cap,expiresAt:0});
 assert.equal('card' in latest.options.onCardAction!({operatorId:'human',chatId:'owner',messageId:'platform-card',value:fresh}),false);
});

test('主人选项目、切回主 Agent 后，引用原卡仍进入原项目并在原话题返回',async t=>{
 const f=fixture(t), a=await f.add('ProjectCard',{kind:'global'});await a.pair();
 f.store.put('projects','p',{id:'p',name:'项目 P'});
 const projectInputs:string[]=[];
 f.app.projectWorkspace={async post(projectId,text){
   projectInputs.push(text);return {id:'p-'+projectInputs.length,role:'user',text,createdAt:'',conversationId:'project:'+projectId+':work'};
 }};
 await a.instance.options.onMessage('工作台',source('dash'));
 const card=a.instance.contexts.at(-1)!.card as any;
 const actions=card.elements.flatMap((el:any)=>el.actions??[]).filter((a:any)=>a.value?.kind==='workbench.chat');
 const press=(projectId:string,messageId:string,operatorId='human')=>a.instance.options.onCardAction!({chatId:'owner',operatorId,messageId,value:actions.find((a:any)=>a.value.projectId===projectId).value}) as any;
 assert.notEqual(press('p','card-project','other').toast.type,'success');
 assert.equal(press('p','card-project').toast.type,'success');
 await a.instance.options.onMessage('第一问',source('question'));
 assert.deepEqual(projectInputs,['第一问']);
 assert.equal(press('','card-main').toast.type,'success');
 await a.instance.options.onMessage('普通提问',source('main-q'));
 assert.equal(f.posts.at(-1)?.text,'普通提问');
 await a.instance.options.onMessage('跟进',{...source('follow'),parentId:'card-project',rootId:'card-project'});
 assert.deepEqual(projectInputs,['第一问','跟进']);
 f.reply('p-2');await tick();
 assert.equal(a.instance.contexts.at(-1)?.replyTo,'follow');
 assert.equal(a.instance.contexts.at(-1)?.threadId,'card-project');
 f.store.put('projects','p',{id:'p',name:'P',archivedAt:'today'});
 await a.instance.options.onMessage('归档后的追问',{...source('archived'),parentId:'card-project'});
 assert.equal(projectInputs.length,2);
 assert.match(a.instance.sent.at(-1)![1],/重新选择/);
});

test('CLI 会话卡限定主人，读取与重复回调只发送一张，分页跨重启',async t=>{
  const f=fixture(t), a=await f.add('NativeCard',{kind:'global'});await a.pair();
  let scans=0; const proposals: Record<string,unknown>[] = [];
  f.app.agentSessions={ async discover() {
    scans++;
    return {capturedAt:'2026-11-20',machines:[{machineId:'machine',machineName:'测试电脑',truncated:true,sessions:Array.from({length:7},(_,i)=>({
      executorId:'codex',nativeSessionId:'native-'+i,cwd:'/tmp/project',resumable:i===0,
    }))}]};
  }, async proposeResume(input) { proposals.push(input); return {id:"approval-fixture",status:"pending"}; }};
  await a.instance.options.onMessage('工作台',source('dashboard'));
  const buttons=(card:any)=>card.elements.flatMap((row:any)=>row.actions??[]);
  const value=buttons(a.instance.contexts.at(-1)?.card).find((b:any)=>b.value?.kind==='workbench.readSessions').value;
  const click=(value:Record<string,unknown>,id='human',formValue?:Record<string,unknown>)=>f.instances.at(-1)!.options.onCardAction!({operatorId:id,chatId:'owner',messageId:'source-card',value,formValue}) as any;
  click(value,'other');assert.equal(scans,0);
  click(value);click(value);
  for(let n=0;n<25 && !a.instance.sent.some(s=>s[1].includes('本次发现'));n++)await tick();
  assert.equal(scans,1);
  const card=a.instance.contexts.at(-1)!.card;
  assert.match(JSON.stringify(card),/native-0/);assert.doesNotMatch(JSON.stringify(card),/native-6/);
  const open=buttons(card).find((b:any)=>b.text.content==='申请恢复').value;
  assert.equal(click(open,'other').card,undefined);
  const form=click(open).card.data.body.elements.find((el:any)=>el.tag==='form');
  const submit=form.elements.find((el:any)=>el.form_action_type==='submit').behaviors[0].value;
  assert.equal(click(submit).toast.type,'error');
  assert.ok(form.elements.filter((el:any)=>el.tag==='input').every((el:any)=>el.max_length===1000));
  const fields={prompt:'继续检查',doneWhen:'所有测试通过',minutes:'10',stopped:'已停止',machineId:'forged'};
  assert.equal(click(submit,'human',{...fields,prompt:'长'.repeat(1001)}).toast.type,'error');
  click(submit,'other',fields);assert.equal(proposals.length,0);
  click(submit,'human',fields);click(submit,'human',fields);
  await tick();
  assert.equal(proposals.length,1); assert.equal(proposals[0].machineId,'machine');
  assert.equal(proposals[0].nativeSessionId,'native-0');
  assert.match(a.instance.sent.at(-1)![1],/approval-fixture.*已提交/);
  const next=buttons(card).find((b:any)=>b.text.content==='下一页').value;
  await f.restart();
  assert.match(JSON.stringify(click(next).card),/native-6/);
  assert.equal(click(next,'other').card,undefined);
  assert.equal(f.posts.length,0);
});

test('主人在工作台回答真实问题，保留版本检查和执行机送达回执', async t => {
  const f = fixture(t), bot = await f.add('Questions');
  await bot.pair();
  const delivered: string[] = [];
  const service = createInteractions({store:f.store, events:f.events, decide:()=>({handler:'user',layer:'default'}),
    answer:async (_,answer)=>{ delivered.push(answer); throw Object.assign(new Error('超时'),{delivery:'unknown'}); }});
  f.app.interactions = service;
  const q = service.open({kind:'question',title:'选择版本',body:'要验收哪个版本？'});
  const perm = service.open({kind:'permission',title:'执行授权',body:'允许执行？'});
  await bot.instance.options.onMessage('工作台',source('questions'));
  const actions = (card:any) => card.elements.flatMap((row:any)=>row.actions??[]);
  const list = actions(bot.instance.contexts.at(-1)?.card).find((b:any)=>b.value?.view==='questions').value;
  const click = (value:Record<string,unknown>, formValue?:Record<string,unknown>, operatorId='human') =>
    bot.instance.options.onCardAction!({operatorId,chatId:'owner',messageId:'om-dashboard',value,formValue}) as any;
  const page = click(list).card.data;
  assert.doesNotMatch(JSON.stringify(page),/执行授权/);
  const open = actions(page).find((b:any)=>b.value?.kind==='workbench.questionForm').value;
  assert.equal(click(open,undefined,'another').card,undefined);
  assert.equal(click({...open,id:perm.id}).card,undefined);
  const form = click(open).card.data.body.elements;
  assert.match(JSON.stringify(form),/要验收哪个版本/);
  await bot.instance.options.onMessage('开始验收',source('origin'));
  const input = f.posts.at(-1)!;
  f.store.put('interaction-origins',q.id,{inputId:input.id});
  f.reply(input.id,'interaction-notice:'+q.id,'notification');
  await tick();
  const notice = bot.instance.contexts.at(-1);
  assert.match(JSON.stringify(notice?.card),/submit_answer/);
  assert.equal(notice?.replyTo,'origin');
  const submit = form.find((e:any)=>e.tag==='form').elements[1].behaviors[0].value;
  assert.equal(form.find((el:any)=>el.tag==='form').elements[0].max_length,1000);
  assert.equal(click(submit,{answer:'长'.repeat(1001)}).toast.type,'error');
  assert.equal(click(submit,{answer:' '}).toast.type,'error');
  click(submit,{answer:'版本 A'});
  assert.match(click(submit,{answer:'版本 B'}).toast.content,/已变化/);
  await tick();
  assert.deepEqual(delivered,['版本 A']);
  assert.match(bot.instance.sent.at(-1)![1],/送达结果待核对/);
  assert.equal(f.store.get<{answeredBy:string}>('interactions',q.id)?.answeredBy,'user_feishu');
  assert.equal(f.posts.length,1);
  await service.close();
});

test('飞书主人私聊 /today 和主页按钮读取今日简报，去重并报告未授权日历与停用状态', async t => {
  const f = fixture(t), bot = await f.add('TodayBrief', { kind: 'global' }, true);
  const stamp = '2026-03-01T12:30:00.000Z';
  const completed = { id: 'today-done', title: '已核对合成回执', notes: '', createdAt: stamp, updatedAt: stamp, completedAt: stamp };
  f.store.put('todos', completed.id, completed);
  const plugins = f.app.plugins!;
  const list = plugins.list;
  let enabled = true, reads = 0, calendarReady = false;
  plugins.list = () => [...list(), { id: 'daily-brief', status: enabled ? 'active' : 'disabled', enabled }];
  plugins.invocations!.use = async (name, input) => {
    reads++;
    assert.equal(name, 'daily-brief.today');
    assert.deepEqual(input, {});
    return readTodayBrief(f.store, {
      todayBriefSources: () => ({ timezone: 'Asia/Shanghai', calendarIdentity: calendarReady ? 'local-calendar' : undefined,
        decisions: [], inbox: [] }),
      calendarAgenda: async () => ({ available: true, events: [{ eventId: 'local-all-day', summary: '合成全天安排',
        startTime: '2026-03-01', endTime: '2026-03-02' }] }),
    }, input, new AbortController().signal, Date.parse(stamp));
  };
  const receive = bot.instance.options.onMessage;
  const human = (id: string) => ({ ...source(id), senderType: 'user' as const });
  await receive('/today', human('unpaired'));
  await bot.pair();
  await receive('/今日', { ...human('foreign'), senderId: 'unrelated' });
  await receive('/今天', { ...human('group'), chatType: 'group' });
  await receive('/today', { ...human('bot'), senderType: 'bot' });
  assert.equal(reads, 0);
  const event = human('today-message');
  await Promise.all([receive('/today', event), receive('/today', event)]);
  assert.equal(reads, 1);
  assert.equal(bot.instance.sent.length, 1);
  const [target, fallback] = bot.instance.sent[0]!;
  assert.equal(target, 'owner');
  for (const detail of [fallback, JSON.stringify(bot.instance.contexts.at(-1)?.card)]) {
    assert.match(detail, /今日简报/);
    assert.match(detail, /2026-03-01/);
    assert.match(detail, /Asia\/Shanghai/);
    assert.ok(detail.includes(completed.title));
    assert.match(detail, /来源不可用/);
  }
  type Button = { text: { content: string }; value: Record<string, unknown> };
  const button = (card: unknown, label: string) => {
    const { elements } = card as { elements: Array<{ actions?: Button[] }> };
    const match = elements.flatMap(row => row.actions ?? []).find(row => row.text.content === label);
    assert.ok(match);
    return match.value;
  };
  const click = (value: Record<string, unknown>, operatorId = 'human') => bot.instance.options.onCardAction!({
    value, operatorId, chatId: 'owner', messageId: 'local-platform-card',
  });
  const home = click(button(bot.instance.contexts.at(-1)?.card, '返回工作台')) as {card: {data:unknown}};
  const refresh = button(home.card.data, '今日简报');
  click(refresh, 'unrelated');
  assert.equal(reads, 1);
  f.store.put('todos', completed.id, { ...completed, title: '新的合成验收标题' });
  calendarReady = true;
  click(refresh);
  await t.waitFor(() => assert.equal(bot.instance.sent.length, 2));
  const refreshed = bot.instance.sent.at(-1)![1];
  assert.match(refreshed, /新的合成验收标题/);
  assert.match(refreshed, /全天[^\n]*合成全天安排/);
  assert.doesNotMatch(refreshed, /08:00/);
  assert.equal(reads, 2);

  enabled = false;
  await receive('/今天', human('disabled'));
  assert.match(bot.instance.sent.at(-1)![1], /每日简报插件已停用/);
  assert.equal(reads, 2);
  assert.equal(f.posts.length, 0);
});

test('飞书 /status 读取当前机器人或引用卡片的会话，旧目标与重复事件不会改投', async t => {
  const f = fixture(t), bot = await f.add('ConversationStatus');
  const plugins = f.app.plugins!, list = plugins.list;
  let enabled = true, failRead = false;
  const reads: string[] = [];
  let inFlight: Promise<void> | undefined;
  plugins.list = () => [...list(), { id: 'conversation-search', enabled, status: enabled ? 'active' : 'disabled' }];
  plugins.invocations!.use = async (name, input) => {
    assert.equal(name, 'conversation-search.status');
    reads.push((input as {conversationId:string}).conversationId);
    if (failRead) throw Error('合成状态来源暂不可用');
    if (inFlight) await inFlight;
    return readConversationStatus(f.store, input);
  };
  const human = (id: string) => ({ ...source(id), senderType: 'user' as const });
  const receive = bot.instance.options.onMessage;
  await receive('/status', human('before-pair'));
  await bot.pair();
  await receive('/状态', { ...human('group-status'), chatType: 'group' });
  await receive('/status', { ...human('bot-status'), senderType: 'bot' });
  await receive('/status', { ...human('another-owner'), senderId: 'other' });
  await receive('/status', { ...human('another-chat'), chatId: 'other' });
  assert.deepEqual(reads, []);
  assert.equal(bot.instance.sent.length, 0);

  const projectInputs: Array<{ projectId: string; text: string }> = [];
  f.app.projectWorkspace = { async post(projectId, text) {
    projectInputs.push({ projectId, text });
    return { id: 'status-follow-up', text, role: 'user', projectId, conversationId: 'project:' + projectId + ':work',
      createdAt: new Date().toISOString() };
  } };
  const project = { id: 'status-project', name: '合成项目目标' };
  f.store.put('projects', project.id, project);
  const other = { id: 'status-other-project', name: '切换后的合成项目' };
  f.store.put('projects', other.id, other);
  const projectConversation = 'project:' + project.id + ':work';
  const botConversation = botConversationId(bot.bot);
  const putMessage = (id: string, text: string, conversationId: string, projectId?: string) => {
    f.store.put('messages', id, { id, text, conversationId, ...(projectId && { projectId }), role: 'assistant',
      status: 'done', createdAt: '2026-03-01T10:00:00.000Z' } satisfies Message);
  };
  const direct = '私聊机器人上一条合成回复', projectText = '引用项目上一条合成回复';
  putMessage('status-bot-last', direct, botConversation);
  putMessage('status-project-last', projectText, projectConversation, project.id);
  await Promise.all([receive('/status', human('same-event')), receive('/status', human('same-event'))]);
  assert.deepEqual(reads, [botConversation]);
  assert.equal(bot.instance.sent.length, 1);
  assert.ok(bot.instance.sent[0]![1].includes(direct));
  assert.ok(!bot.instance.sent[0]![1].includes(projectText));
  const acknowledgeCard = (outgoingId: string) => {
    const onSent = bot.instance.contexts.at(-1)?.onSent;
    assert.ok(onSent);
    onSent(outgoingId);
  };
  acknowledgeCard('outgoing-main-status');
  await receive('工作台', human('dashboard-for-status'));
  const dashboard = bot.instance.contexts.at(-1)!.card as { elements: Array<{actions?: Array<{value: Record<string,unknown>}>}> };
  const select = (projectId: string, messageId: string) => {
    const button = dashboard.elements.flatMap(row => row.actions ?? []).find(action =>
      action.value.kind === 'workbench.chat' && action.value.projectId === projectId);
    assert.ok(button);
    return bot.instance.options.onCardAction!({ operatorId: 'human', chatId: 'owner', messageId, value: button.value });
  };
  select(project.id, 'choose-project');
  await receive('/状态', human('default-project'));
  assert.equal(reads.at(-1), projectConversation);
  const delayedReceipt = bot.instance.contexts.at(-1)?.onSent;
  assert.ok(delayedReceipt);
  select(other.id, 'choose-other');
  delayedReceipt('outgoing-project-status');
  await receive('/status', human('new-default'));
  assert.equal(reads.at(-1), 'project:' + other.id + ':work');
  await receive('/status', { ...human('quote-status-card'), parentId: 'outgoing-project-status' });
  assert.equal(reads.at(-1), projectConversation);
  assert.ok(bot.instance.sent.at(-1)![1].includes(projectText));
  await receive('/status', { ...human('quote-main-status-card'), parentId: 'outgoing-main-status' });
  assert.equal(reads.at(-1), botConversation);
  assert.ok(bot.instance.sent.at(-1)![1].includes(direct));
  await receive('继续处理这张状态卡里的事项', { ...human('ordinary-card-reply'), parentId: 'outgoing-project-status' });
  assert.deepEqual(projectInputs, [{ projectId: project.id, text: '继续处理这张状态卡里的事项' }]);
  select('', 'choose-main');
  await receive('/status', { ...human('quoted-project'), parentId: 'choose-project', rootId: 'choose-main' });
  assert.equal(reads.at(-1), projectConversation);
  assert.ok(bot.instance.sent.at(-1)![1].includes(projectText));
  assert.ok(!bot.instance.sent.at(-1)![1].includes(direct));
  assert.equal(bot.instance.contexts.at(-1)?.replyTo, 'quoted-project');
  assert.equal(bot.instance.contexts.at(-1)?.threadId, 'choose-main');
  await receive('/status', human('back-to-main'));
  assert.equal(reads.at(-1), botConversation);

  let release!: () => void;
  inFlight = new Promise<void>(resolve => { release = resolve; });
  const baseline = reads.length, sent = bot.instance.sent.length;
  const stale = receive('/status', human('status-in-flight'));
  await t.waitFor(() => assert.equal(reads.length, baseline + 1));
  select(other.id, 'switch-during-read');
  release();
  await stale;
  assert.equal(bot.instance.sent.length, sent);
  inFlight = undefined;

  f.store.put('projects', project.id, { ...project, archivedAt: '2026-03-02' });
  const previous = reads.length;
  await receive('/status', { ...human('archived-quote'), parentId: 'choose-project' });
  assert.equal(reads.length, previous);
  assert.match(bot.instance.sent.at(-1)![1], /重新选择/);
  failRead = true;
  await receive('/status', human('failed-read'));
  assert.match(bot.instance.sent.at(-1)![1], /失败|不可用/);
  assert.ok(!bot.instance.sent.at(-1)![1].includes(direct));
  enabled = false;
  await receive('/status', human('disabled-read'));
  assert.match(bot.instance.sent.at(-1)![1], /停用|不可用/);
  assert.equal(reads.length, previous + 1);
  assert.equal(f.posts.length, 0);
});

test('/status 在固定项目和待办机器人使用各自绑定，未标记机器人不能借用其他会话', async t => {
  const f = fixture(t);
  const projectId = 'status-fixed-project', todoId = 'status-fixed-todo';
  f.store.put('projects', projectId, { id: projectId, name: '固定机器人合成项目' });
  f.store.put('todos', todoId, { id: todoId, projectId, title: '固定机器人合成事项' });
  const plugins = f.app.plugins!, original = plugins.list;
  plugins.list = () => [...original(), { id: 'conversation-search', enabled: true, status: 'active' }];
  const reads: unknown[] = [];
  plugins.invocations!.use = async (_name, input) => {
    reads.push(input);
    return readConversationStatus(f.store, input);
  };
  const scopes: BotScope[] = [{ kind: 'project', projectId }, { kind: 'task', projectId, todoId }, { kind: 'unmarked' }];
  for (const scope of scopes) {
    const scoped = await f.add('ScopeStatus' + scope.kind, scope);
    await scoped.pair();
    await scoped.instance.options.onMessage('/status', { ...source('status-' + scope.kind), senderType: 'user' });
    const answer = scoped.instance.sent.at(-1)![1];
    if (scope.kind === 'unmarked') {
      assert.match(answer, /尚未绑定/);
      assert.equal(reads.length, 2);
    } else {
      assert.deepEqual(reads.at(-1), { conversationId: botConversationId(scoped.bot), projectId,
        ...(scope.kind === 'task' && { todoId }) });
      assert.match(answer, /没有会话记录/);
    }
  }
  assert.equal(f.posts.length, 0);
});

test('飞书对话列表可分页选项目，主对话命令持久切换，旧事件与引用保留各自目标', async t => {
  const f = fixture(t), bot = await f.add('SelectConversation');
  await bot.pair();
  const human = (id: string) => ({ ...source(id), senderType: 'user' as const });
  const receive = bot.instance.options.onMessage;
  const projectTexts: string[] = [];
  f.app.projectWorkspace = { async post(projectId, text) {
    projectTexts.push(text);
    return { id: 'chosen-' + projectTexts.length, projectId, text, role: 'user',
      createdAt: '', conversationId: 'project:' + projectId + ':work' };
  } };
  for (let index = 0; index < 7; index++) {
    const id = 'pick-' + index;
    f.store.put('projects', id, { id, name: '测试项目' + index });
  }
  f.store.put('projects', 'old', { id: 'old', name: '归档样例', archivedAt: '2026-01-01' });
  type Choice = { value: Record<string, unknown>; text: { content: string } };
  const choices = (card: unknown) => {
    const content = card as { elements: Array<{ actions?: Choice[] }> };
    assert.ok(Array.isArray(content?.elements));
    return content.elements.flatMap(row => row.actions ?? []);
  };
  const click = (button: Choice, messageId: string) => bot.instance.options.onCardAction!({
    value: button.value, messageId, chatId: 'owner', operatorId: 'human',
  }) as { card?: { data: unknown }; toast?: { type: string } };

  await Promise.all([receive('/list', human('list')), receive('/list', human('list'))]);
  assert.equal(bot.instance.sent.length, 1);
  const firstContext = bot.instance.contexts.at(-1);
  assert.ok(firstContext?.onSent && firstContext.beforeTextFallback);
  const firstPage = choices(firstContext.card);
  const next = firstPage.find(action => action.text.content === '下一页');
  assert.ok(next);
  const secondPage = choices(click(next, 'choose-page').card?.data);
  const projectButtons = [...firstPage, ...secondPage].filter(action => action.value.kind === 'workbench.chat' && action.value.projectId);
  assert.deepEqual(projectButtons.map(button => button.value.projectId).sort(),
    Array.from({ length: 7 }, (_, i) => 'pick-' + i));
  assert.ok(firstPage.some(action => action.value.kind === 'workbench.chat' && action.value.projectId === ''));
  const chosen = projectButtons.at(-1)!;
  assert.equal(click(chosen, 'project-card').toast?.type, 'success');
  firstContext.onSent('project-card');
  await receive('/对话', human('list-again'));
  await receive('列表保留当前选择', human('list-no-switch'));
  assert.deepEqual(projectTexts, ['列表保留当前选择']);

  await receive('/main', { ...human('main-command'), parentId: 'project-card' });
  const acknowledge = bot.instance.contexts.at(-1)?.onSent;
  assert.ok(acknowledge);
  await receive('切回后的消息', human('default-main'));
  assert.equal(f.posts.at(-1)?.text, '切回后的消息');
  assert.equal(click(chosen, 'selected-again').toast?.type, 'success');
  acknowledge('main-confirmation');
  await receive('/main', { ...human('main-command'), parentId: 'project-card' });
  await receive('重放后仍发项目', human('duplicate-does-not-switch'));
  await receive('引用较早的主对话确认', { ...human('quote-main'), parentId: 'main-confirmation' });
  assert.deepEqual(projectTexts, ['列表保留当前选择', '重放后仍发项目']);
  assert.equal(f.posts.at(-1)?.text, '引用较早的主对话确认');
  await receive('/主对话', human('return-main'));
  await f.restart();
  const restarted = f.instances.at(-1)!.options.onMessage;
  await restarted('重启后的主对话', human('after-restart'));
  assert.equal(f.posts.at(-1)?.text, '重启后的主对话');
  await restarted('/list 里有什么', human('ordinary-with-command-prefix'));
  assert.equal(f.posts.at(-1)?.text, '/list 里有什么');
  await restarted('引用项目继续', { ...human('quote-project'), parentId: 'project-card' });
  assert.equal(projectTexts.at(-1), '引用项目继续');
  const currentList = 'archive-during-send';
  await restarted('/list', human(currentList));
  const lastContext = f.instances.at(-1)!.contexts.at(-1);
  assert.ok(lastContext?.beforeTextFallback);
  const displayed = choices(lastContext.card).find(action => action.value.projectId);
  assert.ok(displayed);
  const archived = String(displayed.value.projectId);
  f.store.put('projects', archived, { id: archived, name: '刚归档', archivedAt: '2026-02-01' });
  assert.throws(() => lastContext.beforeTextFallback!(), /项目/);
  assert.equal(f.mailboxes.list().some(row => row.direction === 'inbox' && /^\/(main|主对话|list|对话)$/.test(row.text)), false);
});

test('飞书对话命令只允许已配对主人的全局私聊', async t => {
  const f = fixture(t);
  const bot = await f.add('SelectOwner');
  const human = (id: string) => ({ ...source(id), senderType: 'user' as const });
  for (const command of ['/list', '/main']) await bot.instance.options.onMessage(command, human('unpaired-' + command));
  await bot.pair();
  const before = f.mailboxes.list().length;
  for (const command of ['/对话', '/主对话']) {
    const origins = [{ senderId: 'other' }, { senderType: 'bot' as const }, { senderType: undefined },
      { chatType: 'group' }, { chatId: 'other' }];
    for (const [index, patch] of origins.entries()) await bot.instance.options.onMessage(command, { ...human(command + index), ...patch });
  }
  assert.equal(f.mailboxes.list().length, before);
  assert.equal(bot.instance.sent.length, 0);
  f.store.put('projects', 'fixed-scope', { id: 'fixed-scope', name: '固定作用域' });
  f.store.put('todos', 'fixed-task', { id: 'fixed-task', projectId: 'fixed-scope', title: '固定事项' });
  const scopes: BotScope[] = [{ kind: 'project', projectId: 'fixed-scope' },
    { kind: 'task', todoId: 'fixed-task', projectId: 'fixed-scope' }, { kind: 'unmarked' }];
  for (const scope of scopes) {
    const scoped = await f.add('Select' + scope.kind, scope);
    await scoped.pair();
    const baseline = f.mailboxes.list().length;
    for (const command of ['/list', '/main']) await scoped.instance.options.onMessage(command, human(command + scope.kind));
    assert.equal(f.mailboxes.list().length, baseline);
    assert.equal(scoped.instance.sent.length, 0);
  }
  assert.equal(f.posts.length, 0);
});

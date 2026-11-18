import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFeishuController } from '../apps/server/src/feishu.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createEffects } from '../packages/core/src/effects.ts';
import { createInboxService } from '../packages/core/src/inbox.ts';
import type { InboxThing, Message, Todo } from '../packages/protocol/src/index.ts';

type App = Parameters<typeof createFeishuController>[0];
type Factory = NonNullable<Parameters<typeof createFeishuController>[2]>;
type Options = Parameters<Factory>[0];
const thing: InboxThing = { thread: 'offline-thread', last: 'offline-message', title: '报告', text: '请检查报告' };
const source = (messageId: string, chatId = 'owner', chatType = 'p2p') => ({ messageId, chatId, chatType });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(t: test.TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mario-feishu-controller-'));
  const store = createStore(join(dataDir, 'test.sqlite'));
  const events = createEventBus(store);
  const effects = createEffects({store, events});
  let enabled = true;
  let available = true;
  let triageEnabled = true;
  const posts: { id: string; text: string; conversation: string | undefined }[] = [];
  const inbox = createInboxService({ store, events, createTodo(input): Todo {
    const todo = { id: 'todo-offline', title: String(input.title), notes: String(input.notes), createdAt: '', updatedAt: '' };
    store.put('todos', todo.id, todo); return todo;
  } });
  const app = { store, events, inbox, effects,
    plugins: { list: () => [{ id: 'feishu', enabled, status: enabled ? 'active' : 'disabled' }, { id: 'inbox-triage', enabled: triageEnabled, status: triageEnabled ? 'active' : 'disabled' }] },
    agent: { status: () => ({ available, reason: 'offline missing model' }), async post(text: string, conversation?: string) {
      const input = { id: `input-${posts.length + 1}`, text, conversation }; posts.push(input); return input;
    } },
  } as unknown as App;
  const instances: { options: Options; sent: [string, string][]; closed: boolean; collect: () => Promise<InboxThing[]> }[] = [];
  const factory: Factory = options => {
    const instance = { options, sent: [] as [string, string][], closed: false, collect: async () => [thing] };
    instances.push(instance);
    return { async start() {}, async close() { instance.closed = true; },
      async send(chatId, text) { instance.sent.push([chatId, text]); },
      collect: () => instance.collect(), status: () => ({ connected: !instance.closed }) };
  };
  const controller = createFeishuController(app, { dataDir, host: '127.0.0.1', port: 0, demo: true }, factory);
  t.after(async () => { await controller.close(); await effects.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  async function configure(appId = 'cli_OfflineUserA') {
    await controller.update({ appId, appSecret: `secret-${appId}`, profile: 'offline-profile' });
    return instances.at(-1)!;
  }
  async function pair(instance = instances.at(-1)!) {
    const code = controller.status().pairingCode;
    assert.match(code!, /^\d{6}$/);
    return instance.options.onMessage(code!, source('pair'));
  }
  function reply(replyTo: string, text: string, id = `answer-${replyTo}`, status = 'done') {
    store.put('messages', id, { id, role: 'assistant', replyTo, text, status } as Message);
    events.publish('messages.changed', { messageId: id });
  }
  return { controller, instances, configure, pair, posts, store, inbox, events, reply,
    disable() { enabled = false; events.publish('plugins.changed', { id: 'feishu' }); },
    disableTriage() { triageEnabled = false; events.publish('plugins.changed', { id: 'inbox-triage' }); },
    unavailable() { available = false; } };
}

test('user supplies arbitrary app credentials; only a p2p pairing code binds an owner', async t => {
  const f = fixture(t);
  await f.controller.start();
  assert.equal(f.instances.length, 0);
  assert.equal(f.controller.status().configured, false);
  const instance = await f.configure();
  assert.equal(instance.options.appId, 'cli_OfflineUserA');
  assert.equal(instance.options.appSecret, 'secret-cli_OfflineUserA');
  assert.equal(instance.options.profile, 'offline-profile');
  const code = f.controller.status().pairingCode!;
  await instance.options.onMessage('wrong', source('wrong'));
  await instance.options.onMessage(code, source('group', 'owner', 'group'));
  assert.equal(f.controller.status().paired, false);
  assert.equal(f.posts.length, 0);
  assert.match((await f.pair())!, /绑定/);
  assert.equal(f.controller.status().paired, true);
  assert.equal(f.controller.status().pairingCode, undefined);
  await instance.options.onMessage('intruder', source('other', 'other'));
  assert.equal(f.posts.length, 0);
  await instance.options.onMessage('hello', source('owner-message'));
  assert.deepEqual(f.posts.map(p => [p.text, p.conversation]), [['hello', 'main']]);
});

test('completed model replies correlate with input and are sent once; duplicate receipts are ignored', async t => {
  const f = fixture(t); const instance = await f.configure(); await f.pair();
  await instance.options.onMessage('first', source('m1'));
  await instance.options.onMessage('first', source('m1'));
  await instance.options.onMessage('second', source('m2'));
  assert.equal(f.posts.length, 2);
  f.reply('unrelated-web-input', 'web reply');
  f.reply(f.posts[0].id, 'partial', 'partial', 'pending');
  assert.deepEqual(instance.sent, []);
  f.reply(f.posts[1].id, 'answer second');
  f.reply(f.posts[0].id, 'answer first');
  f.reply(f.posts[0].id, 'duplicate');
  await tick();
  assert.deepEqual(instance.sent, [['owner', 'answer second'], ['owner', 'answer first']]);
});

test('unavailable model reports its reason without posting a turn', async t => {
  const f = fixture(t); const instance = await f.configure(); await f.pair(); f.unavailable();
  assert.match((await instance.options.onMessage('hello', source('m1')))!, /offline missing model/);
  assert.equal(f.posts.length, 0);
});

test('disabled plugin closes its adapter and rejects stale incoming callbacks', async t => {
  const f = fixture(t); const instance = await f.configure(); await f.pair();
  f.disable(); await tick();
  assert.equal(instance.closed, true);
  assert.equal(f.controller.status().enabled, false);
  await instance.options.onMessage('late', source('late'));
  await instance.options.onInbox([thing]);
  assert.equal(f.posts.length, 0);
  assert.deepEqual(f.inbox.list(), []);
  await assert.rejects(f.controller.collect(), /尚未连接/);
});

test('configuration switch and close isolate stale callbacks, pending replies and owner bindings', async t => {
  const f = fixture(t); const first = await f.configure(); await f.pair();
  await first.options.onMessage('old turn', source('old'));
  const second = await f.configure('cli_OfflineUserB');
  assert.equal(first.closed, true);
  assert.equal(f.controller.status().paired, false);
  await first.options.onMessage('stale', source('stale'));
  await first.options.onInbox([thing]);
  f.reply(f.posts[0].id, 'old answer');
  assert.deepEqual(first.sent, []); assert.deepEqual(second.sent, []);
  assert.equal(f.posts.length, 1); assert.deepEqual(f.inbox.list(), []);
  await f.pair(second);
  await second.options.onMessage('new turn', source('new'));
  await f.controller.close();
  await second.options.onMessage('closed', source('closed'));
  await second.options.onInbox([thing]);
  f.reply(f.posts[1].id, 'closed answer');
  assert.equal(f.posts.length, 2); assert.deepEqual(second.sent, []);
  assert.deepEqual(f.inbox.list(), []); assert.equal(second.closed, true);
});

test('collect persists inbox items and explicit confirmation creates exactly one todo', async t => {
  const f = fixture(t); await f.configure();
  assert.deepEqual(await f.controller.collect(), { collected: 1 });
  const item = f.inbox.list()[0];
  assert.equal(item.text, thing.text); assert.equal(item.tier, 'action');
  assert.deepEqual(f.store.list('todos'), []);
  const result = f.inbox.confirm(item.id, item.version);
  assert.equal(f.store.get<Todo>('todos', result.todoId)?.title, thing.title);
  await f.controller.collect();
  assert.equal(f.inbox.list().length, 1); assert.equal(f.store.list('todos').length, 1);
});

// Regression tests intentionally assert the isolation contract, even when current code violates it.
test('concurrent deliveries of the same platform message post only one model turn', async t => {
  const f = fixture(t); const instance = await f.configure(); await f.pair();
  await Promise.all([
    instance.options.onMessage('same delivery', source('concurrent')),
    instance.options.onMessage('same delivery', source('concurrent')),
  ]);
  assert.equal(f.posts.length, 1, 'receipt must be claimed before awaiting agent.post');
});

for (const transition of ['switch', 'close'] as const) {
  test(`in-flight collect cannot commit old results after ${transition}`, async t => {
    const f = fixture(t); const instance = await f.configure();
    let release!: (things: InboxThing[]) => void;
    let started!: () => void;
    const collecting = new Promise<void>(resolve => { started = resolve; });
    instance.collect = () => { started(); return new Promise(resolve => { release = resolve; }); };
    const pending = f.controller.collect();
    // Attach immediately: cancellation may legitimately reject the pending operation.
    const settled = pending.then(() => undefined, () => undefined);
    await collecting;
    if (transition === 'switch') await f.configure('cli_OfflineUserB');
    else await f.controller.close();
    release([thing]); await settled;
    assert.deepEqual(f.inbox.list(), [], 'stale collection must not ingest or acquire the new app identity');
  });
}


test('unrelated plugin changes preserve adapter and outstanding model replies', async t => {
  const f = fixture(t); const instance = await f.configure(); await f.pair();
  await instance.options.onMessage('pending', source('pending'));
  f.events.publish('plugins.changed', { id: 'knowledge' }); await tick();
  assert.equal(f.instances.length, 1); assert.equal(instance.closed, false);
  f.reply(f.posts[0].id, 'still associated'); await tick();
  assert.deepEqual(instance.sent, [['owner', 'still associated']]);
});

test('disabled inbox-triage blocks polling ingestion and explicit collect without reconnecting', async t => {
  const f = fixture(t); const instance = await f.configure();
  let collections = 0;
  instance.collect = async () => { collections++; return [thing]; };
  f.disableTriage(); await tick();
  await instance.options.onInbox([thing]);
  await assert.rejects(f.controller.collect(), /启用收件箱整理插件/);
  assert.equal(collections, 0); assert.deepEqual(f.inbox.list(), []);
  assert.equal(instance.closed, false); assert.equal(f.instances.length, 1);
});

test('plugin disable blocks an incoming callback immediately, before asynchronous restart drains', async t => {
  const f = fixture(t); const instance = await f.configure(); await f.pair();
  f.disable();
  await instance.options.onMessage('delivery during shutdown', source('disable-race'));
  assert.equal(f.posts.length, 0, 'disabled plugin must not post while restart is queued');
});

test('native task results return once to their original bot chat after the initial assistant reply', async t => {
  const f = fixture(t); const instance = await f.configure(); await f.pair();
  await instance.options.onMessage('dispatch', source('original-task'));
  f.reply(f.posts[0].id, '任务已派发'); await tick();
  const id = 'run-result:offline-run';
  f.store.put('messages', id, { id, conversationId: 'main', role: 'assistant', origin: 'result', replyTo: f.posts[0].id, text: '原生任务已完成', status: 'done', createdAt: '' } as Message);
  f.events.publish('messages.changed', {messageId: id});
  f.events.publish('runs.result', {messageId: id, runId: 'offline-run'});
  f.events.publish('runs.result', {messageId: id, runId: 'offline-run'});
  await tick();
  assert.deepEqual(instance.sent, [['owner', '任务已派发'], ['owner', '原生任务已完成']]);
  await f.configure('cli_OfflineUserB');
  f.events.publish('runs.result', {messageId: id, runId: 'offline-run'}); await tick();
  assert.deepEqual(f.instances.at(-1)!.sent, []);
});

test('user-required notices do not consume the main reply; resumed card answers route replies and results once', async t => {
  const f=fixture(t);const instance=await f.configure();await f.pair();
  await instance.options.onMessage('original goal',source('card-flow'));
  const originalId=f.posts[0].id;
  const noticeId='interaction-notice:q';
  f.store.put('messages',noticeId,{id:noticeId,conversationId:'main',role:'assistant',origin:'notification',replyTo:originalId,text:'需要选择项目',status:'done',createdAt:''} as Message);
  f.events.publish('messages.changed',{messageId:noticeId});f.events.publish('notifications.message',{messageId:noticeId});
  f.reply(originalId,'已创建交互卡，请选择');await tick();
  assert.deepEqual(instance.sent,[['owner','需要选择项目'],['owner','已创建交互卡，请选择']]);
  f.store.put('message.routes','resumed-input',{...f.store.get<Record<string,unknown>>('message.routes',originalId),resumed:true});
  f.reply('resumed-input','根据回答继续执行','resumed-answer');f.reply('resumed-input','根据回答继续执行','resumed-answer');
  const resultId='run-result:resumed';
  f.store.put('messages',resultId,{id:resultId,conversationId:'main',role:'assistant',origin:'result',replyTo:'resumed-input',text:'后续任务完成',status:'done',createdAt:''} as Message);
  f.events.publish('runs.result',{runId:'resumed',messageId:resultId});await tick();
  assert.deepEqual(instance.sent.slice(2),[['owner','根据回答继续执行'],['owner','后续任务完成']]);
});

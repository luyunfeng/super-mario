import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentRuntime } from '../packages/core/src/agent-runtime/index.ts';
import { createInboxHandlingRuntime } from '../packages/core/src/agent-runtime/inbox-handling.ts';
import { createHash } from 'node:crypto';
import type { InboxHandlingSource } from '../packages/protocol/src/inbox-handling.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createContributions } from '../packages/core/src/plugin-host.ts';
import type { AppConfig, KnowledgeEntry, Message } from '../packages/protocol/src/index.ts';

type LoadSDK = NonNullable<Parameters<typeof createAgentRuntime>[1]>;
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

// Exercise real runtime setup, bridge, tool loadout and message_end persistence.
// SDK sessions own separate history; resuming a session would fail these tests.
function fakeSDK() {
  const sessions: {
    options: any; loader: any; history: string[]; contexts: string[];
    tools: Map<string, any>; activeTools: string[]; listeners: Set<(event: any) => void>;
    disposed: boolean; aborted: boolean;
  }[] = [];
  const loaders = new Map<string, any>();
  const credentials: unknown[][] = [];
  let loads = 0;
  const control = {
    hold: false, error: '', initializationError: '',
    started: deferred(), late: deferred(), startingSession: false, sessionStarted: deferred(),
    holdAvailability: false, availabilityStarted: deferred(),
    holdKey: false, keyStarted: deferred(), keyRelease: deferred(),
    holdReload: false, reloadStarted: deferred(),
    holdCredentials: false, credentialStarted: deferred(), credentialRelease: deferred(),
  };
  const sdk = {
    ModelRuntime: { async create() {
      if (control.initializationError) throw new Error(control.initializationError);
      return {
        getAvailable: async () => {
          if (control.holdAvailability) { control.availabilityStarted.resolve(); await new Promise(() => {}); }
          return [{ provider: 'test', id: 'first' }, { provider: 'test', id: 'second' }];
        },
        getModel: (provider: string, id: string) => ({ provider, id }),
        setRuntimeApiKey: async (...args: unknown[]) => { credentials.push(args); if (control.holdKey) { control.keyStarted.resolve(); await control.keyRelease.promise; } },
        settleCredentialWrites: async () => {
          if (control.holdCredentials) { control.credentialStarted.resolve(); await control.credentialRelease.promise; }
        },
      };
    } },
    SettingsManager: { inMemory: (options: unknown) => options },
    DefaultResourceLoader: class {
      options: any;
      constructor(options: any) { this.options = options; loaders.set(options.cwd, this); }
      async reload() { if (control.holdReload) { control.reloadStarted.resolve(); await new Promise(() => {}); } }
    },
    SessionManager: {
      continueRecent() { throw new Error('Classifier must never resume any SDK history'); },
      inMemory(cwd: string) { return { cwd, id: Symbol('fresh-session'), history: [] }; },
    },
    async createAgentSession(options: any) {
      const loader = loaders.get(options.cwd).options;
      const handlers = new Map<string, (event: any) => Promise<any>>();
      const record = { options, loader, history: options.sessionManager.history as string[], contexts: [] as string[],
        tools: new Map<string, any>(), activeTools: [] as string[], listeners: new Set<(event: any) => void>(),
        disposed: false, aborted: false };
      sessions.push(record);
      for (const factory of loader.extensionFactories) await factory({
        registerTool: (tool: any) => record.tools.set(tool.name, tool),
        setActiveTools: (names: string[]) => { record.activeTools = names; },
        on: (name: string, handler: any) => handlers.set(name, handler),
      });
      const session = {
        subscribe(listener: (event: any) => void) { record.listeners.add(listener); return () => record.listeners.delete(listener); },
        async prompt(text: string) {
          record.history.push(text);
          // Real pi adds cwd even to a custom system prompt. The principles
          // branch must replace that prompt, rather than appending to it.
          const context = await handlers.get('before_agent_start')!({ systemPrompt: `${loader.systemPrompt}\nSDK_MACHINE_PRIVATE_CWD` });
          record.contexts.push(context.systemPrompt);
          control.started.resolve();
          if (control.hold) await control.late.promise;
          if (control.error) throw new Error(control.error);
          for (const listener of record.listeners) listener({ type: 'message_end', message: {
            role: 'assistant', content: [{ type: 'text', text: '{"answer":"建议确认","suggestions":[{"kind":"conclusion","text":"待确认"}]}' }], stopReason: 'stop',
          } });
        },
        async abort() { record.aborted = true; if (control.hold) await new Promise(() => {}); },
        dispose() { record.disposed = true; },
      };
      if (control.startingSession) { control.sessionStarted.resolve(); await control.late.promise; }
      return { session };
    },
  };
  const load: LoadSDK = async () => { loads++; return sdk as unknown as Awaited<ReturnType<LoadSDK>>; };
  return { load, loads: () => loads, sessions, credentials, control };
}

const source = (id: string, projectId?: string): InboxHandlingSource => ({ kind: projectId ? 'mailbox' : 'personal',
  id, projectId, version: 1, title: `TITLE_${id}`, text: `BODY_${id}`, active: true, replyAvailable: false });
const conversation = (id: string) => `inbox-handling:${createHash('sha256').update(id).digest('hex')}`;
async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-inbox-handling-'));
  const store = createStore(join(dataDir, 'test.sqlite'));
  const events = createEventBus(store);
  const contributions = createContributions();
  const config: AppConfig = { host: '127.0.0.1', port: 0, demo: false, dataDir,
    model: { provider: 'test', model: 'first', apiKey: 'fake-first-key' } };
  const sdk = fakeSDK();
  const runtime = createInboxHandlingRuntime({ config, store, events, contributions, ready: () => true }, sdk.load);
  t.after(async () => { await runtime.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { config, store, events, contributions, runtime, sdk };
}

test('lazy independent conversations, fixed schema, zero tools and filtered knowledge', async t => {
  const f = await fixture(t);
  assert.equal(f.sdk.loads(), 0);
  for (const name of ['todo_create', 'channel_send', 'knowledge_list']) f.contributions.add('tools', name, {
    name, description: name, parameters: {}, execute: async () => { throw new Error('Must not execute'); },
  });
  const knowledge = (id: string, layer: KnowledgeEntry['layer'], projectId?: string): KnowledgeEntry =>
    ({ id, layer, projectId, title: id, content: id, updatedAt: '' });
  f.contributions.add('knowledge_backends', 'test', { list: async () => [
    knowledge('GLOBAL', 'global'), knowledge('PERSONAL', 'personal'), knowledge('PROJECT_A', 'project', 'A'),
    knowledge('PROJECT_B', 'project', 'B'), knowledge('INVALID_PERSONAL', 'personal', 'B'),
  ], put: async () => { throw new Error('No writes'); }, remove: async () => false });
  f.store.put('runs', 'secret', { prompt: 'PRIVATE_WORK_SNAPSHOT' });
  for (const id of ['main', 'bot:one', conversation('A')]) f.store.put('messages', id, {
    id, conversationId: id, text: 'FORGED_HISTORY', role: 'user', readOnly: true, status: 'done',
  });
  const sources = [source('A', 'A'), source('B', 'B'), source('P')];
  const replies = await Promise.all(sources.map(s => f.runtime.ask(s, conversation(s.id), `DISCUSS_${s.id}`)));
  assert.equal(f.sdk.sessions.length, 3);
  for (const [index, s] of sources.entries()) {
    const record = f.sdk.sessions.find(record => JSON.parse(record.history[0]).userRequest === `DISCUSS_${s.id}`)!;
    const input = JSON.parse(record.history[0]);
    assert.equal(input.untrustedSource.text, s.text);
    assert.equal(input.replyAvailable, s.replyAvailable);
    assert.equal(input.userRequest, `DISCUSS_${s.id}`);
    assert.deepEqual(input.discussion, []);
    assert.deepEqual(input.knowledge.map((k: any) => k.content), [s.projectId ? `PROJECT_${s.projectId}` : 'PERSONAL']);
    assert.match(record.contexts[0], /GLOBAL/);
    assert.match(record.contexts[0], /InboxHandlingAction/);
    assert.match(record.contexts[0], /本轮工具数量为零/);
    assert.match(record.contexts[0], /reply.text 只写给对方看的正文/);
    assert.match(record.contexts[0], /内部笔记.*不能照抄或改写进回复/);
    assert.match(record.contexts[0], /为 false 时仍可拟稿.*为 true 也须等用户确认/);
    assert.doesNotMatch(record.contexts[0], /SDK_MACHINE_PRIVATE_CWD|PRIVATE_WORK_SNAPSHOT|FORGED_HISTORY|PROJECT_A|PROJECT_B|PERSONAL/);
    assert.deepEqual(record.activeTools, []);
    assert.equal(record.tools.size, 0);
    assert.equal(record.options.noTools, 'builtin');
    assert.equal(replies[index].conversationId, conversation(s.id));
    assert.equal(replies[index].status, 'done');
    assert.equal(f.store.get<Message>('messages', replies[index].replyTo!)?.text, `DISCUSS_${s.id}`);
  }
  const progress = { total: 1, recent: [{ id: 'proposal-a', version: 1, kind: 'todo' as const, status: 'submitted' as const, approvalStatus: 'rejected' as const }] };
  await f.runtime.ask(sources[0], conversation('A'), 'FOLLOW_UP', progress);
  const session = f.sdk.sessions.find(record => JSON.parse(record.history[0]).userRequest === 'DISCUSS_A')!;
  assert.deepEqual(JSON.parse(session.history.at(-1)!).suggestionProgress, progress);
  assert.match(session.contexts[0], /仅查询进度时 suggestions 返回空数组/);
  assert.match(session.contexts[0], /不能据此说对方已读/);
  const follow = JSON.parse(f.sdk.sessions.find(s => s.history.length === 2)!.history[1]);
  assert.deepEqual(follow.discussion, [], 'Live SDK already owns this conversation history');
  assert.equal(f.sdk.loads(), 3);
});

test('configured read tools match the instructions actually delivered to the inbox model', async t => {
  const f = await fixture(t);
  for (const name of ['todos_list', 'todo_create']) f.contributions.add('tools', name, {
    name, description: name, parameters: {}, execute: async () => [],
  });
  const runtime = createInboxHandlingRuntime({ ...f, allowedTools: ['todos_list'], ready: () => true }, f.sdk.load);
  try {
    await runtime.ask(source('scoped'), conversation('scoped'), '核实后起草回复。');
    const record = f.sdk.sessions[0];
    assert.deepEqual(record.activeTools, ['todos_list']);
    assert.match(record.contexts[0], /本轮实际开放的只读工具/);
    assert.doesNotMatch(record.contexts[0], /工具数量为零/);
    assert.equal(JSON.parse(record.history[0]).userRequest, '核实后起草回复。');
  } finally { await runtime.close(); }
});

test('invalid ids, fake/inactive source and source rebinding cannot enter a conversation', async t => {
  const f = await fixture(t);
  for (const id of ['main', 'bot:one', 'inbox-handling:../main', 'inbox-handling:']) {
    await assert.rejects(f.runtime.ask(source('A'), id, 'hello'), /无效/);
  }
  for (const patch of [{ kind: 'fake' }, { active: false }, { id: '' }, { version: 0 }, { projectId: '' }]) {
    await assert.rejects(f.runtime.ask({ ...source('A'), ...patch } as InboxHandlingSource, conversation('A'), 'hi'));
  }
  assert.equal(f.sdk.loads(), 0);
  await f.runtime.ask(source('A'), conversation('A'), 'first');
  await assert.rejects(f.runtime.ask(source('B'), conversation('A'), 'cross source'));
  await assert.rejects(f.runtime.ask({ ...source('A'), version: 2 }, conversation('A'), 'cross version'));
  await f.runtime.ask({ ...source('A'), version: 2 }, conversation('A-v2'), 'new version');
  assert.deepEqual(JSON.parse(f.sdk.sessions[1].history[0]).discussion, []);
});

test('temporary reply connectivity changes reuse a discussion; a host grant generation change cannot reuse it',async t=>{
  const f=await fixture(t),s={...source('connectivity'),binding:'grant-one'};const id=conversation(s.id);
  await f.runtime.ask(s,id,'first');await f.runtime.ask({...s,replyAvailable:true},id,'continue');
  assert.equal(f.sdk.sessions.length,1);
  assert.deepEqual(f.sdk.sessions[0].history.map(turn => JSON.parse(turn).replyAvailable), [false, true]);
  await assert.rejects(f.runtime.ask({...s,binding:'grant-two'},id,'old authority'));
  await f.runtime.ask({...s,binding:'grant-two'},conversation('new-grant'),'new authority');assert.equal(f.sdk.sessions.length,2);
});

test('eight cached sessions evict only idle; evicted and restarted conversations restore only their own durable pairs', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 9; i++) await f.runtime.ask(source(String(i)), conversation(String(i)), `TURN_${i}`);
  assert.equal(f.sdk.sessions[0].disposed, true);
  assert.equal(f.sdk.sessions.filter(s => !s.disposed).length, 8);
  await f.runtime.ask(source('0'), conversation('0'), 'resume');
  assert.equal(JSON.parse(f.sdk.sessions[9].history[0]).discussion[0].text, 'TURN_0');
  await f.runtime.close();
  const restarted = createInboxHandlingRuntime({ ...f, ready: () => true }, f.sdk.load);
  try {
    await restarted.ask(source('0'), conversation('0'), 'restart');
    const restored = JSON.parse(f.sdk.sessions[10].history[0]).discussion;
    assert.deepEqual(restored.filter((m: any) => m.role === 'user').map((m: any) => m.text), ['TURN_0', 'resume']);
  } finally { await restarted.close(); }
});

test('restored discussion reports omitted turns and clipped evidence while leaving stored messages intact', async t => {
  const f = await fixture(t);
  const s = source('history'), id = conversation('history');
  for (let i = 0; i < 14; i++) await f.runtime.ask(s, id, i + ':开始' + '字'.repeat(3200) + '结束' + i);
  await f.runtime.close();
  const restarted = createInboxHandlingRuntime({ ...f, ready: () => true }, f.sdk.load);
  try {
    await restarted.ask(s, id, '核对旧答复是否真的发送');
    const session = f.sdk.sessions.at(-1)!;
    const { discussion, discussionCoverage } = JSON.parse(session.history[0]);
    assert.equal(discussionCoverage.omittedPairs, 7);
    assert.equal(discussion.length, 14);
    for (let i = 0; i < 7; i++) {
      const [user, reply] = discussion.slice(i * 2, i * 2 + 2);
      assert.equal(user.role, 'user');
      assert.equal(user.truncated, true);
      assert.ok(user.text.startsWith((7 + i) + ':开始') && user.text.endsWith('结束' + (7 + i)));
      assert.equal(reply.role, 'assistant');
    }
    assert.match(session.contexts[0], /不能作为已经批准、执行或送达的证据/);
    assert.ok(f.store.list<Message>('messages').some(row => row.text.startsWith('0:开始') && row.text.length > 3200));
  } finally { await restarted.close(); }
});

for (const stop of ['abortCurrent', 'close'] as const) test(`${stop} cancels concurrent and queued turns without SDK prompt/abort deadlock`, { timeout: 4000 }, async t => {
  const f = await fixture(t);
  f.sdk.control.hold = true;
  const pending = Array.from({ length: 8 }, (_, i) => assert.rejects(f.runtime.ask(source(String(i)), conversation(String(i)), 'hold'), /失败或已取消/));
  await f.sdk.control.started.promise;
  // Wait until every session has entered prompt without using a wall-clock delay.
  while (f.sdk.sessions.filter(s => s.history.length).length < 8) await new Promise(resolve => setImmediate(resolve));
  const queued = assert.rejects(f.runtime.ask(source('0'), conversation('0'), 'queued'), /失败或已取消/);
  await assert.rejects(f.runtime.ask(source('ninth'), conversation('ninth'), 'capacity'));
  assert.equal(f.sdk.loads(), 8);
  await f.runtime[stop]();
  await Promise.all([...pending, queued]);
  assert.ok(f.sdk.sessions.every(s => s.disposed && s.aborted && s.listeners.size === 0));
  const before = f.store.list<Message>('messages');
  assert.equal(before.length, 16);
  assert.ok(before.every(m => m.status === 'failed'));
  f.sdk.control.late.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.store.list('messages'), before);
});

test('configuration lock prevents admission; abort drains old sessions and unlock uses updated config', async t => {
  const f = await fixture(t);
  await f.runtime.ask(source('A'), conversation('A'), 'first');
  f.runtime.lockConfiguration();
  assert.equal(f.runtime.status().available, false);
  await assert.rejects(f.runtime.ask(source('B'), conversation('B'), 'locked'), /不可用/);
  await f.runtime.abortCurrent();
  f.config.model = { provider: 'test', model: 'second', apiKey: 'fake-second-key' };
  f.runtime.unlockConfiguration();
  await f.runtime.ask(source('A'), conversation('A'), 'second');
  assert.equal(f.sdk.sessions[1].options.model.id, 'second');
  assert.equal(JSON.parse(f.sdk.sessions[1].history[0]).discussion[0].text, 'first');
});

for (const stage of ['load', 'availability', 'session', 'reload'] as const) test(`close during stalled ${stage} initialization drains cancelled messages`, { timeout: 3000 }, async t => {
  const f = await fixture(t);
  let runtime = f.runtime;
  if (stage === 'load') runtime = createInboxHandlingRuntime({ ...f, ready: () => true }, () => new Promise(() => {}));
  if (stage === 'availability') f.sdk.control.holdAvailability = true;
  if (stage === 'session') f.sdk.control.startingSession = true;
  if (stage === 'reload') f.sdk.control.holdReload = true;
  const pending = assert.rejects(runtime.ask(source('A'), conversation('A'), 'hi'));
  if (stage === 'availability') await f.sdk.control.availabilityStarted.promise;
  else if (stage === 'session') await f.sdk.control.sessionStarted.promise;
  else if (stage === 'reload') await f.sdk.control.reloadStarted.promise;
  else await new Promise(resolve => setImmediate(resolve));
  await runtime.close();
  await pending;
  assert.ok(f.store.list<Message>('messages').every(m => m.status === 'failed'));
  f.sdk.control.late.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.sdk.sessions.every(s => s.disposed));
});

test('provider errors stay private and failed assistant is durably failed, never returned as success', async t => {
  const f = await fixture(t);
  f.sdk.control.error = 'PRIVATE_PROVIDER_ERROR secret-token BODY_A';
  await assert.rejects(f.runtime.ask(source('A'), conversation('A'), 'hello'), /失败或已取消/);
  assert.ok(f.store.list<Message>('messages').every(m => m.status === 'failed'));
  assert.doesNotMatch(JSON.stringify({ status: f.runtime.status(), events: f.events.since(0), messages: f.store.list('messages') }), /PRIVATE_PROVIDER_ERROR|secret-token|BODY_A/);
});

test('same conversation serializes concurrent requests while another source can proceed', async t => {
  const f = await fixture(t);
  f.sdk.control.hold = true;
  const first = f.runtime.ask(source('A'), conversation('A'), 'FIRST');
  await f.sdk.control.started.promise;
  const second = f.runtime.ask(source('A'), conversation('A'), 'SECOND');
  const other = f.runtime.ask(source('B'), conversation('B'), 'OTHER');
  while (f.sdk.sessions.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sdk.sessions[0].history.length, 1);
  f.sdk.control.late.resolve();
  await Promise.all([first, second, other]);
  assert.deepEqual(f.sdk.sessions[0].history.map(text => JSON.parse(text).userRequest), ['FIRST', 'SECOND']);
});

test('concurrent admission during eviction retains at most eight live sessions', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) await f.runtime.ask(source(String(i)), conversation(String(i)), 'seed');
  f.sdk.control.holdCredentials = true;
  const first = f.runtime.ask(source('new1'), conversation('new1'), 'one');
  await f.sdk.control.credentialStarted.promise;
  const second = f.runtime.ask(source('new2'), conversation('new2'), 'two');
  assert.equal(f.sdk.loads(), 8);
  f.sdk.control.holdCredentials = false;
  f.sdk.control.credentialRelease.resolve();
  await Promise.all([first, second]);
  assert.equal(f.sdk.sessions.filter(s => !s.disposed).length, 8);
});

test('close waits for credential persistence and is idempotent', async t => {
  const f = await fixture(t);
  await f.runtime.ask(source('A'), conversation('A'), 'hello');
  f.sdk.control.holdCredentials = true;
  let done = false;
  const closing = f.runtime.close().then(() => { done = true; });
  await f.sdk.control.credentialStarted.promise;
  assert.equal(done, false);
  f.sdk.control.credentialRelease.resolve();
  await closing;
  await f.runtime.close();
  assert.equal(f.runtime.status().available, false);
});

test('failed message persistence rejects ask and close instead of inventing success', async t => {
  const f = await fixture(t);
  const store = { ...f.store, put<T>(collection: string, id: string, value: T) {
    if (collection === 'messages' && (value as Message).role === 'assistant') throw new Error('PRIVATE_DISK_FAILURE');
    f.store.put(collection, id, value);
  } };
  const runtime = createInboxHandlingRuntime({ ...f, store, ready: () => true }, f.sdk.load);
  await assert.rejects(runtime.ask(source('A'), conversation('A'), 'hi'), /失败或已取消/);
  await assert.rejects(runtime.close(), /失败或已取消/);
  assert.ok(f.sdk.sessions.every(s => s.disposed));
  assert.equal(f.store.list<Message>('messages').filter(m => m.role === 'assistant').length, 0);
});

test('close reports a stuck credential flush as failure within its bounded drain', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  const runtime = createInboxHandlingRuntime({ ...f, ready: () => true }, f.sdk.load);
  await runtime.ask(source('A'), conversation('A'), 'hi');
  f.sdk.control.holdCredentials = true;
  await assert.rejects(runtime.close(), /失败或已取消/);
  assert.ok(f.sdk.sessions.every(s => s.disposed));
  f.sdk.control.credentialRelease.resolve();
});

test('cancellation also detaches a stalled scoped knowledge read without posting a fabricated assistant', async t => {
  const f = await fixture(t);
  const started = deferred();
  f.contributions.add('knowledge_backends', 'stalled', { list: async query => {
    if (query?.layer === 'global') return [];
    started.resolve();
    return new Promise(() => {});
  }, put: async () => { throw new Error('No writes'); }, remove: async () => false });
  const pending = assert.rejects(f.runtime.ask(source('A'), conversation('A'), 'hi'), /失败或已取消/);
  await started.promise;
  await f.runtime.close();
  await pending;
  assert.equal(f.store.list<Message>('messages').length, 0);
  assert.ok(f.sdk.sessions.every(s => s.disposed));
});

test('close owns credential writes even when cancelled before runtime initialization installs its flush', async t => {
  const f = await fixture(t);
  f.sdk.control.holdKey = true;
  const pending = assert.rejects(f.runtime.ask(source('A'), conversation('A'), 'hi'));
  await f.sdk.control.keyStarted.promise;
  let closed = false;
  const closing = f.runtime.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  f.sdk.control.keyRelease.resolve();
  await closing;
  await pending;
  assert.equal(f.sdk.sessions.length, 0);
});

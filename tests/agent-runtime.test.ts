import { createContributions } from '../packages/core/src/plugin-host.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TRACE_COLLECTION, type AgentTurnTrace } from '../packages/core/src/agent-traces.ts';
import { createAgentRuntime } from '../packages/core/src/agent-runtime/index.ts';
import type { AppConfig, AppEvent, Json, Message } from '../packages/protocol/src/index.ts';
import type { ContributionMap, Contributions, EventBus, Store, Tool } from '../packages/plugin-sdk/src/index.ts';

type LoadSDK = NonNullable<Parameters<typeof createAgentRuntime>[1]>;

async function fixture(t: test.TestContext, demo = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'super-mario-runtime-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const data = new Map<string, Map<string, unknown>>();
  const store: Store = {
    get: <T>(collection: string, id: string) => data.get(collection)?.get(id) as T | undefined,
    list: <T>(collection: string) => [...(data.get(collection)?.values() ?? [])] as T[],
    put(collection, id, value) {
      if (!data.has(collection)) data.set(collection, new Map());
      data.get(collection)!.set(id, structuredClone(value));
    },
    remove: (collection, id) => data.get(collection)?.delete(id) ?? false,
    transaction: fn => fn(), close() {},
  };
  const published: AppEvent[] = [];
  const listeners = new Set<(event: AppEvent) => void>();
  const events: EventBus = {
    publish(type, value: Json) {
      const event = { id: published.length + 1, type, data: value, createdAt: new Date().toISOString() };
      published.push(event);
      for (const listener of listeners) listener(event);
      return event;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    since: id => published.filter(event => event.id > id),
  };
  const contributionsData = new Map<keyof ContributionMap, Map<string, unknown>>();
  const contributions: Contributions = {
    ...createContributions(),
    add(kind, id, value) {
      if (!contributionsData.has(kind)) contributionsData.set(kind, new Map());
      contributionsData.get(kind)!.set(id, value);
      return () => { contributionsData.get(kind)?.delete(id); };
    },
    list(kind) { return [...(contributionsData.get(kind)?.entries() ?? [])].map(([id, value]) => ({ id, value })) as ReturnType<Contributions['list']> as never; },
  };
  const config: AppConfig = { host: '127.0.0.1', port: 0, dataDir, demo };
  return { config, store, events, contributions, published };
}

// This fake deliberately exercises the SDK surface (factory, final message events, and prompt),
// rather than replacing the complete runtime with a canned assistant response.
function fakeSDK() {
  const calls: Record<string, any> = {};
  const tools = new Map<string, any>();
  const handlers = new Map<string, (event: any) => Promise<any>>();
  const listeners = new Set<(event: any) => void>();
  const model = { provider: 'test', id: 'fake' };
  let active = 0;
  let maxActive = 0;
  const prompts: string[] = [];
  const session = {
    subscribe(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt(text: string, options: unknown) {
      calls.promptOptions = options;
      active++; maxActive = Math.max(maxActive, active); prompts.push(text);
      try {
        calls.context = await handlers.get('before_agent_start')?.({ systemPrompt: 'base' });
        await new Promise(resolve => setTimeout(resolve, 5));
        if (text === 'throw') throw new Error('provider refused');
        const message = {
          role: 'assistant', content: [{ type: 'text', text: `answer:${text}` }],
          stopReason: text === 'error' ? 'error' : 'stop', errorMessage: 'stream failed',
        };
        for (const listener of listeners) {
          listener({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', delta: 'ignored' } });
          listener({ type: 'message_end', message });
        }
      } finally { active--; }
    },
    dispose() { calls.disposed = true; },
  };
  const sdk = {
    ModelRuntime: { async create(options: unknown) {
      calls.auth = options;
      return { getAvailable: async () => calls.unavailable ? [] : [model],
        setRuntimeApiKey: async (_provider: string, key: string) => { calls.runtimeKey = key; },
        getModel: () => calls.missingModel ? undefined : model,
        settleCredentialWrites: async () => { calls.settled = true; } };
    } },
    SettingsManager: { inMemory(options: unknown) { calls.settings = options; return options; } },
    DefaultResourceLoader: class {
      constructor(options: any) { calls.loader = options; }
      async reload() {
        for (const factory of calls.loader.extensionFactories) {
          await factory({
            registerTool(tool: any) { tools.set(tool.name, tool); },
            setActiveTools(names: string[]) { calls.activeTools = names; },
            on(name: string, handler: any) { handlers.set(name, handler); },
          });
        }
      }
    },
    SessionManager: { continueRecent(cwd: string, dir: string) { calls.sessions = { cwd, dir }; return { resumed: true }; } },
    async createAgentSession(options: unknown) { calls.session = options; return { session }; },
  };
  const load: LoadSDK = async () => sdk as unknown as Awaited<ReturnType<LoadSDK>>;
  return { calls, tools, load, prompts, listeners, session, maxActive: () => maxActive };
}

test('demo acknowledges persistence before replying and drains on close without loading pi', async t => {
  const options = await fixture(t);
  const runtime = createAgentRuntime(options, async () => { throw new Error('pi must not load'); });
  assert.equal(runtime.status().available, true);
  const accepted = await runtime.post(' hello ');
  assert.equal(accepted.text, 'hello');
  assert.equal(accepted.status, 'pending');
  assert.equal(options.store.list('messages').length, 1);
  await runtime.close();
  const messages = options.store.list<Message>('messages');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].status, 'done');
  assert.match(messages[1].text, /本地演示.*hello/s);
  assert.match(messages[1].text, /没有调用模型或外部 CLI/);
  assert.equal(options.published.filter(event => event.type === 'messages.changed').length, 3);
  assert.equal(runtime.status().available, false);
  await assert.rejects(runtime.post('late'), /关闭/);
});

test('图片在演示模式只确认接收，纯文本模型明确拒绝且不调用提供方', async t => {
  const image = {mime:'image/gif', data:'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='};
  const demo = createAgentRuntime(await fixture(t), async () => { throw Error('演示不应加载 SDK'); });
  const reply = await demo.ask('', {images:[image]});
  assert.match(reply.text,/1 张图片，演示模式未识别内容/);
  await demo.close();
  const sdk = fakeSDK();
  const runtime = createAgentRuntime(await fixture(t,false),sdk.load);
  await assert.rejects(runtime.ask('这是什么？',{images:[image]}),/当前模型不支持图片输入/);
  assert.deepEqual(sdk.prompts,[]);
  await runtime.close();
});

test('invalid requests do not persist messages', async t => {
  const options = await fixture(t);
  const runtime = createAgentRuntime(options);
  await assert.rejects(runtime.post('  '), /不能为空/);
  await assert.rejects(runtime.post('x', 'another'), /main/);
  assert.deepEqual(options.store.list('messages'), []);
  await runtime.close();
});

test('SDK阶段和可见正文实时入库；不公开thinking原文或工具参数，最终正文不重复拼接', async t => {
  const options = await fixture(t, false), sdk = fakeSDK();
  const snapshots: Message[] = [];
  options.events.subscribe(event => {
    if (event.type !== 'messages.changed' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
    const message = options.store.get<Message>('messages', String(event.data.messageId));
    if (message?.role === 'assistant') snapshots.push(structuredClone(message));
  });
  sdk.session.prompt = async () => {
    const send = (event: unknown) => { for (const listener of sdk.listeners) listener(event); };
    const base = { role: 'assistant', content: [{ type: 'thinking', thinking: 'private-thought' }, { type: 'text', text: '可见回复' }], stopReason: 'stop' };
    send({ type: 'message_update', message: base, assistantMessageEvent: { type: 'thinking_delta', delta: 'private-thought' } });
    send({ type: 'tool_execution_start', toolName: 'read', args: { password: 'private-tool-argument' } });
    await new Promise(resolve => setTimeout(resolve, 270));
    send({ type: 'message_update', message: base, assistantMessageEvent: { type: 'text_delta', delta: '可见回复' } });
    await new Promise(resolve => setTimeout(resolve, 270));
    send({ type: 'message_end', message: base });
  };
  const runtime = createAgentRuntime(options, sdk.load); await runtime.post('hi'); await runtime.close();
  assert.ok(snapshots.some(message => message.status === 'pending' && message.progress?.toolName === 'read'));
  assert.ok(snapshots.some(message => message.status === 'pending' && message.text === '可见回复'));
  assert.equal(snapshots.at(-1)!.text, '可见回复'); assert.equal(snapshots.at(-1)!.status, 'done');
  assert.ok(!JSON.stringify(snapshots).includes('private-thought')); assert.ok(!JSON.stringify(snapshots).includes('private-tool-argument'));
});

test('live turns are serial; stream and thrown failures are visible and do not block later messages', async t => {
  const options = await fixture(t, false);
  const sdk = fakeSDK();
  const runtime = createAgentRuntime(options, sdk.load);
  const posted = await Promise.all(['one', 'error', 'throw', 'four'].map(text => runtime.post(text)));
  assert.ok(posted.every(message => message.status === 'pending'));
  await runtime.close();
  assert.deepEqual(sdk.prompts, ['one', 'error', 'throw', 'four']);
  assert.equal(sdk.maxActive(), 1);
  const replies = options.store.list<Message>('messages').filter(message => message.role === 'assistant');
  assert.deepEqual(replies.map(message => message.status), ['done', 'failed', 'failed', 'done']);
  assert.equal(replies[0].text, 'answer:one');
  assert.match(replies[1].text, /stream failed/);
  assert.match(replies[2].text, /provider refused/);
  assert.equal(options.published.filter(event => event.type === 'agent.error').length, 2);
  assert.equal(sdk.listeners.size, 0);
  assert.equal(sdk.calls.disposed, true);
  assert.equal(sdk.calls.settled, true);
});

test('SDK resources, credentials, and resumed sessions stay inside the data directory', async t => {
  const options = await fixture(t, false);
  const apiKey = 'synthetic-runtime-credential';
  options.config.model = { provider: 'test', model: 'fake', apiKey };
  const sdk = fakeSDK();
  const runtime = createAgentRuntime(options, sdk.load);
  await runtime.post('hello');
  await runtime.close();
  assert.equal(sdk.calls.runtimeKey, apiKey);
  const [trace] = options.store.list<AgentTurnTrace>(TRACE_COLLECTION);
  assert.ok(trace);
  assert.equal(trace.runtime?.tokenSource, 'config.model.apiKey');
  assert.match(trace.contextItems.find(item => item.id === 'req-meta')!.content, /Token Source: config\.model\.apiKey/);
  assert.equal(JSON.stringify(trace).includes(apiKey), false);
  const { loader, session, auth, settings, sessions } = sdk.calls;
  for (const flag of ['noExtensions', 'noSkills', 'noContextFiles', 'noPromptTemplates', 'noThemes']) assert.equal(loader[flag], true);
  assert.equal(loader.extensionFactories.length, 1);
  assert.deepEqual(loader.appendSystemPrompt, []);
  assert.equal(auth.authPath, join(options.config.dataDir, 'pi', 'auth.json'));
  assert.equal(auth.allowModelNetwork, false);
  assert.ok(auth.modelsPath.startsWith(options.config.dataDir));
  assert.ok(auth.modelsStorePath.startsWith(options.config.dataDir));
  assert.ok(loader.cwd.startsWith(options.config.dataDir));
  assert.ok(sessions.dir.startsWith(options.config.dataDir));
  assert.deepEqual(session.sessionManager, { resumed: true });
  assert.equal(session.noTools, 'builtin');
  assert.deepEqual(settings.packages, []);
  assert.equal(settings.retry.enabled, false);
  assert.equal(settings.cacheWarming, 'off');
  assert.equal(sdk.calls.promptOptions.expandPromptTemplates, false);
});

test('one bridge refreshes plugin tools and global knowledge; stale tools cannot execute', async t => {
  const options = await fixture(t, false);
  options.store.put('knowledge', 'g', { id: 'g', layer: 'global', title: 'Global', content: 'shared' });
  options.store.put('knowledge', 'p', { id: 'p', layer: 'personal', title: 'Personal', content: 'secret' });
  const disableKnowledge = options.contributions.add('knowledge_backends', 'memory', {
    list: async () => [{ id: 'g', layer: 'global', title: 'Global', content: 'shared', updatedAt: '' }, { id: 'b', layer: 'global', title: 'Backend', content: 'also shared', updatedAt: '' }],
    put: async () => { throw new Error('unused'); }, remove: async () => false,
  });
  const tool: Tool = { name: 'lookup', description: 'lookup data', parameters: { type: 'object' }, execute: async args => args };
  const disable = options.contributions.add('tools', 'lookup', tool);
  const sdk = fakeSDK();
  const runtime = createAgentRuntime(options, sdk.load);
  const first = await runtime.post('first');
  await new Promise<void>(resolve => {
    if (options.store.get<Message>('messages', first.id)?.status === 'done') return resolve();
    const off = options.events.subscribe(() => {
      if (options.store.get<Message>('messages', first.id)?.status === 'done') { off(); resolve(); }
    });
  });
  assert.match(sdk.calls.context.systemPrompt, /shared/);
  assert.match(sdk.calls.context.systemPrompt, /also shared/);
  assert.doesNotMatch(sdk.calls.context.systemPrompt, /secret/);
  const registered = sdk.tools.get('lookup');
  const result = await registered.execute('call', { value: 1 }, undefined);
  assert.equal(result.content[0].text, '{"value":1}');
  await disable();
  await assert.rejects(registered.execute('call', {}, undefined), /停用/);
  options.contributions.add('tools', 'new', { ...tool, name: 'new_tool' });
  await disableKnowledge();
  const second = await runtime.post('second');
  await new Promise<void>(resolve => {
    const off = options.events.subscribe(() => { if (options.store.get<Message>('messages', second.id)?.status === 'done') { off(); resolve(); } });
  });
  assert.doesNotMatch(sdk.calls.context.systemPrompt, /shared/);
  await runtime.close();
  assert.deepEqual(sdk.calls.activeTools, ['new_tool']);
});

test('missing model, credentials, and SDK report unavailable while still recording accepted messages', async t => {
  for (const reason of ['missing', 'credentials', 'sdk']) {
    const options = await fixture(t, false);
    options.config.model = { provider: 'test', model: 'fake' };
    const sdk = fakeSDK();
    sdk.calls.missingModel = reason === 'missing';
    sdk.calls.unavailable = reason === 'credentials';
    const runtime = createAgentRuntime(options, reason === 'sdk' ? async () => { throw new Error('SDK unavailable'); } : sdk.load);
    await runtime.post('hello');
    await runtime.close();
    const reply = options.store.list<Message>('messages').find(message => message.role === 'assistant')!;
    assert.equal(reply.status, 'failed');
    assert.match(reply.text, reason === 'missing' ? /未找到模型/ : reason === 'credentials' ? /凭证/ : /SDK unavailable/);
    const status = options.published.find(event => event.type === 'agent.status');
    assert.equal((status!.data as { available: boolean }).available, false);
    assert.equal(sdk.prompts.length, 0);
  }
});

test('background persistence errors surface from close', async t => {
  const options = await fixture(t);
  const put = options.store.put;
  options.store.put = (collection, id, value) => {
    if ((value as Message).role === 'assistant') throw new Error('disk full');
    put(collection, id, value);
  };
  const runtime = createAgentRuntime(options);
  await runtime.post('hello');
  await assert.rejects(runtime.close(), error => error instanceof AggregateError && error.errors[0].message === 'disk full');
});


test('server shutdown aborts an active model before waiting for its queue', async t => {
  const options = await fixture(t, false);
  const sdk = fakeSDK();
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  sdk.session.prompt = async () => { started(); await new Promise<void>(resolve => { release = resolve; }); };
  Object.assign(sdk.session, { async abort() { sdk.calls.aborted = true; release(); } });
  const runtime = createAgentRuntime(options, sdk.load);
  await runtime.post('long request');
  await running;
  await runtime.close({ abort: true });
  assert.equal(sdk.calls.aborted, true);
  assert.equal(sdk.calls.disposed, true);
});


test('each queued turn uses its persisted project and fresh active knowledge only', async t => {
  const options = await fixture(t, false);
  const sdk = fakeSDK();
  const contexts: string[] = [];
  let version = 'first-version';
  const disable = options.contributions.add('knowledge_backends', 'layers', {
    list: async () => [
      { id: 'g', layer: 'global', title: 'Principles', content: version, updatedAt: '' },
      { id: 'p', layer: 'personal', title: 'Preferences', content: 'personal-body', updatedAt: '' },
      { id: 'a', layer: 'project', projectId: 'A', title: 'Alpha', content: 'alpha-body', updatedAt: '' },
      { id: 'b', layer: 'project', projectId: 'B', title: 'Beta', content: 'beta-body', updatedAt: '' },
    ],
    put: async () => { throw new Error('unused'); }, remove: async () => false,
  });
  const originalPrompt = sdk.session.prompt.bind(sdk.session);
  sdk.session.prompt = async (text, promptOptions) => {
    await originalPrompt(text, promptOptions);
    contexts.push(sdk.calls.context.systemPrompt);
    // Change the backend between turns, including disabling it without restarting the session.
    if (text === 'alpha') version = 'second-version';
    if (text === 'directory') await disable();
  };
  const runtime = createAgentRuntime(options, sdk.load);
  const context = { projectId: 'A' };
  const first = await runtime.post('alpha', 'main', context);
  context.projectId = 'B';
  const second = await runtime.post('beta', 'main', { projectId: 'B' });
  await runtime.post('directory');
  await runtime.post('disabled', 'main', { projectId: 'A' });
  await runtime.close();
  assert.equal(first.projectId, 'A');
  assert.equal(options.store.get<Message>('messages', first.id)?.projectId, 'A');
  assert.equal(options.store.get<Message>('messages', second.id)?.projectId, 'B');
  const replies = options.store.list<Message>('messages').filter(message => message.role === 'assistant');
  assert.deepEqual(replies.map(message => message.projectId), ['A', 'B', undefined, 'A']);
  assert.match(contexts[0], /first-version/);
  assert.match(contexts[0], /personal-body/);
  assert.match(contexts[0], /alpha-body/);
  assert.doesNotMatch(contexts[0], /beta-body/);
  assert.ok(contexts[0].indexOf('first-version') < contexts[0].indexOf('personal-body'));
  assert.match(contexts[0], /"id":"a","layer":"project","projectId":"A"/);
  assert.match(contexts[0], /不得绕过全局原则/);
  assert.match(contexts[1], /second-version/);
  assert.match(contexts[1], /beta-body/);
  assert.doesNotMatch(contexts[1], /alpha-body|first-version/);
  assert.match(contexts[2], /knowledge_list/);
  assert.match(contexts[2], /"title":"Alpha","id":"a","layer":"project","projectId":"A"/);
  assert.match(contexts[2], /"title":"Beta","id":"b","layer":"project","projectId":"B"/);
  assert.doesNotMatch(contexts[2], /alpha-body|beta-body/);
  assert.doesNotMatch(contexts[3], /first-version|second-version|personal-body|alpha-body|beta-body|Alpha|Beta/);
  assert.match(sdk.calls.loader.systemPrompt, /knowledge_list.*executors_list.*cwd.*work_dispatch/);
  assert.match(sdk.calls.loader.systemPrompt, /异步返回.*不代表工作完成/);
  assert.match(sdk.calls.loader.systemPrompt, /工作结果会由系统回送/);
  assert.match(sdk.calls.loader.systemPrompt, /unknown.*不能自动重派/);
});

test('invalid project context is rejected before persistence', async t => {
  const options = await fixture(t);
  const runtime = createAgentRuntime(options);
  await assert.rejects(runtime.post('hello', 'main', { projectId: ' ' }), /projectId/);
  assert.deepEqual(options.store.list('messages'), []);
  await runtime.close();
});


test('currentInput follows the executing turn rather than queued users and clears on failure', async t => {
  const options = await fixture(t, false);
  const sdk = fakeSDK();
  const runtime = createAgentRuntime(options, sdk.load);
  const observed: Message[] = [];
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalPrompt = sdk.session.prompt.bind(sdk.session);
  sdk.session.prompt = async (text, promptOptions) => {
    observed.push(structuredClone(runtime.currentInput()!));
    if (text === 'first') { started(); await gate; }
    await originalPrompt(text, promptOptions);
  };
  assert.equal(runtime.currentInput(), undefined);
  const first = await runtime.post('first', 'main', { projectId: 'A' });
  await running;
  assert.equal(runtime.currentInput()?.id, first.id);
  const second = await runtime.post('throw', 'main', { projectId: 'B' });
  const third = await runtime.post('last');
  assert.equal(runtime.currentInput()?.id, first.id);
  assert.equal(runtime.currentInput()?.projectId, 'A');
  // Completed/failed turn persistence happens after the active input is cleared.
  const off = options.events.subscribe(event => {
    if (event.type !== 'messages.changed') return;
    const message = options.store.get<Message>('messages', (event.data as { messageId: string }).messageId);
    if (message?.status !== 'pending') assert.equal(runtime.currentInput(), undefined);
  });
  release();
  await runtime.close();
  off();
  assert.deepEqual(observed.map(message => [message.id, message.projectId]), [
    [first.id, 'A'], [second.id, 'B'], [third.id, undefined],
  ]);
  assert.equal(options.store.get<Message>('messages', second.id)?.status, 'failed');
  assert.equal(runtime.currentInput(), undefined);
});

test('restart surfaces interrupted durable inputs once without replaying a model or tool turn', async t => {
  const f = await fixture(t);
  const input: Message = { id: 'pending-before-crash', role: 'user', conversationId: 'main', text: 'do work', status: 'pending', createdAt: '' };
  f.store.put('messages', input.id, input);
  const runtime = createAgentRuntime(f, async () => { throw new Error('demo must never load SDK'); });
  assert.equal(f.store.get<Message>('messages', input.id)?.status, 'failed');
  assert.match(f.store.get<Message>('messages', `interrupted:${input.id}`)!.text, /不会自动重复/);
  assert.equal(f.store.list<Message>('messages').length, 2);
  await runtime.close();
  const restarted = createAgentRuntime(f, async () => { throw new Error('must not replay'); });
  await restarted.close();
  assert.equal(f.store.list<Message>('messages').length, 2);
});

test('older partial replies become terminal and cannot be stopped after restart', async t => {
  const f = await fixture(t);
  const input: Message = { id: 'old-input', role: 'user', conversationId: 'main', text: '原输入', status: 'failed', createdAt: '' };
  f.store.put('messages', input.id, input);
  const draft: Message = { ...input, id: 'old-draft', role: 'assistant', status: 'pending', text: '保留未完成的片段', replyTo: input.id };
  f.store.put('messages', draft.id, draft);
  f.store.put('messages', `interrupted:${input.id}`, { ...draft, id: `interrupted:${input.id}`, status: 'failed', text: '服务重启' });
  const runtime = createAgentRuntime(f);
  assert.deepEqual(f.store.get<Message>('messages', draft.id), { ...draft, status: 'failed' });
  assert.equal(f.store.list('messages').length, 3);
  assert.deepEqual(runtime.interruptTurn(input.id), { outcome: 'idle' });
  await runtime.close();
});

test('main and supervisor have independent queues and never recover each other pending input', async t => {
  const f = await fixture(t);
  const main = createAgentRuntime(f);
  const pending = await main.post('main pending');
  const supervisor = createAgentRuntime({ ...f, conversationId: 'supervisor' });
  assert.equal(f.store.get<Message>('messages', pending.id)!.status, 'pending');
  const answer = await supervisor.ask('review a run', { projectId: 'A', readOnly: true });
  assert.equal(answer.conversationId, 'supervisor');
  assert.equal(answer.projectId, 'A');
  await assert.rejects(supervisor.post('wrong destination', 'main'), /supervisor/);
  await Promise.all([main.close(), supervisor.close()]);
  assert.equal(f.store.list<Message>('messages').filter(message => message.conversationId === 'main').length, 2);
  assert.equal(f.store.list<Message>('messages').filter(message => message.conversationId === 'supervisor').length, 2);
});

test('read-only model assessments cannot register mutation tools and ask surfaces model failures', async t => {
  const f = await fixture(t, false); const sdk = fakeSDK();
  f.contributions.add('tools', 'read', {name:'knowledge_list',description:'read',parameters:{type:'object'},async execute(){return []}});
  f.contributions.add('tools', 'write', {name:'work_dispatch',description:'write',parameters:{type:'object'},async execute(){throw new Error('must not mutate')}});
  const runtime = createAgentRuntime({...f,conversationId:'supervisor'},sdk.load);
  const reply = await runtime.ask('assess', { readOnly: true });
  assert.equal(reply.conversationId, 'supervisor');
  assert.ok(sdk.tools.has('knowledge_list')); assert.equal(sdk.tools.has('work_dispatch'),false);
  await assert.rejects(runtime.ask('throw', {readOnly:true}), /回复失败/);
  await runtime.close();
});

test('主动跟进的通知权限仅对本轮生效，等待用户回答时立即撤回', async t => {
  const f = await fixture(t, false), sdk = fakeSDK();
  let sent = 0;
  f.contributions.add('tools', 'notify', { name: 'notify_user', description: 'notify', parameters: { type: 'object' },
    async execute() { sent++; return {}; } });
  const runtime = createAgentRuntime(f, sdk.load);
  const original = sdk.session.prompt.bind(sdk.session);
  sdk.session.prompt = async (text, options) => {
    const notify = () => sdk.tools.get('notify_user').execute('check', {}, new AbortController().signal);
    if (text === '巡查') {
      assert.ok(sdk.calls.activeTools.includes('notify_user'));
      await notify();
      f.store.put('input-paused', runtime.currentInput()!.id, { cardId: 'fixture' });
    } else {
      assert.ok(!sdk.calls.activeTools.includes('notify_user'));
    }
    await assert.rejects(notify(), /等待交互卡回答/);
    return original(text, options);
  };
  try {
    await Promise.all([
      runtime.ask('巡查', { readOnly: true, readOnlyAction: 'notify_user' }),
      runtime.ask('晚报', { readOnly: true }),
    ]);
    assert.equal(sent, 1);
  } finally { await runtime.close(); }
});

test('opening a blocking question prevents writes from the old turn but permits its new continuation', async t => {
  const f=await fixture(t,false);const sdk=fakeSDK();let writes=0;
  f.contributions.add('tools','write',{name:'todo_create',description:'write',parameters:{type:'object'},async execute(){writes++;return {saved:true}}});
  const runtime=createAgentRuntime(f,sdk.load);const original=sdk.session.prompt.bind(sdk.session);
  sdk.session.prompt=async(text:string,options:unknown)=>{
    if(text==='old turn') {
      f.store.put('input-paused',runtime.currentInput()!.id,{cardId:'q'});
      await assert.rejects(sdk.tools.get('todo_create').execute('blocked',{},new AbortController().signal),/等待交互卡回答/);
    } else await sdk.tools.get('todo_create').execute('allowed',{},new AbortController().signal);
    return original(text,options);
  };
  await runtime.ask('old turn');assert.equal(writes,0);
  await runtime.ask('continuation');assert.equal(writes,1);await runtime.close();
});

test('project memory and real progress are refreshed in the next model turn',async t=>{
 const options=await fixture(t,false),sdk=fakeSDK();let memory='MEMORY-V1';
 const runtime=createAgentRuntime({...options,projectContext:id=>({projectId:id,memory,progress:{open:2,completed:0}})},sdk.load);
 try{await runtime.ask('read project',{projectId:'A'});assert.match(sdk.calls.context.systemPrompt,/MEMORY-V1/);assert.match(sdk.calls.context.systemPrompt,/"projectId":"A"/);memory='MEMORY-V2';await runtime.ask('continue project',{projectId:'A'});assert.match(sdk.calls.context.systemPrompt,/MEMORY-V2/);assert.doesNotMatch(sdk.calls.context.systemPrompt,/MEMORY-V1/);assert.match(sdk.calls.context.systemPrompt,/"completed":0/);}finally{await runtime.close();}
});

test('working decisions are re-read before every SDK turn, with current scope and no accumulated old versions', async t => {
  const f=await fixture(t,false),sdk=fakeSDK();let version=1;const scopes:unknown[]=[];
  const runtime=createAgentRuntime({...f,scope:{kind:'project',projectId:'a'},conversationId:'project:a:work',workDecisions:(scope,projectId)=>{scopes.push([scope,projectId]);return{items:[{id:'fact',version,text:version===1?'FIRST_FACT':'CORRECTED_FACT'}]};}},sdk.load);
  await runtime.ask('first');assert.match(sdk.calls.context.systemPrompt,/FIRST_FACT/);version=2;
  await runtime.ask('next');assert.match(sdk.calls.context.systemPrompt,/CORRECTED_FACT/);assert.doesNotMatch(sdk.calls.context.systemPrompt,/FIRST_FACT/);
  assert.deepEqual(scopes,[[{kind:'project',projectId:'a'},'a'],[{kind:'project',projectId:'a'},'a']]);await runtime.close();
});
test('project decision tools pin list/create and reject foreign references; result turns have no decision mutations', async t => {
  const f=await fixture(t,false),sdk=fakeSDK();const called:unknown[]=[];
  f.store.put('work.decisions','own',{scope:{kind:'project',projectId:'a'}});f.store.put('work.decisions','foreign',{scope:{kind:'project',projectId:'b'}});f.store.put('work.decisions','child',{scope:{kind:'task',projectId:'a',todoId:'child'}});
  for(const name of ['work_decisions_list','work_decision_record','work_decision_reference','work_decision_correct','work_decision_withdraw'])f.contributions.add('tools',name,{name,description:name,parameters:{type:'object'},async execute(args){called.push([name,args]);return{name};}});
  const runtime=createAgentRuntime({...f,scope:{kind:'project',projectId:'a'},conversationId:'project:a:work'},sdk.load),original=sdk.session.prompt.bind(sdk.session);
  sdk.session.prompt=async(text:string,options:unknown)=>{
    const execute=(name:string,args:unknown)=>sdk.tools.get(name).execute('call',args,new AbortController().signal);
    await execute('work_decisions_list',{});
    await execute('work_decision_reference',{id:'own',version:1});await execute('work_decision_reference',{id:'child',version:1});
    await assert.rejects(execute('work_decision_reference',{id:'foreign',version:1}),/作用域/);
    if(text==='result')assert.equal(sdk.calls.activeTools.includes('work_decision_record'),false);
    else{await execute('work_decision_record',{key:'stable',text:'明确决定'});await assert.rejects(execute('work_decision_record',{key:'x',text:'跨项目',projectId:'b'}),/作用域/);}
    return original(text,options);
  };
  await runtime.ask('user');await runtime.ask('result',{readOnly:true,origin:'result'});
  assert.ok(called.some(x=>JSON.stringify(x)===JSON.stringify(['work_decision_record',{key:'stable',text:'明确决定',projectId:'a'}])));
  assert.ok(called.filter(x=>Array.isArray(x)&&x[0]==='work_decisions_list').every(x=>(x as any)[1].projectId==='a'));
  await runtime.close();
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('stop pins one input, retains streamed text and skips a stopped queued input', async t => {
  const options = await fixture(t, false);
  const sdk = fakeSDK();
  const original = sdk.session.prompt.bind(sdk.session);
  const running = barrier();
  const release = barrier();
  const abortDone = barrier();
  let aborts = 0;
  let publish: ((event: unknown) => void) | undefined;
  const subscribe = sdk.session.subscribe.bind(sdk.session);
  sdk.session.subscribe = listener => { publish = listener; return subscribe(listener); };
  sdk.session.prompt = async (text, opts) => {
    if (text !== 'active') return original(text, opts);
    const write = (content: string) => publish!({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: content }] },
      assistantMessageEvent: { type: 'text_delta' } });
    write('已经生成的片段');
    running.resolve();
    await release.promise;
    write('取消后的迟到片段');
  };
  Object.assign(sdk.session, { async abort() { aborts++; release.resolve(); await abortDone.promise; } });
  const runtime = createAgentRuntime(options, sdk.load);
  const active = await runtime.post('active');
  await running.promise;
  const queued = await runtime.post('queued');
  const next = await runtime.post('next');
  assert.deepEqual(runtime.interruptTurn('other'), { outcome: 'idle' });
  assert.deepEqual(runtime.interruptTurn(queued.id), { outcome: 'requested' });
  assert.equal(aborts, 0);
  assert.deepEqual(runtime.interruptTurn(active.id), { outcome: 'requested' });
  assert.deepEqual(runtime.interruptTurn(active.id), { outcome: 'idle' });
  assert.equal(aborts, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sdk.prompts, []);
  abortDone.resolve();
  await runtime.close();
  const messages = options.store.list<Message>('messages');
  const answer = (input: Message) => messages.filter(row => row.replyTo === input.id);
  assert.deepEqual(sdk.prompts, ['next']);
  assert.equal(answer(active).length, 1);
  assert.equal(answer(active)[0].text, '已经生成的片段\n\n已停止本轮回复。');
  assert.equal(answer(active)[0].progress?.phase, 'responding');
  assert.equal(answer(active)[0].progress?.detail, '正在生成回复');
  assert.equal(answer(queued)[0].text, '已停止本轮回复。');
  assert.equal(answer(next)[0].status, 'done');
  for (const row of [active, queued]) {
    assert.equal(options.store.get<Message>('messages', row.id)?.status, 'failed');
    assert.equal(options.store.get<Message>('messages', row.id)?.stoppedByUser, true);
    assert.equal(answer(row)[0].stoppedByUser, true);
  }
  assert.equal(answer(next)[0].stoppedByUser, undefined);
  assert.equal(options.store.list<AgentTurnTrace>(TRACE_COLLECTION).find(row => row.userMessageId === active.id)?.status, 'failed');
  assert.deepEqual(runtime.interruptTurn(next.id), { outcome: 'idle' });
});

test('stop during startup is durable before the SDK resolves and never enters prompt', async t => {
  const options = await fixture(t, false);
  const sdk = fakeSDK();
  const startup = barrier();
  const runtime = createAgentRuntime(options, async () => { await startup.promise; return sdk.load(); });
  const first = await runtime.post('waiting');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runtime.interruptTurn(first.id), { outcome: 'requested' });
  assert.equal(options.store.get<Message>('messages', first.id)?.status, 'failed');
  startup.resolve();
  await runtime.close();
  assert.deepEqual(sdk.prompts, []);
});

test('stop during SDK preflight is applied again after the run acquires an abort controller', async t => {
  const options = await fixture(t, false);
  const sdk = fakeSDK();
  const preflight = barrier();
  const begin = barrier();
  const aborted = barrier();
  let started = false;
  Object.assign(sdk.session, { async abort() { if (started) aborted.resolve(); } });
  sdk.session.prompt = async (_text, opts) => {
    preflight.resolve();
    await begin.promise;
    started = true;
    (opts as { preflightResult(result: string): void }).preflightResult('started');
    await aborted.promise;
  };
  const runtime = createAgentRuntime(options, sdk.load);
  const first = await runtime.post('preflight');
  await preflight.promise;
  assert.deepEqual(runtime.interruptTurn(first.id), { outcome: 'requested' });
  begin.resolve();
  await runtime.close();
  assert.equal(options.store.get<Message>('messages', first.id)?.status, 'failed');
});

test('Web 排队取消仅作用于未开始的消息，顺序、迟到点击和取消重放可核对', async t=>{
  const f=await fixture(t,false),sdk=fakeSDK();
  const {createStore}=await import('../packages/core/src/store.ts');
  f.store=createStore(':memory:');
  t.after(()=>f.store.close());
  let loaded!:()=>void;
  const gate=new Promise<void>(ok=>{loaded=ok;});
  const runtime=createAgentRuntime({...f,validateQueuedWebInput(input){if(input.text==='已移动')throw Error('原待办归属变化');}},async()=>{await gate;return sdk.load();});
  const send=(text:string)=>runtime.post(text,'main',{directWebInput:true});
  const first=await send('第一条'), second=await send('取消这条'), internal=await runtime.post('内部回投','main',{origin:'result'}), third=await send('第三条');
  assert.equal(first.queueState,'queued');assert.equal(internal.queueState,undefined);
  assert.deepEqual(runtime.queuedWebInputs().map(m=>m.id),[first.id,second.id,third.id]);
  await t.waitFor(()=>assert.equal(f.store.get<Message>('messages',first.id)?.queueState,'running'));
  assert.deepEqual(runtime.queuedWebInputs().map(m=>m.id),[second.id,third.id]);
  assert.deepEqual(runtime.cancelQueuedTurn(first.id),{outcome:'started'});
  assert.deepEqual(runtime.cancelQueuedTurn(internal.id),{outcome:'idle'});
  // A failure while preparing the draft rolls back its receipts and keeps the queue slot.
  assert.throws(()=>runtime.cancelQueuedTurn(second.id,()=>{
    f.store.put('test.receipts',second.id,{prepared:true});
    throw Error('附件原件缺失');
  }),/附件原件缺失/);
  assert.equal(f.store.get('test.receipts',second.id),undefined);
  assert.deepEqual(runtime.queuedWebInputs().map(m=>m.id),[second.id,third.id]);
  assert.deepEqual(runtime.cancelQueuedTurn(second.id),{outcome:'cancelled'});
  assert.deepEqual(runtime.cancelQueuedTurn(second.id),{outcome:'cancelled'});
  assert.deepEqual(runtime.queuedWebInputs().map(m=>m.id),[third.id]);
  const moved=await send('已移动');
  loaded();await runtime.close();
  assert.deepEqual(sdk.prompts,['第一条','内部回投','第三条']);
  const failed=f.store.list<Message>('messages').find(m=>m.replyTo===moved.id)!;
  assert.match(failed.text,/原待办归属变化/);assert.equal(failed.retryable,undefined);
  assert.equal(f.store.get<Message>('messages',first.id)?.queueState,undefined);
  assert.equal(f.store.get<Message>('messages',second.id)?.queueState,'cancelled');
  assert.equal(f.store.list<Message>('messages').some(m=>m.replyTo===second.id),false);
  const reopened=createAgentRuntime(f,sdk.load);
  assert.deepEqual(reopened.cancelQueuedTurn(second.id),{outcome:'cancelled'});
  await reopened.close();
});

test('重启只为明确尚未开始的 Web 队列项登记手动重试',async t=>{
  const f=await fixture(t,true);
  for(const state of ['queued','running','legacy'] as const){
    const msg:Message={id:state,role:'user',text:'保留原文',status:'pending',conversationId:'main',directWebInput:true,todoId:'todo',createdAt:new Date().toISOString(),
      ...(state==='legacy'?{}:{queueState:state})};
    f.store.put('messages',msg.id,msg);
  }
  const runtime=createAgentRuntime(f);
  const replies=f.store.list<Message>('messages').filter(m=>m.role==='assistant');
  assert.equal(replies.length,3);
  for(const reply of replies){
    assert.equal(f.store.get<Message>('messages',reply.replyTo!)?.queueState,undefined);
    assert.equal(!!reply.retryable,reply.replyTo==='queued');
    assert.equal(!!f.store.get('retryableFailures',reply.id),reply.replyTo==='queued');
  }
  const notice=replies.find(m=>m.retryable)!;
  assert.match(notice.text,/尚未开始/);assert.equal(notice.origin,undefined);
  const retried=await runtime.retryFailedInput(f.store.get<Message>('messages','queued')!,notice);
  assert.equal(retried.queueState,'queued');assert.equal(retried.todoId,'todo');
  await runtime.close();
});

test('工作台重启时恢复项目队列，只打开工作区即可看到可重试的原消息',async t=>{
  const {createStore}=await import('../packages/core/src/store.ts');
  const {createWorkbench}=await import('../packages/core/src/workbench.ts');
  const dir=await mkdtemp(join(tmpdir(),'mario-queued-project-'));
  const seed=createStore(join(dir,'workbench.sqlite'));
  const now=new Date().toISOString(), id='queue-project', conversationId='project:'+id+':work';
  seed.put('projects',id,{id,name:'项目样本',description:'',createdAt:now,updatedAt:now});
  seed.put('messages','waiting',{id:'waiting',role:'user',conversationId,projectId:id,text:'未开始的请求',directWebInput:true,status:'pending',queueState:'queued',createdAt:now} satisfies Message);
  seed.close();
  const app=await createWorkbench({host:'127.0.0.1',port:0,dataDir:dir,demo:true});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const view=await app.projectWorkspace.view(id);
  assert.match(view.agents.work.reason??'',/按需初始化/);
  assert.equal(view.messages.find(m=>m.id==='waiting')?.status,'failed');
  const notice=view.messages.find(m=>m.retryable && m.replyTo==='waiting')!;
  assert.ok(notice);
  const resent=await app.retryFailedReply(notice.id,conversationId);
  assert.equal(resent.retryOf,notice.id); assert.equal(resent.text,'未开始的请求');
});

test('重排调换实际 Web 轮次，保留内部消息和其他范围的槽位与权限，ask 等到自己的答复',async t=>{
  const f=await fixture(t,false), sdk=fakeSDK();
  f.contributions.add('tools','notify',{name:'notify_user',description:'通知',parameters:{type:'object'},async execute(){return {};}});
  let load!:()=>void, finish!:()=>void, lastEntered=false, answered=false;
  const startup=new Promise<void>(ok=>{load=ok;}), last=new Promise<void>(ok=>{finish=ok;});
  const runtime=createAgentRuntime(f,async()=>{await startup;return sdk.load();});
  const original=sdk.session.prompt.bind(sdk.session);
  sdk.session.prompt=async(text,opts)=>{
    if(text==='问答'){lastEntered=true;assert.ok(!sdk.calls.activeTools.includes('notify_user'));await last;}
    if(text==='内部')assert.ok(sdk.calls.activeTools.includes('notify_user'));
    await original(text,opts);
  };
  const send=(text:string,projectId?:string)=>runtime.post(text,'main',{directWebInput:true,projectId});
  const head=await send('运行中');
  await t.waitFor(()=>assert.equal(f.store.get<Message>('messages',head.id)?.queueState,'running'));
  const result=runtime.ask('问答',{directWebInput:true,readOnly:true}).finally(()=>{answered=true;});
  const a=runtime.queuedWebInputs().find(m=>m.text==='问答')!;
  const internal=await runtime.post('内部','main',{origin:'notification',readOnly:true,readOnlyAction:'notify_user'});
  const other=await send('其他范围','project-different');
  const b=await send('提前');
  const cancelled=await send('仍能取消');
  runtime.reorderQueuedInputs([a.id,b.id],[b.id,a.id]);
  assert.deepEqual(runtime.queuedWebInputs().map(m=>m.id),[b.id,other.id,a.id,cancelled.id]);
  assert.throws(()=>runtime.reorderQueuedInputs([a.id,b.id],[a.id,b.id]),{status:409});
  for(const id of [internal.id,head.id]) assert.throws(()=>runtime.reorderQueuedInputs([id,b.id],[b.id,id]),{status:409});
  assert.throws(()=>runtime.reorderQueuedInputs([b.id,a.id],[b.id,b.id]),{status:400});
  assert.equal(runtime.cancelQueuedTurn(cancelled.id).outcome,'cancelled');
  load();
  await t.waitFor(()=>assert.ok(lastEntered));
  assert.equal(answered,false);assert.deepEqual(sdk.prompts,['运行中','提前','内部','其他范围']);
  finish();
  assert.equal((await result).replyTo,a.id);
  await runtime.close();
  assert.deepEqual(sdk.prompts,['运行中','提前','内部','其他范围','问答']);
});

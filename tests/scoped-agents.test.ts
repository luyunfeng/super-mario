import { createContributions } from '../packages/core/src/plugin-host.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createScopedAgents } from '../packages/core/src/scoped-agents.ts';
import { createAgentRuntime } from '../packages/core/src/agent-runtime/index.ts';
import type { AppConfig, AppEvent, Json, JsonObject, Message } from '../packages/protocol/src/index.ts';
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


function seed(f: Awaited<ReturnType<typeof fixture>>) {
  for (const id of ['A', 'B']) f.store.put('projects', id, { id, name: id });
  for (const [id, projectId] of [['a', 'A'], ['a2', 'A'], ['b', 'B']]) f.store.put('todos', id, { id, projectId });
}
function addTool(f: Awaited<ReturnType<typeof fixture>>, name: string, execute: Tool['execute']) {
  f.contributions.add('tools', name, { name, description: name, parameters: { type: 'object' }, execute });
}

test('registered tools revalidate the executing stored input when its scope is revoked during prompt', async t => {
  for (const revokeBeforeFirstCall of [true, false]) {
    const f = await fixture(t, false); seed(f); const sdk = fakeSDK();
    let revoked = false;
    let writes = 0;
    const checked: Message[] = [];
    const scope = { kind: 'project', projectId: 'A' } as const;
    addTool(f, 'work_dispatch', async () => { writes++; return { accepted: true }; });
    const runtime = createAgentRuntime({ ...f, conversationId: 'bot:revocation', scope,
      canUseScope(input) {
        if (!input) return true;
        assert.deepEqual(input, f.store.get<Message>('messages', input.id));
        checked.push(input);
        return !revoked || input.text === 'next';
      },
      botContext(conversationId, runtimeScope) {
        assert.equal(conversationId, 'bot:revocation');
        assert.deepEqual(runtimeScope, scope);
        return { checkedScope: runtimeScope!.kind };
      },
    }, sdk.load);
    const prompt = sdk.session.prompt.bind(sdk.session);
    let queued: Message | undefined;
    sdk.session.prompt = async (text, options) => {
      if (text === 'current') {
        const registered = sdk.tools.get('work_dispatch');
        assert.ok(registered, 'tool was registered before revocation');
        if (!revokeBeforeFirstCall) await registered.execute('before', {}, undefined);
        revoked = true;
        // Admission must not accidentally revalidate this revoked, still executing input.
        queued = await runtime.post('next');
        await assert.rejects(registered.execute('after', {}, undefined), /当前轮次/);
        assert.equal(checked.at(-1)?.text, 'current');
        assert.notEqual(checked.at(-1)?.id, queued.id);
      } else {
        assert.equal(runtime.currentInput()?.id, queued!.id);
        await sdk.tools.get('work_dispatch').execute('next', {}, undefined);
      }
      await prompt(text, options);
    };
    try {
      await assert.rejects(runtime.ask('current'), /输入授权或绑定范围已失效/);
      const current = f.store.list<Message>('messages').find(message => message.role === 'user' && message.text === 'current')!;
      await runtime.close();
      assert.equal(writes, revokeBeforeFirstCall ? 1 : 2);
      assert.equal(f.store.get<Message>('messages', current.id)?.status, 'failed');
      assert.equal(f.store.get<Message>('messages', queued!.id)?.status, 'done');
      assert.match(sdk.calls.context.systemPrompt, /"checkedScope":"project"/);
      assert.ok(checked.some(input => input.id === current.id));
      assert.ok(checked.some(input => input.id === queued!.id));
    } finally { await runtime.close(); }
  }
});

test('scoped manager forwards persisted inputs for queued validation and read-only result reports', async t => {
  const f = await fixture(t); seed(f);
  const checked: Message[] = [];
  const manager = createScopedAgents({ ...f, validScope(scope, botId, input) {
    assert.deepEqual(scope, { kind: 'project', projectId: 'A' });
    assert.equal(botId, 'bot');
    if (!input) return true;
    assert.deepEqual(input, f.store.get<Message>('messages', input.id));
    checked.push(input);
    return input.origin === 'result';
  } });
  const rejected = await manager.post('revoked queued input', { kind: 'project', projectId: 'A' }, 'bot');
  const report = await manager.post('result report', { kind: 'project', projectId: 'A' }, 'bot', {
    origin: 'result', readOnly: true, replyTo: 'run-result',
  });
  await manager.close();
  assert.deepEqual(checked.map(input => input.id), [rejected.id, report.id]);
  assert.equal(f.store.get<Message>('messages', rejected.id)?.status, 'failed');
  assert.equal(f.store.get<Message>('messages', report.id)?.status, 'done');
  assert.equal(checked[1].readOnly, true);
  assert.equal(checked[1].replyTo, 'run-result');
});

test('read-only result prompts retain reads and reject previously registered writes', async t => {
  const f = await fixture(t, false); const sdk = fakeSDK();
  let writes = 0;
  addTool(f, 'knowledge_list', async () => []);
  addTool(f, 'work_dispatch', async () => { writes++; return {}; });
  const runtime = createAgentRuntime({ ...f, conversationId: 'bot:readonly', scope: { kind: 'global' },
    canUseScope(input) {
      if (input) assert.deepEqual(input, f.store.get<Message>('messages', input.id));
      return true;
    },
  }, sdk.load);
  const prompt = sdk.session.prompt.bind(sdk.session);
  sdk.session.prompt = async (text, options) => {
    if (text === 'report') {
      assert.equal(runtime.currentInput()?.origin, 'result');
      assert.deepEqual(sdk.calls.activeTools, ['knowledge_list']);
      await sdk.tools.get('knowledge_list').execute('read', {}, undefined);
      await assert.rejects(sdk.tools.get('work_dispatch').execute('write', {}, undefined), /只读/);
    }
    await prompt(text, options);
  };
  try {
    await runtime.ask('register writes');
    await runtime.ask('report', { origin: 'result', readOnly: true });
    assert.equal(writes, 0);
  } finally { await runtime.close(); }
});

test('lazy manager isolates each bot/scope conversation, pins demo projects, and shares durable records', async t => {
  const f = await fixture(t); seed(f);
  const manager = createScopedAgents(f);
  assert.deepEqual(manager.list(), []);
  assert.equal(manager.status({ kind: 'project', projectId: 'A' }, 'one').available, false);
  assert.deepEqual(manager.list(), []);
  const scopes = [{ kind: 'project', projectId: 'A' }, { kind: 'project', projectId: 'B' },
    { kind: 'task', todoId: 'a' }, { kind: 'global' }, { kind: 'unmarked' }] as const;
  const messages = await Promise.all(scopes.map(scope => manager.post('hello', scope, 'one')));
  const other = await manager.post('another bot', scopes[0], 'two');
  assert.equal(new Set([...messages, other].map(message => message.conversationId)).size, 6);
  assert.deepEqual(messages.map(message => message.projectId), ['A', 'B', 'A', undefined, undefined]);
  assert.equal(messages[4].readOnly, true);
  assert.equal((await manager.post('same identity', scopes[0], 'one')).conversationId, messages[0].conversationId);
  assert.equal(manager.tryLockConfiguration(), false);
  await manager.close();
  const all = f.store.list<Message>('messages');
  assert.equal(all.filter(message => message.role === 'assistant').length, 7);
  assert.ok(all.filter(message => message.role === 'assistant').every(message => message.text.includes('本地演示')));
  const restarted = createScopedAgents(f);
  assert.equal((await restarted.post('restart', scopes[0], 'one')).conversationId, messages[0].conversationId);
  await restarted.close();
});

test('manager validates authoritative task projects and refuses invalid/disabled scopes before persistence', async t => {
  const f = await fixture(t); seed(f);
  const manager = createScopedAgents({ ...f, validScope: (_scope, botId) => botId !== 'disabled' });
  await assert.rejects(manager.post('bad', { kind: 'project', projectId: 'missing' }, 'bot'), /不存在/);
  await assert.rejects(manager.post('bad', { kind: 'task', todoId: 'a', projectId: 'B' }, 'bot'), /不符/);
  await assert.rejects(manager.post('bad', { kind: 'task', todoId: 'missing' }, 'bot'), /不存在/);
  await assert.rejects(manager.post('bad', { kind: 'global' }, 'disabled'), /失效/);
  assert.deepEqual(f.store.list('messages'), []);
  assert.deepEqual(manager.list(), []);
  await manager.close();
});

test('project bridge pins writes, filters reads and rejects nested or referenced cross-scope work', async t => {
  const f = await fixture(t, false); seed(f); const sdk = fakeSDK();
  f.store.put('runs', 'ra', { id: 'ra', projectId: 'A', todoId: 'a' });
  f.store.put('runs', 'rb', { id: 'rb', projectId: 'B', todoId: 'b' });
  f.store.put('knowledge', 'private', { id: 'private', layer: 'personal' });
  const writes: { name: string; args: Json }[] = [];
  for (const name of ['work_dispatch', 'todo_create', 'task_plan', 'knowledge_source', 'knowledge_ingest', 'knowledge_put']) {
    addTool(f, name, async args => { writes.push({ name, args }); return args; });
  }
  const knowledge: JsonObject[] = [
    { id: 'g', layer: 'global', content: 'global-body' },
    { id: 'p', layer: 'personal', content: 'personal-body' },
    { id: 'ka', layer: 'project', projectId: 'A', content: 'alpha-body' },
    { id: 'kb', layer: 'project', projectId: 'B', content: 'beta-body' },
  ];
  addTool(f, 'knowledge_list', async () => knowledge);
  addTool(f, 'todos_list', async () => f.store.list('todos'));
  addTool(f, 'runs_list', async () => f.store.list('runs'));
  addTool(f, 'projects_list', async () => f.store.list('projects'));
  for (const name of ['run_commit_diff', 'run_worktree_status']) addTool(f, name, async args => ({ id: args.id }));
  addTool(f, 'work_read', async args => ({ screen: String(args.id) }));
  for (const name of ['project_create', 'interaction_answer', 'interactions_list', 'brief_read', 'policy_set', 'unknown']) {
    addTool(f, name, async () => { throw new Error('must not execute'); });
  }
  f.contributions.add('knowledge_backends', 'test', { list: async () => knowledge as any, put: async () => { throw new Error('unused'); }, remove: async () => false });
  const runtime = createAgentRuntime({ ...f, conversationId: 'bot:project:A', scope: { kind: 'project', projectId: 'A' } }, sdk.load);
  await runtime.ask('hello');
  assert.match(sdk.calls.context.systemPrompt, /global-body/);
  assert.match(sdk.calls.context.systemPrompt, /alpha-body/);
  assert.doesNotMatch(sdk.calls.context.systemPrompt, /personal-body|beta-body|"id":"kb"/);
  const invoke = async (name: string, args: Json = {}) => (await sdk.tools.get(name).execute('call', args, undefined)).details;
  assert.deepEqual((await invoke('knowledge_list')).map((entry: any) => entry.id), ['g', 'ka']);
  assert.deepEqual((await invoke('todos_list')).map((entry: any) => entry.id), ['a', 'a2']);
  assert.deepEqual((await invoke('runs_list')).map((entry: any) => entry.id), ['ra']);
  assert.deepEqual((await invoke('projects_list')).map((entry: any) => entry.id), ['A']);
  for (const name of ['project_create', 'interaction_answer', 'interactions_list', 'brief_read', 'policy_set', 'unknown']) assert.equal(sdk.tools.has(name), false);
  const args = { prompt: 'do work' };
  assert.equal((await invoke('work_dispatch', args)).projectId, 'A');
  assert.deepEqual(args, { prompt: 'do work' });
  assert.equal((await invoke('todo_create')).projectId, 'A');
  assert.equal((await invoke('knowledge_ingest')).layer, 'project');
  assert.deepEqual((await invoke('task_plan', { tasks: [{ prompt: 'one' }] })).tasks, [{ prompt: 'one', projectId: 'A' }]);
  const count = writes.length;
  for (const name of ['work_dispatch', 'todo_create', 'knowledge_source', 'knowledge_put']) await assert.rejects(invoke(name, { projectId: 'B' }), /跨作用域/);
  await assert.rejects(invoke('work_dispatch', { todoId: 'b' }), /作用域/);
  await assert.rejects(invoke('task_plan', { tasks: [{ projectId: 'A' }, { projectId: 'B' }] }), /跨作用域/);
  await assert.rejects(invoke('knowledge_put', { layer: 'global' }), /项目知识/);
  await assert.rejects(invoke('knowledge_put', { id: 'private' }), /作用域/);
  await assert.rejects(invoke('knowledge_list', { layer: 'personal' }), /知识层/);
  await assert.rejects(invoke('knowledge_list', { projectId: 'B' }), /跨作用域/);
  await assert.rejects(invoke('work_read', { id: 'rb' }), /作用域/);
  assert.equal((await invoke('work_read', { id: 'ra' })).screen, 'ra');
  assert.deepEqual(await invoke('run_commit_diff', { id: 'ra' }), { id: 'ra' });
  await assert.rejects(invoke('run_commit_diff', { id: 'rb' }), /作用域/);
  await assert.rejects(invoke('run_worktree_status', { id: 'rb' }), /作用域/);
  assert.equal(writes.length, count);
  await assert.rejects(runtime.post('wrong project', undefined, { projectId: 'B' }), /作用域不符/);
  await runtime.close();
});

test('task bridge pins todoId including nested plans and denies creating unrelated todos', async t => {
  const f = await fixture(t, false); seed(f); const sdk = fakeSDK();
  for (const name of ['work_dispatch', 'task_plan', 'todo_create']) addTool(f, name, async args => args);
  addTool(f, 'todos_list', async () => f.store.list('todos'));
  addTool(f, 'runs_list', async () => [{ id: 'one', todoId: 'a', projectId: 'A' }, { id: 'two', todoId: 'a2', projectId: 'A' }]);
  f.store.put('runs', 'one', { projectId: 'A', todoId: 'a' });
  f.store.put('runs', 'two', { projectId: 'A', todoId: 'a2' });
  for (const name of ['run_commit_diff', 'run_worktree_status']) addTool(f, name, async args => ({ id: args.id }));
  const runtime = createAgentRuntime({ ...f, conversationId: 'bot:task:a', scope: { kind: 'task', todoId: 'a', projectId: 'A' } }, sdk.load);
  await runtime.ask('task');
  const invoke = async (name: string, args = {}) => (await sdk.tools.get(name).execute('call', args, undefined)).details;
  assert.deepEqual(await invoke('work_dispatch'), { todoId: 'a', projectId: 'A' });
  assert.equal(sdk.tools.has('todo_create'), false);
  assert.deepEqual((await invoke('todos_list')).map((entry: any) => entry.id), ['a']);
  assert.deepEqual((await invoke('runs_list')).map((entry: any) => entry.id), ['one']);
  assert.deepEqual(await invoke('run_commit_diff', { id: 'one' }), { id: 'one' });
  await assert.rejects(invoke('run_commit_diff', { id: 'two' }), /作用域/);
  await assert.rejects(invoke('run_worktree_status', { id: 'two' }), /作用域/);
  assert.deepEqual((await invoke('task_plan', { tasks: [{}] })).tasks, [{ projectId: 'A', todoId: 'a' }]);
  await assert.rejects(invoke('task_plan', { tasks: [{ todoId: 'a2' }] }), /跨作用域/);
  await assert.rejects(invoke('work_dispatch', { todoId: 'a2' }), /跨作用域/);
  await runtime.close();
});

test('unmarked exposes only global knowledge and executors; global bot keeps its own SDK resources/history', async t => {
  const f = await fixture(t, false);
  addTool(f, 'knowledge_list', async (): Promise<Json> => [{ layer: 'global' }, { layer: 'personal' }, { layer: 'project', projectId: 'A' }]);
  for (const name of ['executors_list', 'todo_create', 'todos_list', 'runs_list', 'interaction_answer']) addTool(f, name, async args => args);
  const unmarkedSDK = fakeSDK();
  const unmarked = createAgentRuntime({ ...f, scope: { kind: 'unmarked' }, conversationId: 'bot:unmarked' }, unmarkedSDK.load);
  await unmarked.ask('hello');
  assert.deepEqual(unmarkedSDK.calls.activeTools, ['knowledge_list', 'executors_list']);
  assert.deepEqual((await unmarkedSDK.tools.get('knowledge_list').execute('', {}, undefined)).details, [{ layer: 'global' }]);
  await assert.rejects(unmarked.post('bad', undefined, { projectId: 'A' }), /作用域不符/);
  const globalSDK = fakeSDK();
  const global = createAgentRuntime({ ...f, scope: { kind: 'global' }, conversationId: 'bot:../../global' }, globalSDK.load);
  await global.ask('global');
  assert.equal(globalSDK.tools.has('todo_create'), true);
  assert.notEqual(unmarkedSDK.calls.sessions.dir, globalSDK.calls.sessions.dir);
  assert.notEqual(unmarkedSDK.calls.loader.cwd, globalSDK.calls.loader.cwd);
  assert.notEqual(unmarkedSDK.calls.auth.authPath, globalSDK.calls.auth.authPath);
  assert.ok(globalSDK.calls.sessions.dir.startsWith(join(f.config.dataDir, 'pi', 'agents')));
  await Promise.all([unmarked.close(), global.close()]);
});

test('configuration lock blocks posts/new identities and reloads all lazy runtimes', async t => {
  const f = await fixture(t); const manager = createScopedAgents(f);
  await assert.rejects(manager.reloadConfiguration(), /锁定/);
  assert.equal(manager.tryLockConfiguration(), true);
  assert.equal(manager.tryLockConfiguration(), false);
  await assert.rejects(manager.post('blocked', { kind: 'global' }, 'new'), /配置/);
  await manager.reloadConfiguration({ ...f.config, demo: true });
  manager.unlockConfiguration();
  await manager.post('accepted', { kind: 'global' }, 'new');
  // Wait for durable completion, as post only acknowledges acceptance.
  await new Promise<void>(resolve => {
    const off = f.events.subscribe(() => {
      if (f.store.list<Message>('messages').some(message => message.role === 'assistant')) { off(); resolve(); }
    });
  });
  // The queue releases its busy count just after publishing persistence events.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.tryLockConfiguration(), true);
  await manager.reloadConfiguration(); manager.unlockConfiguration();
  assert.equal(manager.list()[0].available, true);
  await manager.close();
  assert.equal(manager.tryLockConfiguration(), false);
  await assert.rejects(manager.post('closed', { kind: 'global' }, 'new'), /关闭/);
});

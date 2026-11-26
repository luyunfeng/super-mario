import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotScope, Json } from '../packages/protocol/src/index.ts';
import { createAgentRuntime } from '../packages/core/src/agent-runtime/index.ts';
import { createProjectLessons } from '../packages/core/src/project-lessons.ts';
import { createSystemExtensions } from '../plugins/index.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';

// The SDK is replaced: no model runs and no real CLI starts. The store, event bus, plugin
// host, system extensions and the runtime are real, so both the tool registration and the
// scope checks in the runtime are covered.
async function callInTurn(t: test.TestContext, scope: BotScope | undefined, conversationId: string, args: unknown) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-lessons-tool-'));
  const store = createStore(':memory:');
  const events = createEventBus(store);
  const lessons = createProjectLessons(store);
  for (const id of ['A', 'B']) store.put('projects', id, { id, name: id });
  store.put('todos', 't1', { id: 't1', projectId: 'A', title: '结算' });
  lessons.learn('A', { todoId: 't1' }, [{ kind: 'missing_context', text: '先确认对账口径' }]);
  lessons.learn('B', { todoId: 't2' }, [{ kind: 'improvement', text: '另一个项目的经验' }]);

  // The tool is called from inside the model turn, where this input's scope is in force.
  const listeners = new Set<(event: unknown) => void>();
  // The SDK calls a tool as execute(callId, args, signal).
  const tools = new Map<string, { execute(callId: string, args: unknown, signal: AbortSignal): Promise<unknown> }>();
  // The real loader reloads the extensions at the start of every turn. The turn below
  // calls the same loader instance, once the runtime has created it.
  let loader: { reload(): Promise<void> } | undefined;
  const currentLoader = () => { if (!loader) throw new Error('the runtime has not created the loader yet'); return loader; };
  const model = { provider: 'test', id: 'fake' };
  const session = {
    subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {},
    async prompt() {
      await currentLoader().reload();
      const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' };
      for (const listener of listeners) listener({ type: 'message_end', message });
    },
  };
  const sdk = {
    ModelRuntime: { async create() { return { getAvailable: async () => [model], getModel: () => model, settleCredentialWrites: async () => {} }; } },
    SettingsManager: { inMemory(options: unknown) { return options; } },
    DefaultResourceLoader: class {
      options: any;
      constructor(options: any) { this.options = options; loader = this; }
      async reload() {
        for (const factory of this.options.extensionFactories) {
          await factory({ registerTool(tool: any) { tools.set(tool.name, tool); }, setActiveTools() {}, on() {} });
        }
      }
    },
    SessionManager: { continueRecent: () => ({ resumed: true }) },
    async createAgentSession() { return { session }; },
  };
  const load = async () => sdk as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof createAgentRuntime>[1]>>>;

  const contributions = createContributions();
  const host = new PluginHost({ dataDir, store, events, contributions });
  // Only this action is exercised. The other system extensions see no action and stay idle.
  const actions = { projectLessonsList: (projectId: string) => lessons.list(projectId) as unknown as Json } as unknown as Parameters<typeof createSystemExtensions>[0]['actions'];
  for (const extension of createSystemExtensions({ demo: true, actions })) host.register(extension);
  await host.start();
  const runtime = createAgentRuntime({ store, events, contributions, config: { host: '127.0.0.1', port: 0, dataDir, demo: false }, conversationId, scope }, load);
  try {
    // A turn registers the tools. The call is then made with the registered wrapper, which
    // applies this scope's checks before the tool runs.
    await runtime.ask('你好');
    const tool = tools.get('project_lessons_list');
    if (!tool) return undefined;
    // The tool answers the model with its result as JSON text.
    const result = await tool.execute('call-1', args, new AbortController().signal) as { content: { type: string; text?: string }[] };
    return JSON.parse(result.content.find(part => part.type === 'text')!.text!) as { text: string }[];
  } finally {
    await runtime.close();
    await host.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('project_lessons_list 按范围读取：项目和任务范围固定到所属项目，未标记范围拒绝', async t => {
  const texts = async (scope: BotScope | undefined, conversationId: string, args: unknown) => {
    const result = await callInTurn(t, scope, conversationId, args);
    assert.ok(result, 'the tool is offered to the model in this scope');
    return result.map(item => item.text);
  };
  // The main assistant names the project.
  assert.deepEqual(await texts(undefined, 'main', { projectId: 'A' }), ['先确认对账口径']);
  assert.deepEqual(await texts(undefined, 'main', { projectId: 'B' }), ['另一个项目的经验']);
  assert.deepEqual(await texts(undefined, 'main', { projectId: 'missing' }), []);
  // A project scope reads its own lessons without naming the project.
  assert.deepEqual(await texts({ kind: 'project', projectId: 'A' }, 'bot:a', {}), ['先确认对账口径']);
  // Naming another project is refused, so the model cannot mistake one project for another.
  await assert.rejects(texts({ kind: 'project', projectId: 'A' }, 'bot:a', { projectId: 'B' }), /跨作用域/);
  assert.deepEqual(await texts({ kind: 'task', projectId: 'A', todoId: 't1' }, 'bot:task', {}), ['先确认对账口径']);
  // An unmarked identity is not offered the tool at all, so it cannot read any project's lessons.
  assert.equal(await callInTurn(t, { kind: 'unmarked' }, 'bot:unmarked', { projectId: 'A' }), undefined);
});

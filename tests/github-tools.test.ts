import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json, JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { createAgentRuntime } from '../packages/core/src/agent-runtime/index.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import { createSystemExtensions } from '../plugins/index.ts';

// The SDK is replaced, so no model runs and no real CLI starts. The plugin host, the system
// extensions and the runtime are real: the tools are registered the way the product does it.
// The GitHub reads are a stand-in for the connected machine.
function fakeSDK() {
  const tools = new Map<string, { execute(callId: string, args: unknown, signal: AbortSignal): Promise<Json> }>();
  const listeners = new Set<(event: unknown) => void>();
  const model = { provider: 'test', id: 'fake' };
  let loader: { reload(): Promise<void> } | undefined;
  const session = {
    subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {},
    // Extensions are reloaded at the start of a turn, as the real loader does.
    async prompt() {
      if (!loader) throw new Error('the runtime has not created the loader yet');
      await loader.reload();
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
  return { tools, load: async () => sdk as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof createAgentRuntime>[1]>>> };
}

type GithubTool = (method: 'search' | 'issue' | 'comments' | 'diff' | 'checks', input: JsonObject) => Promise<unknown>;
type Call = (name: string, args: unknown) => Promise<Json>;
/** The tools only work while their host is alive, so the checks run inside this function. */
async function withTools(t: test.TestContext, githubTool: GithubTool, check: (call: Call, offered: string[]) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-github-tools-'));
  const store = createStore(':memory:');
  const events = createEventBus(store);
  const contributions = createContributions();
  const host = new PluginHost({ dataDir, store, events, contributions });
  const actions = { githubTool } as unknown as Parameters<typeof createSystemExtensions>[0]['actions'];
  for (const extension of createSystemExtensions({ demo: true, actions })) host.register(extension);
  await host.start();
  const sdk = fakeSDK();
  const runtime = createAgentRuntime({ store, events, contributions, config: { host: '127.0.0.1', port: 0, dataDir, demo: false }, conversationId: 'main' }, sdk.load);
  try {
    // A turn registers the tools. They are then called through the wrapper the model would call.
    await runtime.ask('你好');
    await check((name, args) => sdk.tools.get(name)!.execute('call-1', args, new AbortController().signal), [...sdk.tools.keys()]);
  } finally {
    await runtime.close();
    await host.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const names = ['github_search', 'github_read', 'github_diff', 'github_checks'];
const data = (result: Json) => JSON.parse((result as { content: { type: string; text?: string }[] }).content.find(part => part.type === 'text')!.text!);

test('四个 GitHub 工具已注册：输入经校验后只把合法参数交给连接器，非法输入在本地被拒', async t => {
  const calls: { method: string; input: unknown }[] = [];
  await withTools(t, async (method, input) => { calls.push({ method, input }); return { ok: true }; }, async (call, offered) => {
  for (const name of names) assert.ok(offered.includes(name), name + ' is offered to the model');
  assert.equal(offered.filter(name => name.startsWith('github_')).length, 4);
  await call('github_search', { query: 'is:pr is:open review-requested:@me', limit: 5 });
  await call('github_read', { repository: 'octo/widgets', number: 42 });
  await call('github_diff', { repository: 'octo/widgets', number: 42, path: 'src/a.ts' });
  await call('github_checks', { repository: 'octo/widgets', number: 42 });
  assert.deepEqual(calls, [
    { method: 'search', input: { query: 'is:pr is:open review-requested:@me', limit: 5 } },
    { method: 'issue', input: { repository: 'octo/widgets', number: 42 } },
    { method: 'diff', input: { repository: 'octo/widgets', number: 42, path: 'src/a.ts' } },
    { method: 'checks', input: { repository: 'octo/widgets', number: 42 } },
  ]);
  // Without a limit the machine receives only the query.
  await call('github_search', { query: 'bugs' });
  assert.deepEqual(calls.at(-1), { method: 'search', input: { query: 'bugs' } });
  const before = calls.length;
  for (const [name, args] of [
    ['github_search', { query: '' }], ['github_search', { query: 'x', limit: 'many' }], ['github_search', { query: 'x', limit: 0 }], ['github_search', { query: 'x', limit: 31 }], ['github_search', { query: 'x', limit: 1.5 }], ['github_search', { query: 'x', extra: 1 }], ['github_search', {}],
    ['github_read', { repository: '../x', number: 1 }], ['github_read', { repository: 'octo/widgets', number: '42' }], ['github_read', { repository: 'octo/widgets' }],
    ['github_diff', { repository: 'octo/widgets', number: 1, path: '' }], ['github_diff', { repository: 'octo/widgets', number: 1, path: 5 }],
    ['github_checks', { repository: 'octo?x=1', number: 1 }], ['github_checks', { repository: 'octo/widgets', number: 0 }],
  ] as const) {
    await assert.rejects(call(name, args), /参数无效|请提供搜索词|条数须为|需要有效的仓库和编号|文件路径无效/, name + ' ' + JSON.stringify(args));
  }
  assert.equal(calls.length, before, 'an invalid input never reaches the connector');
  });
});

test('连接器不可用时工具报告原因，读取结果原样返回给模型', async t => {
  let refusal: string | undefined = 'GitHub 连接未启用，可在渠道页启用';
  await withTools(t, async method => {
    if (refusal) throw Object.assign(new Error(refusal), { status: 409 });
    return method === 'issue' ? { title: '一个议题', comments: [{ body: '评论' }] } : { items: [] };
  }, async call => {
  await assert.rejects(call('github_read', { repository: 'octo/widgets', number: 1 }), /GitHub 连接未启用/);
  refusal = undefined;
  assert.deepEqual(data(await call('github_read', { repository: 'octo/widgets', number: 1 })), { title: '一个议题', comments: [{ body: '评论' }] });
  assert.deepEqual(data(await call('github_search', { query: 'x' })), { items: [] });
  });
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import { createFeishuIntegration, type FeishuOptions } from '../plugins/feishu.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { Message } from '../packages/protocol/src/index.ts';

type Request = { system: string; tools: string[]; lastRole: string; content: unknown; callId?: string };
type Reply = { role: string; content?: string; tool_calls?: unknown[] };

function call(name: string, args: object, id: string): Reply {
  return { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

/** The real SDK chain with a stand-in model, which records what it is asked. */
async function fixture(t: TestContext, respond: (request: Request) => Reply, botFactory?: FeishuBotFactory) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-routing-agent-'));
  const requests: Request[] = [];
  const model = createServer(async (req, res) => {
    if (req.method === 'GET') { res.end('fixture'); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    const last = payload.messages.at(-1);
    requests.push({
      system: JSON.stringify(payload.messages.filter((m: { role: string }) => ['system', 'developer'].includes(m.role))),
      tools: (payload.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
      lastRole: last.role, content: last.content, callId: last.tool_call_id,
    });
    const delta = respond(requests.at(-1)!);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [part, reason] of [[delta, null], [{}, delta.tool_calls ? 'tool_calls' : 'stop']] as const) {
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta: part, finish_reason: reason }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(ok => model.listen(0, '127.0.0.1', ok));
  const address = model.address();
  assert.ok(address && typeof address === 'object');
  const server = await startServer({ dataDir: dir, host: '127.0.0.1', port: 0, demo: false, model: {
    provider: 'openai-compatible', model: 'fixture', apiKey: 'offline-model-fixture', baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
  } }, { botFactory });
  // The server is closed before the model it talks to: a runtime still starting would otherwise
  // wait on a connection that is gone.
  t.after(async () => { await server.close(); model.closeAllConnections(); await new Promise<void>(ok => model.close(() => ok())); await rm(dir, { recursive: true, force: true }); });
  // The runtime resolves its model when it starts. A message sent before that is queued, and the
  // first request the model sees would be the one that resumes the session, with no user message.
  const ready = async () => {
    for (let i = 0; i < 300; i++) {
      const status = await fetch(server.url + '/api/v1/model').then(answer => answer.json() as Promise<{ runtime: { main: { available: boolean } } }>);
      if (status.runtime.main.available) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('运行时未就绪');
  };
  const ask = async (text: string) => {
    const response = await fetch(server.url + '/api/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    assert.ok(response.ok, await response.clone().text());
    const input = await response.json() as Message;
    for (let i = 0; i < 500; i++) {
      const reply = server.app.store.list<Message>('messages').find(m => m.replyTo === input.id && (m.status === 'done' || m.status === 'failed'));
      if (reply) { assert.equal(reply.status, 'done', reply.text); return reply.text; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('模型回合未结束');
  };
  return { server, ask, requests, ready };
}

test('主人问按用途分模型：助手拿到工具和指引，读出当前设置并按用途回答', { timeout: 60000 }, async t => {
  const { server, ask, requests, ready } = await fixture(t, req => {
    if (req.lastRole === 'user') return call('model_routing_read', {}, 'routing');
    return { role: 'assistant', content: '回复翻译跟随主模型 fixture，今日已用 0 次，上限 5 次。备用型号只在首选型号不存在时启用。' };
  });
  // A limit is set so that the tool has something of its own to report.
  const saved = await fetch(server.url + '/api/v1/model/routing/translation', { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dailyLimit: 5 }) });
  assert.equal(saved.status, 200);
  await ready();
  const answer = await ask('后台督办和回复翻译用的是什么型号，今天还能用吗');
  assert.match(answer, /回复翻译跟随主模型 fixture/);
  // The tool was offered, with the guidance that tells of it in the system prompt.
  const first = requests[0]!;
  assert.ok(first.tools.includes('model_routing_read'), first.tools.join(','));
  assert.match(first.system, /model_routing_read/);
  assert.match(first.system, /按用途分模型/);
  assert.match(first.system, /调用中途的失败不会自动换型号重试/);
  // What the tool returned is what the page is told: the limit that was set, for that purpose only.
  const read = JSON.parse(String(requests.find(row => row.callId === 'routing')!.content));
  const translation = read.purposes.find((row: { purpose: string }) => row.purpose === 'translation');
  assert.deepEqual(translation.usage, { used: 0, limit: 5 });
  assert.equal(translation.model, 'fixture');
  assert.equal(read.purposes.find((row: { purpose: string }) => row.purpose === 'main').usage.limit, undefined);
  // The turn is counted for the main conversation as it starts, so the tool, called within the
  // turn, already sees it. It is counted for that purpose and for no other.
  assert.equal(read.purposes.find((row: { purpose: string }) => row.purpose === 'main').usage.used, 1);
  assert.equal(translation.usage.used, 0);
  const after = server.app.store.list<{ purpose: string; count: number }>('settings').find(row => row.purpose === 'main');
  assert.equal(after?.count, 1);
});

test('飞书全局机器人也拿到同一个工具和指引，并按用途回答', { timeout: 60000 }, async t => {
  const adapters = new Map<string, FeishuOptions>();
  const sent: string[] = [];
  const factory: FeishuBotFactory = options => {
    adapters.set(options.appId, options);
    const reader = createFeishuIntegration({ ...options,
      wsFactory: ws => ({ async start() { ws.onReady?.(); }, close() {},
        getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }) }),
      fetch: async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'offline', expire: 3600 });
        if (url.pathname.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: 'ou_bot' } });
        return Response.json({ code: 0, data: { items: [] } });
      },
    });
    return { start: reader.start, close: reader.close, readPrivateQuote: reader.readPrivateQuote, status: () => ({ connected: true }),
      collect: async () => [], send: async (_chatId, text) => { sent.push(text); } };
  };
  const { server, requests, ready } = await fixture(t, req => {
    if (req.lastRole === 'user') return call('model_routing_read', {}, 'routing-feishu');
    return { role: 'assistant', content: '后台督办跟随主模型 fixture，今日已用 0 次，没有设上限。' };
  }, factory);
  const api = async (path: string, input: unknown) => {
    const response = await fetch(server.url + '/api/v1' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  await ready();
  const appId = 'cli_' + 'f'.repeat(16);
  const bot = await api('/feishu/bots', { name: '按用途分模型测试', appId, appSecret: 'offline-fixture', scope: { kind: 'global' }, requireConfirmation: false });
  const adapter = adapters.get(appId)!;
  const source = { chatId: 'oc_fixture', senderId: 'ou_fixture', senderType: 'user', chatType: 'p2p' } as const;
  await adapter.onMessage(bot.pairingCode, { ...source, messageId: 'pair' });
  await adapter.onMessage('后台督办用的是什么型号', { ...source, messageId: 'ask' });
  // The first reply is the pairing's own. The answer to the question is the second.
  for (let i = 0; i < 300 && sent.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, ['工作台已绑定。', '后台督办跟随主模型 fixture，今日已用 0 次，没有设上限。']);
  // The same tool and the same guidance as the Web conversation.
  const first = requests[0]!;
  assert.ok(first.tools.includes('model_routing_read'), first.tools.join(','));
  assert.match(first.system, /按用途分模型/);
  assert.match(first.system, /调用中途的失败不会自动换型号重试/);
});

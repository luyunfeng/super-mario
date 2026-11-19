import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import { createFeishuIntegration, type FeishuOptions } from '../plugins/feishu.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { MailboxEntry, Message } from '../packages/protocol/src/index.ts';
import { runWithAgentInput } from '../packages/core/src/agent-input.ts';

const settle = async (predicate: () => boolean) => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('local event workflow did not settle');
};
test('paired dashboard uses startup URL and delivers one interactive request through the real gateway', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-dashboard-'));
  const previous = process.env.SUPER_MARIO_WEB_URL;
  process.env.SUPER_MARIO_WEB_URL = 'https://work.example';
  t.after(async () => {
    if (previous === undefined) delete process.env.SUPER_MARIO_WEB_URL;
    else process.env.SUPER_MARIO_WEB_URL = previous;
  });
  const requests: Array<{ msg_type: string; receive_id: string; content: string }> = [];
  let adapter!: FeishuOptions;
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token: 'test-dashboard-token' }, {
    botFactory(options) {
      adapter = options;
      const integration = createFeishuIntegration({ ...options, fetch: async (url, init) => {
        if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fake', expire: 7200 });
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ code: 0, data: { message_id: 'fake-' + requests.length } });
      } });
      return { ...integration, start: async () => {}, status: () => ({ connected: true }) };
    },
  });
  t.after(async () => { try { await server.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  const bot = await server.bots.create({ name: '主机器人', appId: 'cli_0123456789abcdef', appSecret: 'test-secret', scope: { kind: 'global' } });
  const source = { messageId: 'pair', chatId: 'owner', senderId: 'human', chatType: 'p2p' };
  await adapter.onMessage(bot.pairingCode!, source);
  await Promise.all([1, 2].map(() => adapter.onMessage('/dashboard', { ...source, messageId: 'command' })));
  const cards = requests.filter(request => request.msg_type === 'interactive');
  assert.equal(cards.length, 1, JSON.stringify(server.app.mailboxes.list().map(entry => [entry.title, entry.status, entry.error])));
  assert.equal(cards[0].receive_id, 'owner');
  assert.ok(JSON.parse(cards[0].content).elements.some((element: { actions?: { url: string }[] }) =>
    element.actions?.some(action => action.url === 'https://work.example/#home')));
  assert.doesNotMatch(cards[0].content, /test-dashboard-token|localhost|127\.0\.0\.1/);
  assert.equal(server.app.mailboxes.list({ botId: bot.id }).find(entry => entry.sourceMessageId === 'command')?.status, 'completed');
});

test('HTTP multi-bot inbox confirmation dispatches isolated project context and returns only through its own outbox', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-bot-api-'));
  const adapters = new Map<string, { options: FeishuOptions; sent: [string, string][]; closed: boolean }>();
  const factory: FeishuBotFactory = options => {
    const value = { options, sent: [] as [string, string][], closed: false }; adapters.set(options.appId, value);
    return { async start() {}, async close() { value.closed = true; }, async send(chat, text) { value.sent.push([chat, text]); }, async collect() { return []; }, status: () => ({ connected: !value.closed }) };
  };
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token: 'local-api' }, { botFactory: factory });
  async function request(path: string, method = 'GET', input?: unknown, expected = 200) {
    const response = await fetch(`${server.url}/api/v1${path}`, { method, headers: { Authorization: 'Bearer local-api', 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  try {
    const project = await request('/projects', 'POST', { name: '范围验证' }, 201);
    const first = await request('/feishu/bots', 'POST', { name: '项目机器人', appId: 'cli_1111111111111111', appSecret: 'local-secret-one', scope: { kind: 'project', projectId: project.id }, requireConfirmation: true }, 201);
    const second = await request('/feishu/bots', 'POST', { name: '主机器人', appId: 'cli_2222222222222222', appSecret: 'local-secret-two', scope: { kind: 'global' }, requireConfirmation: false }, 201);
    const a = adapters.get(first.appId)!, b = adapters.get(second.appId)!;
    const source = (messageId: string, chatId: string) => ({ messageId, chatId, chatType: 'p2p', senderId: `${chatId}-sender` });
    await a.options.onMessage(first.pairingCode, source('pair-a', 'chat-a'));
    await b.options.onMessage(second.pairingCode, source('pair-b', 'chat-b'));
    await a.options.onMessage('项目消息需确认', source('input-a', 'chat-a'));
    await a.options.onMessage('项目消息需确认', source('input-a', 'chat-a'));
    assert.equal(server.app.store.list<Message>('messages').filter(m => m.role === 'user').length, 0);
    const incoming = server.app.mailboxes.list({ botId: first.id, direction: 'inbox' });
    assert.equal(incoming.length, 1); assert.equal(incoming[0].status, 'pending');
    const result = await request(`/mailboxes/${incoming[0].id}/confirm`, 'POST', { version: incoming[0].version });
    assert.equal(result.status, 'completed');
    await request(`/mailboxes/${incoming[0].id}/confirm`, 'POST', { version: incoming[0].version }, 409);
    await settle(() => a.sent.some(([, text]) => text.includes('项目消息需确认')));
    const accepted = server.app.store.get<Message>('messages', result.resultId)!;
    assert.equal(accepted.projectId, project.id); assert.ok(accepted.conversationId.startsWith('bot:'));
    assert.ok(a.sent.every(([chat]) => chat === 'chat-a'));
    assert.ok(b.sent.every(([chat, text]) => chat === 'chat-b' && !text.includes('项目消息需确认')));
    const dispatchTool = server.app.contributions.list('tools').find(item => item.value.name === 'work_dispatch')!.value;
    const run = await runWithAgentInput(accepted, () => dispatchTool.execute({ prompt: '项目执行结果回原机器人', projectId: project.id }, new AbortController().signal)) as unknown as { id: string; conversationId: string; sourceMessageId: string };
    assert.equal(run.conversationId, accepted.conversationId); assert.equal(run.sourceMessageId, accepted.id);
    await settle(() => a.sent.some(([, text]) => text.includes('执行完成：项目执行结果回原机器人')));
    assert.ok(!b.sent.some(([, text]) => text.includes('项目执行结果回原机器人')));
    await b.options.onMessage('全局消息', source('input-b', 'chat-b'));
    await settle(() => b.sent.some(([, text]) => text.includes('全局消息')));
    assert.equal(server.app.mailboxes.list({ scope: 'global', direction: 'inbox' }).length, 1);
    const outbound = await request('/mailboxes', 'POST', { botId: first.id, target: 'chat-a', text: '用户确认后发送', requiresConfirmation: false }, 201);
    assert.equal(outbound.requiresConfirmation, true); assert.equal(outbound.status, 'pending');
    assert.ok(!a.sent.some(([, text]) => text === outbound.text));
    await request(`/mailboxes/${outbound.id}/confirm`, 'POST', { version: outbound.version });
    assert.equal(a.sent.filter(([, text]) => text === outbound.text).length, 1);
    const all = await request('/feishu/bots'); assert.doesNotMatch(JSON.stringify(all), /local-secret/);
    const unmarked = await request('/feishu/bots', 'POST', { name: '待分配机器人', appId: 'cli_3333333333333333', appSecret: 'local-secret-three', scope: { kind: 'unmarked' }, requireConfirmation: false }, 201);
    const c = adapters.get(unmarked.appId)!;
    await c.options.onMessage(unmarked.pairingCode, source('pair-c', 'chat-c'));
    await c.options.onMessage('归入项目再处理', source('input-c', 'chat-c'));
    const unassigned = server.app.mailboxes.list({ botId: unmarked.id, direction: 'inbox' })[0];
    assert.equal(unassigned.status, 'pending');
    await request(`/mailboxes/${unassigned.id}/confirm`, 'POST', { version: unassigned.version }, 400);
    const assigned = await request(`/mailboxes/${unassigned.id}`, 'PATCH', { version: unassigned.version, scope: { kind: 'project', projectId: project.id } });
    const assignedResult = await request(`/mailboxes/${assigned.id}/confirm`, 'POST', { version: assigned.version });
    assert.equal(assignedResult.status, 'completed');
    await settle(() => c.sent.some(([, text]) => text.includes('归入项目再处理')));
    assert.deepEqual(server.app.mailboxes.list({ botId: unmarked.id, direction: 'outbox' }).find(entry => entry.replyTo === assignedResult.resultId)?.scope, { kind: 'project', projectId: project.id });
    const assignedInput = server.app.store.get<Message>('messages', assignedResult.resultId)!;
    const assignedRun = await runWithAgentInput(assignedInput, () => dispatchTool.execute({ prompt: '在明确分配的项目中执行', projectId: project.id }, new AbortController().signal)) as unknown as { id: string; projectId: string };
    assert.equal(assignedRun.projectId, project.id);
    await request(`/feishu/bots/${unmarked.id}`, 'PATCH', { enabled: false });
    const count = server.app.store.list('runs').length;
    await assert.rejects(runWithAgentInput(assignedInput, () => dispatchTool.execute({ prompt: '旧输入不能再次派发', projectId: project.id }, new AbortController().signal)), /绑定已变化|授权.*失效/);
    assert.equal(server.app.store.list('runs').length, count);
    assert.equal((await fetch(`${server.url}/api/v1/feishu/bots`)).status, 401);
    assert.ok(server.app.mailboxes.list().every((entry: MailboxEntry) => entry.botId));
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('registration HTTP exposes a real QR image from provider payload and never returns credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-bot-register-api-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true }, {
    registrationProvider: { async register(context) {
      context.progress({ stage: 'waiting_for_scan', url: JSON.stringify({ qrlogin: { token: 'synthetic-local-qr' } }) });
      await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
      throw new Error('unreachable');
    } },
  });
  try {
    const response = await fetch(`${server.url}/api/v1/feishu/registrations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '扫码验证', scope: { kind: 'global' } }) });
    assert.equal(response.status, 202); const started = await response.json();
    await settle(() => server.registrations.get(started.id)?.status === 'waiting_for_scan');
    const job = await (await fetch(`${server.url}/api/v1/feishu/registrations/${started.id}`)).json();
    assert.match(job.qrDataUrl, /^data:image\/png;base64,/); assert.equal(job.qrUrl, undefined);
    assert.doesNotMatch(JSON.stringify(job), /appSecret|cookie|client_secret/);
    const cancel = await (await fetch(`${server.url}/api/v1/feishu/registrations/${started.id}/cancel`, { method: 'POST' })).json();
    assert.equal(cancel.status, 'cancelled'); assert.equal(cancel.qrDataUrl, undefined);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a verified scanner can talk to a newly registered bot without copying a pairing code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-bot-owner-api-'));
  let adapter: FeishuOptions | undefined;
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true }, {
    botFactory: options => {
      adapter = options;
      return { async start() {}, async close() {}, async send() {}, async collect() { return []; }, status: () => ({ connected: true }) };
    },
    registrationProvider: { async register() { return { appId: 'cli_4444444444444444', appSecret: 'private-registration-secret', verified: true, missingSteps: [], ownerOpenId: 'ou_verifiedScanner' }; } },
  });
  try {
    const job = server.registrations.start({ name: '免配对码机器人', scope: { kind: 'global' }, requireConfirmation: false });
    await settle(() => server.registrations.get(job.id)?.status === 'completed');
    const bot = server.bots.list()[0];
    assert.equal(bot.pairingCode, undefined); assert.equal(bot.paired, false);
    await adapter!.onMessage('陌生人消息', { messageId: 'stranger', chatId: 'wrong-chat', chatType: 'p2p', senderId: 'ou_intruder' });
    assert.equal(server.app.mailboxes.list({ direction: 'inbox' }).length, 0);
    await adapter!.onMessage('直接开始工作', { messageId: 'verified-owner', chatId: 'owner-chat', chatType: 'p2p', senderId: 'ou_verifiedScanner' });
    assert.equal(server.bots.list()[0].paired, true);
    assert.equal(server.app.mailboxes.list({ direction: 'inbox' })[0].status, 'completed');
    assert.equal(server.app.store.list<Message>('messages').filter(message => message.role === 'user')[0].text, '直接开始工作');
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

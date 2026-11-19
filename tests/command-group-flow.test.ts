import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import { createFeishuIntegration } from '../plugins/feishu.ts';
import type { BotScope, FeishuBot, MailboxEntry } from '../packages/protocol/src/bots.ts';
import type { Message } from '../packages/protocol/src/index.ts';

const mainApp = 'cli_1111111111111111';
const projectApp = 'cli_2222222222222222';
const otherApp = 'cli_3333333333333333';
const group = 'oc_offline_command';
const memberOpenId = 'ou_project_as_seen_by_main';
const owner = (app: string) => 'ou_paired_' + app;
const matched = '核对蓝鲸项目的交付清单';
const ambiguous = '帮忙看一下这个事情';
const direct = '请确认本次联调';

async function until(predicate: () => boolean, expectation: string) {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), expectation);
}

test('Web command group provisions Feishu members and routes owner messages once to the project', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-command-group-flow-'));
  const errors: unknown[] = [];
  const classifications: string[] = [];
  const projectReplies: string[] = [];
  let projectId: string, otherProjectId: string;

  // Exercise the real model protocol. The two model calls have distinct observable effects:
  // routing returns an ID or a clarification, and a project turn produces the delivered answer.
  const model = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') { res.end('offline'); return; }
      assert.equal(req.url, '/v1/chat/completions');
      let body = '';
      for await (const chunk of req) body += chunk;
      const messages = JSON.parse(body).messages as Array<{ role: string; content: string | Array<{ text?: string }> }>;
      const last = messages.filter(msg => msg.role === 'user').at(-1);
      assert.ok(last);
      const prompt = typeof last.content === 'string' ? last.content : last.content.map(part => part.text ?? '').join('');
      let input;
      try { input = JSON.parse(prompt); } catch { /* Ordinary project turns carry plain text. */ }
      let reply: string;
      if (Array.isArray(input?.candidates)) {
        assert.deepEqual(input.candidates.map((p: { id: string }) => p.id).sort(), [projectId, otherProjectId].sort());
        classifications.push(input.text);
        reply = JSON.stringify(input.text === matched ? { projectId } : { ask: true });
      } else {
        reply = '本地项目回执-' + (projectReplies.length + 1);
        projectReplies.push(reply);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', content: reply }, null], [{}, 'stop']]) {
        res.write('data: ' + JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', model: 'fixture',
          choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); res.writeHead(500); res.end(); }
  });
  let server: Awaited<ReturnType<typeof startServer>>;
  t.after(async () => {
    await server?.close();
    model.closeAllConnections();
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address();
  assert.ok(address && typeof address !== 'string');

  const sockets = new Map<string, EventDispatcher>();
  const sends: Array<{ id: string; app: string; path: string; target?: string; type: string; content: string }> = [];
  const botFactory: FeishuBotFactory = options => createFeishuIntegration({
    ...options,
    wsFactory: params => ({
      async start({ eventDispatcher }) { sockets.set(options.appId, eventDispatcher); params.onReady?.(); },
      close() {}, getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }),
    }),
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'local', expire: 7200 });
      if (path.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: 'ou_self_' + options.appId } });
      if (path.startsWith('/open-apis/im/v1/messages')) {
        const body = JSON.parse(String(init?.body));
        if (init?.method === 'PATCH') {
          const card = sends.find(message => message.app === options.appId && message.id === path.split('/').at(-1));
          if (!card) return Response.json({ code: 1, msg: 'unknown card' });
          card.content = body.content;
          return Response.json({ code: 0 });
        }
        const id = 'om_offline_' + (sends.length + 1);
        sends.push({ id, app: options.appId, path, target: body.receive_id, type: body.msg_type, content: body.content });
        return Response.json({ code: 0, data: { message_id: id } });
      }
      errors.push('unexpected Feishu request ' + path);
      return Response.json({ code: 1 }, { status: 400 });
    },
    runCLI: async () => { errors.push('unexpected CLI request'); throw new Error('unexpected CLI request'); },
  });
  const creates: Array<{ app: string; user: string; members: string[] }> = [];
  const joins: string[][] = [];
  server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: false, token: 'local',
    model: { provider: 'openai-compatible', model: 'fixture', apiKey: 'offline', baseUrl: `http://127.0.0.1:${address.port}/v1` } }, {
    botFactory,
    commandGroupPlatform: {
      async create(app, user, members) { creates.push({ app, user, members: [...members] }); return group; },
      async join(app, chat, member) { joins.push([app, chat, member]); return 'joined'; },
      async resolveOpenId(app, member) { return app === mainApp && member === projectApp ? memberOpenId : undefined; },
    },
  });
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(server.url + '/api/v1' + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer local', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.ok(res.ok, await res.clone().text());
    return res.json() as Promise<T>;
  }
  async function emit(app: string, id: string, text: string, chat: string, senderId: string, mention?: string) {
    const socket = sockets.get(app);
    assert.ok(socket);
    await socket.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: 'evt_' + id }, event: {
      sender: { sender_type: 'user', sender_id: { open_id: senderId } },
      message: { chat_type: chat === group ? 'group' : 'p2p', chat_id: chat, message_id: id, message_type: 'text',
        content: JSON.stringify({ text: mention ? '@_user_1 ' + text : text }),
        ...(mention ? { mentions: [{ key: '@_user_1', id: { open_id: mention }, name: '蓝鲸助手' }] } : {}) },
    } }, { needCheck: false });
  }
  async function pair(app: string, name: string, scope: BotScope) {
    const bot = await api<FeishuBot>('/feishu/bots', { appId: app, appSecret: 'fixture', name, scope, requireConfirmation: false });
    assert.ok(bot.pairingCode);
    await emit(app, 'om_pair_' + app, bot.pairingCode, 'oc_private_' + app, owner(app));
    await until(() => server.bots.list().some(row => row.id === bot.id && row.paired), name + ' pairs through its own application');
    return bot;
  }
  projectId = (await api<{ id: string }>('/projects', { name: '蓝鲸项目' })).id;
  otherProjectId = (await api<{ id: string }>('/projects', { name: '飞鸟项目' })).id;
  const main = await pair(mainApp, '指挥助手', { kind: 'global' });
  const project = await pair(projectApp, '蓝鲸助手', { kind: 'project', projectId });
  const other = await pair(otherApp, '飞鸟助手', { kind: 'project', projectId: otherProjectId });
  const path = '/feishu/command-group';
  const view = await api<{ status: string; chatId: string; mainBotId: string; members: Array<{ botId: string; status: string }> }>(path, {});
  assert.equal(view.status, 'ready', JSON.stringify(view));
  assert.equal(view.chatId, group);
  assert.equal(view.mainBotId, main.id);
  assert.ok(view.members.some(m => m.botId === project.id && m.status === 'joined'));
  assert.deepEqual(await api(path), view);
  assert.equal(creates.length, 1);
  assert.equal(creates[0]!.app, mainApp);
  assert.equal(creates[0]!.user, owner(mainApp));
  assert.deepEqual(creates[0]!.members.sort(), [projectApp, otherApp].sort());
  assert.deepEqual(joins.sort(), [[mainApp, group, projectApp], [mainApp, group, otherApp]].sort());
  for (const bot of await api<FeishuBot[]>('/feishu/bots')) {
    assert.equal(bot.groupChats?.length ?? 0, 0);
    assert.equal(bot.collaboration?.peerBotIds.length ?? 0, 0);
  }

  // Open IDs from a different application cannot stand in for the main application's owner.
  await emit(mainApp, 'om_untrusted', matched, group, owner(projectApp));
  await emit(mainApp, 'om_match', matched, group, owner(mainApp));
  const delivered = (answer: string) => sends.filter(s => s.app === projectApp && s.target === group && s.content.includes(answer));
  await until(() => delivered('本地项目回执-1').length > 0, 'scoped answer reaches the command chat via the project identity');
  assert.deepEqual(classifications, [matched]);

  // The project websocket can observe a natural @ before the main websocket. Replay it on both.
  for (let replay = 0; replay < 2; replay++) {
    await emit(projectApp, 'om_direct', direct, group, owner(projectApp), 'ou_self_' + projectApp);
    await emit(mainApp, 'om_direct', direct, group, owner(mainApp), memberOpenId);
  }
  await until(() => delivered('本地项目回执-2').length > 0, 'natural mention dispatches once');
  const beforeClarification = sends.length;
  await emit(mainApp, 'om_ask', ambiguous, group, owner(mainApp));
  await until(() => sends.slice(beforeClarification).some(s => s.app === mainApp && (s.target === group || s.path.endsWith('/om_ask/reply'))),
    'main identity clarifies an ambiguous command');
  assert.deepEqual(classifications, [matched, ambiguous]);
  assert.equal(projectReplies.length, 2);
  const inbox = await api<MailboxEntry[]>('/mailboxes?direction=inbox');
  assert.equal(inbox.filter(entry => entry.botId === project.id).length, 2);
  for (const [id, text] of [['om_match', matched], ['om_direct', direct]] as const) {
    const entries = inbox.filter(entry => entry.sourceMessageId === id && entry.botId === project.id);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.deepEqual(entry!.scope, { kind: 'project', projectId });
    assert.equal(entry!.status, 'completed');
    const accepted = server.app.store.get<Message>('messages', entry!.resultId!);
    assert.equal(accepted?.projectId, projectId);
    assert.ok(accepted?.text.includes(text));
  }
  assert.equal(inbox.some(entry => entry.sourceMessageId === 'om_untrusted' || entry.sourceMessageId === 'om_ask' || entry.botId === other.id), false);
  const outbox = await api<MailboxEntry[]>('/mailboxes?direction=outbox');
  const questions = outbox.filter(entry => entry.sourceMessageId === 'om_ask');
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.botId, main.id);
  assert.equal(questions[0]!.target, group);
  assert.match(questions[0]!.text, /项目/);
  assert.equal(outbox.some(entry => entry.sourceMessageId === 'om_untrusted'), false);
  assert.equal(sends.some(s => s.app === otherApp && s.target === group), false);
  const mentions = sends.filter(s => s.app === mainApp && s.target === group && s.type === 'post');
  assert.equal(mentions.length, 2, 'one handoff per owner command');
  for (const s of mentions) {
    assert.ok(JSON.parse(s.content).zh_cn.content.flat().some((node: { tag: string; user_id?: string }) =>
      node.tag === 'at' && node.user_id === memberOpenId));
  }
  assert.equal(delivered('本地项目回执-1').length, 1);
  assert.equal(delivered('本地项目回执-2').length, 1);
  assert.deepEqual(errors, []);
});

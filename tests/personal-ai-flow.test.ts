import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../apps/server/src/index.ts';
import { createPersonalProvider, PERSONAL_MESSAGE_SCOPES } from '../plugins/feishu-personal.ts';
import type { InboxItem } from '../packages/protocol/src/index.ts';
import type { InboxHandlingView } from '../packages/protocol/src/inbox-handling.ts';

const personal = '/feishu/personal';
const chat = 'oc_flow_group';
const owner = 'ou_flow_owner';
const peer = 'ou_flow_peer';
const appId = 'cli_flow';
const question = '请根据上文拟一个回复';
const reply = '蓝色样件共七盒，请周五送达。';

function message(id: string, sender: string, thread: string, text: string, time: number) {
  return { message_id: id, chat_id: chat, thread_id: thread, chat_type: 'group', msg_type: 'text',
    sender: { id: sender, id_type: 'open_id', sender_type: 'user' },
    content: text, create_time: String(time) };
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 5000;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await delay(10);
    value = await read();
  }
  assert.ok(ready(value), JSON.stringify(value));
  return value;
}

test('本人 /ai 从同话题生成一份收件回复草稿，重叠采集不会再调用模型或发件', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-personal-ai-flow-'));
  const path = process.env.PATH;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  // 发件使用独立于采集 provider 的 CLI。即便意外进入发件路径，也只能触达此记录器。
  const cliLog = join(dataDir, 'unexpected-cli-call');
  await writeFile(join(dataDir, 'lark-cli'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(cliLog)}, 'called');process.exit(1)\n`, { mode: 0o700 });
  process.env.PATH = dataDir + ':' + (path ?? '');

  let feed: ReturnType<typeof message>[] = [];
  let groupReads = 0;
  const envelope = (data: object) => ({ ok: true, identity: 'user', data });
  // 仅替换平台响应。生产 provider 完成授权核验，并从搜索行生成 items、evidence 和 aiMessages。
  const provider = createPersonalProvider({ application: () => undefined, runCLI: async args => {
    if (args.includes('show')) return { profile: 'flow-local', appId };
    if (args.includes('--no-wait')) return { verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify', device_code: 'offline-device', expires_in: 60 };
    if (args.includes('--device-code')) return { ok: true };
    if (args.includes('--verify')) return { appId, identity: 'user', verified: true,
      identities: { user: { available: true, openId: owner, userName: '合成账号', scope: PERSONAL_MESSAGE_SCOPES.join(' ') } } };
    if (args.includes('+chat-list')) return envelope({ chats: [{ chat_id: chat, chat_mode: 'group' }], has_more: false });
    if (args.includes('batch_query')) return envelope({ items: [{ chat_id: chat, is_muted: false }] });
    if (args.includes('chats') && args.includes('get')) return envelope({ chat_mode: 'group', user_count: '3' });
    if (args.includes('+messages-search')) {
      const selected = args.includes(chat) && !args.includes('--is-at-me');
      if (selected) groupReads++;
      return envelope({ messages: selected ? feed : [], has_more: false });
    }
    throw Error('未预期的测试平台调用 ' + args.join(' '));
  } });
  const token = 'offline-flow';
  server = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, token }, { personalProvider: provider });
  const { app, url } = server;
  async function api<T>(route: string, method = 'GET', body?: object, expected = 200): Promise<T> {
    const response = await fetch(url + '/api/v1' + route, { method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value as T;
  }

  const calls: string[] = [];
  app.inboxHandlingRuntime.status = () => ({ available: true });
  app.inboxHandlingRuntime.ask = async (_source, conversationId, prompt) => {
    calls.push(prompt);
    return { id: 'offline-answer', role: 'assistant', conversationId, status: 'done', createdAt: new Date().toISOString(),
      text: JSON.stringify({ answer: reply, suggestions: [{ kind: 'reply', text: reply }] }) };
  };

  type Settings = { accountKey: string; enabled: boolean; triggerSenderIds: string[]; chatIds: string[]; prefix: string; contextCount: number;
    turns: { messageId: string; status: string; inboxId?: string }[] };
  const settings = () => api<Settings>(personal + '/ai');
  await api(personal + '/authorize', 'POST', {}, 202);
  await until(() => api<{ status: string }>(personal), state => state.status === 'connected');
  const authorized = await settings();
  assert.equal(authorized.enabled, false);
  assert.ok(authorized.accountKey);
  const config = { enabled: true, triggerSenderIds: [], chatIds: [chat], prefix: '/ai', contextCount: 2 };
  await api(personal + '/ai', 'PUT', { ...config, expectedAccountKey: authorized.accountKey });
  assert.partialDeepStrictEqual(await settings(), { ...config, turns: [] });

  const at = Date.now();
  const order = '蓝色样件共七盒';
  const arrival = '交付时间改为周五';
  const triggerId = 'om_flow_owner';
  feed = [
    message('om_flow_one', peer, 'omt_order', order, at),
    message('om_flow_two', peer, 'omt_order', arrival, at + 1),
    message('om_flow_other', peer, 'omt_else', '/ai 其他话题的请求', at + 2),
    message(triggerId, owner, 'omt_order', '/ai ' + question, at + 3),
  ];
  await api(personal, 'PUT', { enabled: true });
  const settled = await until(settings, state => state.turns.some(turn => turn.status !== 'pending'));
  assert.equal(settled.turns.length, 1);
  const [turn] = settled.turns;
  assert.equal(turn.messageId, triggerId);
  assert.equal(turn.status, 'completed', JSON.stringify(turn));
  assert.ok(turn.inboxId);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(question));
  assert.ok(calls[0].includes(order));
  assert.ok(calls[0].includes(arrival));
  assert.ok(!calls[0].includes('其他话题的请求'));

  const inbox = await api<InboxItem[]>('/inbox');
  const item = inbox.find(row => row.id === turn.inboxId);
  assert.equal(item?.source, `feishu:${appId}:${owner}`);
  assert.equal(item?.thread, 'feishu:message:' + JSON.stringify([chat, triggerId]));
  const view = () => api<InboxHandlingView>('/inbox-handling/personal/' + turn.inboxId);
  const initial = await view();
  assert.equal(initial.suggestions.length, 1);
  const [draft] = initial.suggestions;
  assert.deepEqual(draft.action, { kind: 'reply', text: reply });
  assert.equal(draft.status, 'draft');
  assert.deepEqual(draft.source, { kind: 'personal', id: turn.inboxId });

  const readsBefore = groupReads;
  await api(personal + '/collect', 'POST', {});
  assert.ok(groupReads > readsBefore, '重叠窗口必须实际重读同一批消息');
  assert.deepEqual((await settings()).turns, settled.turns);
  assert.deepEqual((await view()).suggestions, [draft]);
  assert.equal(calls.length, 1);
  assert.equal(app.store.list('approvals').length, 0);
  await app.background.tick();
  assert.deepEqual(app.background.outbox.list(), []);
  assert.equal(existsSync(cliLog), false);
});

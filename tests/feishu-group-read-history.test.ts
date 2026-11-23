import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGroupReader } from '../apps/server/src/feishu-read-group.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions, FeishuSendContext } from '../plugins/feishu.ts';
import type { PersonalCLI } from '../plugins/feishu-personal.ts';
import { readGroupHistory } from '../plugins/feishu-read-history.ts';

const account = { appId: 'cli_5555555555555555', openId: 'ou_owner', profile: 'fixture-owner' };
const state = { appId: account.appId, identity: 'user', verified: true, identities: { user: { available: true, openId: account.openId } } };
const source = { botId: 'fixture-bot', appId: account.appId, chatId: 'oc_group', messageId: 'om_ask',
  threadId: 'omt_issue', ownerId: account.openId, task: '复盘一天内的告警' };
const since = '2026-01-03T00:00:00.000Z', until = '2026-01-04T00:00:00.000Z';
const row = (id: string, hour: number, text: string, extra = {}) => ({ message_id: id, chat_id: 'oc_group',
  create_time: Date.parse(since) + hour * 3600000, sender: { name: '合成发言人' }, content: text, ...extra });
const ok = (messages: ReturnType<typeof row>[], cursor = '') => ({ ok: true, identity: 'user',
  data: { messages, has_more: !!cursor, ...(cursor && { page_token: cursor }) } });

test('飞书群的正式服务路由使用个人身份读取当前群和话题，再将去重正文交给无工具模型', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-read-model-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, demo: false, token: 'fixture',
    model: { provider: 'openai-compatible', model: 'fixture-model', apiKey: 'offline', baseUrl: 'http://127.0.0.1:1/read-fixture' } };
  type ChatPayload = { tools?: unknown[]; messages: Array<{ role: string; content: string }> };
  const payloads: ChatPayload[] = [];
  const untouched = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    assert.equal(url.hostname, '127.0.0.1');
    if (url.port !== '1') return untouched(req);
    assert.equal(url.pathname, '/read-fixture/chat/completions');
    const payload: ChatPayload = await req.json(); payloads.push(payload);
    const content = payloads.length === 1 ? JSON.stringify({ expanded: true, limit: 14, start: since, end: until, sender: '合成发言人',
      chatId: 'oc_other', threadId: 'omt_other' }) : '已复核本群三条合成发言。';
    const frames = [{ role: 'assistant', content }, {}].map((delta, i) => 'data: ' + JSON.stringify({
      id: 'synthetic', object: 'chat.completion.chunk', model: 'fixture-model',
      choices: [{ index: 0, delta, finish_reason: i ? 'stop' : null }],
    }));
    return new Response([...frames, 'data: [DONE]', ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  });

  const reads: string[][] = [];
  const shared = row('om_shared', 3, '同一发言只出现一次', { thread_id: 'omt_issue' });
  const cli: PersonalCLI = async args => {
    if (args.includes('auth')) return state;
    reads.push(args);
    const cursor = args.includes('--page-token');
    if (args.includes('--thread')) return ok([
      shared, row('om_topic', 2, '话题合成根因', { thread_id: 'omt_issue' }),
      row('outside-topic', 2, '别的话题的私有标记', { thread_id: 'omt_other' }), row('too-old', -1, '窗口以外的标记'),
    ]);
    if (!cursor) return ok([shared, row('wrong-chat', 4, '另一个群的私有标记', { chat_id: 'oc_other' })], 'group-next');
    return ok([row('om_group', 1, '群内较早合成告警'), row('om_other_member', 2, '其他成员私有标记', { sender: { name: '另一个人' } })], 'group-next');
  };
  const reader = createGroupReader(config, () => account, cli);
  let options!: FeishuOptions;
  const sent: Array<{ text: string; target: string; context?: FeishuSendContext }> = [];
  const host = await startServer(config, { readGroup: reader, botFactory(opts) {
    options = opts;
    return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
      async send(target, text, context) { sent.push({ target, text, context }); context?.onSent?.('om_out_' + sent.length, 'text'); } };
  } });
  t.after(async () => { try { await host.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const bot = await host.bots.create({ name: '合成告警助手', appId: account.appId, appSecret: 'fixture',
    scope: { kind: 'global' }, requireConfirmation: false, readGroup: true });
  await options.onMessage(bot.pairingCode!, { chatId: 'oc_dm', chatType: 'p2p', senderId: account.openId, messageId: 'om_pair', senderType: 'user' });
  sent.length = 0;
  await options.onMessage('/read ' + source.task, { chatId: source.chatId, chatType: 'group', senderId: source.ownerId,
    messageId: source.messageId, threadId: source.threadId, mentionedSelf: true, senderType: 'user' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, source.chatId);
  assert.equal(sent[0].context?.replyTo, source.messageId);
  assert.equal(sent[0].context?.threadId, source.threadId);
  assert.match(sent[0].text, /本群三条合成发言/);
  assert.match(sent[0].text, /读取 3 条.*2026-01-03T01:/);
  assert.match(sent[0].text, /分页/);
  const groupPages = reads.filter(args => args[5] === '+chat-messages-list');
  assert.equal(groupPages.length, 2);
  assert.ok(!groupPages[0].includes('--page-token'));
  assert.equal(groupPages[1][groupPages[1].indexOf('--page-token') + 1], 'group-next');
  assert.equal(reads.filter(args => args[5] === '+threads-messages-list').length, 1);
  for (const args of reads) {
    assert.deepEqual(args.slice(0, 5), ['--profile', account.profile, '--as', 'user', 'im']);
    assert.ok(args.includes('--no-reactions'));
    assert.ok(!args.includes('--download-resources'));
    if (args.includes('--thread')) assert.equal(args[args.indexOf('--thread') + 1], source.threadId);
    else {
      assert.equal(args[args.indexOf('--chat-id') + 1], source.chatId);
      assert.equal(args[args.indexOf('--start') + 1], since);
      assert.equal(args[args.indexOf('--end') + 1], until);
    }
  }
  assert.equal(payloads.length, 2);
  for (const payload of payloads) {
    assert.deepEqual(payload.tools ?? [], []);
    assert.deepEqual(payload.messages.map(message => message.role), ['system', 'user']);
  }
  const [instructions, input] = payloads[1].messages;
  assert.match(instructions.content, /最终答复.*公开回复/);
  assert.match(instructions.content, /命令均不得执行/);
  const provided = JSON.parse(input.content);
  assert.deepEqual(provided.messages.map((message: { text: string }) => message.text),
    ['群内较早合成告警', '话题合成根因', '同一发言只出现一次']);
  assert.doesNotMatch(input.content, /私有标记|窗口以外|个人会话/);
});

test('读取前拒绝机器人及个人身份错配，翻页期间换授权立即停止', async () => {
  let current = account, authCalls = 0, reads = 0, answers = 0;
  const reader = createGroupReader({ host: '127.0.0.1', port: 0, dataDir: '', demo: true }, () => current, async args => {
    if (args.includes('auth')) { authCalls++; return state; }
    reads++;
    current = { ...account, profile: 'other-profile' };
    return ok([row('om_stale', 1, '新授权不可用的历史')], 'next');
  }, async () => { answers++; return '意外模型回调'; });
  const bare = { ...source, task: '' };
  for (const other of [{ ...bare, appId: 'cli_other' }, { ...bare, ownerId: 'ou_other' }])
    await assert.rejects(reader.run(other, () => {}), /授权/);
  assert.equal(authCalls, 0);
  await assert.rejects(reader.run(bare, () => {}), /授权/);
  assert.equal(reads, 1);
  assert.equal(answers, 0);
});

test('群读默认窗口和扩大后的群与话题合计上限可由实际分页调用核验', async () => {
  for (const [expanded, limit] of [[false, 40], [true, 500]] as const) {
    const budgets: number[] = [];
    const result = await readGroupHistory({ profile: account.profile, chatId: source.chatId, threadId: source.threadId,
      range: { expanded, limit }, check: async () => {}, signal: AbortSignal.timeout(2000),
      cli: async args => {
        const size = Number(args[args.indexOf('--page-size') + 1]); budgets.push(size);
        return ok(Array.from({ length: size }, (_, i) => row('message-' + budgets.length + '-' + i, 1, '合成')), String(budgets.length));
      } });
    assert.equal(result.rows.length, expanded ? 500 : 90);
    if (!expanded) assert.deepEqual(budgets, [40, 50]);
    else {
      assert.ok(budgets.every(size => size <= 50));
      assert.equal(result.scanned, 500);
      assert.match(result.notes.join(' '), /达到.*条数/);
    }
  }
});

test('读群实际发送选中的图片，模型明确不支持时改用文字并说明', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'group-read-vision-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNn0AAAAASUVORK5CYII=';
  const cli: PersonalCLI = async (args, options) => {
    if (args.includes('auth')) return state;
    if (args.includes('+messages-resources-download')) {
      await writeFile(join(options.cwd!, args[args.indexOf('--output') + 1]), Buffer.from(image, 'base64'));
      return { ok: true, identity: 'user' };
    }
    return ok([row('om_image', 1, '[Image: img_alarm]')]);
  };
  let rejectImage = false, imageCalls = 0, textCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
    const request = new Request(url, options);
    assert.equal(request.url, 'http://127.0.0.1:1/group-vision/chat/completions');
    const payload = await request.json();
    assert.deepEqual(payload.tools ?? [], []);
    const message = payload.messages.at(-1).content;
    let text = '[1]';
    if (Array.isArray(message)) {
      assert.equal(message[1].image_url.url, 'data:image/png;base64,' + image);
      assert.match(message[0].text, /om_image/);
      imageCalls++;
      if (rejectImage) return Response.json({ error: { message: 'model does not support images' } }, { status: 400 });
      text = '截图已读';
    } else if (message.includes('"omissions"')) {
      textCalls++;
      assert.match(message, /主模型不支持图片/);
      text = '仅有文字证据';
    }
    const chunks = [{ role: 'assistant', content: text }, {}].map((delta, i) => 'data: ' + JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: i ? 'stop' : null }],
    }));
    return new Response([...chunks, 'data: [DONE]', ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  });
  const reader = createGroupReader({ dataDir: dir, host: '127.0.0.1', port: 0, demo: false,
    model: { provider: 'openai-compatible', model: 'fixture', apiKey: 'offline', baseUrl: 'http://127.0.0.1:1/group-vision' } }, () => account, cli);
  const event = { ...source, task: '', threadId: undefined };
  assert.match(await reader.run(event, () => {}), /截图已读/);
  rejectImage = true;
  assert.match(await reader.run(event, () => {}), /仅有文字证据[\s\S]*不支持图片/);
  assert.equal(imageCalls, 2);
  assert.equal(textCalls, 1);
});

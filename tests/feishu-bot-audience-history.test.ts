import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FeishuOptions, FeishuMessageSource } from '../plugins/feishu.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import { startServer } from '../apps/server/src/index.ts';

test('全局机器人按私聊主人和各群隔离模型实际历史，重启后同一受众能继续追问', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-bot-audience-'));
  const config = { dataDir, host: '127.0.0.1', port: 0, demo: false, model: {
    provider: 'openai-compatible', model: 'fixture', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:1/audience-fixture' } };
  const marker = '合成回执标记Q6B8R4';
  const questions = {
    private: '主人私聊查找上次读群结果甲', follow: '主人私聊问上次结论乙', later: '重启后主人继续提问丙',
    a: '普通告警群甲的合成讨论', b: '普通进度群乙的合成讨论', again: '重启后告警群甲的追问',
    rebound: '新配对主人第一次发言丁',
  };
  type Turn = keyof typeof questions;
  type ModelRequest = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
  const calls = new Map<Turn, ModelRequest[]>();
  let turn: Turn = 'private';
  const answer = (label: Turn) => label === 'private' ? '已核对，标记为' + marker : '处理完成-' + label;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    assert.equal(req.url, 'http://127.0.0.1:1/audience-fixture/chat/completions');
    const body: ModelRequest = await req.json();
    const previous = calls.get(turn) ?? [];
    previous.push(body); calls.set(turn, previous);
    const lookup = turn === 'private' && body.messages.at(-1)?.role === 'user';
    const delta = lookup ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture_call', type: 'function',
      function: { name: 'group_read_records', arguments: '{}' } }] } : { role: 'assistant', content: answer(turn) };
    const frames = [delta, {}].map((piece, i) => 'data: ' + JSON.stringify({ id: 'fixture', model: 'fixture',
      object: 'chat.completion.chunk', choices: [{ index: 0, delta: piece, finish_reason: i ? lookup ? 'tool_calls' : 'stop' : null }] }));
    return new Response([...frames, 'data: [DONE]', ''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  });
  let opts!: FeishuOptions;
  const deliveries: Array<{ chat: string; text: string }> = [];
  const botFactory: FeishuBotFactory = options => {
    opts = options;
    return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
      async send(chat, text, ctx) { deliveries.push({ chat, text }); ctx?.onSent?.('om_out_' + deliveries.length, 'text'); } };
  };
  const dependencies = { botFactory, readGroup: { account: () => 'fixture-account', async run() { return marker; } } };
  let host = await startServer(config, dependencies);
  t.after(async () => { try { await host.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const bot = await host.bots.create({ name: '合成受众验收', appId: 'cli_1111111111111111', appSecret: 'fixture-secret',
    scope: { kind: 'global' }, requireConfirmation: false, readGroup: true,
    groupChats: ['oc_audience_a', 'oc_audience_b'].map(chatId => ({ chatId, mentionOnly: true, allowedSenderIds: [] })) });
  const owner = { chatType: 'p2p', chatId: 'oc_dm', senderId: 'ou_owner', senderType: 'user' } as const;
  const group = (chatId: string) => ({ ...owner, chatType: 'group', chatId, mentionedSelf: true });
  await opts.onMessage(bot.pairingCode!, { ...owner, messageId: 'pair' });
  await opts.onMessage('/读群 核对版本', { ...group('oc_original_source'), messageId: 'read' });
  assert.ok(deliveries.some(row => row.chat === 'oc_original_source' && row.text === marker));
  async function ask(label: Turn, source: Omit<FeishuMessageSource, 'messageId'>) {
    turn = label;
    await opts.onMessage(questions[label], { ...source, messageId: 'turn-' + label });
    await t.waitFor(() => assert.ok(deliveries.some(row => row.chat === source.chatId && row.text === answer(label)), label + ' 未收到对应答复'), { timeout: 10000 });
    const trace = calls.get(label)!;
    assert.ok(trace?.length);
    return JSON.stringify(trace.flatMap(call => call.messages));
  }
  const original = await ask('private', owner);
  assert.ok(calls.get('private')![0].tools?.some(tool => tool.function.name === 'group_read_records'));
  assert.ok(calls.get('private')!.some(req => req.messages.some(msg => msg.role === 'tool' && JSON.stringify(msg.content).includes(marker))));
  assert.ok(original.includes(questions.private));
  const firstInputMessages = calls.get('private')![0].messages.filter(message => message.role !== 'system' && message.role !== 'developer');
  assert.equal(JSON.stringify(firstInputMessages).split(questions.private).length - 1, 1, '首次初始化重复写入当前输入');
  const second = await ask('follow', owner);
  assert.ok(second.includes(questions.private) && second.includes(marker), '原主人私聊追问丢失已核对的结论');
  const a = await ask('a', group('oc_audience_a'));
  const b = await ask('b', group('oc_audience_b'));
  const previous = opts;
  await host.close(); host = await startServer(config, dependencies);
  await t.waitFor(() => assert.notEqual(opts, previous));
  const groupFollow = await ask('again', group('oc_audience_a'));
  const privateFollow = await ask('later', owner);
  const rebound = await host.bots.update(bot.id, { appId: 'cli_2222222222222222', appSecret: 'fixture-rebound' });
  const newOwner = { ...owner, chatId: 'oc_new_dm', senderId: 'ou_new_owner' };
  await opts.onMessage(rebound.pairingCode!, { ...newOwner, messageId: 'pair-new' });
  const newChat = await ask('rebound', newOwner);
  const unexpected: string[] = [];
  for (const [label, history, forbidden] of [
    ['群甲', a, [marker, questions.private, questions.follow]],
    ['群乙', b, [marker, questions.private, questions.follow, questions.a]],
    ['群甲重启后', groupFollow, [marker, questions.private, questions.follow, questions.b]],
    ['主人私聊重启后', privateFollow, [questions.a, questions.b, questions.again]],
    ['新主人', newChat, [marker, questions.private, questions.follow, questions.a, questions.b, questions.again, questions.later]],
  ] as const) {
    const count = forbidden.filter(text => history.includes(text)).length;
    if (count) unexpected.push(label + ' 混入 ' + count + ' 项其他受众内容');
  }
  assert.deepEqual(unexpected, [], '受众之间的模型请求历史必须隔离');
  assert.ok(groupFollow.includes(questions.a), '重启后群甲无法续接本群历史');
  assert.ok(privateFollow.includes(questions.private) && privateFollow.includes(marker), '重启后原主人未恢复旧私聊');
});

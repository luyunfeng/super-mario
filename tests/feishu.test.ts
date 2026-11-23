import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import type { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import { createFeishuIntegration, isFeishuMessageGone } from '../plugins/feishu.ts';
import type { FeishuMessageSource, FeishuOptions } from '../plugins/feishu.ts';

// All external effects in this suite are explicit offline fakes.
const credentials = { appId: 'cli_0123456789abcdef', appSecret: 'fake-secret-not-a-credential' };
function offlineWS({ ready = true, reject = false } = {}) {
  let dispatcher: EventDispatcher;
  let params: ConstructorParameters<typeof WSClient>[0];
  let state: ReturnType<WSClient['getConnectionStatus']>['state'] = 'idle';
  let closes = 0;
  const factory: NonNullable<FeishuOptions['wsFactory']> = options => {
    params = options;
    return {
      async start(spec) {
        dispatcher = spec.eventDispatcher;
        state = 'connecting';
        if (reject) throw new Error('fake connect rejected');
        if (ready) { state = 'connected'; options.onReady?.(); }
      },
      close() { state = 'idle'; closes++; },
      getConnectionStatus: () => ({ state, reconnectAttempts: 0 }),
    };
  };
  return {
    factory, get closes() { return closes; }, get params() { return params; }, get dispatcher() { return dispatcher; },
    fail() { state = 'failed'; params.onError?.(new Error('fake socket failed')); },
    disconnect() { state = 'reconnecting'; params.onReconnecting?.(); },
    reconnect() { state = 'connected'; params.onReconnected?.(); },
    async emit(id: string, overrides: Record<string, unknown> = {}, senderType = 'user', target = dispatcher) {
      return target.invoke({ schema: '2.0', header: { event_id: `event-${id}`, event_type: 'im.message.receive_v1' }, event: {
        sender: { sender_type: senderType, sender_id: { open_id: 'ou_fake_sender' } },
        message: { message_id: id, chat_id: 'oc_fake_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '假用户文本' }), ...overrides },
      } }, { needCheck: false });
    },
  };
}
function offlineHTTP() {
  const calls: Array<{ url: string; method: string | undefined; body: Record<string, unknown>; bearer: string | null; signal: AbortSignal | null | undefined }> = [];
  let tokenCalls = 0;
  let tokenCode = 0, sendCode = 0, httpStatus = 200;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, method: init?.method, body, bearer: new Headers(init?.headers).get('authorization'), signal: init?.signal });
    const data = url.includes('tenant_access_token')
      ? { code: tokenCode, msg: tokenCode ? 'fake token denied' : 'ok', tenant_access_token: `fake-tenant-token-${++tokenCalls}`, expire: 7200 }
      : url.endsWith('/bot/v3/info') ? { code: 0, bot: { open_id: 'ou_fake_bot' } }
        : { code: sendCode, msg: sendCode ? 'fake send denied' : 'ok', data: { message_id: `om_fake_sent_${calls.length}` } };
    return Response.json(data, { status: httpStatus });
  };
  return { fakeFetch, calls, get tokenCalls() { return tokenCalls; }, setTokenCode(code: number) { tokenCode = code; }, setSendCode(code: number) { sendCode = code; }, setHTTPStatus(code: number) { httpStatus = code; } };
}
function setup(extra: Partial<FeishuOptions> = {}, socketOptions = {}) {
  const socket = offlineWS(socketOptions), http = offlineHTTP();
  const integration = createFeishuIntegration({ ...credentials, onMessage: async () => {}, onInbox: async () => {}, wsFactory: socket.factory, fetch: http.fakeFetch, ...extra });
  return { integration, socket, http };
}
const envelope = (messages: unknown[], extra = {}) => ({ ok: true, identity: 'user', data: { messages, ...extra } });

test('进度卡保存真实发送标识并PATCH同一消息，不重发创建', async t => {
  const { integration, http } = setup(); t.after(() => integration.close());
  let sent = '';
  await integration.send('oc_owner', '进度', { card: { elements: [] }, onSent: id => { sent = id; } });
  assert.ok(sent);
  const updated = { schema: '2.0', body: { elements: [] } };
  await integration.updateCard(sent, updated);
  const call = http.calls.at(-1)!;
  assert.equal(call.method, 'PATCH'); assert.ok(call.url.endsWith(`/messages/${encodeURIComponent(sent)}`));
  assert.deepEqual(call.body, { content: JSON.stringify(updated) });
});

test('real dispatcher acknowledges before a slow business callback; dedupes by message_id and preserves identity', async t => {
  let release!: (value: string) => void;
  const answer = new Promise<string>(resolve => { release = resolve; });
  const received: unknown[] = [];
  const { integration, socket, http } = setup({ onMessage: async (text, source) => { received.push({ text, source }); return answer; } });
  t.after(() => integration.close());
  assert.equal(integration.status().connected, false);
  await integration.start();
  assert.deepEqual(integration.status(), { connected: true });
  assert.equal(socket.params.autoReconnect, true);
  await Promise.race([socket.emit('om_input'), delay(250).then(() => { throw new Error('SDK ack blocked on model'); })]);
  await socket.emit('om_input'); // Different event deliveries, same platform message ID.
  await socket.emit('om_other_bot', {}, 'bot');
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { text: '假用户文本', source: { chatId: 'oc_fake_chat', messageId: 'om_input', chatType: 'p2p', senderId: 'ou_fake_sender', senderType: 'user', mentionedSelf: false } });
  assert.equal(http.calls.length, 0);
  release('假助手回复'); await tick();
  assert.equal(http.calls.length, 2);
  assert.match(http.calls[1]!.url, /om_input\/reply$/);
  assert.deepEqual(http.calls[1]!.body, { msg_type: 'text', content: JSON.stringify({ text: '假助手回复' }) });
  await socket.emit('om_fake_sent_2', {}, 'user');
  assert.equal(received.length, 1);
});

test('void reply leaves ownership to host; bot, malformed and non-text events do not recurse', async t => {
  const sources: Array<{ chatType?: string }> = [];
  const { integration, socket, http } = setup({ onMessage: async (_text, source) => { sources.push(source); } });
  t.after(() => integration.close());
  await integration.start();
  await socket.emit('om_group', { chat_type: 'group' });
  await socket.emit('om_bad', { content: 'not json' });
  await socket.emit('om_image', { message_type: 'image' });
  await socket.emit('om_own', {}, 'bot');
  await tick();
  assert.deepEqual(sources.map(source => source.chatType), ['group']);
  assert.equal(http.calls.length, 0);
  assert.match(integration.status().reason!, /无法解析/);
});

test('tenant token is single-flight cached; send always uses bot HTTP and never user CLI', async t => {
  const { integration, http } = setup({ runCLI: async () => { throw new Error('CLI must not be called by bot send'); } });
  t.after(() => integration.close());
  await Promise.all([integration.send('oc_fake', 'one'), integration.send('oc_fake', 'two')]);
  assert.equal(http.tokenCalls, 1);
  const sent = http.calls.filter(call => call.url.includes('/im/'));
  assert.equal(sent.length, 2);
  for (const call of sent) {
    assert.equal(call.bearer, 'Bearer fake-tenant-token-1');
    assert.match(call.url, /receive_id_type=chat_id$/);
    assert.equal(call.body.receive_id, 'oc_fake');
  }
  assert.deepEqual(http.calls[0]!.body, { app_id: credentials.appId, app_secret: credentials.appSecret });
});

test('token, API and HTTP errors are explicit; sends never retry unknown effects', async t => {
  const { integration, http } = setup();
  t.after(() => integration.close());
  http.setTokenCode(10003);
  await assert.rejects(integration.send('oc_fake', 'text'), /fake token denied/);
  assert.equal(http.calls.length, 1);
  assert.match(integration.status().reason!, /发送失败/);
  http.setTokenCode(0); http.setSendCode(99991663);
  await assert.rejects(integration.send('oc_fake', 'text'), /99991663/);
  assert.equal(http.calls.length, 3);
  http.setSendCode(0);
  await integration.send('oc_fake', 'text');
  assert.equal(http.tokenCalls, 3); // Failed token + token rejected on send + refreshed token.
  http.setHTTPStatus(503);
  await assert.rejects(integration.send('oc_fake', 'text'), /HTTP 503/);
  assert.equal(http.calls.length, 6);
});

test('invalid/missing token response is rejected rather than treated as authenticated', async t => {
  const { integration } = setup({ fetch: async () => Response.json({ code: 0, expire: 7200 }) });
  t.after(() => integration.close());
  await assert.rejects(integration.send('oc_fake', 'text'), /tenant_access_token/);
});

test('start returns on invalid config or pending connection; status and close are observable', async t => {
  const invalid = setup({ appSecret: '' });
  await invalid.integration.start();
  assert.match(invalid.integration.status().reason!, /appId 或 appSecret/);
  await invalid.integration.close();
  const { integration, socket } = setup({}, { ready: false });
  t.after(() => integration.close());
  await integration.start();
  assert.deepEqual(integration.status(), { connected: false, reason: '正在连接飞书' });
  socket.fail();
  assert.match(integration.status().reason!, /fake socket failed/);
  await integration.close();
  assert.deepEqual(integration.status(), { connected: false, reason: '已关闭' });
  assert.equal(socket.closes, 1);
  await assert.rejects(integration.send('oc_fake', 'text'), /已关闭/);
});

test('connection rejection is observed without blocking start or leaking credentials/endpoints', async t => {
  const { integration, socket } = setup({}, { reject: true });
  t.after(() => integration.close());
  await integration.start(); await tick();
  assert.match(integration.status().reason!, /fake connect rejected/);
  socket.params.logger!.error(credentials.appSecret, 'wss://fake.invalid/ws?token=secret');
  assert.ok(!integration.status().reason!.includes(credentials.appSecret));
  assert.ok(!integration.status().reason!.includes('fake.invalid'));
});

test('close drops queued business callbacks and suppresses a late reply', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let called = 0;
  const { integration, socket, http } = setup({ onMessage: async () => { called++; await waiting; return 'late'; } });
  await integration.start();
  await socket.emit('om_first'); await socket.emit('om_queued');
  await integration.close(); release(); await tick();
  assert.equal(called, 1); assert.equal(http.calls.length, 0);
  await socket.emit('om_after_close'); assert.equal(called, 1);
});

test('no profile disables personal collection and never invokes CLI', async t => {
  const { integration } = setup({ runCLI: async () => { throw new Error('no profile must not read'); } });
  t.after(() => integration.close());
  await integration.start(); assert.deepEqual(await integration.collect(), []);
});

test('user-only collection enriches full content/context and has stable thread/last without bot callbacks', async t => {
  const calls: string[][] = [];
  const search = { message_id: 'om_new', chat_id: 'oc_personal', chat_name: '假个人会话', create_time: '2000', content: 'search excerpt', sender: { name: '假用户' } };
  const { integration, http } = setup({ profile: 'configured-profile', onMessage: async () => { throw new Error('user collection must not enter bot callback'); }, runCLI: async argv => {
    calls.push(argv);
    return argv.includes('+messages-search') ? envelope([search]) : envelope([
      { ...search, content: '完整正文，长度不应由preview决定' },
      { ...search, message_id: 'om_old', create_time: '1000', content: '前文上下文' },
    ]);
  } });
  t.after(() => integration.close());
  const first = await integration.collect(), second = await integration.collect();
  assert.deepEqual(first, second);
  assert.equal(first[0]!.thread, 'feishu:oc_personal:main');
  assert.equal(first[0]!.last, 'om_new');
  assert.match(first[0]!.text, /完整正文/); assert.match(first[0]!.text, /前文上下文/);
  assert.ok(!first[0]!.text.includes('search excerpt'));
  for (const argv of calls) {
    assert.deepEqual(argv.slice(0, 5), ['--profile', 'configured-profile', '--as', 'user', 'im']);
    assert.ok(argv.includes('--format') && argv.includes('json'));
    assert.ok(!argv.some(arg => /^\+(messages-send|messages-reply)$|^login$/.test(arg)));
    if (argv.includes('+messages-search')) {
      assert.match(argv[argv.indexOf('--start') + 1]!, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, '飞书搜索的起点不接受毫秒');
      assert.ok(!argv.includes('--query'), '无关键词时沿用过滤条件，不额外传空关键词');
    }
  }
  assert.equal(http.calls.length, 0);
});

test('thread collection expands platform thread id and exposes truncated pagination', async t => {
  const calls: string[][] = [];
  const message = { message_id: 'om_thread', chat_id: 'oc_fake', thread_id: 'omt_fake', content: '假话题', create_time: '1000' };
  const { integration } = setup({ profile: 'fake', runCLI: async argv => {
    calls.push(argv); return envelope([message], { has_more: true });
  } });
  t.after(() => integration.close());
  const things = await integration.collect();
  assert.equal(things[0]!.thread, 'feishu:oc_fake:omt_fake');
  assert.ok(calls.some(args => args.includes('+threads-messages-list') && args.includes('omt_fake')));
  assert.match(integration.status().reason!, /未采集分页/);
});

test('wrong CLI identity, authorization error and malformed envelope reject explicitly', async t => {
  for (const result of [
    { ok: true, identity: 'bot', data: { messages: [] } },
    { ok: false, identity: 'user', error: { message: 'fake missing_scope' } },
    { ok: true, identity: 'user', data: { items: [] } },
  ]) {
    const { integration } = setup({ profile: 'fake', runCLI: async () => result });
    t.after(() => integration.close());
    await assert.rejects(integration.collect(), /身份|missing_scope|data.messages/);
    assert.match(integration.status().reason!, /采集失败/);
  }
});

test('pollMs controls non-overlapping polling and close stops it; failure stops without retry', async t => {
  let calls = 0, deliveries = 0;
  const { integration } = setup({ profile: 'fake', collectEnabled: true, pollMs: 10, runCLI: async () => { calls++; return envelope([]); }, onInbox: async () => { deliveries++; } });
  t.after(() => integration.close());
  await integration.start();
  for (let attempts = 0; deliveries < 2 && attempts < 30; attempts++) await delay(5);
  assert.ok(deliveries >= 2);
  await integration.close(); const atClose = calls;
  await delay(30); assert.equal(calls, atClose);
  let failedCalls = 0;
  const failed = setup({ profile: 'fake', collectEnabled: true, pollMs: 5, runCLI: async () => { failedCalls++; throw new Error('fake CLI unavailable'); } });
  t.after(() => failed.integration.close());
  await failed.integration.start(); await delay(25);
  assert.equal(failedCalls, 1);
  assert.match(failed.integration.status().reason!, /轮询已停止.*fake CLI unavailable/);
});

test('expired tenant token is refreshed before the next send', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { integration, http } = setup();
  t.after(() => integration.close());
  await integration.send('oc_fake', 'first');
  t.mock.timers.tick(7_200_000);
  await integration.send('oc_fake', 'after expiry');
  assert.equal(http.tokenCalls, 2);
});

test('late token response cannot send or seed token cache after close/restart', async t => {
  const http = offlineHTTP();
  let release!: (response: Response) => void;
  const delayed = new Promise<Response>(resolve => { release = resolve; });
  let first = true;
  const { integration } = setup({ fetch: async (input, init) => {
    if (first) { first = false; return delayed; }
    return http.fakeFetch(input, init);
  } });
  t.after(() => integration.close());
  const pending = integration.send('oc_fake', 'old');
  const rejected = assert.rejects(pending, /发送失败/);
  await integration.close(); await integration.start();
  await integration.send('oc_fake', 'new');
  release(Response.json({ code: 0, tenant_access_token: 'fake-stale-token', expire: 7200 }));
  await rejected;
  assert.deepEqual(integration.status(), { connected: true });
  await integration.send('oc_fake', 'new again');
  assert.equal(http.tokenCalls, 1);
  assert.equal(http.calls.filter(call => call.url.includes('/im/')).length, 2);
  assert.ok(http.calls.every(call => call.bearer !== 'Bearer fake-stale-token'));
});

test('bounded dedupe eventually evicts old IDs and never grows an unbounded event history', async t => {
  let received = 0;
  const { integration, socket } = setup({ onMessage: async () => { received++; } });
  t.after(() => integration.close());
  await integration.start();
  for (let id = 0; id < 2050; id++) await socket.emit(`om_${id}`);
  assert.equal(received, 2050);
  await socket.emit('om_2049'); assert.equal(received, 2050);
  await socket.emit('om_0'); assert.equal(received, 2051);
});

test('collection normalizes mixed ISO, Unix seconds and milliseconds before sorting and inbox validation', async t => {
  const base = { chat_id: 'oc_mixed_time', content: 'fake time fixture', sender: { name: 'fake sender' } };
  // IDs deliberately disagree with chronology. A numeric or lexical-only sort fails.
  const messages = [
    { ...base, message_id: 'om_a_latest', create_time: String(Date.parse('2026-11-15T02:00:00Z')) },
    { ...base, message_id: 'om_z_earliest', create_time: '2026-11-15T08:00:00+08:00' },
    { ...base, message_id: 'om_b_middle', create_time: String(Date.parse('2026-11-15T01:00:00Z') / 1000) },
  ];
  const { integration } = setup({ profile: 'fake', runCLI: async () => envelope(messages) });
  t.after(() => integration.close());
  const [thing] = await integration.collect();
  assert.equal(thing!.receivedAt, '2026-11-15T02:00:00.000Z');
  assert.ok(Number.isFinite(Date.parse(thing!.receivedAt!)));
  assert.equal(thing!.last, 'om_a_latest');
  assert.deepEqual(thing!.text.split('\n').map(line => line.match(/^\[([^\]]+)\]/)![1]), ['om_z_earliest', 'om_b_middle', 'om_a_latest']);
});

test('receivedAt is ISO for each supported representation; invalid times fail explicitly', async t => {
  const expected = '2026-11-15T01:00:00.000Z', milliseconds = Date.parse(expected);
  for (const createTime of [expected, String(milliseconds / 1000), String(milliseconds), milliseconds / 1000, milliseconds]) {
    const { integration } = setup({ profile: 'fake', runCLI: async () => envelope([{ message_id: 'om_time', chat_id: 'oc_fake', create_time: createTime, content: 'fake' }]) });
    t.after(() => integration.close());
    const [thing] = await integration.collect();
    assert.equal(thing!.receivedAt, expected);
    assert.ok(Number.isFinite(Date.parse(thing!.receivedAt!)));
  }
  for (const createTime of ['invalid date', '', '999999999999999999999', false]) {
    const { integration } = setup({ profile: 'fake', runCLI: async () => envelope([{ message_id: 'om_bad_time', chat_id: 'oc_fake', create_time: createTime, content: 'fake' }]) });
    t.after(() => integration.close());
    await assert.rejects(integration.collect(), /create_time/);
    assert.match(integration.status().reason!, /采集失败/);
  }
});

test('SDK reconnect recovers channel status without replaying callbacks or HTTP sends', async t => {
  let callbacks = 0;
  const { integration, socket, http } = setup({ onMessage: async () => { callbacks++; return 'fake reply'; } });
  t.after(() => integration.close());
  await integration.start();
  await socket.emit('om_reconnect'); await tick();
  assert.equal(callbacks, 1); const sent = http.calls.length;
  socket.disconnect();
  assert.deepEqual(integration.status(), { connected: false, reason: '正在重连飞书' });
  socket.reconnect();
  assert.deepEqual(integration.status(), { connected: true });
  await socket.emit('om_reconnect'); await tick();
  assert.equal(callbacks, 1); assert.equal(http.calls.length, sent);
  await socket.emit('om_after_reconnect'); await tick();
  assert.equal(callbacks, 2);
});

test('reconnect budget is finite, resets after recovery, and is cancelled on close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { integration, socket } = setup({ reconnectTimeoutMs: 1000 });
  t.after(() => integration.close());
  await integration.start();
  socket.disconnect(); t.mock.timers.tick(500); socket.reconnect();
  t.mock.timers.tick(1000); assert.equal(socket.closes, 0);
  socket.disconnect(); t.mock.timers.tick(500); socket.disconnect(); t.mock.timers.tick(500);
  assert.equal(socket.closes, 1);
  assert.deepEqual(integration.status(), { connected: false, reason: '飞书重连超时，已停止重连' });
  await integration.close(); await integration.start();
  socket.disconnect(); await integration.close(); const closes = socket.closes;
  t.mock.timers.tick(5000); assert.equal(socket.closes, closes);
  assert.deepEqual(integration.status(), { connected: false, reason: '已关闭' });
});

// An existing account is not consent to read it in the background.
test('configured profile does not start collection without separate opt-in', async t => {
  let reads = 0;
  const { integration } = setup({ profile: 'fake', pollMs: 5, runCLI: async () => { reads++; return envelope([]); } });
  t.after(() => integration.close());
  await integration.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reads, 0);
  await integration.collect();
  assert.ok(reads > 0);
});

test('group opt-in resolves bot identity once and compares raw SDK open_id rather than names or appId', async t => {
  const sources: FeishuMessageSource[] = [];
  const { integration, socket, http } = setup({ groupMessages: true, onMessage: async (_text, source) => { sources.push(source); } });
  t.after(() => integration.close());
  await integration.start(); await tick();
  const info = http.calls.find(call => call.url.endsWith('/bot/v3/info'))!;
  assert.equal(info.url, 'https://open.feishu.cn/open-apis/bot/v3/info');
  assert.equal(info.method, 'GET');
  assert.deepEqual(info.body, {});
  assert.equal(info.bearer, 'Bearer fake-tenant-token-1');
  assert.ok(info.signal instanceof AbortSignal);
  assert.deepEqual(integration.status(), { connected: true });
  const mention = (openId: string, name = 'same display name') => ({ key: '@_user_1', id: { open_id: openId }, name });
  await socket.emit('om_self', { chat_type: 'group', mentions: [mention('ou_fake_bot', 'different name')], thread_id: 'omt_thread', root_id: 'om_root' });
  await socket.emit('om_other', { chat_type: 'group', mentions: [mention('ou_other')] });
  await socket.emit('om_app', { chat_type: 'group', mentions: [mention(credentials.appId)] });
  await socket.emit('om_no_mention', { chat_type: 'group' });
  await socket.emit('om_cli_shape', { chat_type: 'group', mentions: [{ id: 'ou_fake_bot', name: 'same display name' }] });
  await socket.emit('om_multi', { chat_type: 'group', mentions: [mention('ou_other'), mention('ou_fake_bot')] });
  await socket.emit('om_self', { chat_type: 'group', mentions: [mention('ou_fake_bot')] });
  for (const sender of ['bot', 'app', 'unknown', '']) await socket.emit(`om_sender_${sender}`, { chat_type: 'group', mentions: [mention('ou_fake_bot')] }, sender);
  await tick();
  assert.deepEqual(sources.map(source => source.mentionedSelf), [true, false, false, false, false, true]);
  assert.ok(sources.every(source => source.senderType === 'user'));
  assert.deepEqual(sources[0], { chatId: 'oc_fake_chat', messageId: 'om_self', chatType: 'group', senderId: 'ou_fake_sender', senderType: 'user', mentionedSelf: true, mentions: [{ key: '@_user_1', openId: 'ou_fake_bot', name: 'different name' }], threadId: 'omt_thread', rootId: 'om_root' });
  assert.equal(http.calls.length, 2);
  socket.disconnect(); socket.reconnect(); await tick();
  assert.equal(http.calls.length, 2);
});

test('group mode disabled preserves receipt and sends with no bot identity request', async t => {
  for (const groupMessages of [undefined, false]) {
    const sources: FeishuMessageSource[] = [];
    const { integration, socket, http } = setup({ groupMessages, onMessage: async (_text, source) => { sources.push(source); } });
    t.after(() => integration.close());
    await integration.start();
    await socket.emit('om_default_group', { chat_type: 'group', mentions: [{ id: { open_id: 'ou_fake_bot' }, name: 'bot' }] });
    await tick();
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.mentionedSelf, false);
    assert.equal(http.calls.length, 0);
    await integration.send('oc_fake', 'legacy');
    assert.equal(http.calls.length, 2);
    assert.ok(http.calls.every(call => !call.url.includes('/bot/')));
  }
});

test('identity failures reject only groups, expose redacted reason and never retry', async t => {
  for (const failure of ['token', 'http', 'api', 'missing', 'network']) {
    const http = offlineHTTP();
    const sources: FeishuMessageSource[] = [];
    let infoCalls = 0;
    if (failure === 'token') http.setTokenCode(10003);
    const { integration, socket } = setup({ groupMessages: true, onMessage: async (_text, source) => { sources.push(source); }, fetch: async (input, init) => {
      if (!String(input).endsWith('/bot/v3/info')) return http.fakeFetch(input, init);
      infoCalls++;
      if (failure === 'network') throw new Error(`fake network ${credentials.appSecret} fake-tenant-token-1 Bearer fake-auth wss://fake.invalid/ws`);
      if (failure === 'http') return Response.json({}, { status: 403 });
      if (failure === 'api') return Response.json({ code: 99991663, msg: `fake-tenant-token-1 ${credentials.appSecret} Bearer fake-auth` });
      return Response.json({ code: 0, bot: {} });
    } });
    t.after(() => integration.close());
    await integration.start(); await tick();
    assert.match(integration.status().reason!, /机器人身份读取失败/);
    for (const secret of [credentials.appSecret, 'fake-tenant-token-1', 'fake-auth', 'fake.invalid']) assert.ok(!integration.status().reason!.includes(secret));
    await socket.emit('om_group_failed', { chat_type: 'group' });
    await socket.emit('om_private_ok'); await tick();
    assert.deepEqual(sources.map(source => source.messageId), ['om_private_ok']);
    socket.disconnect(); socket.reconnect(); await tick();
    assert.equal(infoCalls, failure === 'token' ? 0 : 1);
    assert.equal(http.tokenCalls, 1);
    assert.match(integration.status().reason!, /机器人身份读取失败/);
  }
});

test('pending identity refuses groups; late identity and old dispatcher/lifecycle cannot contaminate restart', async t => {
  const http = offlineHTTP();
  let release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  let first = true;
  let oldSignal: AbortSignal | null | undefined;
  const sources: FeishuMessageSource[] = [];
  const { integration, socket } = setup({ groupMessages: true, onMessage: async (_text, source) => { sources.push(source); }, fetch: async (input, init) => {
    if (String(input).endsWith('/bot/v3/info') && first) { first = false; oldSignal = init?.signal; return pending; }
    return http.fakeFetch(input, init);
  } });
  t.after(() => integration.close());
  await integration.start(); await tick();
  assert.match(integration.status().reason!, /正在读取机器人身份/);
  await socket.emit('om_pending_group', { chat_type: 'group' });
  await socket.emit('om_pending_private');
  const oldDispatcher = socket.dispatcher, oldParams = socket.params;
  await integration.close();
  assert.equal(oldSignal?.aborted, true);
  await integration.start(); await tick();
  release(Response.json({ code: 0, bot: { open_id: 'ou_stale_bot' } })); await tick();
  await socket.emit('om_old_event', { chat_type: 'group' }, 'user', oldDispatcher);
  oldParams.logger!.error('old logger'); oldParams.onError?.(new Error('old error')); oldParams.onReconnecting?.();
  await socket.emit('om_new', { chat_type: 'group', mentions: [{ id: { open_id: 'ou_fake_bot' } }] });
  await socket.emit('om_pending_group', { chat_type: 'group' }); await tick();
  assert.deepEqual(sources.map(source => source.messageId), ['om_pending_private', 'om_new', 'om_pending_group']);
  assert.equal(sources[1]!.mentionedSelf, true);
  assert.deepEqual(integration.status(), { connected: true });
});

test('identity timeout is bounded by the abort signal and leaves private receipt available', async t => {
  const timeoutController = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', () => timeoutController.signal);
  const http = offlineHTTP();
  let signal: AbortSignal | null | undefined;
  const sources: FeishuMessageSource[] = [];
  let infoCalls = 0;
  const { integration, socket } = setup({ groupMessages: true, onMessage: async (_text, source) => { sources.push(source); }, fetch: async (input, init) => {
    if (!String(input).endsWith('/bot/v3/info')) return http.fakeFetch(input, init);
    infoCalls++; signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  } });
  t.after(() => integration.close());
  await integration.start(); await tick();
  assert.ok(timeout.mock.calls.every(call => call.arguments[0] === 15_000));
  timeoutController.abort(new DOMException('fake identity timeout', 'TimeoutError')); await tick();
  assert.equal(signal?.aborted, true);
  assert.match(integration.status().reason!, /身份读取失败.*timeout/);
  await socket.emit('om_timeout_group', { chat_type: 'group' });
  await socket.emit('om_timeout_private'); await tick();
  assert.deepEqual(sources.map(source => source.messageId), ['om_timeout_private']);
  assert.equal(infoCalls, 1);
});

test('adapter serializes an internal dashboard as an interactive Feishu message', async t => {
  const { integration, http } = setup();
  t.after(() => integration.close());
  const card = { elements: [{ tag: 'markdown', content: '工作台' }] };
  await integration.send('oc_owner', '工作台', { card });
  const request = http.calls.at(-1)!;
  assert.match(request.url, /messages\?receive_id_type=chat_id$/);
  assert.deepEqual(request.body, { receive_id: 'oc_owner', msg_type: 'interactive', content: JSON.stringify(card) });
});

test('send reply context and automatic answers preserve thread without using thread ID as message ID', async t => {
  const { integration, socket, http } = setup({ onMessage: async () => 'automatic' });
  t.after(() => integration.close());
  await integration.start();
  await integration.send('oc_fake', 'thread reply', { replyTo: 'om_parent/encoded', threadId: 'omt_not_message' });
  await integration.send('oc_fake', 'plain reply', { replyTo: 'om_plain' });
  await integration.send('oc_fake', 'thread only', { threadId: 'omt_not_message' });
  await socket.emit('om_auto', { thread_id: 'omt_not_message', root_id: 'om_root' }); await tick();
  const sends = http.calls.filter(call => call.url.includes('/im/'));
  assert.equal(sends.length, 4);
  assert.match(sends[0]!.url, /om_parent%2Fencoded\/reply$/);
  assert.deepEqual(sends[0]!.body, { msg_type: 'text', content: JSON.stringify({ text: 'thread reply' }), reply_in_thread: true });
  assert.match(sends[1]!.url, /om_plain\/reply$/);
  assert.ok(!('reply_in_thread' in sends[1]!.body));
  assert.match(sends[2]!.url, /receive_id_type=chat_id$/);
  assert.match(sends[3]!.url, /om_auto\/reply$/);
  assert.equal(sends[3]!.body.reply_in_thread, true);
  const count = http.calls.length;
  for (let id = 2; id <= 5; id++) await socket.emit(`om_fake_sent_${id}`);
  await tick(); assert.equal(http.calls.length, count);
});

test('old business callback does not block new generation or send stale automatic replies', async t => {
  let release!: (answer: string) => void;
  const pending = new Promise<string>(resolve => { release = resolve; });
  const ids: string[] = [];
  const { integration, socket, http } = setup({ onMessage: async (_text, source) => { ids.push(source.messageId); return source.messageId === 'om_old' ? pending : 'new reply'; } });
  t.after(() => integration.close());
  await integration.start(); await socket.emit('om_old'); await socket.emit('om_dropped');
  await integration.close(); await integration.start();
  await socket.emit('om_new'); await tick();
  assert.deepEqual(ids, ['om_old', 'om_new']);
  release('stale reply'); await tick();
  assert.deepEqual(http.calls.filter(call => call.url.includes('/im/')).map(call => call.url.split('/').slice(-2).join('/')), ['om_new/reply']);
  assert.deepEqual(integration.status(), { connected: true });
});

test('queue remains bounded while processing is blocked and overflow can be redelivered', async t => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const ids: string[] = [];
  const { integration, socket } = setup({ onMessage: async (_text, source) => { ids.push(source.messageId); if (ids.length === 1) await pending; } });
  t.after(() => integration.close());
  await integration.start(); await socket.emit('om_busy');
  for (let id = 0; id < 101; id++) await socket.emit(`om_queued_${id}`);
  assert.equal(ids.length, 1);
  assert.match(integration.status().reason!, /队列已满/);
  release(); await tick();
  assert.equal(ids.length, 101);
  assert.ok(!ids.includes('om_queued_100'));
  await socket.emit('om_queued_100'); await tick();
  assert.equal(ids.at(-1), 'om_queued_100');
});

test('late send response after restart cannot add a message ID to the new generation dedupe', async t => {
  const http = offlineHTTP();
  let release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  let oldSignal: AbortSignal | null | undefined;
  const ids: string[] = [];
  const { integration, socket } = setup({ onMessage: async (_text, source) => { ids.push(source.messageId); }, fetch: async (input, init) => {
    if (String(input).includes('/im/')) { oldSignal = init?.signal; return pending; }
    return http.fakeFetch(input, init);
  } });
  t.after(() => integration.close());
  await integration.start();
  const sending = integration.send('oc_fake', 'old send');
  const rejected = assert.rejects(sending, /发送失败/);
  await tick();
  await integration.close(); await integration.start();
  assert.equal(oldSignal?.aborted, true);
  release(Response.json({ code: 0, data: { message_id: 'om_stale_response' } })); await rejected;
  await socket.emit('om_stale_response'); await tick();
  assert.deepEqual(ids, ['om_stale_response']);
  assert.deepEqual(integration.status(), { connected: true });
});

test('configured message renderer sends cards once, retains reply thread, and falls back before send for long text', async t=>{
 const {buildFeishuMessageCard}=await import('../apps/server/src/feishu-cards.ts');
 const {integration,http}=setup({renderMessage:(text,context)=>buildFeishuMessageCard(text,{webBase:'https://work.example/',...context?.presentation})});
 t.after(()=>integration.close());
 await integration.send('oc_fake_chat','结果内容',{replyTo:'om_parent',threadId:'omt_thread',presentation:{kind:'result',route:'projects/p/runs/r'}});
 let sent=http.calls.filter(c=>c.url.includes('/im/v1/messages'));
 assert.equal(sent.length,1);assert.match(sent[0]!.url,/om_parent\/reply$/);
 assert.equal(sent[0]!.body.reply_in_thread,true);assert.equal(sent[0]!.body.msg_type,'interactive');
 assert.match(String(sent[0]!.body.content),/#projects\/p\/runs\/r/);
 const long='中'.repeat(7000);await integration.send('oc_fake_chat',long);
 sent=http.calls.filter(c=>c.url.includes('/im/v1/messages'));assert.equal(sent.length,2);assert.equal(sent[1]!.body.msg_type,'text');assert.equal(JSON.parse(String(sent[1]!.body.content)).text,long);
 http.setSendCode(10003);await assert.rejects(integration.send('oc_fake_chat','卡片发送失败'),/未自动重试/);
 assert.equal(http.calls.filter(c=>c.url.includes('/im/v1/messages')).length,3,'no text retry after uncertain card send');
});

test('real SDK card callback returns toast and replacement card without waiting for model queue; old generations do nothing', async t=>{
 let calls=0;const {integration,socket}=setup({onCardAction:input=>{calls++;assert.deepEqual(input.formValue,{prompt:'验收'});assert.equal(input.operatorId,'ou_owner');assert.equal(input.chatId,'oc_owner');return{toast:{type:'success',content:'已刷新'},card:{type:'raw',data:{elements:[]}}};}});
 t.after(()=>integration.close());await integration.start();const dispatcher=socket.dispatcher;
 const event={schema:'2.0',header:{event_id:'card-event',event_type:'card.action.trigger'},event:{operator:{open_id:'ou_owner'},context:{open_chat_id:'oc_owner',open_message_id:'om_card'},action:{value:{kind:'workbench.navigate'},form_value:{prompt:'验收'}}}};
 const result=await dispatcher.invoke(event,{needCheck:false}) as any;
 assert.equal(result.toast.content,'已刷新');assert.equal(result.card.type,'raw');assert.equal(calls,1);
 await integration.close();const stale=await dispatcher.invoke(event,{needCheck:false}) as any;
 assert.equal(stale.toast.type,'info');assert.equal(calls,1);
});

test('总指挥群只扩展指定群的人类入口，保留未解析点名并过滤发送回声', async t => {
  const sources: FeishuMessageSource[] = [];
  const chatId = 'oc_command';
  const { integration, socket, http } = setup({ commandGroupChatId: chatId,
    renderMessage: () => ({ schema: '2.0' }), onMessage: async (_, source) => { sources.push(source); } });
  t.after(() => integration.close());
  await integration.start(); await tick();
  const group = { chat_id: chatId, chat_type: 'group' };
  await socket.emit('om_plain', group);
  await socket.emit('om_plain', group);
  await socket.emit('om_other', { ...group, chat_id: 'oc_other' });
  for (const sender of ['app', 'bot', 'unknown']) await socket.emit('om_' + sender, group, sender);
  await socket.emit('om_mention', { ...group, mentions: [{ key: '@_user_1', id: { open_id: 'ou_target', app_id: 'cli_target' }, name: '项目' }, {}] });
  await tick();
  assert.deepEqual(sources.map(s => s.messageId), ['om_plain', 'om_mention']);
  assert.deepEqual(sources[1]!.mentions, [{ key: '@_user_1', openId: 'ou_target', appId: 'cli_target', name: '项目' }, {}]);
  const mention = { openId: 'ou_target', name: '项目' };
  const text = '<at user_id="all">测试</at>';
  let receipt = '';
  await integration.send(chatId, text, { mention, onSent: id => { receipt = id; } });
  const sent = http.calls.at(-1)!;
  assert.ok(sent.url.endsWith('/im/v1/messages?receive_id_type=chat_id'));
  assert.deepEqual(sent.body, { receive_id: chatId, msg_type: 'post',
    content: JSON.stringify({ zh_cn: { content: [[{ tag: 'at', user_id: 'ou_target' }, { tag: 'text', text: ' ' + text }]] } }) });
  assert.ok(receipt);
  await socket.emit(receipt, group);
  await tick();
  assert.equal(sources.length, 2);
  const count = http.calls.length;
  await assert.rejects(integration.send(chatId, text, { mention: { ...mention, openId: credentials.appId } }), /openId/);
  await assert.rejects(integration.send('oc_other', text, { mention }), /总指挥群/);
  assert.equal(http.calls.length, count);
});

test('会话清单只有在卡片明确被拒且主人仍有权读取时，才向原目标发送文本', async t => {
  let status = 400, code = 230099, allowed = true;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const { integration } = setup({ fetch: async (input, init) => {
    const url = String(input);
    if (url.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
    return body.msg_type === 'interactive' ? Response.json({ code }, { status })
      : Response.json({ code: 0, data: { message_id: 'om_text_receipt' } });
  } });
  t.after(() => integration.close());
  const receipts: string[] = [];
  const context = { card: { elements: [] }, replyTo: 'om_list', threadId: 'thread', onSent: (id: string) => receipts.push(id),
    beforeTextFallback() { if (!allowed) throw new Error('主人已变更'); } };
  await integration.send('oc_chat', '最近对话', context);
  assert.deepEqual(requests.map(r => r.body.msg_type), ['interactive', 'text']);
  assert.equal(requests[0]!.url, requests[1]!.url);
  assert.deepEqual(requests[1]!.body, { msg_type: 'text', content: JSON.stringify({ text: '最近对话' }), reply_in_thread: true });
  assert.deepEqual(receipts, ['om_text_receipt']);
  allowed = false;
  await assert.rejects(integration.send('oc_chat', '最近对话', context), { message: /主人已变更/, delivery: 'no' });
  allowed = true;
  status = 503;
  await assert.rejects(integration.send('oc_chat', '最近对话', context), /HTTP 503/);
  status = 400; code = 230028;
  await assert.rejects(integration.send('oc_chat', '最近对话', context), /HTTP 400/);
  assert.deepEqual(requests.slice(2).map(r => r.body.msg_type), ['interactive', 'interactive', 'interactive']);
  assert.deepEqual(receipts, ['om_text_receipt']);
});

test('机器人在同一租户令牌下置顶、取消置顶和撤回准确的消息', async t => {
  const { integration, http } = setup();
  t.after(() => integration.close());
  await assert.rejects(integration.pinMessage('om_card'), { delivery: 'no' });
  await integration.start();
  await assert.rejects(integration.recallMessage('../pins'), { delivery: 'no' });
  assert.equal(http.calls.length, 0);
  await integration.pinMessage('om_card');
  await integration.unpinMessage('om_card');
  await integration.recallMessage('om_command');
  assert.equal(http.tokenCalls, 1);
  assert.deepEqual(http.calls.slice(1).map(row => [row.method, new URL(row.url).pathname, row.body, row.bearer]), [
    ['POST', '/open-apis/im/v1/pins', { message_id: 'om_card' }, 'Bearer fake-tenant-token-1'],
    ['DELETE', '/open-apis/im/v1/pins/om_card', {}, 'Bearer fake-tenant-token-1'],
    ['DELETE', '/open-apis/im/v1/messages/om_command', {}, 'Bearer fake-tenant-token-1'],
  ]);
  await integration.close();
  await assert.rejects(integration.unpinMessage('om_card'), { delivery: 'no' });
  assert.equal(http.calls.length, 4);
});

test('飞书明确拒绝与传输结果未知分别报告，变更请求只发一次', async t => {
  const replies = [
    { response: () => Response.json({ code: 99991672, msg: 'synthetic-private-detail' }, { status: 400 }), delivery: 'no' },
    { response: () => Response.json({}, { status: 403 }), delivery: 'no' },
    { response: () => Response.json({}, { status: 503 }), delivery: 'unknown' },
    { response: () => Response.json({ code: 99991500 }), delivery: 'unknown' },
    { response: () => Response.json({ code: 123456 }), delivery: 'unknown' },
    { response: () => Response.json({}), delivery: 'unknown' },
    { response: () => { throw new Error('synthetic-private-detail'); }, delivery: 'unknown' },
  ];
  let calls = 0;
  const { integration } = setup({ fetch: async url => String(url).includes('tenant_access_token')
    ? Response.json({ code: 0, tenant_access_token: 'fake-auth', expire: 7200 })
    : replies[calls++].response() });
  t.after(() => integration.close());
  await integration.start();
  for (const [index, expected] of replies.entries()) {
    await assert.rejects(integration.recallMessage('om_command'), (error: Error & { delivery?: string }) => {
      assert.equal(error.delivery, expected.delivery);
      if (index < 2) assert.match(error.message, /im:message:recall/);
      assert.doesNotMatch(error.message, /synthetic-private-detail|fake-auth/);
      return true;
    });
    assert.equal(calls, index + 1);
  }
});

test('适配器在鉴权等待期间关闭时保留消息，变更已发出后关闭时报告未知', async () => {
  for (const phase of ['auth', 'send']) {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let writes = 0;
    const { integration } = setup({ fetch: async url => {
      const auth = String(url).includes('tenant_access_token');
      if (!auth) writes++;
      if (auth === (phase === 'auth')) { entered(); await gate; }
      return Response.json(auth ? { code: 0, tenant_access_token: 'fake-auth', expire: 7200 } : { code: 0 });
    } });
    await integration.start();
    const pin = integration.pinMessage('om_card');
    await started;
    await integration.close();
    release();
    await assert.rejects(pin, { delivery: phase === 'auth' ? 'no' : 'unknown' });
    assert.equal(writes, phase === 'auth' ? 0 : 1);
  }
});

test('卡片被拒后只报告实际送达的文本类型', async t => {
  const sent: unknown[] = [];
  let rejectCard = false;
  const { integration } = setup({ fetch: async (url, init) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fake-auth', expire: 7200 });
    const type = JSON.parse(String(init?.body)).msg_type;
    return Response.json(rejectCard && type === 'interactive' ? { code: 230099 } : { code: 0, data: { message_id: 'om_' + type } });
  } });
  t.after(() => integration.close());
  const context = { card: {}, beforeTextFallback() {}, onSent(id: string, type?: string) { sent.push([id, type]); } };
  await integration.send('oc_chat', '工作台', context);
  rejectCard = true;
  await integration.send('oc_chat', '工作台', { ...context, replyTo: 'om_command' });
  assert.deepEqual(sent, [['om_interactive', 'interactive'], ['om_text', 'text']]);
});


test('只有回复父消息被飞书明确判定已撤回或删除时，释放该话题锚点', async t => {
  let status = 400, code = 230011, loseConnection = false, replies = 0;
  const { integration } = setup({ fetch: async url => {
    if (String(url).includes('tenant_access_token')) return Response.json({code:0,tenant_access_token:'fixture',expire:7200});
    replies++;
    if (loseConnection) throw new Error('network timeout 230011');
    return Response.json({code,msg:'业务错误'}, {status});
  } });
  t.after(() => integration.close());
  const reply = () => integration.send('oc_fixture','合成状态',{replyTo:'om_anchor',threadId:'omt_fixture',plainText:true});
  for (const businessCode of [230011,230110]) {
    code=businessCode;
    for (const http of [200,400,404]) {
      status=http;
      await assert.rejects(reply(), error => isFeishuMessageGone(error) && (error as {delivery?:string}).delivery==='no');
    }
  }
  for (const [http, businessCode] of [[403,99991672],[404,0],[429,230429],[502,230011],[400,230027]]) {
    status=http;code=businessCode;
    await assert.rejects(reply(), error => !isFeishuMessageGone(error));
  }
  status=400;code=230011;
  await assert.rejects(integration.send('oc_fixture','普通群消息'), error=>!isFeishuMessageGone(error));
  loseConnection=true;
  await assert.rejects(reply(), error=>!isFeishuMessageGone(error));
  assert.equal(replies,13);
  assert.equal(isFeishuMessageGone(Object.assign(new Error('230110'),{apiCode:230110})),false);
});

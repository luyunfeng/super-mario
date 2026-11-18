import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import type { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import { createFeishuIntegration } from '../plugins/feishu.ts';
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
  assert.ok(calls[1]!.includes('+threads-messages-list'));
  assert.ok(calls[1]!.includes('omt_fake'));
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
  assert.deepEqual(sources[0], { chatId: 'oc_fake_chat', messageId: 'om_self', chatType: 'group', senderId: 'ou_fake_sender', senderType: 'user', mentionedSelf: true, threadId: 'omt_thread', rootId: 'om_root' });
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

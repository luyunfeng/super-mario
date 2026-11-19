import { chatDirectory } from './feishu-scope-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPersonalProvider, PERSONAL_MESSAGE_SCOPES, PersonalAuthError } from '../plugins/feishu-personal.ts';
import type { PersonalCLI, PersonalProvider, PersonalAccount, PersonalCheckpoint } from '../plugins/feishu-personal.ts';
import { preparePersonalCheckpoint } from '../plugins/feishu.ts';
import { createPersonalMessages } from '../apps/server/src/feishu-personal.ts';
import type { InboxThing } from '../packages/protocol/src/index.ts';

const account = { profile: 'test-profile', appId: 'cli_0123456789abcdef', openId: 'ou_me', name: '测试' };
const signal = () => new AbortController().signal;
const value = (args: string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const route = (args: string[]) => args.includes('--is-at-me') ? 1 : args.includes('p2p') ? 0 : 2;
const row = (n: number, extra = {}) => ({ message_id: `om_${n}`, chat_id: `oc_${n}`, chat_type: 'group', create_time: '2026-11-17T00:00:00Z', content: `消息${n}`, sender: { id: 'ou_other', name: '对方' }, ...extra });
const envelope = (messages: unknown[] = [], data = {}, meta = {}) => ({ ok: true, identity: 'user', data: { messages, has_more: false, ...data }, meta });
function providerWith(search: (args: string[]) => unknown | Promise<unknown>, calls: string[][] = [], chat?: (id: string) => Record<string, unknown>, groupIds = () => Array.from({length: 10}, (_, n) => `oc_${n}`)) {
  const runCLI: PersonalCLI = async args => {
    calls.push(args);
    const directory = chatDirectory(args, groupIds());
    if (directory) return directory;
    if (args.includes('status')) return { appId: account.appId, identity: 'user', verified: true, identities: { user: { available: true, openId: account.openId, userName: account.name, scope: PERSONAL_MESSAGE_SCOPES.join(' ') } } };
    if (args.includes('+messages-search')) return await search(args) as Record<string, any>;
    if (args.includes('chats') && chat) return chat(value(args, '--chat-id')!);
    return envelope();
  };
  return createPersonalProvider({ application: () => account, runCLI });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
async function until(check: () => boolean) { for (let n = 0; n < 200; n++) { if (check()) return; await delay(5); } assert.fail('状态未收敛'); }
function fixture(t: test.TestContext, provider: PersonalProvider, ingest?: (source: string, things: InboxThing[]) => Promise<unknown>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mario-pagination-'));
  const ingested: InboxThing[][] = [];
  const options = { config: { host: '127.0.0.1', port: 0, dataDir, demo: false }, provider, canCollect: () => true,
    ingest: ingest ?? (async (_source: string, things: InboxThing[]) => { ingested.push(things); }) };
  // Authorization itself is a local substitute; collection below still uses the production provider.
  provider.application = async () => account;
  provider.begin = async () => ({ url: 'https://accounts.feishu.cn/test', code: 'fake', expiresIn: 60 });
  provider.complete = async () => account;
  const services = [createPersonalMessages(options)];
  t.after(async () => { for (const service of services) await service.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { service: services[0]!, ingested, options,
    read: () => JSON.parse(readFileSync(join(dataDir, 'private/feishu-personal/account.json'), 'utf8')),
    restart() { const service = createPersonalMessages(options); services.push(service); service.start(); return service; },
    file: join(dataDir, 'private/feishu-personal/account.json') };
}
async function connect(service: ReturnType<typeof createPersonalMessages>) { service.authorize(); await until(() => service.status().status === 'connected'); }

test('生产 provider 跨页超过50条，三路公平读取并去重，保留精确个人@和来源', async () => {
  const calls: string[][] = [];
  const direct = row(100, { chat_type: 'p2p' });
  const mention = row(101, { chat_id: 'oc_3', mentions: [{ id: account.openId }] });
  const p = providerWith(args => {
    if (route(args) === 0) return envelope([direct]);
    if (route(args) === 1) return envelope([mention]);
    return value(args, '--page-token') ? envelope(Array.from({ length: 10 }, (_, n) => row(n + 50, {chat_id:'oc_1'})))
      : envelope([direct, mention, ...Array.from({ length: 48 }, (_, n) => row(n, {chat_id:'oc_1'}))], { has_more: true, page_token: 'opaque-next' });
  }, calls);
  const first = await p.collectBatch!(account, signal());
  assert.equal(first.items.length, 50); assert.equal(first.hasMore, true);
  assert.equal(first.checkpoint.lastCompletedThrough, undefined);
  assert.equal(first.items.find(item => item.origin?.chatId === 'oc_100')!.origin!.kind, 'direct');
  assert.equal(first.items.find(item => item.origin?.chatId === 'oc_3')!.origin!.mentionedMe, true);
  const second = await p.collectBatch!(account, signal(), first.checkpoint);
  assert.equal(first.items.length + second.items.length, 60);
  assert.equal(second.hasMore, false); assert.equal(second.checkpoint.lastCompletedThrough, first.checkpoint.window!.end);
  const searches = calls.filter(args => args.includes('+messages-search'));
  assert.deepEqual(searches.map(route), [0, 1, 2, 2]);
  assert.equal(new Set(searches.map(args => value(args, '--start'))).size, 1);
  assert.equal(new Set(searches.map(args => value(args, '--end'))).size, 1);
  assert.equal(value(searches[3]!, '--page-token'), 'opaque-next');
  assert.ok(!searches.some(args => args.includes('--page-all')));
});

test('重启从持久断页续读同一窗口；只有三路耗尽后水位完成，公开状态无游标', async t => {
  const calls: string[][] = [];
  const p = providerWith(args => route(args) !== 2 ? envelope() : value(args, '--page-token')
    ? envelope([row(2)]) : envelope([row(1)], { has_more: true, page_token: 'private-next-token' }), calls);
  const f = fixture(t, p); await connect(f.service); await f.service.enable(true);
  await until(() => f.service.status().collectionPages === 3);
  const before = f.read().checkpoint as PersonalCheckpoint;
  assert.equal(f.service.status().hasMore, true); assert.equal(f.service.status().lastCompletedThrough, undefined);
  const publicJSON = JSON.stringify(f.service.status());
  for (const secret of ['private-next-token', account.profile, account.openId, account.appId]) assert.ok(!publicJSON.includes(secret));
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  await f.service.close(); const resumed = f.restart();
  await until(() => Boolean(resumed.status().lastCompletedThrough));
  assert.equal(resumed.status().lastCompletedThrough, before.window!.end);
  assert.equal(resumed.status().hasMore, false);
  const searches = calls.filter(args => args.includes('+messages-search'));
  assert.equal(searches.length, 4); assert.equal(value(searches[3]!, '--page-token'), 'private-next-token');
  assert.equal(value(searches[3]!, '--start'), before.window!.start);
});

test('ingest 失败不提交页或水位；重启重读已固定的首次窗口', async t => {
  let failing = true; const calls: string[][] = [];
  const p = providerWith(() => envelope([row(1)]), calls);
  const f = fixture(t, p, async () => { if (failing) throw new Error('temporary inbox failure'); });
  await connect(f.service); await f.service.enable(true); await until(() => Boolean(f.service.status().error));
  const checkpoint = f.read().checkpoint;
  assert.equal(checkpoint.pages, 0); assert.ok(checkpoint.window); assert.equal(checkpoint.lastCompletedThrough, undefined);
  assert.equal(f.service.status().enabled, false);
  await f.service.close(); failing = false; const resumed = f.restart();
  await until(() => resumed.status().status === 'connected'); await resumed.enable(true);
  await until(() => Boolean(resumed.status().lastCompletedThrough));
  const searches = calls.filter(args => args.includes('+messages-search'));
  assert.equal(searches.length, 6);
  assert.ok(searches.every(args => value(args, '--start') === checkpoint.window.start && !args.includes('--page-token')));
});

test('hasMore 以短延时继续同一串行队列，不等常规轮询间隔', async t => {
  let active = 0, maximum = 0;
  const p = providerWith(async args => {
    active++; maximum = Math.max(maximum, active); await delay(1); active--;
    return route(args) === 2 && !args.includes('--page-token') ? envelope([row(1)], { has_more: true, page_token: 'next' }) : envelope();
  });
  const f = fixture(t, p); await connect(f.service); await f.service.enable(true);
  await until(() => Boolean(f.service.status().lastCompletedThrough));
  assert.equal(f.ingested.length, 2); assert.equal(maximum, 1);
});

for (const broken of ['missing', 'meta-incomplete', 'same-token', 'cycle', 'unknown-completion'] as const) {
  test(`分页 ${broken} 不推进水位，失败不修改传入checkpoint`, async () => {
    const initial = preparePersonalCheckpoint(account);
    const lane = initial.window!.lanes[0]!;
    if (broken === 'same-token' || broken === 'cycle') lane.token = 'A';
    if (broken === 'cycle') lane.seen = ['B'];
    const snapshot = structuredClone(initial);
    const p = providerWith(() => broken === 'meta-incomplete' ? envelope([], {}, { pagination: { complete: false } })
      : broken === 'unknown-completion' ? { ok: true, identity: 'user', data: { messages: [] } }
      : envelope([], { has_more: true, ...(broken === 'same-token' ? { page_token: 'A' } : broken === 'cycle' ? { page_token: 'B' } : {}) }));
    await assert.rejects(p.collectBatch!(account, signal(), initial), /分页/);
    assert.deepEqual(initial, snapshot);
  });
}

test('过期token只回到原窗口起点，重新只读扫描；不吞掉普通错误', async () => {
  const initial = preparePersonalCheckpoint(account); initial.window!.lanes[0]!.token = 'expired-token';
  initial.window!.lanes[0]!.seen = ['old'];
  const calls: string[][] = [];
  const p = providerWith(args => { if (args.includes('--page-token')) throw new PersonalAuthError('cursor'); return envelope([row(1)]); }, calls);
  const batch = await p.collectBatch!(account, signal(), initial);
  const searches = calls.filter(args => args.includes('+messages-search'));
  assert.equal(searches.length, 4); assert.equal(batch.hasMore, false);
  assert.equal(value(searches[0]!, '--page-token'), 'expired-token'); assert.equal(value(searches[1]!, '--page-token'), undefined);
  assert.ok(searches.every(args => value(args, '--start') === initial.window!.start && value(args, '--end') === initial.window!.end));
  const failedCalls: string[][] = [];
  const failed = providerWith(() => { throw new PersonalAuthError('timeout'); }, failedCalls);
  await assert.rejects(failed.collectBatch!(account, signal(), initial), PersonalAuthError);
  assert.equal(failedCalls.filter(args => args.includes('+messages-search')).length, 1);
});

test('初次24h，后续水位重叠5分钟；账号、应用、profile任一变化均不串游标', async () => {
  const p = providerWith(() => envelope());
  const first = await p.collectBatch!(account, signal());
  const next = preparePersonalCheckpoint(account, first.checkpoint);
  assert.equal(Date.parse(next.window!.start), Date.parse(first.checkpoint.lastCompletedThrough!) - 300_000);
  const initial = preparePersonalCheckpoint(account);
  assert.equal(Date.parse(initial.window!.end) - Date.parse(initial.window!.start), 86_400_000);
  initial.window!.lanes[0]!.token = 'private-old';
  for (const changed of [{ ...account, profile: 'other' }, { ...account, appId: 'cli_other' }, { ...account, openId: 'ou_other' }]) {
    const result = preparePersonalCheckpoint(changed, initial);
    assert.equal(result.window!.lanes[0]!.token, undefined); assert.equal(result.pages, 0);
  }
});

test('stop发生在ingest等待中时，迟到成功不能保存新游标或完成水位', async t => {
  const gate = deferred<void>(); let entered = false;
  const p = providerWith(() => envelope([row(1)]));
  const f = fixture(t, p, async () => { entered = true; await gate.promise; });
  await connect(f.service); await f.service.enable(true); await until(() => entered);
  const stopping = f.service.enable(false); gate.resolve(); await stopping;
  assert.equal(f.read().checkpoint.pages, 0); assert.equal(f.read().checkpoint.lastCompletedThrough, undefined);
  assert.equal(f.service.status().lastCollectedAt, undefined);
});

test('新授权换号时旧批次迟到不能ingest或覆写账号游标；新授权不继承旧水位', async t => {
  const gate = deferred<ReturnType<typeof envelope>>(); let entered = false;
  const p = providerWith(async () => { entered = true; return gate.promise; });
  const f = fixture(t, p); await connect(f.service); await f.service.enable(true); await until(() => entered);
  f.service.cancel(); p.complete = async () => ({ ...account, openId: 'ou_new' });
  await connect(f.service); gate.resolve(envelope([row(1)])); await delay(20);
  assert.equal(f.read().account.openId, 'ou_new'); assert.equal(f.read().checkpoint, undefined);
  assert.equal(f.ingested.length, 0); assert.equal(f.service.status().enabled, false);
});

test('仅collect的旧provider继续可用，不伪造分页完成水位', async t => {
  const p = providerWith(() => envelope()); delete p.collectBatch; p.collect = async () => [{ thread: 'old', last: '1', title: '旧消息', text: '旧provider' }];
  const f = fixture(t, p); await connect(f.service); await f.service.enable(true); await until(() => f.ingested.length === 1);
  assert.equal(f.service.status().collected, 1); assert.equal(f.read().checkpoint, undefined);
  assert.equal(f.service.status().lastCompletedThrough, undefined);
});

test('等待扫码时enable(false)转cancelled并可重新授权，旧poll成功不复活', async t => {
  const p = providerWith(() => envelope()); const f = fixture(t, p);
  const gate = deferred<PersonalAccount>(); let attempts = 0;
  p.complete = () => { attempts++; return attempts === 1 ? gate.promise : Promise.resolve(account); };
  f.service.authorize(); await until(() => f.service.status().status === 'waiting_for_scan');
  await f.service.enable(false); assert.equal(f.service.status().status, 'cancelled');
  f.service.authorize(); await until(() => f.service.status().status === 'connected');
  gate.resolve({ ...account, openId: 'ou_stale' }); await delay(10);
  assert.equal(f.read().account.openId, account.openId); assert.equal(attempts, 2);
});

test('已连接工作台应用优先于宿主wrong-default；显式profile必须核对appId', async () => {
  const calls: string[][] = [];
  const selected = createPersonalProvider({ application: () => undefined, fallbackApplication: () => ({ ...account, appSecret: 'fake-secret' }),
    runCLI: async args => { calls.push(args); return { appId: 'cli_wrong', profile: 'wrong-default' }; } });
  assert.deepEqual(await selected.application(signal()), { appId: account.appId, profile: account.profile });
  assert.equal(calls.length, 1); assert.ok(calls[0]!.includes('init')); assert.ok(!calls[0]!.includes('show'));
  const explicit = createPersonalProvider({ application: () => account,
    runCLI: async args => { assert.deepEqual(args.slice(0, 2), ['--profile', account.profile]); return { profile: account.profile, appId: 'cli_wrong' }; } });
  await assert.rejects(explicit.application(signal()), (error: unknown) => error instanceof PersonalAuthError && error.kind === 'needs_application');
});

test('同一窗口回扫后token再次失效时停止，不在批次间无限回扫', async () => {
  const initial = preparePersonalCheckpoint(account); initial.window!.lanes[0]!.token = 'expired';
  let reads = 0;
  const p = providerWith(args => {
    if (route(args) !== 0) return envelope();
    reads++;
    if (args.includes('--page-token')) throw new PersonalAuthError('cursor');
    return envelope([row(1)], { has_more: true, page_token: 'expired-again' });
  });
  const first = await p.collectBatch!(account, signal(), initial);
  assert.equal(first.hasMore, true); assert.equal(first.checkpoint.window!.lanes[0]!.restarted, true);
  const snapshot = structuredClone(first.checkpoint);
  await assert.rejects(p.collectBatch!(account, signal(), first.checkpoint), /回扫后再次失效/);
  assert.equal(reads, 3); assert.deepEqual(first.checkpoint, snapshot);
});

test('个人分页采集从同账号群详情读取用户数，同群只查一次，失败保留未知', async () => {
  const calls: string[][] = [];
  const rows = [row(1), row(2, {chat_id: 'oc_1'}), row(3), row(4), row(5),
    row(6, {chat_type: 'p2p'}), row(7, {chat_type: 'unknown'}),
    row(8, {chat_name: '100人', user_count: '100'})];
  const provider = providerWith(() => envelope(rows), calls, chat => {
    if (chat === 'oc_4') throw new Error('denied');
    const count = ({oc_1: '51', oc_3: '50', oc_5: '51.5'} as Record<string,string>)[chat];
    return {ok: true, identity: 'user', data: {user_count: count, bot_count: '100'}};
  });
  const batch = await provider.collectBatch!(account, signal());
  assert.deepEqual(batch.items.sort((a,b) => Number(a.last.slice(3)) - Number(b.last.slice(3))).map(item => item.origin?.personalGroupUserCount), [51,51,50,undefined,undefined,undefined,undefined,undefined]);
  const queries = calls.filter(args => args.includes('chats'));
  assert.deepEqual(queries.map(args => value(args, '--chat-id')), ['oc_1','oc_3','oc_4','oc_5','oc_7','oc_8']);
  assert.ok(queries.every(args => value(args, '--profile') === account.profile && value(args, '--as') === 'user'));
});

test('分页和会话聚合均按详情 chat_mode 补来源，只有已确认的群携带人数和个人@', async () => {
  const samples = [
    {chat_mode: 'group', user_count: 51}, {chat_mode: 'p2p', user_count: 100},
    {chat_type: 'group', user_count: '80'}, {chat_mode: 'topic', user_count: 60},
    {chat_mode: 'group', user_count: 0}, {chat_mode: 'group', user_count: '050'},
    ...[-1, 1.2, '', '1e3', '9007199254740992', Number.MAX_SAFE_INTEGER + 1].map(user_count => ({chat_mode: 'group', user_count})),
  ];
  const rows = samples.map((_, n) => row(n, {chat_type: undefined, mentions: [{id: account.openId}]}));
  const provider = providerWith(args => envelope(route(args) === 0 ? [] : rows), [], id => ({
    ok: true, identity: 'user', data: samples[Number(id.slice(3))],
  }), () => rows.map(r => r.chat_id));
  for (const items of [(await provider.collectBatch!(account, signal())).items, await provider.collect(account, signal())]) {
    items.sort((a,b) => Number(a.last.slice(3)) - Number(b.last.slice(3)));
    assert.deepEqual(items.map(item => item.origin?.kind), ['group','direct','group','group', ...Array(8).fill('group')]);
    assert.deepEqual(items.map(item => item.origin?.personalGroupUserCount), [51,undefined,80,60,0,50,...Array(6).fill(undefined)]);
    for (const {origin} of items) assert.equal(origin?.mentionedMe, origin?.kind === 'group' ? true : undefined);
  }
});

test('同账号跨页复用详情和失败结果，隔离账号，到期重新取数', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let count = 50;
  const calls: string[][] = [];
  const provider = providerWith(args => envelope(route(args) === 0 ? [] : [row(1, {chat_type: undefined}), row(2, {chat_type: undefined})],
    args.includes('--page-token') ? {} : {has_more: true, page_token: 'next'}), calls, id => {
    if (id === 'oc_2' && count === 50) throw new Error('denied');
    return {ok: true, identity: 'user', data: {chat_mode: 'group', user_count: count}};
  });
  const first = await provider.collectBatch!(account, signal());
  count = 51;
  const next = await provider.collectBatch!(account, signal(), first.checkpoint);
  assert.deepEqual(next.items.map(i => i.origin?.personalGroupUserCount), [50, undefined]);
  assert.equal(next.items[1].origin?.kind, 'group');
  assert.equal(calls.filter(args => args.includes('chats')).length, 2);
  const separate = await provider.collectBatch!({...account, profile: 'another-profile'}, signal());
  assert.deepEqual(separate.items.map(i => i.origin?.personalGroupUserCount), [51, 51]);
  now += 60_000;
  const refreshed = await provider.collectBatch!(account, signal());
  assert.deepEqual(refreshed.items.map(i => i.origin?.personalGroupUserCount), [51, 51]);
  assert.equal(calls.filter(args => args.includes('chats')).length, 6);
});

test('群详情缓存达到256条后淘汰最早记录', async () => {
  let ids: number[] = [];
  const calls: string[][] = [];
  const provider = providerWith(() => envelope(ids.map(n => row(n))), calls,
    () => ({ok: true, identity: 'user', data: {chat_mode: 'group', user_count: 50}}), () => ids.map(n => 'oc_'+n));
  for (let start = 0; start < 257; start += 50) {
    ids = Array.from({length: Math.min(50, 257 - start)}, (_, n) => start + n);
    await provider.collectBatch!(account, signal());
  }
  ids = [256, 0];
  await provider.collectBatch!(account, signal());
  const queries = calls.filter(args => args.includes('chats'));
  assert.equal(queries.length, 258);
  assert.equal(value(queries.at(-1)!, '--chat-id'), 'oc_0');
});

test('多批群 checkpoint 落盘重启后只续读未完成的群范围', async t => {
  const calls: string[][] = [];
  const groups = Array.from({length: 23}, (_, n) => 'oc_' + n);
  let pendingScope: string | undefined;
  const p = providerWith(args => {
    const scope = value(args, '--chat-id');
    if (route(args) !== 2 || !scope) return envelope();
    pendingScope ??= scope;
    if (scope === pendingScope && !value(args,'--page-token')) return envelope([], {has_more:true,page_token:'pending-scope'});
    return envelope();
  }, calls, undefined, () => groups);
  const f = fixture(t,p);
  await connect(f.service);
  await f.service.enable(true);
  await until(() => f.service.status().collectionPages === 7);
  await f.service.close();
  assert.equal(f.read().checkpoint.window.lanes.length,7);
  const before = calls.length;
  groups.reverse();
  const resumed = f.restart();
  await until(() => Boolean(resumed.status().lastCompletedThrough));
  const reads = calls.slice(before).filter(args => args.includes('+messages-search'));
  assert.equal(reads.length,1);
  assert.equal(value(reads[0]!, '--chat-id'),pendingScope);
  assert.equal(value(reads[0]!, '--page-token'),'pending-scope');
});

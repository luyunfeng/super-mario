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
function providerWith(search: (args: string[]) => unknown | Promise<unknown>, calls: string[][] = []) {
  const runCLI: PersonalCLI = async args => {
    calls.push(args);
    if (args.includes('status')) return { appId: account.appId, identity: 'user', verified: true, identities: { user: { available: true, openId: account.openId, userName: account.name, scope: PERSONAL_MESSAGE_SCOPES.join(' ') } } };
    if (args.includes('+messages-search')) return await search(args) as Record<string, any>;
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
  const mention = row(101, { mentions: [{ id: account.openId }] });
  const p = providerWith(args => {
    if (route(args) === 0) return envelope([direct]);
    if (route(args) === 1) return envelope([mention]);
    return value(args, '--page-token') ? envelope(Array.from({ length: 10 }, (_, n) => row(n + 50)))
      : envelope([direct, mention, ...Array.from({ length: 48 }, (_, n) => row(n))], { has_more: true, page_token: 'opaque-next' });
  }, calls);
  const first = await p.collectBatch!(account, signal());
  assert.equal(first.items.length, 50); assert.equal(first.hasMore, true);
  assert.equal(first.checkpoint.lastCompletedThrough, undefined);
  assert.equal(first.items.find(item => item.origin?.chatId === 'oc_100')!.origin!.kind, 'direct');
  assert.equal(first.items.find(item => item.origin?.chatId === 'oc_101')!.origin!.mentionedMe, true);
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

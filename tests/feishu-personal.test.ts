import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPersonalMessages } from '../apps/server/src/feishu-personal.ts';
import { createPersonalProvider, PERSONAL_MESSAGE_SCOPES, PersonalAuthError, runPersonalCLI } from '../plugins/feishu-personal.ts';
import type { PersonalCLI, PersonalProvider, PersonalAccount } from '../plugins/feishu-personal.ts';

const account = { profile: 'private-profile', appId: 'cli_0123456789abcdef', openId: 'ou_test', name: '测试用户' };
const authorization = { url: 'https://accounts.feishu.cn/oauth/v1/device/verify?opaque=%2B123', code: 'private-device-code', expiresIn: 60 };
const thing = { thread: 'thread', last: 'last', title: '需要处理的消息', text: '测试消息' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fake(): PersonalProvider { return { async application() { return account; }, async begin() { return authorization; }, async complete() { return account; }, async verify() { return account; }, async collect() { return [thing]; } }; }
async function until(check: () => boolean) { for (let n = 0; n < 100; n++) { if (check()) return; await delay(5); } assert.fail('状态未收敛'); }
function fixture(t: test.TestContext, provider = fake()) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mario-personal-'));
  const ingested: unknown[] = [];
  const options = { config: { host: '127.0.0.1', port: 0, dataDir, demo: false }, provider, canCollect: () => true, async ingest(source: string, things: unknown[]) { ingested.push({ source, things }); } };
  const service = createPersonalMessages(options);
  t.after(async () => { await service.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { service, ingested, dataDir, options };
}

test('扫码确认后仍关闭采集；明确开启后写入收件箱，公开状态不含配置或设备码', async t => {
  const scan = deferred<PersonalAccount>();
  const provider = fake(); provider.complete = () => scan.promise;
  const f = fixture(t, provider);
  assert.equal(f.service.authorize().status, 'preparing');
  await until(() => f.service.status().status === 'waiting_for_scan');
  assert.equal(f.service.status().url, authorization.url);
  assert.equal(f.ingested.length, 0);
  const publicJSON = JSON.stringify(f.service.status());
  for (const secret of [account.profile, authorization.code]) assert.ok(!publicJSON.includes(secret));
  scan.resolve(account);
  await until(() => f.service.status().status === 'connected');
  assert.equal(f.service.status().enabled, false);
  assert.deepEqual(f.service.status().account, { name: account.name });
  await f.service.enable(true);
  await until(() => f.ingested.length === 1);
  assert.deepEqual(f.ingested[0], { source: `feishu:${account.appId}:${account.openId}`, things: [thing] });
  const file = join(f.dataDir, 'private/feishu-personal/account.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, 'utf8').includes(authorization.code));
  await f.service.enable(false); assert.equal(f.service.status().enabled, false);
});

test('取消授权拒绝迟到成功，重复点击不会创建两个授权', async t => {
  const scan = deferred<PersonalAccount>(); let starts = 0;
  const provider = fake(); provider.complete = () => scan.promise; provider.begin = async () => { starts++; return authorization; };
  const f = fixture(t, provider);
  f.service.authorize(); f.service.authorize();
  await until(() => f.service.status().status === 'waiting_for_scan');
  assert.equal(starts, 1);
  f.service.cancel(); scan.resolve(account); await delay(10);
  assert.equal(f.service.status().status, 'cancelled');
  await assert.rejects(f.service.enable(true), /先完成/); assert.equal(f.ingested.length, 0);
});

for (const kind of ['expired', 'permissions', 'denied', 'needs_application', 'unavailable'] as const) {
  test(`授权失败 ${kind} 有明确恢复状态，采集保持关闭`, async t => {
    const provider = fake(); provider.begin = async () => { throw new PersonalAuthError(kind); };
    const f = fixture(t, provider); f.service.authorize();
    await until(() => ['failed', 'expired'].includes(f.service.status().status));
    const state = f.service.status(); assert.equal(state.enabled, false); assert.ok(state.error);
    if (kind === 'permissions') assert.equal(state.permissionUrl, `https://open.feishu.cn/app/${account.appId}/auth`);
    if (kind === 'needs_application') assert.equal(state.recovery, 'connect_application');
    assert.equal(f.ingested.length, 0);
  });
}

test('停止采集后拒绝迟到结果；重启重新校验账号，身份变化不读取', async t => {
  const pending = deferred<typeof thing[]>(); const provider = fake(); provider.collect = () => pending.promise;
  const f = fixture(t, provider); f.service.authorize(); await until(() => f.service.status().status === 'connected');
  await f.service.enable(true);
  const stopping = f.service.enable(false); pending.resolve([thing]); await stopping;
  assert.equal(f.ingested.length, 0);
  await f.service.close();
  provider.verify = async () => ({ ...account, openId: 'ou_other' });
  const resumed = createPersonalMessages(f.options); t.after(() => resumed.close()); resumed.start();
  await until(() => resumed.status().status === 'failed'); assert.equal(resumed.status().enabled, false);
  assert.equal(f.ingested.length, 0);
});

test('生产 CLI 协议：显式 profile、最小读取权限、opaque URL 和扫码后的服务端核验', async () => {
  const calls: string[][] = [];
  const cli: PersonalCLI = async args => {
    calls.push(args);
    if (args.includes('show')) return { appId: account.appId, profile: account.profile };
    if (args.includes('--no-wait')) return { verification_url: authorization.url, device_code: authorization.code, expires_in: 60 };
    if (args.includes('status')) return { appId: account.appId, identity: 'user', verified: true, identities: { user: { available: true, openId: account.openId, userName: account.name, scope: PERSONAL_MESSAGE_SCOPES.join(' ') } } };
    return { ok: true };
  };
  const provider = createPersonalProvider({ application: () => undefined, runCLI: cli }); const signal = new AbortController().signal;
  const app = await provider.application(signal); const auth = await provider.begin(app, signal);
  assert.equal(auth.url, authorization.url); assert.deepEqual(await provider.complete(app, auth, signal), account);
  assert.ok(calls.slice(1).every(args => args[0] === '--profile' && args[1] === account.profile));
  assert.deepEqual(calls[1].slice(2), ['auth', 'login', '--scope', PERSONAL_MESSAGE_SCOPES.join(' '), '--no-wait', '--json']);
  assert.ok(!JSON.stringify(calls).includes('send_as_user'));
});

test('缺应用时自动配置已连接机器人，密钥只经 stdin；核验不接受 bot 或部分权限', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const provider = createPersonalProvider({ application: () => undefined,
    fallbackApplication: () => ({ ...account, appSecret: 'fake-app-secret' }),
    runCLI: async (args, options) => { calls.push({ args, input: options.input }); if (args.includes('show')) throw new PersonalAuthError('needs_application'); return { ok: true }; },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await provider.application(signal), { profile: account.profile, appId: account.appId });
  assert.equal(calls[0].input, 'fake-app-secret'); assert.ok(!calls[0].args.includes('fake-app-secret'));
  for (const identity of ['bot', 'user']) {
    const invalid = createPersonalProvider({ application: () => undefined, runCLI: async () => ({ appId: account.appId, identity, verified: true, identities: { user: { available: true, openId: account.openId, scope: 'search:message' } } }) });
    await assert.rejects(invalid.verify(account, signal), PersonalAuthError);
  }
});

test('演示模式不访问本机飞书配置或真实账号', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-personal-demo-'));
  const service = createPersonalMessages({ config: { host: '127.0.0.1', port: 0, dataDir: dir, demo: true }, canCollect: () => true, async ingest() { assert.fail(); } });
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(service.status().demo, true); assert.throws(() => service.authorize(), /演示模式/);
});

test('真实子进程错误信封分类后穿过消息适配层，参数错误不会要求重新授权', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mario-personal-cli-'));
  const oldPath = process.env.PATH;
  writeFileSync(join(directory, 'lark-cli'), `#!${process.execPath}\nprocess.stderr.write(JSON.stringify({ok:false,identity:'user',error:{type:'api',subtype:'invalid_parameters',code:99992402,message:'field validation failed fake-secret',log_id:'private-log'}}));process.exitCode=1;\n`, { mode: 0o700 });
  process.env.PATH = `${directory}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(directory, { recursive: true, force: true }); });
  let failure: unknown;
  try { await runPersonalCLI(['im', '+messages-search'], { signal: new AbortController().signal }); } catch (error) { failure = error; }
  assert.ok(failure instanceof PersonalAuthError);
  assert.equal(failure.kind, 'request'); assert.equal(failure.apiCode, 99992402);
  assert.ok(!failure.message.includes('fake-secret'));
  const provider = fake(); provider.collect = async () => { throw new Error('adapter collection failed', { cause: failure }); };
  const f = fixture(t, provider); f.service.authorize(); await until(() => f.service.status().status === 'connected');
  await f.service.enable(true); await until(() => Boolean(f.service.status().error));
  assert.match(f.service.status().error!, /参数校验失败/); assert.match(f.service.status().error!, /99992402/);
  assert.match(f.service.status().error!, /无需重新授权/); assert.equal(f.service.status().enabled, false);
});

test('真实子进程的失效page_token分类为cursor，不泄露CLI错误详情', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mario-personal-cursor-cli-'));
  const oldPath = process.env.PATH;
  writeFileSync(join(directory, 'lark-cli'), `#!${process.execPath}\nprocess.stderr.write(JSON.stringify({ok:false,identity:'user',error:{type:'api',subtype:'invalid_parameters',message:'page_token expired private-token'}}));process.exitCode=1;\n`, { mode: 0o700 });
  process.env.PATH = `${directory}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(directory, { recursive: true, force: true }); });
  await assert.rejects(runPersonalCLI(['im', '+messages-search', '--page-token', 'fake'], { signal: new AbortController().signal }),
    (error: unknown) => error instanceof PersonalAuthError && error.kind === 'cursor' && !error.message.includes('private-token'));
});

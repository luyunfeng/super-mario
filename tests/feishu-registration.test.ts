import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFeishuRegistration } from '../apps/server/src/feishu-registration.ts';
import { createFeishuRegistrationProvider, FEISHU_BOT_SCOPES, RegistrationError } from '../plugins/feishu-registration.ts';
import type { FeishuRegistrationProvider, RegistrationResult } from '../plugins/feishu-registration.ts';
import type { FeishuBotInput } from '../packages/protocol/src/bots.ts';
const appId = 'cli_0123456789abcdef', secret = 'private-test-secret-do-not-expose';
const input = { name: '测试机器人', scope: { kind: 'project' as const, projectId: 'project-1' }, requireConfirmation: false };
function fixture(provider: FeishuRegistrationProvider) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mario-registration-'));
  const events: unknown[] = [], creates: FeishuBotInput[] = [], updates: unknown[] = [];
  const options = { dataDir, provider, events: { publish(_type: string, data: unknown) { events.push(data); } }, bots: {
    create(value: FeishuBotInput) { creates.push(value); return { id: 'bot-1' }; }, update(id: string, value: unknown) { updates.push({ id, value }); },
  } };
  const service = createFeishuRegistration(options);
  return { ...options, options, service, creates, updates, events, async cleanup() { await service.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}
async function settled(service: ReturnType<typeof createFeishuRegistration>, id: string) {
  for (let n = 0; n < 300; n++) {
    const job = service.get(id)!;
    if (['completed', 'failed', 'cancelled', 'expired', 'unknown', 'needs_configuration'].includes(job.status)) return job;
    await delay(2);
  }
  assert.fail('registration did not settle');
}
const validResult = (): RegistrationResult => ({ appId, appSecret: secret, verified: true, missingSteps: [] });

test('explicit start drives stages, captures scope, validates before creation and only enables after verification', async () => {
  let calls = 0;
  const f = fixture({ async register(context) {
    calls++; context.progress({ stage: 'waiting_for_scan', url: '{"qrlogin":{"token":"scan-token"}}', expiresAt: new Date(Date.now() + 60000).toISOString() });
    context.progress({ stage: 'creating_app' }); context.progress({ stage: 'configuring' }); context.progress({ stage: 'publishing' }); context.progress({ stage: 'verifying' });
    return validResult();
  } });
  try {
    assert.deepEqual(f.service.list(), []); assert.equal(calls, 0);
    const first = f.service.start(input); input.name = '修改后的名称';
    const job = await settled(f.service, first.id);
    assert.equal(job.status, 'completed'); assert.equal(job.botId, 'bot-1');
    assert.equal(f.creates[0].name, '测试机器人'); assert.deepEqual(f.creates[0].scope, input.scope); assert.equal(f.creates[0].requireConfirmation, false); assert.equal(f.creates[0].enabled, false);
    assert.deepEqual(f.updates, [{ id: 'bot-1', value: { enabled: true } }]);
    assert.equal('owner' in f.creates[0], false);
    for (let n = 0; n < 5; n++) { f.service.get(job.id); f.service.list(); }
    assert.equal(calls, 1); assert.equal(f.creates.length, 1);
    assert.deepEqual((f.events as Array<{ status: string }>).map(e => e.status), ['queued', 'waiting_for_scan', 'creating_app', 'configuring', 'publishing', 'verifying', 'verifying', 'completed']);
    const persisted = readFileSync(join(f.dataDir, 'private/feishu-registration/jobs.json'), 'utf8');
    assert.ok(!JSON.stringify([job, f.events, persisted]).includes(secret));
    assert.equal(statSync(join(f.dataDir, 'private/feishu-registration/jobs.json')).mode & 0o777, 0o600);
  } finally { input.name = '测试机器人'; await f.cleanup(); }
});

test('unverified credentials save a disabled bot with precise configuration links; invalid credentials do not create a bot', async () => {
  for (const invalid of [false, true]) {
    const f = fixture({ async register() { return { ...validResult(), appId: invalid ? 'invalid' : appId, verified: false, missingSteps: [] }; } });
    try {
      const job = await settled(f.service, f.service.start(input).id);
      assert.equal(job.status, invalid ? 'failed' : 'needs_configuration');
      assert.equal(f.creates.length, invalid ? 0 : 1); assert.equal(f.updates.length, 0);
      if (!invalid) assert.ok(job.missingSteps.every(s => s.url.startsWith(`https://open.feishu.cn/app/${appId}/`)));
    } finally { await f.cleanup(); }
  }
});

test('provider error text, cookies and secrets never leak; unknown is never replayed across reads or restart', async () => {
  let calls = 0;
  const f = fixture({ async register() { calls++; throw Object.assign(new RegistrationError('unknown'), { message: `Cookie: session=${secret}` }); } });
  try {
    const id = f.service.start(input).id, job = await settled(f.service, id);
    assert.equal(job.status, 'unknown'); assert.equal(f.creates.length, 0);
    const reloaded = createFeishuRegistration(f.options);
    assert.equal(reloaded.get(id)?.status, 'unknown'); reloaded.list(); assert.equal(calls, 1);
    assert.ok(!JSON.stringify([job, f.events, reloaded.list(), readFileSync(join(f.dataDir, 'private/feishu-registration/jobs.json'), 'utf8')]).includes(secret));
    await reloaded.close();
  } finally { await f.cleanup(); }
});

test('cancellation and close abort jobs; even an adapter ignoring abort cannot create a bot afterwards', async () => {
  for (const close of [false, true]) {
    let release!: (value: RegistrationResult) => void, signal!: AbortSignal;
    const f = fixture({ register(context) { signal = context.signal; return new Promise(resolve => { release = resolve; }); } });
    try {
      const id = f.service.start(input).id; await delay(0);
      assert.throws(() => f.service.start(input), /已有/);
      let closing: Promise<void> | undefined;
      if (close) closing = f.service.close(); else f.service.cancel(id);
      assert.equal(signal.aborted, true); release(validResult()); await closing; await delay(0);
      assert.equal(f.service.get(id)?.status, 'cancelled'); assert.equal(f.creates.length, 0); assert.equal(f.updates.length, 0);
    } finally { await f.cleanup(); }
  }
});

test('cancel before queued job starts prevents provider contact; interrupted metadata is marked unknown without network', async () => {
  let calls = 0;
  const f = fixture({ async register() { calls++; return validResult(); } });
  try {
    const id = f.service.start(input).id; f.service.cancel(id); await delay(0); assert.equal(calls, 0);
    const file = join(f.dataDir, 'private/feishu-registration/jobs.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')); saved[0].job.status = 'publishing'; writeFileSync(file, JSON.stringify(saved));
    const restored = createFeishuRegistration(f.options); assert.equal(restored.get(id)?.status, 'unknown'); assert.equal(calls, 0); await restored.close();
  } finally { await f.cleanup(); }
});

// Every platform stage is exercised with a fetch replacement. This fixture never uses the network.
function webFetch(options: { missingScope?: boolean; publication?: 'review' | 'unknown'; badEvent?: boolean; badCookie?: boolean; badRedirect?: boolean; recognizedOwner?: boolean } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let creates = 0;
  const json = (data: unknown = {}, headers?: HeadersInit) => new Response(JSON.stringify({ code: 0, data }), { headers });
  const fetcher: typeof fetch = async (address, init = {}) => {
    const url = String(address); calls.push({ url, init });
    const path = new URL(url).pathname;
    if (path === '/accounts/qrlogin/init') return json({ step_info: { token: 'qr-token' } }, { 'x-flow-key': 'private-flow-key', 'set-cookie': 'login=private-login-cookie; Domain=feishu.cn; Path=/; Secure' });
    if (path === '/accounts/qrlogin/polling') return json({ next_step: 'enter_app', step_info: { cross_login_uri: options.badRedirect ? 'https://evil.invalid/steal' : 'https://accounts.feishu.cn/cross' } });
    if (path === '/cross') return new Response('', { headers: { 'set-cookie': options.badCookie ? 'foreign=never-send; Domain=open.larkoffice.com; Path=/' : 'session=private-session-cookie; Domain=feishu.cn; Path=/; Secure' } });
    if (url === 'https://ask.feishu.cn/') return new Response('welcome');
    if (path === '/app') return new Response('window.csrfToken="private-csrf"; window.user={"id":"creator-user","email":"scanner@example.invalid","tenantId":"tenant","displayName":{"value":"Test"}};');
    if (path.endsWith('/app/upload/image')) { assert.ok(init.body instanceof FormData); const blob = init.body.get('file') as Blob; assert.equal(blob.type, 'image/png'); return json({ url: 'https://open.feishu.cn/icon.png' }); }
    if (path.endsWith('/manifest/upsert_by_template')) { creates++; return json({ ClientID: appId }); }
    if (path.includes('/secret/')) return json({ secret });
    if (path.includes('/scope/all/')) return json({ appScopes: FEISHU_BOT_SCOPES.map((scope, n) => ({ scopeName: scope, id: `scope-${n}` })), userScopes: [{ name: 'other', id: 'user-id' }] });
    if (path.includes('/scope/update/')) { assert.deepEqual(JSON.parse(String(init.body)).appScopeIDs, ['scope-0', 'scope-1', 'scope-2', 'scope-3']); return json(); }
    if (path.includes('/app_version/create/')) { assert.deepEqual(JSON.parse(String(init.body)).visibleSuggest.members, ['creator-user']); return json({ versionId: 'version-1' }); }
    if (path.includes('/publish/commit/') && options.publication === 'unknown') throw new Error(`network failed ${secret}`);
    if (path.includes('/app_version/list/')) return json({ versions: [{ versionId: 'version-1', versionStatus: options.publication === 'review' ? 1 : 2 }] });
    if (path === `/developers/v1/event/${appId}`) return json({ eventMode: options.badEvent ? 1 : 4, appEventDetails: [{ items: [{ id: 'im.message.receive_v1' }] }] });
    if (path === `/developers/v1/callback/${appId}`) return json({ callbackMode: 4, callbacks: [{ id: 'card.action.trigger' }] });
    if (path.endsWith('/tenant_access_token/internal')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'private-tenant-token' }));
    if (path === '/open-apis/contact/v3/users/batch_get_id') return json({ user_list: options.recognizedOwner ? [{ email: 'scanner@example.invalid', user_id: 'ou_verifiedScanner' }] : [] });
    if (path === '/open-apis/application/v6/scopes') return json({ scopes: FEISHU_BOT_SCOPES.map((name, n) => ({ scope_name: name, scope_type: 'tenant', grant_status: options.missingScope && n === 0 ? 2 : 1 })) });
    if (/\/developers\/v1\/(robot|event|callback)\/(switch|update)\//.test(path) || path.includes('/publish/commit/')) return json();
    throw new Error(`Unexpected offline request ${url}`);
  };
  return { fetcher, calls, creates: () => creates };
}

test('real Web provider performs QR login, configuration, publish/readback and reuses private session across projects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-registration-web-')), fake = webFetch();
  const progress: unknown[] = [];
  try {
    const provider = createFeishuRegistrationProvider({ dataDir: dir, fetch: fake.fetcher, pollMs: 0 });
    const first = await provider.register({ name: 'One', signal: new AbortController().signal, progress: info => { progress.push(info); } });
    assert.equal(first.verified, true); assert.deepEqual(first.missingSteps, []);
    assert.ok(fake.calls.some(c => c.url.includes('/event/update/'))); assert.ok(fake.calls.some(c => c.url.includes('/callback/update/')));
    const second = await createFeishuRegistrationProvider({ dataDir: dir, fetch: fake.fetcher }).register({ name: 'Two', signal: new AbortController().signal, progress: () => {} });
    assert.equal(second.verified, true); assert.equal(fake.calls.filter(c => c.url.includes('/qrlogin/init')).length, 1); assert.equal(fake.creates(), 2);
    const file = join(dir, 'private/feishu-registration/session.json'), saved = readFileSync(file, 'utf8');
    assert.equal(statSync(file).mode & 0o777, 0o600); assert.ok(saved.includes('private-session-cookie')); assert.ok(!saved.includes(secret));
    assert.ok(!JSON.stringify(progress).includes('private-session-cookie')); assert.ok(!JSON.stringify(progress).includes(secret));
    assert.ok(fake.calls.filter(c => c.url.includes('/developers/')).every(c => new Headers(c.init.headers).get('x-csrf-token') === 'private-csrf'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('console login follows the regional accounts hop and keeps cookies scoped to that domain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-regional-console-')), fake = webFetch();
  try {
    const fetcher: typeof fetch = async (address, init) => {
      const url = String(address);
      if (url === 'https://open.feishu.cn/app') return Response.redirect('https://accounts.larkoffice.com/login', 302);
      if (url === 'https://accounts.larkoffice.com/login') {
        assert.equal(new Headers(init?.headers).get('cookie'), null);
        return new Response(null, { status: 302, headers: { location: 'https://open.larkoffice.com/app', 'set-cookie': 'regional=id; Domain=.larkoffice.com; Path=/' } });
      }
      if (url === 'https://open.larkoffice.com/app') assert.equal(new Headers(init?.headers).get('cookie'), 'regional=id');
      return fake.fetcher(address, init);
    };
    const result = await createFeishuRegistrationProvider({ dataDir: dir, fetch: fetcher }).register({ name: 'Regional', signal: new AbortController().signal, progress() {} });
    assert.equal(result.verified, true);
    assert.ok(fake.calls.filter(c => c.url.includes('/developers/')).every(c => new URL(c.url).hostname === 'open.larkoffice.com'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanned session follows console 302 to login.feishu.cn before creating the bot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-console-login-')), fake = webFetch();
  let visitedLogin = false;
  try {
    const fetcher: typeof fetch = async (address, init) => {
      const url = String(address);
      if (url === 'https://open.feishu.cn/app' && !visitedLogin) return Response.redirect('https://login.feishu.cn/sso', 302);
      if (url === 'https://login.feishu.cn/sso') {
        assert.match(new Headers(init?.headers).get('cookie') ?? '', /session=private-session-cookie/);
        visitedLogin = true;
        return Response.redirect('https://open.feishu.cn/app', 302);
      }
      return fake.fetcher(address, init);
    };
    const provider = createFeishuRegistrationProvider({ dataDir: dir, fetch: fetcher });
    const result = await provider.register({ name: 'Main', signal: new AbortController().signal, progress() {} });
    assert.ok(visitedLogin);
    assert.equal(result.verified, true);
    assert.equal(fake.creates(), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('blocked console redirect reports only the hostname and never reaches application creation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-blocked-console-')), fake = webFetch();
  try {
    const fetcher: typeof fetch = (address, init) => String(address) === 'https://open.feishu.cn/app'
      ? Promise.resolve(Response.redirect('https://other.invalid/login?ticket=sensitive', 302)) : fake.fetcher(address, init);
    let diagnostic;
    const provider = createFeishuRegistrationProvider({ dataDir: dir, fetch: fetcher });
    await assert.rejects(provider.register({ name: 'Blocked', signal: new AbortController().signal, progress() {}, trace(info) { diagnostic = info; } }));
    assert.deepEqual(diagnostic, { step: 'console-identity', httpStatus: 302, reason: 'redirect-host', redirectHost: 'other.invalid' });
    assert.equal(fake.calls.some(c => c.url.includes('other.invalid')), false);
    assert.equal(fake.creates(), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scanner ownership is resolved with the newly created app token, not a cross-app open_id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-registration-owner-')), fake = webFetch({ recognizedOwner: true });
  try {
    const provider = createFeishuRegistrationProvider({ dataDir: dir, fetch: fake.fetcher, pollMs: 0 });
    const result = await provider.register({ name: 'Owner', signal: new AbortController().signal, progress: () => {} });
    assert.equal(result.verified, true); assert.equal(result.ownerOpenId, 'ou_verifiedScanner');
    const call = fake.calls.find(c => c.url.includes('/contact/v3/users/batch_get_id'))!;
    assert.match(new Headers(call.init.headers).get('authorization')!, /^Bearer /);
    assert.deepEqual(JSON.parse(String(call.init.body)).emails, ['scanner@example.invalid']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing permissions, event mismatch, pending review and unknown publication never report configured', async () => {
  for (const setting of [{ missingScope: true }, { badEvent: true }, { publication: 'review' as const }, { publication: 'unknown' as const }]) {
    const dir = mkdtempSync(join(tmpdir(), 'mario-registration-fail-')), fake = webFetch(setting);
    try {
      const result = await createFeishuRegistrationProvider({ dataDir: dir, fetch: fake.fetcher }).register({ name: 'Test', signal: new AbortController().signal, progress: () => {} });
      assert.equal(result.verified, false); assert.equal(result.missingSteps.length, 3); assert.equal(fake.creates(), 1);
      if ('publication' in setting && setting.publication === 'unknown') assert.equal(result.outcome, 'unknown');
      assert.equal(fake.calls.filter(c => c.url.includes('/publish/commit/')).length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('cookie domain injection is discarded; foreign redirects are blocked before fetch', async () => {
  for (const setting of [{ badCookie: true }, { badRedirect: true }]) {
    const dir = mkdtempSync(join(tmpdir(), 'mario-registration-domain-')), fake = webFetch(setting);
    try {
      const operation = createFeishuRegistrationProvider({ dataDir: dir, fetch: fake.fetcher }).register({ name: 'Test', signal: new AbortController().signal, progress: () => {} });
      if ('badRedirect' in setting) await assert.rejects(operation); else await operation;
      assert.ok(fake.calls.every(c => !c.url.includes('evil.invalid')));
      assert.ok(fake.calls.every(c => !new Headers(c.init.headers).get('cookie')?.includes('foreign=')));
      if ('badCookie' in setting) assert.ok(!readFileSync(join(dir, 'private/feishu-registration/session.json'), 'utf8').includes('never-send'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('official SDK device registration preserves credentials but honestly requires configuration without Web session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-registration-sdk-'));
  try {
    const provider = createFeishuRegistrationProvider({ dataDir: dir, mode: 'device', registerApp: async options => {
      assert.equal(options.createOnly, true); assert.equal(options.appPreset?.name, 'Device');
      options.onQRCodeReady({ url: 'https://accounts.feishu.cn/device?user_code=123', expireIn: 600 });
      return { client_id: appId, client_secret: secret, user_info: { open_id: 'ou_untrusted' } };
    } });
    const result = await provider.register({ name: 'Device', signal: new AbortController().signal, progress: () => {} });
    assert.equal(result.verified, false); assert.equal(result.missingSteps.length, 3); assert.ok(!('owner' in result));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('activation failure disables the bot and never exposes the controller error', async () => {
  let enabled = false;
  const f = fixture({ async register() { return validResult(); } });
  f.options.bots.update = (_id, value: unknown) => {
    enabled = Boolean((value as { enabled: boolean }).enabled);
    if (enabled) throw new Error(`private controller error ${secret}`);
  };
  try {
    const result = await settled(f.service, f.service.start(input).id);
    assert.equal(result.status, 'failed'); assert.equal(enabled, false);
    assert.ok(!JSON.stringify([result, f.events]).includes(secret));
  } finally { await f.cleanup(); }
});

test('fetch timeout and close abort in-flight platform request without creating a bot', async () => {
  for (const close of [false, true]) {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const dir = mkdtempSync(join(tmpdir(), 'mario-registration-timeout-'));
    let signal!: AbortSignal;
    const provider = createFeishuRegistrationProvider({ dataDir: dir, timeoutMs: close ? 5000 : 15, fetch: async (_address, init) => {
      signal = init!.signal!; started();
      return new Promise<Response>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    } });
    const f = fixture(provider);
    try {
      const id = f.service.start(input).id;
      await ready;
      if (close) await f.service.close();
      const result = await settled(f.service, id);
      assert.equal(result.status, close ? 'cancelled' : 'failed'); assert.equal(signal.aborted, true); assert.equal(f.creates.length, 0);
    } finally { await f.cleanup(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('QR expiry reports expired and never creates an application', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-registration-expired-'));
  try {
    const provider = createFeishuRegistrationProvider({ dataDir: dir, fetch: async address => {
      const url = String(address);
      if (url.includes('/init')) return new Response(JSON.stringify({ code: 0, data: { step_info: { token: 'expires' } } }), { headers: { 'x-flow-key': 'flow' } });
      if (url.includes('/polling')) return new Response(JSON.stringify({ code: 0, data: { step_info: { status: 5 } } }));
      assert.fail('must not create app after QR expiry');
    } });
    await assert.rejects(provider.register({ name: 'Expired', signal: new AbortController().signal, progress: () => {} }), (error: unknown) => error instanceof RegistrationError && error.outcome === 'expired');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown application creation is not retried or routed through a second create endpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-registration-unknown-create-')), fake = webFetch();
  let count = 0;
  try {
    const provider = createFeishuRegistrationProvider({ dataDir: dir, fetch: async (address, init) => {
      if (String(address).includes('/manifest/upsert_by_template')) { count++; throw new Error('connection reset after request'); }
      return fake.fetcher(address, init);
    } });
    await assert.rejects(provider.register({ name: 'Unknown', signal: new AbortController().signal, progress: () => {} }), (error: unknown) => error instanceof RegistrationError && error.outcome === 'unknown');
    assert.equal(count, 1); assert.ok(!fake.calls.some(c => c.url.includes('/app/create')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only definite template rejection permits one self-built app creation', async t => {
  const template = 'manifest/upsert_by_template', ordinary = 'app/create';
  const rejected = () => Response.json({ code: 12345 });
  const success = () => Response.json({ code: 0, data: { clientId: appId } });
  const cases: Array<{
    name: string; templateResponse(): Response; fallbackResponse?: () => Response; outcome?: 'unknown' | 'failed';
  }> = [
    { name: 'template success', templateResponse: success },
    { name: 'template business rejection', templateResponse: rejected, fallbackResponse: success },
    { name: 'template endpoint missing', templateResponse: () => new Response(null, { status: 404 }), fallbackResponse: success },
    { name: 'HTTP timeout', templateResponse: () => new Response(null, { status: 408 }), outcome: 'unknown' },
    { name: 'server error with code', templateResponse: () => Response.json({ code: 123 }, { status: 503 }), outcome: 'unknown' },
    { name: 'malformed JSON', templateResponse: () => new Response('{'), outcome: 'unknown' },
    { name: 'missing code', templateResponse: () => Response.json({}), outcome: 'unknown' },
    { name: 'missing ID after success', templateResponse: () => Response.json({ code: 0 }), outcome: 'unknown' },
    { name: 'ordinary create rejected', templateResponse: rejected, fallbackResponse: rejected, outcome: 'failed' },
    { name: 'ordinary create timed out', templateResponse: rejected, fallbackResponse: () => { throw new DOMException('Timed out', 'TimeoutError'); }, outcome: 'unknown' },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mario-create-')), fake = webFetch();
    const attempts: string[] = [];
    let fallbackBody: unknown;
    try {
      const provider = createFeishuRegistrationProvider({ dataDir, fetch: (address, init) => {
        const path = new URL(String(address)).pathname.replace('/developers/v1/', '');
        if (path === template || path === ordinary) {
          attempts.push(path);
          if (path === template) return Promise.resolve(scenario.templateResponse());
          fallbackBody = JSON.parse(String(init?.body));
          return Promise.resolve(scenario.fallbackResponse!());
        }
        return fake.fetcher(address, init);
      } });
      const operation = provider.register({ name: 'Test', signal: new AbortController().signal, progress() {} });
      if (scenario.outcome) await assert.rejects(operation, (e: unknown) => e instanceof RegistrationError && e.outcome === scenario.outcome);
      else assert.equal((await operation).verified, true);
      assert.deepEqual(attempts, scenario.fallbackResponse ? [template, ordinary] : [template]);
      if (scenario.fallbackResponse) assert.deepEqual(fallbackBody, {
        appSceneType: 0, name: 'Test', desc: 'AI workbench bot', avatar: 'https://open.feishu.cn/icon.png',
        i18n: { zh_cn: { name: 'Test', description: 'AI workbench bot' } }, primaryLang: 'zh_cn',
      });
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
});

test('failed QR initialization reports its stage without showing app setup steps, including after restart', async () => {
  const f = fixture({ async register() { throw new RegistrationError('failed'); } });
  try {
    const job = await settled(f.service, f.service.start(input).id);
    assert.equal(job.status, 'failed');
    assert.match(job.progress, /二维码/);
    assert.deepEqual(job.missingSteps, []);
    const restored = createFeishuRegistration(f.options);
    try { assert.deepEqual(restored.get(job.id)?.missingSteps, []); }
    finally { await restored.close(); }
  } finally { await f.cleanup(); }
});

test('failed QR poll keeps a searchable local ID and upstream diagnostic across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mario-qr-log-'));
  const f = fixture(createFeishuRegistrationProvider({ dataDir: dir, fetch: async address => {
    if (new URL(String(address)).pathname.endsWith('/init')) return Response.json({code:0,data:{step_info:{token:'qr-test'}}}, {headers:{'x-flow-key':'private-flow'}});
    return Response.json({code:12345,message:secret}, {headers:{'x-tt-logid':'test-upstream-12345'}});
  }}));
  try {
    const job = await settled(f.service, f.service.start(input).id);
    assert.equal(job.status, 'failed');
    assert.deepEqual(job.diagnostic, {step:'qr-poll',httpStatus:200,platformCode:12345,platformLogId:'test-upstream-12345',at:job.diagnostic?.at});
    const restored = createFeishuRegistration(f.options);
    try { assert.deepEqual(restored.get(job.id)?.diagnostic, job.diagnostic); }
    finally { await restored.close(); }
    assert.ok(!JSON.stringify(job).includes(secret));
  } finally { await f.cleanup(); rmSync(dir, {recursive:true,force:true}); }
});

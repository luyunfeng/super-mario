import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createECDH } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Agent, request as httpsRequest, createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import { promisify } from 'node:util';

const TOKEN = 'web-push-fixture';

/** A certificate made for this run, for the push service the test starts. */
async function certificate() {
  const directory = await mkdtemp(join(tmpdir(), 'mario-web-push-tls-'));
  try {
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { timeout: 30_000 });
    return { key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** A push service of the test's own, over TLS as a browser's vendor's is. */
async function pushService(tls: { key: Buffer; cert: Buffer }) {
  const posts: { device: string; authorization: string | undefined; ttl: string | undefined; urgency: string | undefined; topic: string | undefined; body: Buffer }[] = [];
  // Set by a test to make the service say every subscription is gone.
  const state = { gone: false };
  const service = createServer(tls, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      posts.push({ device: req.url!.split('/').at(-1)!, authorization: req.headers.authorization, ttl: req.headers.ttl as string | undefined,
        urgency: req.headers.urgency as string | undefined, topic: req.headers.topic as string | undefined, body: Buffer.concat(chunks) });
      if (state.gone) { res.writeHead(410).end('gone'); return; }
      res.writeHead(201).end('created');
    });
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', () => resolve()));
  const port = (service.address() as { port: number }).port;
  return { posts, state, origin: 'https://127.0.0.1:' + port, close: () => new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve())) };
}

/** What the workbench's fetch is for this test: a POST over TLS that trusts the run's certificate.
 *  The built-in fetch does not take a certificate, so the request is made with node:https. */
function fetchTrusting(agent: Agent): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? undefined : typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body as Uint8Array);
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpsRequest(url, { method: init?.method ?? 'POST', headers: init?.headers as Record<string, string>, agent }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
    return new Response(answer.body, { status: answer.status });
  };
}

async function fixture(t: TestContext, options: { withDevice?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-web-push-'));
  const tls = await certificate();
  // A machine without openssl cannot make a certificate; the tests that need one say so and are skipped.
  if (!tls) { await rm(dir, { recursive: true, force: true }); t.skip('本机没有 openssl，无法生成测试证书'); return Promise.resolve({} as never); }
  const service = await pushService(tls);
  // The server posts to the service with a fetch that trusts the certificate made for this run.
  const agent = new Agent({ ca: tls.cert });
  const pushFetch = fetchTrusting(agent);
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token: TOKEN,
    pushServices: ['^' + service.origin.replace(/[.]/g, '\\.') + '/push/'], pushFetch });
  t.after(async () => { await server.close(); await service.close(); agent.destroy(); await rm(dir, { recursive: true, force: true }); });
  const web = async <T>(path: string, method = 'GET', body?: object, headers: Record<string, string> = {}) => {
    const answer = await fetch(server.url + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: answer.status, body: await answer.json() as T };
  };
  /** A browser's subscription to the test's service. The endpoint is HTTPS, as a browser's would be. */
  const subscription = async (device: string) => {
    const curve = createECDH('prime256v1');
    curve.generateKeys();
    const { body } = await web<{ key: string }>('push/web');
    return { endpoint: service.origin + '/push/' + device, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') }, key: body.key, browser: 'Fixture Browser' };
  };
  return { server, service, web, subscription };
}

test('a browser subscribes, is listed, tests, and unsubscribes over HTTP; the plugin off refuses it', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  // The key is public and the same each time.
  const first = await f.web<{ key: string }>('push/web');
  assert.equal(first.status, 200);
  assert.match(first.body.key, /^[A-Za-z0-9_-]{87}$/);
  assert.equal((await f.web<{ key: string }>('push/web')).body.key, first.body.key);
  assert.equal((await f.web('push/web')).status, 200);
  assert.deepEqual((await f.web<{ subscribed: boolean }>('push/web/web-1')).body, { subscribed: false });
  // Nothing is subscribed yet: a test push says so.
  assert.equal((await f.web('push/web/web-1/test', 'POST', {})).status, 404);
  const put = await f.web<{ subscribed: boolean; key: string }>('push/web/web-1', 'PUT', await f.subscription('web-1'));
  assert.equal(put.status, 200);
  assert.equal(put.body.subscribed, true);
  assert.equal((await f.web<{ subscribed: boolean }>('push/web/web-1')).body.subscribed, true);
  // A test push goes to the service with the headers a push service reads, encrypted.
  const tested = await f.web<{ ok: boolean; push_status: number }>('push/web/web-1/test', 'POST', {});
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.push_status, 201);
  assert.equal(f.service.posts.length, 1);
  assert.equal(f.service.posts[0]!.device, 'web-1');
  assert.match(f.service.posts[0]!.authorization!, /^vapid t=/);
  assert.equal(f.service.posts[0]!.ttl, '86400');
  assert.equal(f.service.posts[0]!.urgency, 'high');
  assert.ok(f.service.posts[0]!.body.length > 100);
  // Unsubscribing works once; a second time says nothing was removed.
  assert.equal((await f.web<{ removed: boolean }>('push/web/web-1', 'DELETE', {})).body.removed, true);
  assert.equal((await f.web<{ removed: boolean }>('push/web/web-1', 'DELETE', {})).body.removed, false);
  assert.equal((await f.web<{ subscribed: boolean }>('push/web/web-1')).body.subscribed, false);
  // With the plugin off, every route says so and nothing is pushed.
  await f.web('plugins/browser-notifications', 'POST', { enabled: false });
  assert.equal((await f.web('push/web')).status, 503);
  assert.equal((await f.web('push/web/web-1')).status, 503);
  assert.equal((await f.web('push/web/web-1', 'PUT', await f.subscription('web-1'))).status, 503);
  assert.equal((await f.web('push/web/web-1', 'DELETE', {})).status, 503);
  assert.equal((await f.web('push/web/web-1/test', 'POST', {})).status, 503);
  assert.equal(f.service.posts.length, 1);
});

test('what is refused over HTTP: a service that is not known, keys a browser would not give, and an old key', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const good = await f.subscription('web-1');
  const unknown = await f.web<{ error: string }>('push/web/web-1', 'PUT', { ...good, endpoint: 'https://evil.example/push/web-1' });
  assert.equal(unknown.status, 400);
  assert.match(String(unknown.body.error), /推送服务/);
  const badKeys = await f.web('push/web/web-1', 'PUT', { ...good, keys: { ...good.keys, auth: 'short' } });
  assert.equal(badKeys.status, 400);
  const oldKey = await f.web<{ key: string }>('push/web/web-1', 'PUT', { ...good, key: 'an-old-key' });
  assert.equal(oldKey.status, 409);
  assert.equal(oldKey.body.key, good.key);
  const oddDevice = await f.web('push/web/has%20space', 'PUT', good);
  assert.equal(oddDevice.status, 404);
  assert.equal(f.service.posts.length, 0);
});

test('a notice for a browser with no page open is pushed; one with a page open is not', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.web('push/web/web-away', 'PUT', await f.subscription('web-away'))).status, 200);
  assert.equal((await f.web('push/web/web-here', 'PUT', await f.subscription('web-here'))).status, 200);
  // web-here has a page in front. Its heartbeat says so, with its device id.
  const beat = await fetch(f.server.url + '/api/v1/presence', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ tabId: 'a'.repeat(32), sequence: 1, visible: true, focused: true, device: 'web-here' }) });
  assert.equal(beat.status, 200);
  // A run that finishes is a notice: the demo executor completes at once.
  const run = await f.web<{ id: string }>('runs', 'POST', { executorId: 'demo', prompt: '合成的推送任务' });
  assert.equal(run.status, 202);
  await t.waitFor(() => assert.ok(f.service.posts.some(post => post.device === 'web-away')));
  // Let any push to web-here land before it is looked for.
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(f.service.posts.some(post => post.device === 'web-here'), false);
  assert.deepEqual(f.service.posts.map(post => post.device), ['web-away']);
  const pushed = f.service.posts[0]!;
  assert.equal(pushed.urgency, 'normal', 'a finished run is not urgent');
});

test('a test push that the service says is gone tells the owner, and keeps the subscription', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.web('push/web/web-1', 'PUT', await f.subscription('web-1'))).status, 200);
  // The service says this subscription is no more.
  f.service.state.gone = true;
  const answer = await f.web<{ error: string; gone: boolean }>('push/web/web-1/test', 'POST', {});
  assert.equal(answer.status, 502);
  assert.equal(answer.body.gone, true);
  assert.match(answer.body.error, /推送服务/);
  // It is the owner's to decide: the subscription is still there, so that they can read what
  // happened and turn it off themselves, or try again.
  assert.equal((await f.web<{ subscribed: boolean }>('push/web/web-1')).body.subscribed, true);
});

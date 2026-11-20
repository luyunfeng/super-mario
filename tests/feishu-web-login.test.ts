import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkbench } from '../packages/core/src/workbench.ts';

async function gateway(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return 'http://127.0.0.1:' + address.port;
}
async function workbench(t: TestContext, baseUrl: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-gateway-login-'));
  const app = await createWorkbench({ dataDir, host: '127.0.0.1', port: 0, demo: true,
    feishuWeb: { baseUrl, token: 'synthetic-master', pollIntervalMs: 15 } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return app;
}

test('网关扫码只返回本地生成的二维码和状态，成功后现有监听采集私聊', async t => {
  let polls = 0;
  const posts: string[] = [];
  const account = { userId: 'owner' };
  const baseUrl = await gateway(t, (req, res) => {
    assert.equal(req.headers.cookie, 'agentdock_web=synthetic-master');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      posts.push(req.url!);
      const state = req.url!.endsWith('/qr') ? 'waiting' : ++polls === 1 ? 'scanned' : 'success';
      return res.end(JSON.stringify({ state, qrContent: JSON.stringify({ qrlogin: { token: 'synthetic-scan' } }),
        attempt: 1, message: 'private-diagnostic', session: 'synthetic-session' }));
    }
    const routes: Record<string, unknown> = {
      '/api/lark-avatar/status': { connected: polls === 2, region: 'feishu', account },
      '/api/lark-avatar/config': { state: 'connected', config: { listening: true, region: 'feishu' }, account, updatedAt: '2026-01-01T00:00:00Z' },
      '/api/lark-avatar/inbox': [{ chatType: 'p2p', chatId: 'fixture-chat', messageId: 'fixture-message',
        senderId: 'peer', title: '合成私聊', occurredAt: '2026-01-01T00:01:00Z', receivedAt: '2026-01-01T00:01:00Z' }],
    };
    res.end(JSON.stringify(routes[req.url!]));
  });
  const app = await workbench(t, baseUrl);
  await app.plugins.setEnabled('feishu-web', true);
  assert.equal((await app.pollFeishuWebLogin()).state, 'idle');
  assert.deepEqual(posts, []);
  const qr = await app.startFeishuWebLogin();
  assert.equal(qr.state, 'waiting');
  assert.match(qr.qrDataUrl!, /^data:image\/png;base64,iVBOR/);
  assert.doesNotMatch(JSON.stringify(qr), /synthetic-|private-diagnostic|qrContent/);
  assert.equal((await app.pollFeishuWebLogin()).state, 'scanned');
  const success = await app.pollFeishuWebLogin();
  assert.deepEqual(Object.keys(success).sort(), ['message', 'state']);
  assert.equal(success.state, 'success');
  assert.deepEqual(await app.pollFeishuWebLogin(), success);
  assert.deepEqual(posts, ['/api/lark-avatar/login/qr', '/api/lark-avatar/login/poll', '/api/lark-avatar/login/poll']);
  for (let i = 0; i < 200 && !app.inbox.list().length; i++) await delay(10);
  assert.equal(app.inbox.list()[0]?.last, 'fixture-message');
});

test('换网关和轮换凭证使旧登录失效，重定向不携带凭证，终态不再轮询', async t => {
  const requests: string[] = [];
  const first = await gateway(t, (req, res) => {
    requests.push('a' + req.url);
    res.end(JSON.stringify({ state: 'waiting', qrContent: '{"qrlogin":{"token":"scan"}}' }));
  });
  let redirect = false;
  const second = await gateway(t, (req, res) => {
    requests.push('b' + req.url);
    assert.equal(req.headers.cookie, 'agentdock_web=fresh');
    if (redirect) return res.writeHead(307, { location: first + '/leak' }).end();
    res.end(JSON.stringify({ state: 'waiting', qrContent: '{"qrlogin":{"token":"scan-b"}}' }));
  });
  const app = await workbench(t, first);
  await app.startFeishuWebLogin();
  await app.configureFeishuWeb({ baseUrl: second, token: 'fresh' });
  assert.equal((await app.pollFeishuWebLogin()).state, 'idle');
  assert.deepEqual(requests, ['a/api/lark-avatar/login/qr']);
  await app.startFeishuWebLogin();
  redirect = true;
  assert.equal((await app.pollFeishuWebLogin()).state, 'failed');
  assert.equal((await app.pollFeishuWebLogin()).state, 'failed');
  assert.deepEqual(requests, ['a/api/lark-avatar/login/qr', 'b/api/lark-avatar/login/qr', 'b/api/lark-avatar/login/poll']);
  redirect = false;
  await app.startFeishuWebLogin();
  await app.configureFeishuWeb({ token: 'rotated' });
  assert.equal((await app.pollFeishuWebLogin()).state, 'idle');
  assert.equal(requests.length, 4);
});

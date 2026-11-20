import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createFeishuWebSource } from '../plugins/feishu-web-source.ts';
import type { InboxThing } from '../packages/protocol/src/index.ts';

async function gateway(t: test.TestContext, handler: RequestListener) {
  const http = createServer(handler);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  return 'http://127.0.0.1:' + (http.address() as AddressInfo).port;
}
async function until(condition: () => boolean) {
  const end = Date.now() + 3000;
  while (!condition() && Date.now() < end) await delay(5);
  assert.ok(condition(), '网关轮询未达到预期状态');
}

test('只读 HTTP 快照按账号与消息去重，排除旧登录、群和未知类型，写入失败可重试', async t => {
  const epoch = Date.UTC(2026, 0, 1);
  const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
  let user = '101', since = 0, switched = false;
  const row = (id: string, chatType: string, seconds: number) => ({
    messageId: id, chatId: 'chat', chatType, title: '摘要', payload: { content: '完整正文' },
    occurredAt: at(seconds), receivedAt: at(seconds), senderName: '测试发送者', senderId: '303',
  });
  let rows = [row('new', 'p2p', 2), row('earlier', 'p2p', 1), row('old', 'p2p', 0), row('folded', 'group', 1),
    { ...row('self', 'p2p', 2), senderId: user }, { ...row('anonymous', 'p2p', 2), senderId: '' },
    row('large', 'topic', 1), row('unknown', 'unknown', 1), row('new', 'p2p', 2)];
  const paths: string[] = [];
  const url = await gateway(t, (req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, 'agentdock_web=local-fixture');
    paths.push(req.url!);
    const account = { userId: user };
    res.setHeader('content-type', 'application/json');
    switch (req.url) {
      case '/api/lark-avatar/status': return res.end(JSON.stringify({ connected: true, region: 'feishu', account }));
      case '/api/lark-avatar/config': return res.end(JSON.stringify({ state: 'connected', updatedAt: at(since), account, config: { listening: true, region: 'feishu' } }));
      case '/api/lark-avatar/inbox':
        if (switched) { user = '202'; since = 3; switched = false; }
        return res.end(JSON.stringify(rows));
      default: assert.fail('未约定的网关调用');
    }
  });
  const delivered: { items: InboxThing[]; accountKey: string }[] = [];
  let reject = true;
  const source = createFeishuWebSource({ baseUrl: url, token: 'local-fixture', pollIntervalMs: 15,
    async onInbox(items, { accountKey }) {
      if (reject) throw Error('private exception body');
      delivered.push({ items, accountKey });
    },
  });
  t.after(() => source.stop());
  assert.deepEqual(source.status(), { enabled: false, connected: false });
  source.start(); source.start();
  await until(() => !!source.status().error);
  assert.equal(source.status().error, '网页消息写入收件箱失败');
  reject = false;
  await until(() => source.status().connected);
  assert.equal(source.status().lastReceivedAt, at(2));
  assert.deepEqual(delivered[0].items.map(item => item.last), ['earlier', 'new']);
  for (const item of delivered[0].items) {
    assert.equal(item.text, '完整正文');
    assert.deepEqual(item.origin, { connector: '飞书', kind: 'direct', chatId: 'chat' });
  }
  const count = paths.length;
  await until(() => paths.length >= count + 4);
  assert.equal(delivered.length, 1);
  switched = true;
  rows = [row('crossing', 'p2p', 3), ...rows];
  await until(() => !!source.status().error);
  rows = [row('second', 'p2p', 4), { ...row('new-self', 'p2p', 4), senderId: '202' }, ...rows];
  await until(() => delivered.length === 2);
  assert.notEqual(delivered[0].accountKey, delivered[1].accountKey);
  assert.deepEqual(delivered[1].items.map(item => item.last), ['second']);
  await source.stop();
  assert.equal(source.status().enabled, false);
  const stopped = paths.length;
  await delay(40);
  assert.equal(paths.length, stopped);
});

test('未核验账号及 HTTP 错误不读收件箱，停止会取消阻塞请求', async t => {
  let mode = 'unknown', requested = false, closed = false;
  const url = await gateway(t, (req, res) => {
    assert.equal(req.url, '/api/lark-avatar/status');
    if (mode === 'pending') {
      requested = true;
      res.once('close', () => { closed = true; });
      return;
    }
    if (mode === 'denied') res.writeHead(401);
    res.end(JSON.stringify({ connected: true, region: 'feishu', account: {}, error: 'private upstream detail' }));
  });
  const source = createFeishuWebSource({ baseUrl: url, token: 'local-fixture', pollIntervalMs: 10, async onInbox() { assert.fail('未知账号不可入箱'); } });
  t.after(() => source.stop());
  source.start();
  await until(() => source.status().error === '网关未提供可核验的网页账号');
  mode = 'denied';
  await until(() => source.status().error === '网页网关 HTTP 401');
  mode = 'pending';
  await until(() => requested);
  await source.stop();
  await until(() => closed);
  assert.deepEqual(source.status(), { enabled: false, connected: false });
});

test('网页凭证拒绝明文远端和重定向，错误状态不包含令牌', async t => {
  const token = 'fixture-secret';
  let redirected = 0, requests = 0;
  const target = await gateway(t, (_req, res) => { redirected++; res.end(); });
  const origin = await gateway(t, (req, res) => {
    requests++;
    assert.equal(req.headers.cookie, 'agentdock_web=' + token);
    assert.equal(req.url, '/api/lark-avatar/status');
    res.writeHead(302, { location: target + '/private' }).end();
  });
  for (const [baseUrl, credential, expected] of [
    ['http://127.example.invalid', token, /回环地址或 HTTPS/],
    [origin, '', /配置网关签发的网页访问令牌/],
    [origin, token, /无法读取网页网关/],
  ] as const) {
    const source = createFeishuWebSource({ baseUrl, token: credential, async onInbox() { assert.fail(); } });
    try {
      source.start();
      await until(() => !!source.status().error);
      assert.match(source.status().error!, expected);
      assert.ok(!JSON.stringify(source.status()).includes(token));
    } finally { await source.stop(); }
  }
  assert.equal(requests, 1);
  assert.equal(redirected, 0);
});

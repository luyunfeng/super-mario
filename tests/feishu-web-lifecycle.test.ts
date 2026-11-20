import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkbench } from '../packages/core/src/workbench.ts';

test('网页版插件独立启停，重启沿用选择，停用后收回采集任务', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-web-lifecycle-'));
  let reads = 0;
  const gateway = createServer((_req, res) => { reads++; res.writeHead(503).end(); });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const addr = gateway.address();
  assert.ok(addr && typeof addr === 'object');
  const config = { dataDir, host: '127.0.0.1', port: 0, demo: true,
    feishuWeb: { baseUrl: 'http://127.0.0.1:' + addr.port, token: 'local-fixture', pollIntervalMs: 25 } };
  let app = await createWorkbench(config);
  t.after(async () => {
    await app.close();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const cli = () => app.plugins.list().find(plugin => plugin.id === 'feishu')!;
  const web = () => app.plugins.list().find(plugin => plugin.id === 'feishu-web')!;
  async function waitForRead(previous: number) {
    for (let i = 0; i < 200 && reads === previous; i++) await delay(10);
    assert.ok(reads > previous, '已启用的插件应读取本地替身');
  }
  assert.equal(web().status, 'disabled');
  assert.equal(reads, 0);
  await app.plugins.setEnabled('feishu', false);
  await app.plugins.setEnabled('feishu-web', true);
  await waitForRead(0);
  assert.equal(cli().status, 'disabled');
  assert.equal(app.feishuWebStatus().enabled, true);
  assert.equal(app.feishuWebStatus().connected, false);
  await app.close();
  const previous = reads;
  app = await createWorkbench(config);
  await waitForRead(previous);
  assert.equal(web().status, 'active');
  assert.equal(cli().status, 'disabled');
  await app.plugins.setEnabled('feishu-web', false);
  assert.equal(app.feishuWebStatus().enabled, false);
  await app.plugins.setEnabled('feishu', true);
  assert.equal(web().status, 'disabled');
  const stoppedAt = reads;
  await app.close();
  app = await createWorkbench(config);
  assert.equal(web().status, 'disabled');
  assert.equal(reads, stoppedAt);
});

test('仅开启网页采集时，同账号私聊合并，换号后相同会话和消息标识分别归集', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-web-account-'));
  let account = 'gateway-user-a';
  const gateway = createServer((req, res) => {
    const updatedAt = '2026-01-01T00:00:00Z', receivedAt = '2026-01-01T00:01:00Z';
    const identity = { userId: account };
    const routes: Record<string, unknown> = {
      '/api/lark-avatar/status': { connected: true, region: 'feishu', account: identity },
      '/api/lark-avatar/config': { state: 'connected', config: { listening: true, region: 'feishu' }, account: identity, updatedAt },
      '/api/lark-avatar/inbox': ['one', 'two'].map(messageId => ({
        chatType: 'p2p', chatId: 'shared-chat', messageId, receivedAt, occurredAt: receivedAt,
        title: '合成消息', senderId: 'gateway-peer', senderName: '合成联系人', payload: { content: '合成内容' },
      })),
    };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(routes[req.url!]));
  });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const addr = gateway.address();
  assert.ok(addr && typeof addr === 'object');
  const app = await createWorkbench({ dataDir, host: '127.0.0.1', port: 0, demo: true,
    feishuWeb: { baseUrl: 'http://127.0.0.1:' + addr.port, token: 'local-fixture', pollIntervalMs: 15 } });
  t.after(async () => {
    await app.close();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });
  await app.plugins.setEnabled('feishu', false);
  await app.plugins.setEnabled('feishu-web', true);
  assert.equal(app.inboxAssistant.configure(true).enabled, true);
  for (const [index, userId] of ['gateway-user-a', 'gateway-user-b'].entries()) {
    account = userId;
    const expected = 2 * (index + 1);
    for (let i = 0; i < 200 && app.inbox.list().length !== expected; i++) await delay(10);
    assert.equal(app.inbox.list().length, expected);
  }
  const items = app.inbox.list();
  assert.ok(items.every(item => /^feishu:web:[a-f0-9]{64}$/.test(item.source) && item.origin?.connector === '飞书'));
  assert.equal(new Set(items.map(item => item.source)).size, 2);
  assert.deepEqual(app.inboxAssistant.list().map(group => [group.kind, group.messageIds.length]), [['direct', 2], ['direct', 2]]);
});

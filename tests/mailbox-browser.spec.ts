import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

async function withMailbox(run: (server: Awaited<ReturnType<typeof startServer>>, page: Page) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mailbox-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await run(server, page); assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
}

test('收件箱默认展示行动/知会/低优先级；查看原文、搜索、转待办、归档与刷新持久化', { timeout: 40000 }, async () => {
  await withMailbox(async (server, page) => {
    for (const [index, text] of ['请完成离线评审', '这是一条普通知会', '收到'].entries()) {
      await server.app.inbox.ingest('feishu:offline:owner', [{ thread: `thread-${index}`, last: `msg-${index}`, title: `测试会话${index}`, text }]);
    }
    await page.goto(server.url + '/#inbox');
    await expect(page.locator('#inbox h1')).toHaveText('收件箱');
    await expect(page.locator('#inbox .mailbox-card')).toHaveCount(3);
    for (const label of ['需要处理', '知会', '低优先级']) await expect(page.locator('#inbox .pill', { hasText: new RegExp(`^${label}$`) })).toBeVisible();
    await page.getByLabel('搜索收件箱').fill('普通知会');
    await expect(page.locator('#inbox .mailbox-card')).toHaveCount(1);
    await page.getByLabel('搜索收件箱').fill('');
    const card = page.locator('#inbox .mailbox-card', { hasText: '测试会话0' });
    await card.getByRole('button', { name: '查看原文与详情' }).click();
    const drawer = page.getByRole('dialog', { name: '收件箱消息详情' });
    await expect(drawer.locator('pre')).toHaveText('请完成离线评审');
    await drawer.getByRole('button', { name: '转为待办', exact: true }).click();
    await expect(drawer.getByRole('link', { name: '查看待办' })).toBeVisible();
    assert.equal(server.app.todos().length, 1);
    await drawer.locator('.drawer__foot').getByRole('button', { name: '关闭', exact: true }).click();
    const low = page.locator('#inbox .mailbox-card', { hasText: '测试会话2' });
    await low.getByRole('button', { name: '归档', exact: true }).click();
    await expect(low).toContainText('已归档');
    await page.reload();
    await expect(page.locator('#inbox .mailbox-card')).toHaveCount(3);
    await page.getByLabel('收件箱状态').selectOption('archived');
    await expect(page.locator('#inbox .mailbox-card')).toHaveCount(2);
    await page.locator('#inbox .mailbox-card', { hasText: '测试会话2' }).getByRole('button', { name: '恢复到收件箱' }).click();
    await expect(page.locator('#inbox .mailbox-card')).toHaveCount(1);
    await page.getByLabel('收件箱状态').selectOption('all');
    await expect(page.locator('#inbox .mailbox-card')).toHaveCount(3);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    // A new collection arrives while the page stays open: the existing WebSocket refresh updates it.
    await server.app.inbox.ingest('feishu:offline:owner', [{ thread: 'later', last: 'new', title: '后来采集的消息', text: '新的知会内容' }]);
    await expect(page.locator('#inbox .mailbox-card')).toHaveCount(4);
    await expect(page.locator('.nav__name', { hasText: /^发件箱$/ })).toBeVisible();
  });
});

test('发件箱展示实际投递状态、内容与目标，合并重复记录；页面只读且空箱不伪造记录', { timeout: 40000 }, async () => {
  await withMailbox(async (server, page) => {
    const writes: string[] = [];
    page.on('request', request => {
      if (request.method() === 'GET' || request.url().endsWith('/presence')) return;
      // The shared favorites plugin reads marks through its POST action endpoint.
      if (request.method() === 'POST' && request.url().endsWith('/message-favorites') && request.postDataJSON()?.action === 'marks') return;
      writes.push(request.url());
    });
    await page.goto(server.url + '/#outbox');
    await expect(page.getByText('还没有发件记录', { exact: true })).toBeVisible();
    const createdAt = new Date().toISOString();
    for (const [index, status] of ['needs_approval', 'sent', 'unknown'].entries()) {
      server.app.store.put('outbox.items', `out-${index}`, { id: `out-${index}`, owner: 'user', version: 1, dedupKey: `key-${index}`, channel: 'feishu.bot', target: 'oc_offline_target', content: { text: `测试通知${index}\n完整发送正文` }, contentHash: `hash-${index}`, status, attempt: 0, createdAt, updatedAt: createdAt });
    }
    server.app.mailboxes.put({ direction: 'outbox', botId: 'offline-bot', scope: { kind: 'global' }, eventKey: 'key-1', title: '同一投递的重复记录', text: '重复记录', target: 'oc_offline_target', requiresConfirmation: true });
    server.app.mailboxes.put({ direction: 'outbox', botId: 'offline-bot', scope: { kind: 'global' }, eventKey: 'draft-only', title: '机器人待确认草稿', text: '草稿正文', target: 'oc_offline_target', requiresConfirmation: true });
    await page.reload();
    await expect(page.locator('#outbox .mailbox-card')).toHaveCount(4);
    await expect(page.locator('#outbox')).not.toContainText('同一投递的重复记录');
    // A historical receipt must survive the ordinary outbox's 200-row window.
    const sample = server.app.store.get<any>('outbox.items', 'out-0')!;
    for (let i = 0; i < 200; i++) {
      const id = 'later-' + i;
      server.app.store.put('outbox.items', id, { ...sample, id, dedupKey: id, createdAt: '2099-01-01T00:00:00Z' });
    }
    const historical = page.waitForResponse(response => response.url().endsWith('/api/v1/outbox?id=out-2'));
    await page.goto(server.url + '/#outbox?receipt=delivery%3Aout-2');
    assert.deepEqual((await (await historical).json()).map((item: { id: string }) => item.id), ['out-2']);
    await expect(page.locator('#outbox .mailbox-card')).toHaveCount(1);
    await expect(page.locator('#outbox .mailbox-card')).toContainText('测试通知2');
    await page.goto(server.url + '/#outbox?receipt=delivery%3Amissing');
    await expect(page.getByText('当前可见发件记录中没有这条回执。')).toBeVisible();
    for (let i = 0; i < 200; i++) server.app.store.remove('outbox.items', 'later-' + i);
    await page.getByRole('link', { name: '查看全部发件记录' }).click();
    await expect(page.locator('#outbox .mailbox-card')).toHaveCount(4);
    await page.getByLabel('发件箱状态').selectOption('failed');
    await expect(page.locator('#outbox .mailbox-card')).toHaveCount(1);
    await page.getByRole('button', { name: '查看原文与详情' }).click();
    const drawer = page.getByRole('dialog', { name: '发件箱消息详情' });
    await expect(drawer).toContainText('结果未知'); await expect(drawer).toContainText('oc_offline_target');
    await expect(drawer.locator('pre')).toHaveText('测试通知2\n完整发送正文');
    await expect(drawer).toContainText('不会自动重复发送');
    assert.deepEqual(writes, []);
    assert.ok(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth));
  });
});

test('收件详情链接可冷启动、同页切换和重载，关闭后刷新数据不会重新弹出', async () => {
  await withMailbox(async (server, page) => {
    await server.app.inbox.ingest('offline-links', ['甲', '乙'].map(title => ({
      thread:title, last:title, title, text:'原始正文' + title,
    })));
    const links = new Map(server.app.inbox.list().map(item => [item.title, server.url + '/#inbox?item=' + encodeURIComponent(item.id)]));
    const drawer = page.getByRole('dialog', {name:'收件箱消息详情'});
    await page.goto(links.get('甲')!);
    await expect(drawer.locator('pre')).toHaveText('原始正文甲');
    await page.goto(links.get('乙')!);
    await expect(drawer.locator('pre')).toHaveText('原始正文乙');
    await page.reload();
    await expect(drawer.locator('pre')).toHaveText('原始正文乙');
    await drawer.locator('.drawer__foot').getByRole('button', {name:'关闭',exact:true}).click();
    await server.app.inbox.ingest('offline-links', [{thread:'别处',last:'1',title:'另一个事项',text:'更新记录'}]);
    await expect(page.locator('#inbox')).toContainText('另一个事项');
    await expect(drawer).toHaveCount(0);
    await page.goto(server.url + '/#inbox?item=missing');
    await expect(page.getByText('当前工作台找不到这条收件。')).toBeVisible();
  });
});

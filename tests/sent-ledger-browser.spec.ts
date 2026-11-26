import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Approval } from '../packages/protocol/src/index.ts';
import type { OutboxItem } from '../packages/plugin-sdk/src/index.ts';

test('渠道页列出以主人名义发出的内容，可按连接器筛选、看全文、翻更早的', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-sent-browser-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'test-sent' });
  const { store } = server.app;
  // One mail that went out, and one that was left unknown. Only the first is listed.
  store.put('approvals', 'mail-1', { id: 'mail-1', version: 1, kind: 'plugin:mail-connector.send', title: '发送邮件', status: 'completed',
    details: '审批卡片上的摘要', params: { subject: '评审时间', text: '李四，你好：\n请确认周四的评审时间。\n谢谢。', to: [{ name: '李四', email: 'lisi@example.invalid' }] }, result: { outcome: 'sent', messageId: 'm-1@example.invalid' },
    createdAt: '2026-11-27T09:00:00.000Z', updatedAt: '2026-11-27T09:00:00.000Z' } as Approval);
  store.put('approvals', 'mail-unknown', { id: 'mail-unknown', version: 1, kind: 'plugin:mail-connector.send', title: '发送邮件', status: 'completed',
    details: '这封的结果未知', params: {}, result: { outcome: 'unknown' }, createdAt: '2026-11-27T09:01:00.000Z', updatedAt: '2026-11-27T09:01:00.000Z' } as Approval);
  // Twelve replies that went out, so that the list has a second page.
  for (let index = 1; index <= 12; index++) {
    const at = new Date(Date.UTC(2026, 10, 27, 8, 0, 0) - index * 60_000).toISOString();
    store.put('outbox.items', 'reply-' + index, { id: 'reply-' + index, owner: 'o', version: 1, contentHash: 'h', status: 'sent', attempt: 1, dedupKey: 'r' + index,
      channel: 'feishu.bot', target: 'oc_chat', content: { text: '第 ' + index + ' 条回复。' }, createdAt: at, updatedAt: at } as OutboxItem);
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    try { await browser?.close(); }
    finally { try { await server.close(); } finally { await rm(dir, { recursive: true, force: true }); } }
  });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#channels?token=test-sent');
  const card = page.locator('#channel-sent');
  const list = card.getByLabel('已发出的内容');
  const detail = card.locator('#channel-sent-detail');
  // The newest page: the mail, then nine of the replies. The one left unknown is not there.
  await expect(list.getByRole('listitem')).toHaveCount(10);
  await expect(list.getByRole('listitem').first()).toContainText('邮箱');
  await expect(list.getByRole('listitem').first()).toContainText('发往 李四 <lisi@example.invalid>');
  await expect(list.getByRole('listitem').first()).toContainText('经我批准');
  await expect(card.getByText('这封的结果未知')).toHaveCount(0);
  // The whole of what was written, with its line breaks.
  await list.getByRole('listitem').first().getByRole('button', { name: '看全文' }).click();
  // The whole of it, on its own lines, where the list shows it as one line.
  await expect(detail.locator('.md-p')).toHaveText('主题：评审时间\n\n李四，你好：\n请确认周四的评审时间。\n谢谢。');
  await expect(detail.getByText('m-1@example.invalid')).toBeVisible();
  await detail.getByRole('button', { name: '收起' }).click();
  await expect(detail).toBeHidden();
  // An earlier page is added, and the same rows are not shown twice.
  await card.getByRole('button', { name: '更早的' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(13);
  await expect(card.getByRole('button', { name: '更早的' })).toBeHidden();
  // Only the mail.
  await card.getByLabel('按连接器筛选').selectOption('邮箱');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByRole('listitem').first()).toContainText('邮箱');
  // A connector with nothing sent says so, and does not look like an error.
  await card.getByLabel('按连接器筛选').selectOption('GitHub');
  await expect(card.getByText('这个连接器还没有发出去的内容。')).toBeVisible();
  await expect(card.getByRole('alert')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

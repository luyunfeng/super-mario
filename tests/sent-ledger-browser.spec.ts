import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
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

test('台账里的飞书消息可以撤回：先问一次，确认后才告诉飞书；成功、拒绝、未知都如实显示', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-sent-recall-browser-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'test-sent' });
  const { store } = server.app;
  const bot = 'c'.repeat(64), channel = 'feishu.bot:' + bot + ':' + 'd'.repeat(16);
  const at = '2026-11-27T10:00:00.000Z';
  const notice = (id: string, text: string, extra: Record<string, unknown> = {}) => store.put('outbox.items', id, { id, owner: 'o', version: 1, contentHash: 'h', status: 'sent', attempt: 1, dedupKey: id,
    channel, target: 'oc_chat', content: { text }, createdAt: at, updatedAt: at, ...extra } as OutboxItem);
  notice('ok', '这条可以撤回。', { messageRef: 'om_ok' });
  notice('refused', '这条飞书会拒绝。', { messageRef: 'om_refused' });
  notice('noref', '这条没有记下编号。');
  store.put('approvals', 'mail-1', { id: 'mail-1', version: 1, kind: 'plugin:mail-connector.send', title: '发送邮件', status: 'completed', details: '正文', params: { subject: '评审', text: '请确认。', to: [{ email: 'lisi@example.invalid' }] }, result: { outcome: 'sent', messageId: 'm-1@example.invalid' },
    createdAt: at, updatedAt: at } as Approval);
  // What Feishu answers for each message, decided when it is asked.
  const refused = new Set(['om_refused']);
  const asked: string[] = [];
  server.app.setFeishuRecall(async (_botId, messageId) => {
    asked.push(messageId);
    // The gateway turns what the adapter throws into one of these answers; this stands in for the gateway.
    return refused.has(messageId) ? { status: 'refused', error: '飞书操作未执行 (API 230001)' } : { status: 'done' };
  });
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
  const row = (text: string) => list.getByRole('listitem').filter({ hasText: text });
  await expect(list.getByRole('listitem')).toHaveCount(4);

  // A mail and a record without an id offer no recall, and nothing is asked of Feishu.
  await row('评审').getByRole('button', { name: '看全文' }).click();
  await expect(detail.getByRole('button', { name: '撤回', exact: true })).toHaveCount(0);
  await row('没有记下编号').getByRole('button', { name: '看全文' }).click();
  await expect(detail.getByRole('button', { name: '撤回', exact: true })).toHaveCount(0);
  assert.deepEqual(asked, []);

  // A message that can be taken back: the first click only asks, the confirming one is the request.
  await row('可以撤回').getByRole('button', { name: '看全文' }).click();
  await detail.getByRole('button', { name: '撤回', exact: true }).click();
  await expect(detail.getByRole('button', { name: '撤回消息' })).toBeVisible();
  await expect(detail).toContainText('撤回后对方就看不到它了');
  assert.deepEqual(asked, []);
  const recalled = page.waitForResponse(response => response.url().endsWith('/api/v1/sent/' + encodeURIComponent('outbox:ok') + '/recall') && response.request().method() === 'POST');
  await detail.getByRole('button', { name: '撤回消息' }).click();
  assert.equal((await recalled).status(), 200);
  await expect(detail).toContainText('已于');
  await expect(detail).toContainText('撤回。');
  await expect(detail.getByRole('button', { name: '撤回', exact: true })).toHaveCount(0);
  await expect(row('可以撤回').getByText('已撤回')).toBeVisible();
  assert.deepEqual(asked, ['om_ok']);

  // "Not now" closes the question without a request.
  await row('飞书会拒绝').getByRole('button', { name: '看全文' }).click();
  await detail.getByRole('button', { name: '撤回', exact: true }).click();
  await detail.getByRole('button', { name: '先不撤回' }).click();
  await expect(detail.getByRole('button', { name: '撤回消息' })).toHaveCount(0);
  assert.deepEqual(asked, ['om_ok']);

  // Feishu refuses: the reason is shown, nothing was deleted, and the owner may try again.
  await detail.getByRole('button', { name: '撤回', exact: true }).click();
  await detail.getByRole('button', { name: '撤回消息' }).click();
  await expect(detail).toContainText('上次没有撤回');
  await expect(detail).toContainText('230001');
  await expect(detail.getByRole('button', { name: '撤回', exact: true })).toBeVisible();
  assert.deepEqual(asked, ['om_ok', 'om_refused']);
  await expect(row('飞书会拒绝').getByText('已撤回')).toHaveCount(0);
  assert.deepEqual(pageErrors, []);
});


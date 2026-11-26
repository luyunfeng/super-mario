import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import { createMailReader } from '../packages/core/src/mail-reader.ts';
import type { ImapClient, OpenImap } from '../packages/core/src/mail-imap.ts';

test('渠道页可添加邮箱、按域名填好服务器、检查连接后看到最新邮件；失败时说明原因；可移除', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mail-browser-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'test-mail' });
  // Only the connection is a stand-in. It answers well until it is told to refuse the sign-in.
  let refuse = false;
  const seen: { user: string | undefined; pass: string | undefined; secure: boolean | undefined }[] = [];
  const open: OpenImap = async options => {
    seen.push({ user: options.auth!.user, pass: options.auth!.pass, secure: options.secure });
    if (refuse) throw Object.assign(new Error('Invalid login'), { authenticationFailed: true });
    const client: ImapClient = {
      async list() { return [{ path: 'INBOX', name: 'INBOX', flags: new Set<string>() }, { path: 'Sent', name: 'Sent', flags: new Set<string>() }]; },
      async mailboxOpen(path) { return { path, totalCount: path === 'INBOX' ? 12 : 3, unseenCount: path === 'INBOX' ? 2 : 0 }; },
      fetch: async function * () {
        yield { uid: 4, envelope: { subject: '周四的评审请确认', from: [{ name: '李四', address: 'lisi@example.invalid' }], messageId: '<a@example.invalid>' },
          internalDate: '2026-11-25T09:00:00.000Z', flags: new Set<string>() };
        yield { uid: 3, envelope: { subject: '十一月的报表', from: [{ address: 'finance@example.invalid' }], messageId: '<b@example.invalid>' },
          internalDate: '2026-11-24T01:00:00.000Z', flags: new Set([String.fromCharCode(92) + 'Seen']),
          bodyStructure: { childNodes: [{ disposition: 'attachment', dispositionParameters: { filename: 'report.xlsx' } }] } };
      },
      async download() { return {}; },
      async append() { return false; },
      async logout() {},
    };
    return client;
  };
  server.app.mailReader = createMailReader({ accounts: server.app.mailAccounts, open });
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
  await page.goto(server.url + '/#channels?token=test-mail');
  const card = page.locator('#channel-mail');
  await expect(card.getByText('还没有添加邮箱。')).toBeVisible();

  // Adding: the address fills the servers in from its domain.
  await card.getByRole('button', { name: '添加邮箱' }).click();
  const drawer = page.getByRole('dialog').filter({ hasText: '添加邮箱' });
  await drawer.getByLabel('邮箱地址', { exact: true }).fill('someone@qq.com');
  await drawer.getByText('服务器和加密方式').click();
  await expect(drawer.getByLabel('收件服务器')).toHaveValue('imap.qq.com');
  await expect(drawer.getByLabel('收件端口')).toHaveValue('993');
  await expect(drawer.getByLabel('发件服务器')).toHaveValue('smtp.qq.com');
  // An account needs a password. Adding without one is refused in the page.
  await drawer.getByRole('button', { name: '添加', exact: true }).click();
  await expect(drawer.getByRole('alert')).toHaveText('请填写密码或授权码。');
  await drawer.getByLabel('密码或授权码').fill('the-secret-code');
  await drawer.getByLabel('账号名称').fill('个人的');
  await drawer.getByRole('button', { name: '添加', exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(card.getByText('个人的', { exact: true })).toBeVisible();
  await expect(card.getByText('未检查', { exact: true })).toBeVisible();
  // The password is nowhere in the page.
  expect(await page.content()).not.toContain('the-secret-code');
  const account = server.app.mailAccounts.list()[0]!;
  expect(account.imapHost).toBe('imap.qq.com');
  expect(account.hasPassword).toBe(true);

  // Checking the connection reads the folders and the newest mail, with the sealed password.
  await card.getByRole('button', { name: '检查连接' }).click();
  await expect(card.getByText('已连接', { exact: true })).toBeVisible();
  await expect(card.getByText('周四的评审请确认')).toBeVisible();
  await expect(card.getByText('十一月的报表')).toBeVisible();
  await expect(card.getByText(/李四 · /)).toBeVisible();
  await expect(card.getByText(/有附件/)).toBeVisible();
  await expect(card.getByText(/收件箱 12/)).toBeVisible();
  expect(seen).toEqual([{ user: 'someone@qq.com', pass: 'the-secret-code', secure: true }]);
  expect(await page.content()).not.toContain('the-secret-code');
  // The state is kept, so it is still there after a reload.
  await page.reload();
  await expect(page.locator('#channel-mail').getByText('周四的评审请确认')).toBeVisible();

  // A refused sign-in says why, in the owner's terms. The server's own words are not shown.
  refuse = true;
  await page.locator('#channel-mail').getByRole('button', { name: '检查连接' }).click();
  await expect(page.locator('#channel-mail').getByText('连接失败', { exact: true })).toBeVisible();
  await expect(page.locator('#channel-mail').getByText(/授权码/)).toBeVisible();
  expect(await page.content()).not.toContain('Invalid login');

  // Removing asks first, and takes the password with it.
  await page.locator('#channel-mail').getByRole('button', { name: '移除' }).click();
  const confirm = page.getByRole('dialog').filter({ hasText: '移除邮箱' });
  await confirm.getByRole('button', { name: '移除' }).click();
  await expect(page.locator('#channel-mail').getByText('还没有添加邮箱。')).toBeVisible();
  expect(server.app.mailAccounts.list()).toEqual([]);
  expect(server.app.store.list('mail.account-secrets')).toEqual([]);
  expect(pageErrors).toEqual([]);
});

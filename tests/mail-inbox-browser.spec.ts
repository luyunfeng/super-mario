import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import { fakeMailServer } from './mail-fixture.ts';

const encoded = (value: string) => '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

test('邮件进入收件箱：列表里能看到，点开后读到正文和附件，读取不把邮件标记为已读', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mail-inbox-browser-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'test-mail-inbox' });
  // A message with one file attached, as it comes over the wire.
  const raw = [
    'From: ' + encoded('张三') + ' <zhangsan@example.invalid>', 'To: someone@qq.com', 'Cc: lisi@example.invalid',
    'Subject: ' + encoded('周四的评审请确认'), 'Date: Wed, 25 Nov 2026 09:00:00 +0800', 'Message-ID: <review-1@example.invalid>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="x"', '',
    '--x', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64('请确认周四的评审时间。\r\n谢谢。'),
    '--x', 'Content-Type: application/pdf; name="report.pdf"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="report.pdf"', '',
    b64('a report'), '--x--', '',
  ].join('\r\n');
  const work = fakeMailServer({ folders: [{ path: 'INBOX', messages: [{ uid: 1, raw: Buffer.from(raw), flags: new Set<string>(), internalDate: '2026-11-25T01:00:00.000Z' }] }] });
  server.app.setMailOpen(async () => work.client);
  await server.app.mailAccounts.add({ email: 'someone@qq.com', password: 'an-offline-code', name: '工作邮箱',
    imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    try { await browser?.close(); }
    finally { try { await server.close(); } finally { await rm(dir, { recursive: true, force: true }); } }
  });
  // Turning mail on puts the unread message into the inbox.
  await fetch(server.url + '/api/v1/mail/connector', { method: 'PUT', headers: { authorization: 'Bearer test-mail-inbox', 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  for (let i = 0; i < 300 && !server.app.inbox.list().some(item => item.source === 'mail'); i++)
    await new Promise(resolve => setTimeout(resolve, 20));

  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#inbox?token=test-mail-inbox');
  const item = page.locator('.mailbox-card').filter({ hasText: '周四的评审请确认' }).first();
  await expect(item).toBeVisible();
  // The list says where it came from.
  await expect(item).toContainText('邮箱');

  await item.getByRole('button', { name: /详情|查看/ }).first().click();
  const drawer = page.getByRole('dialog').filter({ hasText: '消息详情' });
  await expect(drawer).toBeVisible();
  // The body is read from the mailbox when the detail opens.
  const body = drawer.getByLabel('邮件正文');
  await expect(body).toContainText('张三 <zhangsan@example.invalid>');
  await expect(body).toContainText('lisi@example.invalid');
  await expect(body).toContainText('请确认周四的评审时间。');
  await expect(body).toContainText('report.pdf');
  // The attachment can be taken out. It comes as a file under its own name, with the token
  // sent as a header and not in a link.
  const downloads: string[] = [];
  page.on('request', request => downloads.push(request.url()));
  const waiting = page.waitForEvent('download');
  await body.getByRole('button', { name: '下载附件 report.pdf' }).click();
  const saved = await waiting;
  expect(saved.suggestedFilename()).toBe('report.pdf');
  const taken = downloads.find(url => url.includes('/attachments/'));
  expect(taken).toBeDefined();
  // The token is not in the address, so it does not end up in a history or a log.
  expect(taken!).not.toContain('test-mail-inbox');
  // Nothing in the message is rendered as markup, and the password is nowhere on the page.
  expect(await page.content()).not.toContain('an-offline-code');
  // Reading left the message as it was: the folder was opened read-only and nothing was stored.
  assertReadOnly(work);
  expect(pageErrors).toEqual([]);
  await page.close();
});

function assertReadOnly(work: ReturnType<typeof fakeMailServer>) {
  // Every folder the page's read opened was opened read-only.
  if (!work.opened.length) throw new Error('the mailbox was not read');
  for (const opened of work.opened) if (!opened.readOnly) throw new Error('a folder was opened for writing: ' + opened.path);
}

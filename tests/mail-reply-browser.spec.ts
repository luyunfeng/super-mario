import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import { MAIL_SEND_APPROVAL } from '../packages/core/src/mail-outbox.ts';
import { fakeMailServer } from './mail-fixture.ts';

const encoded = (value: string) => '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

/** A workbench with one mailbox, mail turned on, and the one message in the inbox. */
async function start(t: { after(fn: () => void): void }, token: string, raw: string, prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token });
  const work = fakeMailServer({ folders: [{ path: 'INBOX', messages: [{ uid: 1, raw: Buffer.from(raw), flags: new Set<string>(), internalDate: '2026-11-25T01:00:00.000Z' }] }] });
  server.app.setMailOpen(async () => work.client);
  await server.app.mailAccounts.add({ email: 'someone@qq.com', password: 'an-offline-code', name: '工作邮箱',
    imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' });
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  await fetch(server.url + '/api/v1/mail/connector', { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) });
  for (let i = 0; i < 300 && !server.app.inbox.list().some(item => item.source === 'mail'); i++)
    await new Promise(resolve => setTimeout(resolve, 20));
  t.after(async () => { try { await server.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  return { server, work };
}

async function open(browser: Browser, url: string, title: string) {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(url);
  const item = page.locator('.mailbox-card').filter({ hasText: title }).first();
  await item.getByRole('button', { name: /详情|查看/ }).first().click();
  const drawer = page.getByRole('dialog').filter({ hasText: '消息详情' });
  return { page, pageErrors, drawer };
}

type Browser = Awaited<ReturnType<typeof chromium.launch>>;

test('回复邮件：预填收件人、Re 和引用的原文；提交后是审批，邮件没有发出', async t => {
  const raw = [
    'From: ' + encoded('张三') + ' <zhangsan@example.invalid>', 'To: someone@qq.com',
    'Subject: ' + encoded('周四的评审'), 'Date: Wed, 25 Nov 2026 09:00:00 +0800', 'Message-ID: <theirs-1@example.invalid>',
    'References: <start@example.invalid>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', b64('请确认周四的评审时间。\r\n第二行。'),
  ].join('\r\n');
  const { server, work } = await start(t, 'test-mail-reply', raw, 'mario-mail-reply-browser-');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const { page, pageErrors, drawer } = await open(browser, server.url + '/#inbox?token=test-mail-reply', '周四的评审');
  const reply = drawer.getByRole('button', { name: '回复' });
  await expect(reply).toBeVisible();
  // The page says before anything is written that a reply is an approval.
  await expect(drawer.getByText('回复会先成为一张审批，你同意后才会发出。')).toBeVisible();

  // The reply comes filled in: who it goes to, Re:, and the message quoted.
  await reply.click();
  const form = page.getByRole('dialog').filter({ hasText: '回复邮件' });
  await expect(form).toBeVisible();
  await expect(form.getByText('从 someone@qq.com 发出')).toBeVisible();
  await expect(form.getByLabel('收件人')).toHaveValue('zhangsan@example.invalid');
  await expect(form.getByLabel('主题')).toHaveValue('Re: 周四的评审');
  const body = form.getByLabel('正文');
  await expect(body).toHaveValue(/张三 写道/);
  await expect(body).toHaveValue(/> 请确认周四的评审时间。/);
  await expect(form.getByText(/提交后是一张审批/)).toBeVisible();

  // Writing something above the quote and asking for the send. This does not send it.
  await body.fill('周四下午三点可以。' + await body.inputValue());
  await form.getByRole('button', { name: '提交审批' }).click();
  await expect(form).toBeHidden();
  await expect(drawer.getByRole('status')).toContainText('已提交审批，这封邮件还没有发出。');
  await expect(drawer.getByRole('link', { name: '前往审批' })).toHaveAttribute('href', '#chat/approvals');
  const approvals = server.app.approvals.list();
  expect(approvals).toHaveLength(1);
  expect(approvals[0]!.kind).toBe(MAIL_SEND_APPROVAL);
  expect(approvals[0]!.status).toBe('pending');
  expect(approvals[0]!.details).toContain('周四下午三点可以。');
  // The reply is tied to what it answers and to the thread.
  expect((approvals[0]!.params as { inReplyTo?: string }).inReplyTo).toBe('theirs-1@example.invalid');
  expect((approvals[0]!.params as { references?: string[] }).references).toEqual(['start@example.invalid', 'theirs-1@example.invalid']);
  // Asking did not send it, and the password is not on the page.
  expect(work.appended).toHaveLength(0);
  expect(await page.content()).not.toContain('an-offline-code');
  expect(pageErrors).toEqual([]);
  await page.close();
});

test('草稿在抽屉用其他方式关闭后保留，再打开时回来；取消后不再保留', async t => {
  const raw = ['From: a@example.invalid', 'To: someone@qq.com', 'Subject: plain', 'Message-ID: <p@example.invalid>',
    'Content-Type: text/plain; charset=UTF-8', '', 'the body'].join('\r\n');
  const { server } = await start(t, 'test-mail-draft', raw, 'mario-mail-reply-draft-');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const { page, pageErrors, drawer } = await open(browser, server.url + '/#inbox?token=test-mail-draft', 'plain');
  await drawer.getByRole('button', { name: '回复' }).click();
  let form = page.getByRole('dialog').filter({ hasText: '回复邮件' });
  await form.getByLabel('正文').fill('写了一半的话。');
  // Esc closes it. That is not a cancel, so what was written is kept.
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await drawer.getByRole('button', { name: '回复' }).click();
  form = page.getByRole('dialog').filter({ hasText: '回复邮件' });
  await expect(form.getByLabel('正文')).toHaveValue('写了一半的话。');
  // Cancel throws it away. The subject is still filled in as a reply, but the text is new.
  await form.getByRole('button', { name: '取消' }).click();
  await expect(form).toBeHidden();
  await drawer.getByRole('button', { name: '回复' }).click();
  form = page.getByRole('dialog').filter({ hasText: '回复邮件' });
  await expect(form.getByLabel('正文')).not.toHaveValue('写了一半的话。');
  await expect(form.getByLabel('主题')).toHaveValue('Re: plain');
  expect(server.app.approvals.list()).toHaveLength(0);
  expect(pageErrors).toEqual([]);
  await page.close();
});

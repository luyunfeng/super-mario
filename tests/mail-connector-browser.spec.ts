import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import { fakeMailServer } from './mail-fixture.ts';

const seen = String.fromCharCode(92) + 'Seen';

function message(uid: number, subject: string, mailbox = 'INBOX', extra: Record<string, unknown> = {}) {
  return { uid, envelope: { subject, from: [{ name: '', address: 'a@example.invalid' }], messageId: '<m' + uid + '@example.invalid>' },
    flags: new Set<string>(), internalDate: new Date(Date.UTC(2026, 10, 27, 1, uid)).toISOString(), ...extra };
}

/** A workbench with one mailbox that has an inbox and one folder of a usual kind. */
async function start(token: string, prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token });
  const folders = [
    { path: 'INBOX', messages: [message(1, '收件箱里的')] },
    { path: 'Sent', specialUse: String.fromCharCode(92) + 'Sent', messages: [] },
    { path: 'Archive', specialUse: String.fromCharCode(92) + 'Archive', messages: [message(2, '归档里的', 'Archive')] },
  ];
  const work = fakeMailServer({ folders });
  server.app.setMailOpen(async () => work.client);
  await server.app.mailAccounts.add({ email: 'someone@qq.com', password: 'an-offline-code', name: '工作邮箱',
    imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' });
  // The case closes the workbench itself. Closing it from a hook leaves the process alive.
  const close = async () => { try { await server.close(); } finally { await rm(dir, { recursive: true, force: true }); } };
  return { server, dir, close, config: { host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token } };
}

async function openInboxCard(browser: Browser, url: string) {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(url);
  const card = page.locator('#channel-mail');
  // The section is open when it is drawn, so it is not clicked: clicking its summary would
  // fold it.
  await expect(card.locator('details').filter({ hasText: '邮件进收件箱' })).toBeVisible();
  return { page, pageErrors, card };
}

type Browser = Awaited<ReturnType<typeof chromium.launch>>;
const mail = (server: { app: { inbox: { list(): Array<{ source: string }> } } }) => server.app.inbox.list().filter(item => item.source === 'mail').length;

/** Runs one case with a browser and closes everything it opened before the case ends.
 *  Closing from a hook leaves the process alive, because the plugin that reads mail is
 *  stopped after the case's own work is over. */
async function withBrowser(f: { close(): Promise<void> }, run: (browser: Browser) => Promise<import('@playwright/test').Page | void>) {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  let page: import('@playwright/test').Page | undefined;
  try {
    page = (await run(browser)) ?? undefined;
  } finally { await page?.close(); await browser.close(); await f.close(); }
}

test('渠道页的邮件进收件箱：默认关闭；打开后立刻读；选文件夹并保存后设置留下', async () => {
  const f = await start('test-mail-switch', 'mario-mail-switch-');
  const server = f.server;
  return withBrowser(f, async browser => {
  const { page, pageErrors, card } = await openInboxCard(browser, server.url + '/#channels?token=test-mail-switch');
  const section = card.locator('details').filter({ hasText: '邮件进收件箱' });
  // Off until the owner turns it on, and nothing has come in.
  await expect(section.getByLabel('把未读邮件放进收件箱')).not.toBeChecked();
  expect(mail(server)).toBe(0);

  // Turning it on reads at once, so the owner sees it work without waiting.
  await section.getByLabel('把未读邮件放进收件箱').check();
  await section.getByRole('button', { name: '保存' }).click();
  await expect.poll(() => mail(server)).toBe(1);
  // The folders are offered now that the mailboxes have been read once.
  await page.reload();
  const again = page.locator('#channel-mail details').filter({ hasText: '邮件进收件箱' });
  await expect(again.getByLabel('把未读邮件放进收件箱')).toBeChecked();
  await expect(again.getByLabel('收件箱', { exact: true })).toBeChecked();
  // A folder of a usual kind that the account has is offered.
  await expect(again.getByLabel(/^Archive/)).toBeVisible();

  // Choosing another folder too, and saving, is kept.
  await again.getByLabel(/^Archive/).check();
  await again.getByRole('button', { name: '保存' }).click();
  await expect.poll(async () => (await (await fetch(server.url + '/api/v1/mail/connector', { headers: { authorization: 'Bearer test-mail-switch' } })).json()).folders).toEqual(['INBOX', 'Archive']);
  await expect.poll(() => mail(server)).toBe(2);

    // One of two can be unchecked. The last one cannot: a list with nothing in it would mean
    // the inbox on the server, which is not what unchecking it looks like.
    await again.getByLabel(/^Archive/).uncheck();
    await expect(again.getByLabel(/^Archive/)).not.toBeChecked();
    // A click is used and not uncheck(), because uncheck() insists that the box ends up
    // unticked, and here the page is expected to put the tick back.
    await again.getByLabel('收件箱', { exact: true }).click();
  await expect(again.getByLabel('收件箱', { exact: true })).toBeChecked();
    // The archive was unchecked for this check only, so it is ticked again and not saved.
    await again.getByLabel(/^Archive/).check();

  // Turning it off and on does not forget the folders.
  await again.getByLabel('把未读邮件放进收件箱').uncheck();
  await again.getByRole('button', { name: '保存' }).click();
  await expect.poll(async () => (await (await fetch(server.url + '/api/v1/mail/connector', { headers: { authorization: 'Bearer test-mail-switch' } })).json()).enabled).toBe(false);
  await again.getByLabel('把未读邮件放进收件箱').check();
  await again.getByRole('button', { name: '保存' }).click();
  await expect.poll(async () => (await (await fetch(server.url + '/api/v1/mail/connector', { headers: { authorization: 'Bearer test-mail-switch' } })).json()).enabled).toBe(true);
  const after = await (await fetch(server.url + '/api/v1/mail/connector', { headers: { authorization: 'Bearer test-mail-switch' } })).json() as { folders: string[] };
  expect(after.folders).toEqual(['INBOX', 'Archive']);
  expect(await page.content()).not.toContain('an-offline-code');
  expect(pageErrors).toEqual([]);
  return page;
  });
});

test('一个邮箱没有读到时在开关下面指名；保存失败时勾选不丢', async () => {
  const f = await start('test-mail-fail', 'mario-mail-fail-');
  const server = f.server;
  return withBrowser(f, async browser => {
    const headers = { authorization: 'Bearer test-mail-fail', 'content-type': 'application/json' };
    // Mail is on and the mailbox reads well, so the folders are known and can be chosen.
    await fetch(server.url + '/api/v1/mail/connector', { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) });
    // A save that the server refuses: what was ticked stays ticked.
    let page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    await page.route('**/api/v1/mail/connector', async route => {
      if (route.request().method() === 'PUT') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '保存失败，请稍后再试。' }) });
      else await route.continue();
    });
    await page.goto(server.url + '/#channels?token=test-mail-fail');
    const section = page.locator('#channel-mail details').filter({ hasText: '邮件进收件箱' });
    const archive = section.getByLabel(/^Archive/);
    await archive.check();
    await section.getByRole('button', { name: '保存' }).click();
    await expect(section.getByRole('status')).toContainText('没有保存');
    await expect(archive).toBeChecked();
    await page.close();

    // Then the mailbox cannot be read. It is named under the switch, in the owner's terms.
    server.app.setMailOpen(async () => { throw new Error('read ECONNRESET for someone@qq.com'); });
    await fetch(server.url + '/api/v1/mail/connector/poll', { method: 'POST', headers });
    page = await browser.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    await page.goto(server.url + '/#channels?token=test-mail-fail');
    const after = page.locator('#channel-mail details').filter({ hasText: '邮件进收件箱' });
    await expect(after.getByRole('alert')).toContainText('这些邮箱没有读到');
    await expect(after.getByRole('alert')).toContainText('工作邮箱');
    expect(await after.innerText()).not.toContain('ECONNRESET');
    expect(pageErrors).toEqual([]);
    return page;
  });
});

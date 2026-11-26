import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import { readAttachment } from '../packages/core/src/mail-message.ts';
import { fakeMailServer } from './mail-fixture.ts';

const encoded = (value: string) => '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const signal = () => new AbortController().signal;

/** A message with a PDF attached, whose name is encoded, as a mail program in Chinese sends it. */
function withAttachment(name = '报表.pdf', content = 'the bytes of a report') {
  return [
    'From: finance@example.invalid', 'To: someone@qq.com', 'Subject: report', 'Message-ID: <r@example.invalid>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="x"', '',
    '--x', 'Content-Type: text/plain; charset=UTF-8', '', 'The report is attached.',
    '--x', 'Content-Type: application/pdf; name="' + encoded(name) + '"', 'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="' + encoded(name) + '"', '', b64(content), '--x--', '',
  ].join('\r\n');
}

test('按编号取出一个附件：名字解开，内容是解码后的字节；读取只读', async () => {
  const server = fakeMailServer({ folders: [{ path: 'INBOX', messages: [{ uid: 3, raw: Buffer.from(withAttachment()), flags: new Set<string>() }] }] });
  const where = { account: 'acc', mailbox: 'INBOX', uid: 3 };
  // The id is the one the message lists.
  const { readMessage } = await import('../packages/core/src/mail-message.ts');
  const listed = (await readMessage(server.client, where, signal())).message.attachments[0]!;
  const file = await readAttachment(server.client, where, listed.id, signal());
  assert.equal(file.id, listed.id);
  assert.equal(file.filename, '报表.pdf');
  assert.equal(file.mimeType, 'application/pdf');
  assert.equal(file.size, Buffer.byteLength('the bytes of a report'));
  assert.equal(Buffer.from(file.content).toString('utf8'), 'the bytes of a report');
  // Every read opened the folder read-only.
  assert.ok(server.opened.length >= 2);
  assert.ok(server.opened.every(opened => opened.readOnly && opened.path === 'INBOX'));
});

test('编造的编号取不到任何东西；换一封邮件，同一个编号也取不到', async () => {
  const first = fakeMailServer({ folders: [{ path: 'INBOX', messages: [{ uid: 1, raw: Buffer.from(withAttachment('one.pdf', 'first')), flags: new Set<string>() },
    { uid: 2, raw: Buffer.from(withAttachment('two.pdf', 'second')), flags: new Set<string>() }] }] });
  const { readMessage } = await import('../packages/core/src/mail-message.ts');
  const ofFirst = (await readMessage(first.client, { account: 'acc', mailbox: 'INBOX', uid: 1 }, signal())).message.attachments[0]!;
  // An id that was made up names nothing.
  await assert.rejects(readAttachment(first.client, { account: 'acc', mailbox: 'INBOX', uid: 1 }, 'A'.repeat(22), signal()), /不在这封邮件里/);
  // The id of the first message's attachment does not reach the second message's.
  await assert.rejects(readAttachment(first.client, { account: 'acc', mailbox: 'INBOX', uid: 2 }, ofFirst.id, signal()), /不在这封邮件里/);
  // The id is tied to the account and the folder as well.
  await assert.rejects(readAttachment(first.client, { account: 'other', mailbox: 'INBOX', uid: 1 }, ofFirst.id, signal()), /不在这封邮件里/);
  // A message that is not there says so before any attachment is looked for.
  await assert.rejects(readAttachment(first.client, { account: 'acc', mailbox: 'INBOX', uid: 9 }, ofFirst.id, signal()), /不在了/);
});

test('HTTP：附件作为文件下载，名字和内容对，响应头不让浏览器把它当页面打开', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mail-attachment-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-mail' });
  const work = fakeMailServer({ folders: [{ path: 'INBOX', messages: [{ uid: 3, raw: Buffer.from(withAttachment('报价 单.pdf', 'a price list')), flags: new Set<string>(), internalDate: '2026-11-25T01:00:00.000Z' }] }] });
  server.app.setMailOpen(async () => work.client);
  await server.app.mailAccounts.add({ email: 'someone@qq.com', password: 'the-secret-code', name: '工作邮箱',
    imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  // The item is put in directly, as the connector would. It names the message and nothing else.
  await server.app.inbox.ingest('mail', [{ thread: 'acc:t', last: 'INBOX:3', title: 'report · finance@example.invalid', text: 'a mail',
      origin: { kind: 'direct', connector: '邮箱', senderName: 'finance@example.invalid', mail: { account: (server.app.mailAccounts.list()[0]!).id, mailbox: 'INBOX', uid: 3 } } }]);
  for (let i = 0; i < 200 && !server.app.inbox.list().some(entry => entry.source === 'mail'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const inboxItem = server.app.inbox.list().find(entry => entry.source === 'mail')!;
  const headers = { authorization: 'Bearer offline-mail' };
  // The id comes from reading the message, as the page does.
  const message = await (await fetch(server.url + '/api/v1/mail/inbox/' + inboxItem.id, { headers })).json() as { attachments: Array<{ id: string }> };
  const response = await fetch(server.url + '/api/v1/mail/inbox/' + inboxItem.id + '/attachments/' + message.attachments[0]!.id, { headers });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'a price list');
  // Sent as a file to save, with the name as it was written.
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  const disposition = response.headers.get('content-disposition')!;
  assert.match(disposition, /^attachment; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!), '报价 单.pdf');
  // And never opened as a page.
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), 'sandbox');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength('a price list'));

  // An id that was not listed for this message is not found.
  const forged = await fetch(server.url + '/api/v1/mail/inbox/' + inboxItem.id + '/attachments/' + 'B'.repeat(22), { headers });
  assert.equal(forged.status, 404);
  assert.match(((await forged.json()) as { error: string }).error, /不在这封邮件里/);
  // An id of the wrong shape is refused before the mailbox is asked.
  assert.equal((await fetch(server.url + '/api/v1/mail/inbox/' + inboxItem.id + '/attachments/' + encodeURIComponent('a b'), { headers })).status, 404);
  // A query is not taken.
  assert.equal((await fetch(server.url + '/api/v1/mail/inbox/' + inboxItem.id + '/attachments/' + message.attachments[0]!.id + '?x=1', { headers })).status, 400);
  // An item that is not mail.
  assert.equal((await fetch(server.url + '/api/v1/mail/inbox/no-such-item/attachments/' + message.attachments[0]!.id, { headers })).status, 404);
  // Without a token nothing is given.
  assert.equal((await fetch(server.url + '/api/v1/mail/inbox/' + inboxItem.id + '/attachments/' + message.attachments[0]!.id)).status, 401);
});

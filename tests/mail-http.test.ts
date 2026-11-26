import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import { createMailReader } from '../packages/core/src/mail-reader.ts';
import type { ImapClient, OpenImap } from '../packages/core/src/mail-imap.ts';
import type { MailAccount } from '../packages/protocol/src/mail.ts';
import { MAIL_SEND_APPROVAL } from '../packages/core/src/mail-outbox.ts';
import { fakeMailServer } from './mail-fixture.ts';

type Answer = { status: number; data: any };

/** A stand-in connection with one folder and one message. It counts how often it was opened. */
function fakeOpen(options: { fail?: Error; onOpen?: () => void } = {}) {
  let opened = 0;
  const open: OpenImap = async () => {
    opened++;
    if (options.fail) throw options.fail;
    const client: ImapClient = {
      async list() { return [{ path: 'INBOX', name: 'INBOX', flags: new Set<string>() }]; },
      async mailboxOpen(path) { return { path, totalCount: 1, unseenCount: 1 }; },
      fetch: async function * () {
        yield { uid: 1, envelope: { subject: '一封邮件', from: [{ address: 'a@example.invalid' }], messageId: '<m@example.invalid>' }, flags: new Set<string>() };
      },
      async download() { return {}; },
      async append() { return false; },
      async logout() {},
    };
    return client;
  };
  return { open, opened: () => opened };
}

async function start(t: test.TestContext, open: OpenImap = fakeOpen().open) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mail-http-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-mail' });
  // Only the connection is replaced. The routes, the account store and the sealed password are
  // the real ones.
  server.app.mailReader = createMailReader({ accounts: server.app.mailAccounts, open });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { authorization: 'Bearer offline-mail', 'content-type': 'application/json' };
  const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const response = await fetch(server.url + '/api/v1' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as unknown };
  };
  return { call, server };
}

test('邮箱账号增改删查的整条流程，密码不出现在任何响应里', async t => {
  const f = await start(t);
  // The preset of a known domain is filled in for the page.
  const preset = await f.call('GET', '/mail/preset?email=someone@qq.com');
  assert.equal(preset.status, 200);
  assert.equal(preset.data.preset.imapHost, 'imap.qq.com');
  assert.equal(preset.data.preset.imapPort, 993);
  assert.equal((await f.call('GET', '/mail/preset?email=a@example.invalid')).data.preset, null);
  assert.equal((await f.call('GET', '/mail/preset?email=a@qq.com&page=2')).status, 400);

  assert.deepEqual(await f.call('GET', '/mail/accounts'), { status: 200, data: [] });
  // Adding without a password is refused before anything is written.
  const noPassword = await f.call('POST', '/mail/accounts', { email: 'someone@qq.com' });
  assert.equal(noPassword.status, 400);
  assert.match(noPassword.data.error, /密码或授权码/);
  const added = await f.call('POST', '/mail/accounts', { email: 'someone@qq.com', password: 'the-secret-code', name: '个人的' });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const account = added.data as MailAccount;
  assert.equal(account.hasPassword, true);
  assert.equal(account.status, 'unknown');
  const id = account.id;
  // No response ever carries the password.
  const listed = await f.call('GET', '/mail/accounts');
  assert.equal(JSON.stringify(listed).includes('the-secret-code'), false);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].account.id, id);
  assert.equal(listed.data[0].mailboxes, undefined, 'nothing has been read yet');

  // A change without the password keeps it. The version says which state the owner saw.
  const renamed = await f.call('PUT', '/mail/accounts/' + id, { version: account.version, name: '工作邮箱' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.name, '工作邮箱');
  assert.equal(renamed.data.version, 2);
  // The same version again is refused: another change was made in between.
  const stale = await f.call('PUT', '/mail/accounts/' + id, { version: account.version, name: '过期' });
  assert.equal(stale.status, 409);
  // A change that names an unknown field is refused.
  assert.equal((await f.call('PUT', '/mail/accounts/' + id, { version: 2, extra: 1 })).status, 400);
  // A version that is not a number is refused before the store is asked.
  assert.equal((await f.call('PUT', '/mail/accounts/' + id, { version: 'two', name: 'x' })).status, 400);

  // Removing takes the version too, and forgets what was read.
  assert.equal((await f.call('DELETE', '/mail/accounts/' + id, { version: 1 })).status, 409);
  const removed = await f.call('DELETE', '/mail/accounts/' + id, { version: 2 });
  assert.deepEqual(removed, { status: 200, data: { removed: id } });
  assert.equal((await f.call('GET', '/mail/accounts')).data.length, 0);
  assert.equal((await f.call('DELETE', '/mail/accounts/' + id, { version: 2 })).status, 404);
  // The version can also come as a query parameter, for a client that sends no body with a
  // DELETE. Anything else in the query is refused.
  const again = (await f.call('POST', '/mail/accounts', { email: 'other@qq.com', password: 'another-code' })).data as MailAccount;
  assert.equal((await f.call('DELETE', '/mail/accounts/' + again.id + '?version=1&extra=1')).status, 400);
  assert.equal((await f.call('DELETE', '/mail/accounts/' + again.id + '?version=0')).status, 400);
  assert.equal((await f.call('DELETE', '/mail/accounts/' + again.id + '?version=1')).status, 200);
  assert.equal((await f.call('GET', '/mail/accounts')).data.length, 0);
});

test('读取一个账号：成功时带文件夹和最新邮件；失败时说明原因，账号状态改为错误', async t => {
  let fail: Error | undefined;
  const open: OpenImap = async options => {
    if (fail) throw fail;
    // The password is on the options only for this call, and is the one that was sealed.
    assert.equal(options.auth?.pass, 'the-secret-code');
    assert.equal(options.auth?.user, 'someone@qq.com');
    assert.equal(options.secure, true);
    assert.equal(options.host, 'imap.qq.com');
    return fakeOpen().open(options);
  };
  const f = await start(t, open);
  const account = (await f.call('POST', '/mail/accounts', { email: 'someone@qq.com', password: 'the-secret-code' })).data as MailAccount;
  const read = await f.call('POST', '/mail/accounts/' + account.id + '/read');
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(read.data.account.status, 'ok');
  assert.equal(read.data.mailboxes[0].name, 'INBOX');
  assert.equal(read.data.messages[0].subject, '一封邮件');
  assert.equal(JSON.stringify(read.data).includes('the-secret-code'), false);
  // The state that the page reads on load carries the same.
  const state = await f.call('GET', '/mail/accounts');
  assert.equal(state.data[0].account.status, 'ok');
  assert.equal(state.data[0].messages[0].subject, '一封邮件');
  assert.match(state.data[0].readAt, /^2026-\d\d-\d\dT/);
  // A refused sign-in is a failure of the account, not of the request. The page reads why.
  fail = Object.assign(new Error('Invalid login'), { authenticationFailed: true });
  const refused = await f.call('POST', '/mail/accounts/' + account.id + '/read');
  assert.equal(refused.status, 502);
  assert.match(refused.data.error, /授权码/);
  const after = (await f.call('GET', '/mail/accounts')).data[0];
  assert.equal(after.account.status, 'error');
  assert.equal(after.failure.failure, 'authentication');
  assert.match(after.account.error, /授权码/);
  assert.equal(JSON.stringify(after).includes('Invalid login'), false, 'the server\'s own words are not passed on');
  // An account that is not there is a 404, not a mail failure.
  assert.equal((await f.call('POST', '/mail/accounts/no-such-account/read')).status, 404);
});

test('读一封邮件的正文和附件；太大、不存在、取消各自如实回答', async t => {
  const server = fakeMailServer({ folders: [{ path: 'INBOX', messages: [
    { uid: 4, raw: Buffer.from('From: a@example.invalid\r\nSubject: =?UTF-8?B?' + Buffer.from('周报').toString('base64') + '?=\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nthe body'), flags: new Set<string>() },
    { uid: 5, raw: Buffer.from('From: a@example.invalid\r\nSubject: big\r\n\r\nx'), size: 11 * 1024 * 1024 },
  ] }] });
  const f = await start(t, async () => { throw new Error('reading the folders is not part of this test'); });
  f.server.app.setMailOpen(async () => server.client);
  const account = (await f.call('POST', '/mail/accounts', { email: 'someone@qq.com', password: 'the-secret-code' })).data as MailAccount;
  const message = await f.call('GET', '/mail/accounts/' + account.id + '/messages/4');
  assert.equal(message.status, 200, JSON.stringify(message.data));
  assert.equal(message.data.subject, '周报');
  assert.equal(message.data.text, 'the body\n');
  assert.equal(message.data.seen, false);
  assert.deepEqual(message.data.attachments, []);
  assert.equal(JSON.stringify(message.data).includes('the-secret-code'), false);
  // The folder is opened read-only, and only the message asked for is read.
  assert.deepEqual(server.opened, [{ path: 'INBOX', readOnly: true }]);
  assert.equal(server.fetched[0]!.range, '4');
  // A message above the limit says so and is not cut short.
  const big = await f.call('GET', '/mail/accounts/' + account.id + '/messages/5');
  assert.equal(big.status, 422);
  assert.match(big.data.error, /超过了一次读取的上限/);
  // A message that is not there, a bad number, a bad folder name and an unknown parameter.
  assert.equal((await f.call('GET', '/mail/accounts/' + account.id + '/messages/9')).status, 404);
  assert.equal((await f.call('GET', '/mail/accounts/' + account.id + '/messages/0')).status, 400);
  assert.equal((await f.call('GET', '/mail/accounts/' + account.id + '/messages/4?mailbox=%0A')).status, 400);
  assert.equal((await f.call('GET', '/mail/accounts/' + account.id + '/messages/4?extra=1')).status, 400);
  assert.equal((await f.call('GET', '/mail/accounts/no-such/messages/4')).status, 404);
  // Another folder is named in the query.
  const other = await f.call('GET', '/mail/accounts/' + account.id + '/messages/4?mailbox=INBOX');
  assert.equal(other.status, 200);
});

test('页面提出发邮件只创建审批，批准前什么都没发', async t => {
  const f = await start(t);
  const account = (await f.call('POST', '/mail/accounts', { email: 'someone@qq.com', password: 'the-secret-code' })).data as MailAccount;
  const asked = await f.call('POST', '/mail/send', { account: account.id, to: [{ name: '李四', email: 'lisi@example.invalid' }],
    bcc: [{ email: 'boss@example.invalid' }], subject: '周四的评审', text: '请确认周四的评审。' });
  assert.equal(asked.status, 201, JSON.stringify(asked.data));
  assert.equal(asked.data.kind, MAIL_SEND_APPROVAL);
  assert.equal(asked.data.status, 'pending');
  assert.match(asked.data.details, /密送：boss@example\.invalid/);
  assert.equal(JSON.stringify(asked.data).includes('the-secret-code'), false);
  // The message is not sent by asking for it. Only one approval exists and it is pending.
  assert.deepEqual(f.server.app.approvals.list().map(item => item.status), ['pending']);
  // A request that is not a well-formed send is refused before an approval is made.
  const bad = await f.call('POST', '/mail/send', { account: account.id, to: [], subject: 's', text: 't' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /发给谁/);
  const unknownField = await f.call('POST', '/mail/send', { account: account.id, to: [{ email: 'a@example.invalid' }], subject: 's', text: 't', extra: 1 });
  assert.equal(unknownField.status, 400);
  const noAccount = await f.call('POST', '/mail/send', { account: 'no-such', to: [{ email: 'a@example.invalid' }], subject: 's', text: 't' });
  assert.equal(noAccount.status, 404);
  assert.equal(f.server.app.approvals.list().length, 1, 'a refused request makes no approval');
});

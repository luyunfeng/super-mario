import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import { setMessageFlags } from '../packages/core/src/mail-imap.ts';
import { fakeMailServer, type FakeMessage } from './mail-fixture.ts';

const SLASH = String.fromCharCode(92);
const SEEN = SLASH + 'Seen';
const FLAGGED = SLASH + 'Flagged';
const ANSWERED = SLASH + 'Answered';
const signal = () => new AbortController().signal;

function message(uid: number, flags: string[]): FakeMessage {
  return { uid, envelope: { subject: 's' + uid, from: [{ address: 'a@example.invalid' }], messageId: '<m' + uid + '@example.invalid>' },
    flags: new Set(flags), internalDate: '2026-11-27T01:00:00.000Z' };
}

test('标为已读和加星标只动这两个标志，邮件程序自己设的标志保留；可以再取消', async () => {
  // The message is read and has a mark a mail program set for its own use.
  const server = fakeMailServer({ folders: [{ path: 'INBOX', messages: [message(1, [ANSWERED])] }] });
  const where = { mailbox: 'INBOX', uid: 1 };
  await setMessageFlags(server.client, where, { seen: true }, signal());
  // Read: one change, adding Seen and nothing else.
  assert.deepEqual(server.flagChanges, [{ remove: false, range: '1', flags: [SEEN], uid: true }]);
  // The folder was opened for writing, because this is the one place that writes.
  assert.equal(server.opened.at(-1)!.readOnly, false);
  // Starred: adding Flagged and nothing else.
  await setMessageFlags(server.client, where, { flagged: true }, signal());
  assert.equal(server.flagChanges.length, 2);
  assert.deepEqual(server.flagChanges[1], { remove: false, range: '1', flags: [FLAGGED], uid: true });
  // Taking the star off takes off that one flag.
  await setMessageFlags(server.client, where, { flagged: false }, signal());
  assert.deepEqual(server.flagChanges[2], { remove: true, range: '1', flags: [FLAGGED], uid: true });
  // Both at once is two changes, in a fixed order.
  server.flagChanges.length = 0;
  await setMessageFlags(server.client, where, { seen: false, flagged: true }, signal());
  assert.deepEqual(server.flagChanges.map(change => [change.remove, change.flags[0]]), [[true, SEEN], [false, FLAGGED]]);
  // The flag the mail program set was never named.
  assert.equal(server.flagChanges.some(change => change.flags.includes(ANSWERED)), false);
});

test('邮件不在文件夹里时明确说不在了，不假装改成功；取消就停下', async () => {
  const server = fakeMailServer({ folders: [{ path: 'INBOX', messages: [message(1, [])] }] });
  await assert.rejects(setMessageFlags(server.client, { mailbox: 'INBOX', uid: 9 }, { seen: true }, signal()), /不在了/);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(setMessageFlags(server.client, { mailbox: 'INBOX', uid: 1 }, { seen: true }, stop.signal), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(server.flagChanges.length, 1, 'a cancelled change is not sent');
});

test('通过收件箱条目标记：只认已读和星标，别的字段、别的条目、不存在的邮件各自拒绝', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mail-flags-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-mail' });
  const message = (uid: number): FakeMessage => ({ uid, envelope: { subject: 'flags ' + uid, from: [{ address: 'a@example.invalid' }], messageId: '<f' + uid + '@example.invalid>' },
    flags: new Set<string>(), internalDate: '2026-11-27T01:00:00.000Z' });
  const work = fakeMailServer({ folders: [{ path: 'INBOX', messages: [message(1)] }] });
  server.app.setMailOpen(async () => work.client);
  const account = await server.app.mailAccounts.add({ email: 'someone@qq.com', password: 'the-secret-code', name: '工作邮箱',
    imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  await server.app.inbox.ingest('mail', [{ thread: 'acc:flags', last: 'INBOX:1', title: 'flags 1 · a@example.invalid', text: 'a mail',
    origin: { kind: 'direct', connector: '邮箱', senderName: 'a@example.invalid', mail: { account: account.id, mailbox: 'INBOX', uid: 1 } } }]);
  for (let i = 0; i < 200 && !server.app.inbox.list().some(entry => entry.source === 'mail'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const item = server.app.inbox.list().find(entry => entry.source === 'mail')!;
  const call = async (id: string, body: unknown) => {
    const response = await fetch(server.url + '/api/v1/mail/inbox/' + encodeURIComponent(id) + '/flags', { method: 'POST',
      headers: { authorization: 'Bearer offline-mail', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };
  // Marking it read says so, and the mailbox was asked for that one flag.
  const read = await call(item.id, { seen: true });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.deepEqual(read.data, { seen: true });
  assert.deepEqual(work.flagChanges, [{ remove: false, range: '1', flags: [SEEN], uid: true }]);
  // An empty change is refused: nothing would be done.
  assert.equal((await call(item.id, {})).status, 400);
  assert.equal((await call(item.id, { seen: 'yes' })).status, 400);
  // A field that is not one of the two is refused by name, before any connection.
  const extra = await call(item.id, { seen: true, deleted: true });
  assert.equal(extra.status, 400);
  assert.match(extra.data.error, /deleted/);
  assert.equal(work.flagChanges.length, 1, 'a refused change does not reach the mailbox');
  // An item that is not mail, and one that is not there.
  assert.equal((await call('no-such-item', { seen: true })).status, 404);
  // A message that is gone from the folder: nothing is left in it to change.
  const emptied = fakeMailServer({ folders: [{ path: 'INBOX', messages: [] }] });
  work.client.messageFlagsAdd = emptied.client.messageFlagsAdd!.bind(emptied.client);
  work.client.messageFlagsRemove = emptied.client.messageFlagsRemove!.bind(emptied.client);
  await emptied.client.mailboxOpen('INBOX', { readOnly: true });
  assert.equal((await call(item.id, { seen: false })).status, 404);
  // The password is never on an answer.
  assert.equal(JSON.stringify(read.data).includes('the-secret-code'), false);
});

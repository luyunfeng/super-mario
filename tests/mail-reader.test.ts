import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createSealedStore } from '../packages/core/src/sealed-store.ts';
import { createMailAccounts } from '../packages/core/src/mail-accounts.ts';
import { createMailReader } from '../packages/core/src/mail-reader.ts';
import { ImapError, type ImapClient } from '../packages/core/src/mail-imap.ts';
import type { Mailbox, MailSummary } from '../packages/protocol/src/mail.ts';
import { fakeMailServer } from './mail-fixture.ts';

const SLASH = String.fromCharCode(92);

/** A server with one message in the inbox. It counts connections and answers from what it was given. */
function fakeServer(options: { failConnect?: Error; failList?: Error } = {}) {
  const clients: ImapClient[] = [];
  let logouts = 0;
  const open = async () => {
    if (options.failConnect) throw options.failConnect;
    // Each connection gets its own server state, as it would on a real one, and the count of
    // logouts is shared so the test can check that every connection was closed.
    const inner = fakeMailServer({ folders: [{ path: 'INBOX', messages: [{
      uid: 7, envelope: { subject: '工资条', from: [{ address: 'payroll@example.invalid' }], messageId: '<p1@example.invalid>' },
      internalDate: '2026-11-25T02:00:00.000Z', flags: new Set<string>(),
    }] }], fail: { list: options.failList } });
    const client: ImapClient = { ...inner.client, async logout() { logouts++; await inner.client.logout(); } };
    clients.push(client);
    return client;
  };
  return { open, clients, logouts: () => logouts };
}

const firstMailbox: Mailbox = { name: 'INBOX', role: 'inbox', unseen: 1, total: 1 };
const firstMessage = (account: string): MailSummary => ({
  account, mailbox: 'INBOX', uid: 7, messageId: '<p1@example.invalid>', subject: '工资条',
  from: { name: '', email: 'payroll@example.invalid' }, to: [], date: '2026-11-25T02:00:00.000Z',
  hasAttachments: false, seen: false, answered: false, flagged: false,
});

async function fixture(t: TestContext, serverOptions: { failConnect?: Error; failList?: Error } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mario-mail-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(':memory:');
  t.after(() => store.close());
  const sealed = await createSealedStore(join(root, 'data'));
  const accounts = createMailAccounts({ store, sealed });
  const account = await accounts.add({ email: 'someone@qq.com', password: 'the-secret-code', name: '个人的' });
  const server = fakeServer(serverOptions);
  const reader = createMailReader({ accounts, open: server.open, now: () => new Date('2026-11-26T03:00:00.000Z') });
  return { store, accounts, account, server, reader };
}

test('读取成功记下状态，密码只用于连接，不出现在状态和结果里', async t => {
  const f = await fixture(t);
  const result = await f.reader.read(f.account.id, new AbortController().signal);
  assert.equal(result.readAt, '2026-11-26T03:00:00.000Z');
  assert.deepEqual(result.mailboxes, [firstMailbox]);
  assert.deepEqual(result.messages, [firstMessage(f.account.id)]);
  assert.equal(result.account.status, 'ok', 'the account says the last check worked');
  assert.equal(result.account.version, 1, 'a check does not move the version');
  assert.equal(f.server.logouts(), 1, 'the connection is closed after the read');
  const shown = JSON.stringify(f.reader.state());
  assert.equal(shown.includes('the-secret-code'), false);
  assert.equal(JSON.stringify(result).includes('the-secret-code'), false);
});

test('登录失败记下原因，账号状态改为错误；之后读取成功会清除失败记录', async t => {
  const f = await fixture(t, { failConnect: Object.assign(new Error('Invalid login'), { authenticationFailed: true }) });
  await assert.rejects(f.reader.read(f.account.id, new AbortController().signal), (error: unknown) =>
    error instanceof ImapError && error.failure === 'authentication' && /授权码/.test(error.message));
  const [state] = f.reader.state();
  assert.equal(state.account.status, 'error');
  assert.match(state.account.error!, /授权码/);
  assert.equal(state.failure?.failure, 'authentication');
  assert.equal(state.mailboxes, undefined, 'a failed read leaves no folder list');
  // The same account then reads well, which clears what went wrong.
  const good = createMailReader({ accounts: f.accounts, open: fakeServer().open, now: () => new Date('2026-11-26T04:00:00.000Z') });
  const result = await good.read(f.account.id, new AbortController().signal);
  assert.equal(result.account.status, 'ok');
  assert.equal(good.state()[0]!.failure, undefined);
  assert.equal(good.state()[0]!.account.error, undefined);
});

test('中途取消不算账号失败，不记状态；之后还能再读', async t => {
  const f = await fixture(t);
  const stop = new AbortController();
  // The connection is made before the read is cancelled, so the cancellation lands inside
  // the read and is not mistaken for a failure of the account.
  const slowOpen = async () => {
    const client = await f.server.open();
    stop.abort();
    return client;
  };
  const reader = createMailReader({ accounts: f.accounts, open: slowOpen, now: () => new Date('2026-11-26T05:00:00.000Z') });
  await assert.rejects(reader.read(f.account.id, stop.signal), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  const [state] = reader.state();
  assert.equal(state.account.status, 'unknown', 'a cancelled read says nothing about the account');
  assert.equal(state.failure, undefined);
  assert.equal(state.mailboxes, undefined);
  assert.equal(f.server.logouts(), 1, 'the connection is still closed');
  // After it, the account reads well again.
  const reader2 = createMailReader({ accounts: f.accounts, open: f.server.open, now: () => new Date('2026-11-26T06:00:00.000Z') });
  await reader2.read(f.account.id, new AbortController().signal);
  assert.equal(reader2.state()[0]!.account.status, 'ok');
});

test('同一账号并发读取只连一次，共享结果', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([
    f.reader.read(f.account.id, new AbortController().signal),
    f.reader.read(f.account.id, new AbortController().signal),
  ]);
  assert.equal(f.server.clients.length, 1, 'two asks for one account make one connection');
  assert.deepEqual(a.messages, b.messages, 'both asks see the same messages');
  assert.equal(a.readAt, b.readAt);
});

test('账号被删除后，它的状态被清掉', async t => {
  const f = await fixture(t);
  await f.reader.read(f.account.id, new AbortController().signal);
  assert.equal(f.reader.state().length, 1);
  f.accounts.remove(f.account.id, f.account.version);
  f.reader.forget(f.account.id);
  assert.deepEqual(f.reader.state(), []);
});

test('读取途中账号被删除：不留下它的失败记录，也不改任何账号的状态', async t => {
  const f = await fixture(t);
  const stop = new AbortController();
  // The account is removed after the connection is made, as it would be by another window,
  // and the read then fails on its own.
  const late = async () => {
    await f.accounts.remove(f.account.id, f.account.version);
    throw new Error('read ECONNRESET');
  };
  const reader = createMailReader({ accounts: f.accounts, open: late, now: () => new Date('2026-11-26T07:00:00.000Z') });
  await assert.rejects(reader.read(f.account.id, stop.signal), (error: unknown) =>
    error instanceof ImapError && error.failure === 'connection');
  assert.deepEqual(reader.state(), [], 'nothing is kept for an account that is gone');
  // A read that was started before the removal still ends without keeping anything.
  await assert.rejects(f.reader.read(f.account.id, stop.signal), /不存在/);
  assert.deepEqual(f.reader.state(), []);
 });

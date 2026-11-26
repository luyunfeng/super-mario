import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Approval } from '../packages/protocol/src/index.ts';
import PostalMime from 'postal-mime';
import { createStore } from '../packages/core/src/store.ts';
import { createSealedStore } from '../packages/core/src/sealed-store.ts';
import { createMailAccounts } from '../packages/core/src/mail-accounts.ts';
import { checkedSendInput, executeMailSend, MAIL_SEND_APPROVAL, MailInputError, proposeMailSend, requestOf } from '../packages/core/src/mail-outbox.ts';
import { fakeMailServer, type FakeServer } from './mail-fixture.ts';
import { fakeSmtp, type FakeSmtp } from './mail-smtp-fixture.ts';

/** An account whose two servers are the stand-ins. The outgoing port is filled in per test. */
async function fixture(t: { after(fn: () => void): void }, options: { breakAt?: 'after-354'; appendFails?: boolean; noSentFolder?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mario-mail-outbox-'));
  const store = createStore(':memory:');
  const sealed = await createSealedStore(join(root, 'data'));
  const smtp: FakeSmtp = await fakeSmtp({ noStartTls: true, breakAt: options.breakAt });
  const folders = [{ path: 'INBOX', messages: [] }, ...(options.noSentFolder ? [] : [{ path: 'Sent Messages', messages: [] as never[], specialUse: String.fromCharCode(92) + 'Sent' }])];
  const imap: FakeServer = fakeMailServer({ folders });
  if (options.appendFails) {
    // The server refuses to keep a copy, as one out of space would.
    imap.client.append = async () => { throw new Error('Overquota'); };
  }
  const accounts = createMailAccounts({ store, sealed });
  const account = await accounts.add({ email: 'someone@qq.com', password: 'the-secret-code', name: '工作邮箱',
    imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecurity: 'none' });
  const approvals: Approval[] = [];
  const propose = (input: Parameters<typeof proposeMailSend>[2] extends (input: infer I) => Approval ? I : never) => {
    const item: Approval = { ...input, id: 'approval-' + (approvals.length + 1), version: 1, status: 'pending', createdAt: '', updatedAt: '' };
    approvals.push(item);
    return item;
  };
  const open = async () => imap.client;
  t.after(async () => { store.close(); await smtp.close(); await rm(root, { recursive: true, force: true }); });
  return { account, accounts, approvals, propose, smtp, imap, open };
}

const ask = () => ({ account: 'filled-in', to: [{ name: '李四', email: 'lisi@example.invalid' }], subject: '周四的评审', text: '请确认周四的评审。' });
const signal = () => new AbortController().signal;
const refused = (match: RegExp) => (error: unknown) => error instanceof MailInputError && match.test(error.message);

test('发邮件的参数逐项核对，不合规的在创建审批之前拒绝', () => {
  const good = checkedSendInput({ account: 'a', to: [{ email: 'x@example.invalid' }], subject: 's', text: 't' });
  assert.deepEqual(good.to, [{ name: '', email: 'x@example.invalid' }]);
  assert.equal(good.cc.length, 0);
  assert.equal(good.bcc.length, 0);
  // A field that is not part of a send is refused by name.
  assert.throws(() => checkedSendInput({ ...ask(), extra: 1 }), refused(/extra/));
  assert.throws(() => checkedSendInput({ ...ask(), account: undefined }), refused(/哪个邮箱/));
  assert.throws(() => checkedSendInput({ ...ask(), to: [] }), refused(/发给谁/));
  assert.throws(() => checkedSendInput({ ...ask(), to: 'x@example.invalid' }), refused(/数组/));
  assert.throws(() => checkedSendInput({ ...ask(), to: [{ email: 'not an address' }] }), refused(/地址无效/));
  assert.throws(() => checkedSendInput({ ...ask(), to: [{ email: 'x@example.invalid', replyTo: 'y@example.invalid' }] }), refused(/参数无效/));
  assert.throws(() => checkedSendInput({ ...ask(), subject: 7 }), refused(/主题须为文本/));
  assert.throws(() => checkedSendInput({ ...ask(), subject: 'x'.repeat(999) }), refused(/最多/));
  assert.throws(() => checkedSendInput({ ...ask(), html: 7 }), refused(/HTML/));
  assert.throws(() => checkedSendInput({ ...ask(), in_reply_to: '<a b>' }), refused(/Message-ID/));
  assert.throws(() => checkedSendInput({ ...ask(), references: ['<has space>'] }), refused(/Message-ID/));
  // The names the tool uses and the names the approval keeps are both taken.
  assert.equal(checkedSendInput({ ...ask(), in_reply_to: '<abc@x>' }).inReplyTo, 'abc@x');
  assert.deepEqual(checkedSendInput({ ...ask(), references: '<a@x> <b@x>' }).references, ['a@x', 'b@x']);
  assert.deepEqual(checkedSendInput({ ...ask(), inReplyTo: 'abc@x' }).references, []);
});

test('提出发邮件只创建审批，不发任何东西；审批上写明发给谁、密送谁、主题和正文', async t => {
  const f = await fixture(t);
  const approval = proposeMailSend({ ...ask(), account: f.account.id, to: ask().to, bcc: [{ email: 'boss@example.invalid' }] }, f.accounts, f.propose);
  assert.equal(approval.kind, MAIL_SEND_APPROVAL);
  assert.equal(approval.status, 'pending');
  assert.match(approval.title, /^发送邮件给 李四 <lisi@example.invalid>：周四的评审$/);
  assert.match(approval.details, /收件人：李四 <lisi@example.invalid>/);
  assert.match(approval.details, /密送：boss@example.invalid/);
  assert.match(approval.details, /主题：周四的评审/);
  assert.match(approval.details, /请确认周四的评审。/);
  // Nothing went out and no connection was made.
  assert.equal(f.smtp.message(), '');
  assert.deepEqual(f.smtp.said, []);
  assert.equal(f.imap.appended.length, 0);
  // The password is not on the approval.
  assert.equal(JSON.stringify(approval).includes('the-secret-code'), false);
  // An account that is not there is refused before an approval is made.
  assert.throws(() => proposeMailSend({ ...ask(), account: 'no-such-account' }, f.accounts, f.propose), /不存在/);
  assert.equal(f.approvals.length, 1);
});

test('主人批准后发出，并把副本存进已发送；副本里有密送，发出的邮件里没有', async t => {
  const f = await fixture(t);
  const approval = proposeMailSend({ ...ask(), account: f.account.id, bcc: [{ email: 'boss@example.invalid' }] }, f.accounts, f.propose);
  const result = await executeMailSend(approval, f.accounts, signal(), f.open);
  assert.equal(result.outcome, 'sent', JSON.stringify(result));
  assert.equal(result.copyKept, true, JSON.stringify(result));
  assert.match(result.messageId!, /@qq\.com$/);
  assert.deepEqual(result.accepted, ['lisi@example.invalid', 'boss@example.invalid']);
  // What went out names no blind copy.
  assert.equal(/^(Bcc|bcc):/m.test(f.smtp.message()), false);
  // The copy kept for the owner does name it, carries the same id, and is marked as read.
  const copy = new TextDecoder().decode(f.imap.appended[0]!.content);
  assert.equal(f.imap.appended[0]!.path, 'Sent Messages');
  assert.deepEqual(f.imap.appended[0]!.flags, [String.fromCharCode(92) + 'Seen']);
  assert.match(copy, /^(Bcc|bcc): boss@example\.invalid/m);
  assert.equal(copy.includes('<' + result.messageId + '>'), true, 'the copy and the message share one id');
  assert.match(copy, /^Subject: =\?UTF-8\?B\?/m);
});

test('主人在审批时改了收件人和正文，发出的是改过的', async t => {
  const f = await fixture(t);
  const approval = proposeMailSend({ ...ask(), account: f.account.id }, f.accounts, f.propose);
  // The owner rewrites it while reviewing: another recipient and another text.
  const edited: Approval = { ...approval, version: 2, params: { ...approval.params, to: [{ name: '王五', email: 'wangwu@example.invalid' }], text: '改过的正文。' } };
  const result = await executeMailSend(edited, f.accounts, signal(), f.open);
  assert.equal(result.outcome, 'sent', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['wangwu@example.invalid']);
  assert.match(f.smtp.message(), /<wangwu@example\.invalid>/);
  assert.equal(/lisi@example\.invalid/.test(f.smtp.message()), false, 'the first recipient is not sent to any more');
  // The copy is parsed as a mail program would read it, so that the text is compared as text.
  const copy = await new PostalMime().parse(f.imap.appended[0]!.content);
  assert.equal(copy.text?.trim(), '改过的正文。');
  assert.deepEqual(copy.to?.map(item => (item as { address: string }).address), ['wangwu@example.invalid']);
});

test('邮箱的地址变了，批准过的邮件不再发出', async t => {
  const f = await fixture(t);
  const approval = proposeMailSend({ ...ask(), account: f.account.id }, f.accounts, f.propose);
  await f.accounts.update(f.account.id, { email: 'other@qq.com', password: 'a-new-code' }, f.account.version);
  await assert.rejects(executeMailSend(approval, f.accounts, signal(), f.open), refused(/地址已经变了/));
  assert.equal(f.smtp.message(), '');
});

test('副本存不进已发送时，邮件仍算发出，并说明没有留副本', async t => {
  const refusedCopy = await fixture(t, { appendFails: true });
  const first = proposeMailSend({ ...ask(), account: refusedCopy.account.id }, refusedCopy.accounts, refusedCopy.propose);
  const result = await executeMailSend(first, refusedCopy.accounts, signal(), refusedCopy.open);
  assert.equal(result.outcome, 'sent', JSON.stringify(result));
  assert.equal(result.copyKept, false, 'the owner is told that the Sent folder has no copy');
  // An account with no sent folder at all.
  const noFolder = await fixture(t, { noSentFolder: true });
  const second = proposeMailSend({ ...ask(), account: noFolder.account.id }, noFolder.accounts, noFolder.propose);
  const without = await executeMailSend(second, noFolder.accounts, signal(), noFolder.open);
  assert.equal(without.outcome, 'sent');
  assert.equal(without.copyKept, false);
});

test('结果未知时邮件可能已发出：不存副本，也不报成已发送', async t => {
  const f = await fixture(t, { breakAt: 'after-354' });
  const approval = proposeMailSend({ ...ask(), account: f.account.id }, f.accounts, f.propose);
  const result = await executeMailSend(approval, f.accounts, signal(), f.open);
  assert.equal(result.outcome, 'unknown', JSON.stringify(result));
  assert.match(result.message, /不要直接重发/);
  // A copy would say the message went, which is not known.
  assert.equal(f.imap.appended.length, 0);
  assert.equal(f.imap.opened.length, 0, 'the mail server was not even connected to');
});

test('审批参数还原成发送请求时再核对一遍，改坏的参数不会发出', async t => {
  const f = await fixture(t);
  const approval = proposeMailSend({ ...ask(), account: f.account.id }, f.accounts, f.propose);
  assert.deepEqual(requestOf(approval.params).to, ask().to);
  const broken: Approval = { ...approval, params: { ...approval.params, to: [{ email: 'not an address' }] } };
  await assert.rejects(executeMailSend(broken, f.accounts, signal(), f.open), refused(/地址无效/));
  assert.equal(f.smtp.message(), '');
});

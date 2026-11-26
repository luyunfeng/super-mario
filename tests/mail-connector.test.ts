import test from 'node:test';
import assert from 'node:assert/strict';
import type { InboxThing, Mailbox, MailConnectorState, MailInboxRead, MailSummary } from '../packages/protocol/src/index.ts';
import { configureMailConnector } from '../packages/core/src/mail-connector-settings.ts';
import { mailThing, mailThread, runMailConnector, type MailConnectorActions } from '../plugins/mail-connector.ts';

function message(uid: number, subject: string, from = 'a@example.invalid', extra: Partial<MailSummary> = {}): MailSummary {
  return { account: 'acc', mailbox: 'INBOX', uid, messageId: '<m' + uid + '@x>', subject, from: { name: '', email: from }, to: [],
    date: new Date(Date.UTC(2026, 10, 1, 0, uid)).toISOString(), hasAttachments: false, seen: false, answered: false, flagged: false, ...extra };
}

function makeRead(messages: MailSummary[], mailboxes: Mailbox[] = [{ name: 'INBOX', role: 'inbox', unseen: messages.length, total: messages.length }]): MailInboxRead {
  return { account: { id: 'acc', name: '工作邮箱', email: 'someone@qq.com' }, mailboxes, messages };
}

function fixture(options: { state?: Partial<MailConnectorState>; reads?: MailInboxRead[]; fail?: Error; failed?: Array<{ id: string; name: string }> } = {}) {
  let state: MailConnectorState = { enabled: true, ...options.state };
  const ingested: InboxThing[][] = [];
  const retired: string[] = [];
  const actions: MailConnectorActions = {
    async read() { if (options.fail) throw options.fail; return { reads: options.reads ?? [], failed: options.failed ?? [] }; },
    async ingest(things) { ingested.push(things); },
    retire(account) { retired.push(account); },
    state: () => state,
    save(next) { state = next; },
  };
  return { actions, ingested, retired, state: () => state };
}

test('话题按去掉回复和转发前缀的主题聚合，大小写和空白不算', () => {
  const base = mailThread('周四的评审');
  assert.equal(base.length, 12);
  for (const same of ['Re: 周四的评审', 'RE:  周四的评审', '回复：周四的评审', '答复: 周四的评审', '转发：周四的评审', 'Fwd: 周四的评审',
    '[团队] 周四的评审', 'Re: [团队] Fwd: 周四的评审', ' 周四的  评审 ']) {
    assert.equal(mailThread(same), base, same);
  }
  assert.notEqual(mailThread('周五的评审'), base);
  // The prefixes are taken off only at the start, so a subject about replying stays itself.
  assert.notEqual(mailThread('怎样写回复：指南'), mailThread('指南'));
});

test('没有主题的邮件按发件人聚合，一个人的不会折到另一个人的下面', () => {
  const one = mailThread('', 'a@example.invalid');
  assert.equal(mailThread('   ', 'A@example.invalid'), one, 'the address is matched without case');
  assert.equal(mailThread('Re: ', 'a@example.invalid'), one, 'a reply with nothing but a prefix is the same');
  assert.notEqual(mailThread('', 'b@example.invalid'), one);
  assert.equal(mailThread('[通知]', 'a@example.invalid'), one, 'a subject that is only a list name says nothing');
  assert.notEqual(mailThread(''), one, 'no subject and no sender is told from any sender');
});

test('未读的邮件成为收件箱条目，带着在邮箱里定位它的信息；已读的不进收件箱', () => {
  const read = makeRead([]);
  const unread = message(3, '周报', 'zhangsan@example.invalid', { hasAttachments: true });
  const thing = mailThing(read, unread, new Set(['INBOX']))!;
  assert.equal(thing.thread, 'acc:' + mailThread('周报', 'zhangsan@example.invalid'));
  assert.equal(thing.last, 'INBOX:3');
  assert.equal(thing.title, '周报 · zhangsan@example.invalid');
  assert.match(thing.text, /发来一封邮件。带附件。/);
  assert.equal(thing.receivedAt, unread.date);
  assert.deepEqual(thing.origin, { kind: 'direct', connector: '邮箱', senderName: 'zhangsan@example.invalid', mail: { account: 'acc', mailbox: 'INBOX', uid: 3 } });
  // The body is not on the thing: it is read again when the item is opened.
  assert.deepEqual(Object.keys(thing.origin!.mail!).sort(), ['account', 'mailbox', 'uid']);
  assert.equal(mailThing(read, { ...unread, seen: true }, new Set(['INBOX'])), undefined, 'read mail is left alone');
  assert.equal(mailThing(read, { ...unread, mailbox: '归档' }, new Set(['INBOX'])), undefined, 'mail of another folder is left alone');
  assert.equal(mailThing(read, { ...unread, from: { name: '张三', email: 'z@example.invalid' } }, new Set(['INBOX']))!.title, '周报 · 张三');
  assert.equal(mailThing(read, { ...unread, subject: '' }, new Set(['INBOX']))!.title, '（无主题） · zhangsan@example.invalid');
});

test('一次读取：同一话题只出一条，取最新那封；最新那封已读则整个话题不进收件箱', async () => {
  const read = makeRead([
    message(1, '周四的评审'),
    message(2, 'Re: 周四的评审', 'b@example.invalid'),
    message(3, 'Re: 周四的评审', 'c@example.invalid', { seen: true }),
    message(4, '另一件事'),
  ]);
  const f = fixture({ reads: [read] });
  await runMailConnector(f.actions);
  // The thread of the review has three messages and its newest one was read, so the whole
  // thread stays out, though uid 1 and 2 were not read.
  assert.deepEqual(f.ingested.flat().map(thing => thing.title), ['另一件事 · a@example.invalid']);
  assert.equal(f.state().lastError, undefined);
  assert.match(f.state().lastRunAt!, /^2026-/);

  // When the newest message is unread, that one is the item and the older ones of the same
  // thread are not added as well.
  const second = fixture({ reads: [makeRead([message(1, '周报'), message(2, 'Re: 周报', 'b@example.invalid')])] });
  await runMailConnector(second.actions);
  assert.deepEqual(second.ingested.flat().map(thing => thing.last), ['INBOX:2']);
  assert.equal(second.ingested.flat()[0]!.origin!.mail!.uid, 2);
});

test('一个邮箱读不到时，它已有的邮件不会被当成没有了，并记下是哪个', async () => {
  const read = makeRead([message(1, '周报')]);
  const f = fixture({ reads: [read], failed: [{ id: 'home', name: '个人的' }] });
  await runMailConnector(f.actions);
  // The mailbox that was read still has its mail put in.
  assert.equal(f.ingested.flat().length, 1);
  // The one that was not is named in the state, and it is not a failure of the whole run.
  assert.deepEqual(f.state().failed, [{ id: 'home', name: '个人的' }]);
  assert.equal(f.state().lastError, undefined);
  // A later run that reads it clears the list.
  const healed = fixture({ reads: [read] });
  await runMailConnector(healed.actions);
  assert.deepEqual(healed.state().failed, []);
});

test('只收指定文件夹的邮件；两个账号的同名话题是两条', async () => {
  const mailboxes = [{ name: 'INBOX', role: 'inbox' as const, unseen: 1, total: 1 }, { name: '工作', role: 'other' as const, unseen: 1, total: 1 }];
  const work = makeRead([message(1, '周报'), { ...message(2, '项目周报'), mailbox: '工作' }], mailboxes);
  const onlyInbox = fixture({ reads: [work], state: { folders: [] } });
  await runMailConnector(onlyInbox.actions);
  assert.deepEqual(onlyInbox.ingested.flat().map(thing => thing.origin!.mail!.mailbox), ['INBOX'], 'an empty list means the inbox only');

  const both = fixture({ reads: [work], state: { folders: ['INBOX', '工作'] } });
  await runMailConnector(both.actions);
  assert.deepEqual(both.ingested.flat().map(thing => thing.origin!.mail!.mailbox).sort(), ['INBOX', '工作']);

  const other = fixture({ reads: [work], state: { folders: ['工作', '不存在的'] } });
  await runMailConnector(other.actions);
  assert.deepEqual(other.ingested.flat().map(thing => thing.origin!.mail!.mailbox), ['工作'], 'a folder the account does not have is ignored');

  const home = { ...work, account: { id: 'home', name: '个人的', email: 'other@163.com' }, messages: [message(5, '周报', 'mom@example.invalid')] };
  const two = fixture({ reads: [work, home] });
  await runMailConnector(two.actions);
  const sameSubject = two.ingested.flat().filter(thing => thing.title.startsWith('周报'));
  assert.equal(sameSubject.length, 2);
  assert.notEqual(sameSubject[0]!.thread, sameSubject[1]!.thread);
});

test('停用后不读邮箱；读取途中被停用则不写入；读取失败记下原因，下次还能读', async () => {
  const off = fixture({ reads: [makeRead([message(1, '周报')])], state: { enabled: false } });
  await runMailConnector(off.actions);
  assert.equal(off.ingested.length, 0);
  assert.equal(off.state().lastRunAt, undefined, 'nothing ran');

  let reads = 0;
  const switching: MailConnectorActions = {
    async read() { reads++; return { reads: [makeRead([message(1, '周报')])], failed: [] }; },
    async ingest() { assert.fail('nothing is put in after the connector is switched off'); },
    retire() {}, state: () => ({ enabled: reads === 0 }), save() {},
  };
  await runMailConnector(switching);
  assert.equal(reads, 1);

  const broken = fixture({ fail: new Error('read ECONNRESET for someone@qq.com') });
  await runMailConnector(broken.actions);
  assert.equal(broken.ingested.length, 0);
  assert.match(broken.state().lastError!, /ECONNRESET/);
  const healed = fixture({ reads: [makeRead([message(1, '周报')])] });
  await runMailConnector(healed.actions);
  assert.equal(healed.state().lastError, undefined, 'a good run clears the reason');
});

test('设置只认开关和文件夹，文件夹先校验', () => {
  const current: MailConnectorState = { enabled: true };
  assert.deepEqual(configureMailConnector(current, { enabled: false }), { enabled: false });
  assert.deepEqual(configureMailConnector(current, { enabled: true, folders: ['工作', '工作'] }), { enabled: true, folders: ['工作'] });
  assert.deepEqual(configureMailConnector({ enabled: true, folders: ['工作'] }, { enabled: false }), { enabled: false, folders: ['工作'] }, 'a list left out keeps the one there was');
  assert.throws(() => configureMailConnector(current, { enabled: 'yes' }), /是否把邮件放进收件箱/);
  assert.throws(() => configureMailConnector(current, { enabled: true, extra: 1 }), /extra/);
  assert.throws(() => configureMailConnector(current, { enabled: true, folders: 'INBOX' }), /文件夹名称无效/);
  assert.throws(() => configureMailConnector(current, { enabled: true, folders: [''] }), /文件夹名称无效/);
  assert.throws(() => configureMailConnector(current, { enabled: true, folders: ['a\nb'] }), /文件夹名称无效/);
  assert.throws(() => configureMailConnector(current, { enabled: true, folders: Array.from({ length: 31 }, (_, index) => 'f' + index) }), /文件夹名称无效/);
});

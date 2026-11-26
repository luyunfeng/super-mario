import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '../packages/plugin-sdk/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { MAIL_SEND_APPROVAL } from '../packages/core/src/mail-outbox.ts';
import { LOCAL_BUDGET, LOCAL_BATCH } from '../packages/core/src/mail-search.ts';
import { fakeMailServer, type FakeMessage } from './mail-fixture.ts';

const seen = String.fromCharCode(92) + 'Seen';
const encoded = (value: string) => '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
const signal = () => new AbortController().signal;
/** A message with one file attached, as it comes over the wire. */
const reportMail: Partial<FakeMessage> = {
  bodyStructure: { childNodes: [{ disposition: 'attachment', dispositionParameters: { filename: 'report.pdf' } }] },
  raw: Buffer.from([
    'From: finance@example.invalid', 'To: someone@qq.com', 'Subject: ' + encoded('十月的报表'),
    'Message-ID: <m1@example.invalid>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="x"', '',
    '--x', 'Content-Type: text/plain; charset=UTF-8', '', 'the report is attached.',
    '--x', 'Content-Type: application/pdf; name="report.pdf"', 'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="report.pdf"', '', Buffer.from('a report').toString('base64'), '--x--', '',
  ].join('\r\n')),
};
/** A reply as it comes over the wire, with the headers that tie it to what it answers. */
const replyMail = [
  'From: Li Si <lisi@example.invalid>', 'To: someone@qq.com', 'Subject: ' + encoded('评审意见'),
  'Message-ID: <reply-7@example.invalid>', 'In-Reply-To: <mine@example.invalid>',
  'References: <first@example.invalid> <mine@example.invalid>',
  'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', '请看附件里的意见。', '',
].join('\r\n');

function message(uid: number, subject: string, from = 'zhangsan@example.invalid', extra: Partial<FakeMessage> = {}): FakeMessage {
  return { uid, envelope: { subject, from: [{ name: '', address: from }], to: [{ address: 'someone@qq.com' }], messageId: '<m' + uid + '@example.invalid>' },
    flags: new Set<string>(uid === 1 ? [seen] : []), internalDate: new Date(Date.UTC(2026, 10, 20 + uid)).toISOString(), ...extra };
}

/** A workbench with two mailboxes. Both go to stand-in mail servers. */
async function start(t: { after(fn: () => void): void }, options: { search?: 'finds' | 'none' | 'refused'; secondFails?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mail-tools-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-mail' });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const work = fakeMailServer({ folders: [{ path: 'INBOX', messages: [
    message(1, '十月的报表', 'finance@example.invalid', reportMail),
    message(2, '请审阅合同'),
  ] }], search: options.search ?? 'finds' });
  const home = fakeMailServer({ folders: [{ path: 'INBOX', messages: [message(1, '家里的信', 'mom@example.invalid')] }], search: options.search ?? 'finds' });
  const first = await server.app.mailAccounts.add({ email: 'someone@qq.com', password: 'code-one', name: '工作邮箱',
    imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' });
  const second = await server.app.mailAccounts.add({ email: 'other@163.com', password: 'code-two', name: '个人的',
    imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' });
  server.app.setMailOpen(async options2 => {
    const user = String((options2.auth as { user?: string } | undefined)?.user ?? '');
    if (options.secondFails && user === second.username) throw new Error('read ECONNRESET for other@163.com');
    return user === first.username ? work.client : home.client;
  });
  const find = (name: string): Tool => {
    const tool = server.app.contributions.list('tools').find(item => item.value.name === name)?.value;
    assert.ok(tool, 'the tool ' + name + ' is registered');
    return tool;
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = find(name);
    try { return { ok: true as const, text: String(await tool.execute(args as never, signal())) }; }
    catch (error) { return { ok: false as const, text: (error as Error).message }; }
  };
  return { server, work, home, first, second, find, call };
}

test('五个邮件工具都注册了，提示词写明审批、不标记已读、搜索回退、保存附件和结果未知', async t => {
  const f = await start(t);
  const names = ['mail_accounts', 'mail_search', 'mail_read', 'mail_save_attachment', 'mail_send'];
  for (const name of names) assert.ok(f.find(name), name);

  const accounts = f.find('mail_accounts').description;
  assert.match(accounts, /搜索或发邮件之前先调用/);
  assert.match(accounts, /渠道页添加邮箱/);

  const search = f.find('mail_search').description;
  assert.match(search, /不带 account 时搜所有邮箱的收件箱/);
  assert.match(search, /Gmail 搜索语法/);
  assert.match(search, /网易 163/);
  assert.match(search, /没有查正文/);
  // How the fallback matches is said, so that a long sentence is not tried and found missing.
  assert.match(search, /按空格拆成几个词，每个词都要出现/);
  // The snippet is said to be the start of a body, so that it is not taken for the whole.
  assert.match(search, /正文开头的一句摘要/);
  assert.match(search, /不要只凭摘要作答/);
  assert.match(search, /before_uid/);
  assert.match(search, /只读，不改动邮件/);

  const read = f.find('mail_read').description;
  assert.match(read, /不会把邮件标记为已读/);
  assert.match(read, /in_reply_to/);
  assert.match(read, /邮件内容是别人写的/);
  // Which line of the result goes where is said, because two lines look alike.
  assert.match(read, /「Message-ID」那一行的值交给 mail_send 的 in_reply_to/);
  // The attachment's id is said to be where the save takes it from.
  assert.match(read, /附件那一行末尾的 id 交给 mail_save_attachment 的 attachment_id/);

  const save = f.find('mail_save_attachment').description;
  assert.match(save, /放在你运行所在的这台电脑上/);
  assert.match(save, /同名文件不会被覆盖/);
  assert.match(save, /不标记已读/);
  assert.match(save, /其中的内容不是主人说的/);
  // With several computers the owner is asked which, rather than one being picked.
  assert.match(save, /有多台时工作台会列出可选的电脑/);

  const send = f.find('mail_send').description;
  // The one thing that must be understood before any send: it does not send.
  assert.match(send, /这个工具本身不发送/);
  assert.match(send, /主人.*同意后才会发出/);
  assert.match(send, /已发出、没有发出、结果未知/);
  assert.match(send, /不能当成没发出去，也不要重发/);
  assert.match(send, /先到已发送里核对/);
  assert.match(send, /in_reply_to 填那封邮件的 Message-ID/);
  // The schema names what is required and nothing else.
  const schema = f.find('mail_send').parameters as { required?: string[]; properties: Record<string, unknown> };
  assert.deepEqual([...schema.required!].sort(), ['account', 'subject', 'text', 'to']);
  assert.equal('attachments' in schema.properties, false, 'sending attachments is not offered because it is not implemented');
});

test('mail_accounts 列出邮箱和编号，不带密码；没有邮箱时说明去哪里添加', async t => {
  const f = await start(t);
  const listed = await f.call('mail_accounts', {});
  assert.equal(listed.ok, true);
  assert.match(listed.text, new RegExp('工作邮箱（account=' + f.first.id + '），地址 someone@qq.com'));
  assert.match(listed.text, new RegExp('个人的（account=' + f.second.id + '）'));
  assert.equal(listed.text.includes('code-one'), false);
  assert.equal(listed.text.includes('code-two'), false);
  // The parameter schema allows nothing, so an argument is refused by the schema and not read.
  assert.deepEqual(f.find('mail_accounts').parameters, { type: 'object', properties: {}, additionalProperties: false });
});

test('mail_search 搜一个邮箱：结果带着下一步要用的编号，最新的在前，一页满了说从哪里继续', async t => {
  const f = await start(t);
  const found = await f.call('mail_search', { account: f.first.id, query: '报表' });
  assert.equal(found.ok, true, found.text);
  assert.match(found.text, /uid=1 account=\S+ mailbox=INBOX date=2026-11-21/);
  assert.match(found.text, /from=finance@example.invalid/);
  assert.match(found.text, /subject="十月的报表"/);
  // The start of the body comes with it, so that a question can often be answered from here.
  assert.match(found.text, /the report is attached\./);
  assert.doesNotMatch(found.text, /code-one|code-two/);
  assert.doesNotMatch(found.text, /没有查邮件正文/, 'the server searched');
  // Listing without a word is newest first.
  const all = await f.call('mail_search', { account: f.first.id });
  const uids = [...all.text.matchAll(/uid=(\d+)/g)].map(match => Number(match[1]));
  assert.deepEqual(uids, [2, 1]);
  // One at a time says where to continue, and the next page does.
  const page = await f.call('mail_search', { account: f.first.id, limit: 1 });
  // The page shows uid 2. The next one takes what is below that, which is uid 1.
  assert.match(page.text, /^- uid=2 /m);
  assert.match(page.text, /还有更多。传 before_uid=2 继续往前翻/);
  const rest = await f.call('mail_search', { account: f.first.id, limit: 1, before_uid: 2 });
  assert.deepEqual([...rest.text.matchAll(/uid=(\d+)/g)].map(match => Number(match[1])), [1]);
  // A search where nothing matches says so, without suggesting there is more.
  const none = await f.call('mail_search', { account: f.first.id, query: '不存在' });
  assert.match(none.text, /没有找到匹配的邮件/);
});

test('mail_search 不带邮箱搜所有收件箱，按时间合并；一个邮箱读不到时说出来，不把结果当成全部', async t => {
  const good = await start(t);
  const both = await good.call('mail_search', { query: '信' });
  assert.equal(both.ok, true, both.text);
  // The one from home is dated later than the one from work, so it comes first.
  assert.match(both.text, /uid=1 account=\S+ mailbox=INBOX date=2026-11-21T00:00:00\.000Z from=mom@example.invalid subject="家里的信"/);
  assert.ok(both.text.indexOf('家里的信') < both.text.indexOf('十月的报表') || !both.text.includes('十月的报表'));
  assert.doesNotMatch(both.text, /没有读到/);
  // One of the two servers found nothing for the word and its headers were matched here, so
  // the answer says the bodies were not looked into. It says so once, for the whole page.
  assert.match(both.text, /没有查邮件正文/);

  const broken = await start(t, { secondFails: true });
  const partial = await broken.call('mail_search', { query: '报表' });
  assert.equal(partial.ok, true, partial.text);
  assert.match(partial.text, /subject="十月的报表"/);
  assert.match(partial.text, /邮箱「个人的」没有读到/);
  assert.match(partial.text, /这里的结果不含它的邮件/);
  assert.equal(partial.text.includes('ECONNRESET'), false, 'the words of the mail server are not passed on');
  // Reading one message through a mailbox that cannot be reached says so too.
  const read = await broken.call('mail_read', { account: broken.second.id, uid: 1 });
  assert.equal(read.ok, false);
  assert.equal(read.text.includes('ECONNRESET'), false);
});

test('服务器搜不到时回退，并说明只匹配了邮件头、没有查正文', async t => {
  const f = await start(t, { search: 'none' });
  const found = await f.call('mail_search', { account: f.first.id, query: '报表' });
  assert.equal(found.ok, true, found.text);
  assert.match(found.text, /subject="十月的报表"/);
  assert.match(found.text, /邮件服务器对这个词搜不到结果/);
  assert.match(found.text, /没有查邮件正文/);
  assert.match(found.text, /只在正文里，这里找不到/);
  // A word that is in a sender's address is found; one that is nowhere is not, and the note
  // still says why.
  const byName = await f.call('mail_search', { account: f.first.id, query: 'ZHANGSAN' });
  assert.match(byName.text, /uid=2 /);
  const nothing = await f.call('mail_search', { account: f.first.id, query: '不存在' });
  assert.match(nothing.text, /没有找到匹配的邮件/);
  assert.match(nothing.text, /没有查邮件正文/);
  // When the local search runs out of its budget the answer says where to continue.
  assert.equal(LOCAL_BATCH, 100);
  assert.equal(LOCAL_BUDGET, 2000);
});

test('mail_read 读出正文，带上回复要用的话题标识；不标记已读', async t => {
  const f = await start(t);
  const reply: FakeMessage = { uid: 7, internalDate: '2026-11-25T09:00:00.000Z', flags: new Set<string>(), raw: Buffer.from(replyMail) };
  const server = fakeMailServer({ folders: [{ path: 'INBOX', messages: [reply] }] });
  f.server.app.setMailOpen(async () => server.client);
  const read = await f.call('mail_read', { account: f.first.id, uid: 7 });
  assert.equal(read.ok, true, read.text);
  assert.match(read.text, /发件人：Li Si <lisi@example.invalid>/);
  assert.match(read.text, /收件人：someone@qq.com/);
  assert.match(read.text, /主题：评审意见/);
  assert.match(read.text, /Message-ID：reply-7@example.invalid/);
  assert.match(read.text, /回复的是：mine@example.invalid/);
  assert.match(read.text, /所属话题：first@example.invalid mine@example.invalid/);
  assert.match(read.text, /请看附件里的意见。/);
  // Reading left the flags alone: the folder was opened read-only and nothing was stored.
  assert.deepEqual(server.opened, [{ path: 'INBOX', readOnly: true }]);
  assert.deepEqual(server.appended, []);
  // A message that is not in the folder says so, and does not make one up.
  const gone = await f.call('mail_read', { account: f.first.id, uid: 8 });
  assert.equal(gone.ok, false);
  assert.match(gone.text, /不在了/);
});

test('mail_read 列出附件的名称、类型和大小', async t => {
  const f = await start(t);
  // The first message of the work mailbox carries one attachment.
  const withFile = await f.call('mail_read', { account: f.first.id, uid: 1 });
  assert.equal(withFile.ok, true, withFile.text);
  assert.match(withFile.text, /^附件：$/m);
  assert.match(withFile.text, /^- report.pdf（application\/pdf，\d+ 字节）id=[A-Za-z0-9_-]{22}$/m);
  assert.match(withFile.text, /十月的报表/);
});

test('mail_send 只提交审批：回复说还没发出，审批上是要发的全文；参数逐项核对', async t => {
  const f = await start(t);
  const asked = await f.call('mail_send', { account: f.first.id, to: [{ name: '李四', email: 'lisi@example.invalid' }],
    subject: '周四的评审', text: '请确认周四的评审。', in_reply_to: 'mine@example.invalid', references: 'first@example.invalid mine@example.invalid' });
  assert.equal(asked.ok, true, asked.text);
  assert.match(asked.text, /等主人同意后才会发出/);
  assert.match(asked.text, /没有发出，不要告诉主人已经发送/);
  assert.match(asked.text, /审批编号/);
  const approvals = f.server.app.approvals.list();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.kind, MAIL_SEND_APPROVAL);
  assert.equal(approvals[0]!.status, 'pending');
  assert.match(approvals[0]!.details, /收件人：李四 <lisi@example.invalid>/);
  assert.match(approvals[0]!.details, /请确认周四的评审。/);
  // The reply goes back in the thread it answers.
  assert.equal((approvals[0]!.params as { inReplyTo?: string }).inReplyTo, 'mine@example.invalid');
  assert.deepEqual((approvals[0]!.params as { references?: string[] }).references, ['first@example.invalid', 'mine@example.invalid']);
  assert.equal(JSON.stringify(approvals[0]).includes('code-one'), false);

  // Anything that is not part of a send is refused, and no approval is made.
  const refused = [
    [{ account: f.first.id, to: [], subject: 's', text: 't' }, /发给谁/],
    [{ account: f.first.id, to: [{ email: 'not an address' }], subject: 's', text: 't' }, /地址无效/],
    [{ account: f.first.id, to: [{ email: 'a@example.invalid', replyTo: 'x@example.invalid' }], subject: 's', text: 't' }, /参数无效/],
    [{ account: f.first.id, to: [{ email: 'a@example.invalid' }], subject: 's', text: 't', extra: 1 }, /extra/],
    [{ account: 'no-such-account', to: [{ email: 'a@example.invalid' }], subject: 's', text: 't' }, /不存在/],
    [{ account: f.first.id, to: [{ email: 'a@example.invalid' }], subject: 's', text: 't', attachments: [{ filename: 'x' }] }, /attachments/],
  ] as const;
  for (const [args, match] of refused) {
    const result = await f.call('mail_send', args as Record<string, unknown>);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.match(result.text, match);
  }
  assert.equal(f.server.app.approvals.list().length, 1, 'a refused request makes no approval');
});

test('参数不合规时拒绝，邮箱编号属于别的范围时也拒绝', async t => {
  const f = await start(t);
  const refused = [
    ['mail_search', { account: 'no-such', query: 'x' }, /不存在/],
    ['mail_search', { query: '   ' }, /搜索词不能为空/],
    ['mail_search', { account: f.first.id, limit: 0 }, /1 至 200/],
    ['mail_search', { account: f.first.id, limit: 201 }, /1 至 200/],
    ['mail_search', { account: f.first.id, before_uid: 0 }, /正整数/],
    ['mail_search', { account: f.first.id, mailbox: 'a\nb' }, /文件夹名称无效/],
    ['mail_search', { account: f.first.id, extra: 1 }, /参数无效/],
    ['mail_read', { account: f.first.id }, /正整数/],
    ['mail_read', { account: f.first.id, uid: 1.5 }, /正整数/],
    ['mail_read', { uid: 1 }, /不存在|须为/],
    ['mail_read', { account: f.first.id, uid: 1, extra: 1 }, /参数无效/],
    ['mail_save_attachment', { account: f.first.id, uid: 1 }, /attachment_id/],
    ['mail_save_attachment', { account: f.first.id, uid: 1, attachment_id: '../x' }, /attachment_id 无效/],
    ['mail_save_attachment', { account: f.first.id, uid: 1, attachment_id: 'a'.repeat(22), dir: '../out' }, /相对子目录/],
    ['mail_save_attachment', { account: f.first.id, uid: 1, attachment_id: 'a'.repeat(22), dir: '/abs' }, /相对子目录/],
    ['mail_save_attachment', { account: f.first.id, uid: 1, attachment_id: 'a'.repeat(22), dir: '.hidden' }, /相对子目录/],
    ['mail_save_attachment', { account: f.first.id, uid: 1, attachment_id: 'a'.repeat(22), extra: 1 }, /参数无效/],
    ['mail_save_attachment', { account: 'no-such', uid: 1, attachment_id: 'a'.repeat(22) }, /不存在|须为/],
  ] as const;
  for (const [name, args, match] of refused) {
    const result = await f.call(name, args as Record<string, unknown>);
    assert.equal(result.ok, false, name + ' ' + JSON.stringify(args));
    assert.match(result.text, match);
  }
  // Both spellings of the account name are taken, as the reference's tools use the other one.
  const snake = await f.call('mail_search', { account_id: f.first.id, query: '报表' });
  assert.equal(snake.ok, true, snake.text);
});

test('mail_save_attachment 读出附件行上的 id；没有能保存的电脑时如实说明', async t => {
  const f = await start(t);
  // The id is on the attachment's line of a read, so that the next call can be made from it.
  const read = await f.call('mail_read', { account: f.first.id, uid: 1 });
  assert.equal(read.ok, true, read.text);
  assert.match(read.text, /^- report\.pdf（application\/pdf，\d+ 字节）id=[A-Za-z0-9_-]{22}$/m);
  const attachmentId = /id=([A-Za-z0-9_-]{22})/m.exec(read.text)![1]!;
  // There is no machine here, so nothing is saved and the tool says why.
  const saved = await f.call('mail_save_attachment', { account: f.first.id, uid: 1, attachment_id: attachmentId, dir: 'bills/2026-11' });
  assert.equal(saved.ok, false);
  assert.match(saved.text, /没有能保存邮件附件的电脑/);
  // Reading and the refused save both left the mailbox read-only.
  assert.ok(f.work.opened.every(opened => opened.readOnly));
  assert.deepEqual(f.work.appended, []);
});

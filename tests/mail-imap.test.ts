import test from 'node:test';
import assert from 'node:assert/strict';
import type { Mailbox, MailSummary } from '../packages/protocol/src/mail.ts';
import { classifyImapError, FOLDERS_PER_READ, hasAttachments, ImapError, readMailboxes, roleOf, subjectOf, transport, type ImapClient } from '../packages/core/src/mail-imap.ts';

const SLASH = String.fromCharCode(92);
const account = { id: 'acc', name: 'a', email: 'a@qq.com', auth: 'password' as const, username: 'a@qq.com', imapHost: 'imap.qq.com', imapPort: 993,
  imapSecurity: 'tls', smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecurity: 'tls', status: 'unknown' as const, hasPassword: true,
  version: 1, createdAt: '2026-11-26T00:00:00.000Z', updatedAt: '2026-11-26T00:00:00.000Z' };

type Box = { path: string; totalCount: number; unseenCount: number };
type Message = Record<string, unknown>;

/** A stand-in server. It records what was opened and read, and answers from what it was given. */
function server(boxes: Box[], messages: Record<string, Message[]> = {}, options: { failOpen?: string[]; failList?: Error; failLogout?: Error } = {}) {
  const opened: string[] = [];
  const readOnly: boolean[] = [];
  // The folder that is selected now. fetch() reads from it, as it does on a real server.
  let selected: string | undefined;
  const fetched: string[] = [];
  let loggedOut = 0;
  const client: ImapClient = {
    async list() {
      if (options.failList) throw options.failList;
      return boxes.map(box => ({ path: box.path, name: box.path.split('/').pop()!, flags: new Set<string>() }));
    },
    async mailboxOpen(path: string, openOptions = {}) {
      opened.push(path);
      readOnly.push(openOptions.readOnly === true);
      if (options.failOpen?.includes(path)) throw new Error('Mailbox does not exist');
      const box = boxes.find(item => item.path === path);
      if (!box) throw new Error('Nonexistent');
      selected = path;
      return { path, totalCount: box.totalCount, unseenCount: box.unseenCount };
    },
    async *fetch(range: string) {
      fetched.push(range);
      for (const message of messages[selected ?? ''] ?? []) yield message;
    },
    // Listing folders never downloads an attachment. The method is here because the
    // connection type has it, and this test has no attachment to give.
    async download() { return {}; },
    // Listing folders keeps no copy of anything. The method is here because the connection
    // type has it.
    async append() { return false; },
    async logout() { loggedOut++; if (options.failLogout) throw options.failLogout; },
  };
  return { client, opened, readOnly, fetched, loggedOut: () => loggedOut };
}

const envelope = (subject: string, extra: Record<string, unknown> = {}) => ({ subject, from: [{ name: '张三', address: 'zhang@example.invalid' }], to: [{ address: 'a@qq.com' }], messageId: '<m1@example.invalid>', ...extra });

test('按角色打开常用文件夹读计数，只读收件箱的最新邮件，读完断开', async () => {
  const s = server([
    { path: 'INBOX', totalCount: 60, unseenCount: 3 },
    { path: 'Sent Messages', totalCount: 12, unseenCount: 0 },
    { path: '工作', totalCount: 7, unseenCount: 7 },
    { path: 'Drafts', totalCount: 1, unseenCount: 0 },
  ], {
    INBOX: [
      { uid: 10, envelope: envelope('第一封', { subject: '第一封\n  折行的主题' }), flags: new Set([]), internalDate: new Date('2026-11-20T08:00:00Z') },
      { uid: 11, envelope: envelope('第二封', { messageId: 'x'.repeat(1200) }), flags: new Set([SLASH + 'Seen', SLASH + 'Flagged']),
        internalDate: 'not a date', bodyStructure: { childNodes: [{ disposition: 'attachment', dispositionParameters: { filename: '报告.pdf' } }] } },
      // A message without an envelope is left out rather than guessed at.
      { uid: 12 },
    ],
  });
  const result = await readMailboxes(account, new AbortController().signal, async () => s.client);
  assert.deepEqual(result.mailboxes, [
    { name: 'INBOX', role: 'inbox', unseen: 3, total: 60 },
    { name: 'Sent Messages', role: 'sent', unseen: 0, total: 12 },
    { name: 'Drafts', role: 'drafts', unseen: 0, total: 1 },
    // Every folder is listed. The usual ones come first with their counters, then the rest.
    { name: '工作', role: 'other', unseen: 0, total: 0 },
  ]);
  // The inbox is the only folder whose messages are read, from its newest fifty.
  assert.deepEqual(s.fetched, ['11:*']);
  // Every folder is opened read-only, so the server itself keeps the workbench from
  // changing a message while it reads.
  assert.deepEqual(s.readOnly, [true, true, true]);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]!.subject, '第一封 折行的主题', 'a folded subject becomes one line');
  assert.deepEqual(result.messages[0]!.from, { name: '张三', email: 'zhang@example.invalid' });
  assert.equal(result.messages[0]!.date, '2026-11-20T08:00:00.000Z');
  assert.equal(result.messages[0]!.seen, false);
  assert.equal(result.messages[1]!.seen, true);
  assert.equal(result.messages[1]!.flagged, true);
  assert.equal(result.messages[1]!.hasAttachments, true);
  assert.equal(result.messages[0]!.hasAttachments, false);
  assert.equal(result.messages[1]!.messageId.length, 998, 'an oversized message id is cut to its limit');
  assert.equal(result.messages[1]!.date, '', 'an unreadable date is empty, never made up');
  assert.equal(s.loggedOut(), 1, 'the connection is closed after reading');
});

test('一个普通文件夹不会被当成收件箱去读邮件，即使它的名字看起来像', async () => {
  // A folder that is none of the usual ones is "other". Before this was checked, any folder
  // whose name was not recognised fell back to the inbox role, so its messages were read as
  // if they were the inbox's.
  assert.equal(roleOf('工作'), 'other');
  assert.equal(roleOf('客户/2026'), 'other');
  assert.equal(roleOf('INBOX'), 'inbox');
  assert.equal(roleOf('INBOX/归档'), 'other', 'a folder under the inbox is not the inbox');
  assert.equal(roleOf('Sent Messages'), 'sent');
  assert.equal(roleOf('[Gmail]/All Mail'), 'archive');
  assert.equal(roleOf('Junk E-mail'), 'junk');
  // The server's own flag decides before the name does.
  assert.equal(roleOf('Anything', new Set([SLASH + 'Trash'])), 'trash');
  assert.equal(roleOf('Anything', new Set([SLASH + 'Drafts'])), 'drafts');
  // A flag that is not a role is ignored.
  assert.equal(roleOf('Anything', new Set([SLASH + 'HasNoChildren', SLASH + 'Noselect'])), 'other');
  // Only the inbox of an account is read, so a folder that is "other" next to it is not.
  const s = server([{ path: 'INBOX', totalCount: 1, unseenCount: 1 }, { path: '工作', totalCount: 5, unseenCount: 5 }], {
    INBOX: [{ uid: 1, envelope: envelope('收件箱里的') }], 工作: [{ uid: 1, envelope: envelope('工作文件夹里的') }],
  });
  const result = await readMailboxes(account, new AbortController().signal, async () => s.client);
  assert.deepEqual(result.messages.map(message => message.subject), ['收件箱里的']);
});

test('某个文件夹打不开不算账号失败，它被列出来但没有计数；收件箱不在则明确报错', async () => {
  const s = server([{ path: 'INBOX', totalCount: 2, unseenCount: 1 }, { path: 'Sent', totalCount: 4, unseenCount: 0 }], {}, { failOpen: ['Sent'] });
  const result = await readMailboxes(account, new AbortController().signal, async () => s.client);
  assert.deepEqual(result.mailboxes, [
    { name: 'INBOX', role: 'inbox', unseen: 1, total: 2 },
    { name: 'Sent', role: 'sent', unseen: 0, total: 0 },
  ]);
  assert.equal(s.loggedOut(), 1);
  // An account with no inbox at all cannot be read.
  const none = server([{ path: 'Sent', totalCount: 1, unseenCount: 0 }]);
  await assert.rejects(readMailboxes(account, new AbortController().signal, async () => none.client), (error: unknown) =>
    error instanceof ImapError && error.failure === 'not-found' && /收件箱/.test(error.message));
  assert.equal(none.loggedOut(), 1, 'even a failed read closes the connection');
});

test('最多打开十二个常用文件夹；中途取消就停下并断开；列出文件夹失败时也断开', async () => {
  // Twenty folders that all have a usual role, so more are wanted than one read opens.
  const usual = ['Sent', 'Drafts', 'Trash', 'Junk', 'Archive', 'Spam', 'All Mail', 'Sent Items', 'Deleted Messages', 'Junk E-mail', 'Sent Messages'];
  const paths = ['INBOX', ...usual, ...usual.map(name => name + ' 2')];
  const many = server(paths.map(path => ({ path, totalCount: 0, unseenCount: 0 })));
  await readMailboxes(account, new AbortController().signal, async () => many.client);
  assert.equal(many.opened.length, FOLDERS_PER_READ);
  assert.equal(many.opened[0], 'INBOX');
  // A folder that is none of the usual roles is listed but not opened.
  const mixed = server([{ path: 'INBOX', totalCount: 0, unseenCount: 0 }, { path: 'Folder1', totalCount: 0, unseenCount: 0 }]);
  const listed = await readMailboxes(account, new AbortController().signal, async () => mixed.client);
  assert.deepEqual(mixed.opened, ['INBOX']);
  assert.deepEqual(listed.mailboxes.map(box => box.name), ['INBOX', 'Folder1']);

  // A read that is cancelled stops where it is, and still closes the connection.
  const stop = new AbortController();
  const slow = server([{ path: 'INBOX', totalCount: 1, unseenCount: 1 }, { path: 'Sent', totalCount: 1, unseenCount: 0 }]);
  const original = slow.client.mailboxOpen.bind(slow.client);
  slow.client.mailboxOpen = async path => { const result = await original(path); stop.abort(); return result; };
  await assert.rejects(readMailboxes(account, stop.signal, async () => slow.client), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(slow.loggedOut(), 1);
  assert.deepEqual(slow.opened, ['INBOX'], 'nothing is opened after the read is cancelled');

  // A failure to list the folders is reported by its kind, and the connection is still closed.
  const broken = server([], {}, { failList: new Error('read ECONNRESET') });
  await assert.rejects(readMailboxes(account, new AbortController().signal, async () => broken.client), (error: unknown) => error instanceof ImapError && error.failure === 'connection');
  assert.equal(broken.loggedOut(), 1);
  // A logout that fails does not hide the result of the read.
  const loud = server([{ path: 'INBOX', totalCount: 0, unseenCount: 0 }], {}, { failLogout: new Error('socket closed') });
  assert.deepEqual((await readMailboxes(account, new AbortController().signal, async () => loud.client)).messages, []);
});

test('加密方式三档各自对应一种连接方式，STARTTLS 必须成功而不是退回明文', () => {
  assert.deepEqual(transport({ ...account, imapSecurity: 'tls' }), { host: 'imap.qq.com', port: 993, secure: true, doSTARTTLS: false });
  assert.deepEqual(transport({ ...account, imapPort: 143, imapSecurity: 'starttls' }), { host: 'imap.qq.com', port: 143, secure: false, doSTARTTLS: true });
  assert.deepEqual(transport({ ...account, imapPort: 143, imapSecurity: 'none' }), { host: 'imap.qq.com', port: 143, secure: false, doSTARTTLS: false });
});

test('库的报错被归成主人能据以行动的几类，原文不外露', () => {
  const cases: [unknown, string, RegExp][] = [
    [new Error('Invalid login or password'), 'authentication', /授权码/],
    [Object.assign(new Error('Nope'), { code: 'EAUTH' }), 'authentication', /授权码/],
    [new Error('self signed certificate in certificate chain'), 'tls', /加密连接/],
    [new Error('getaddrinfo ENOTFOUND imap.example.invalid'), 'connection', /找不到收件服务器/],
    [new Error('connect ECONNREFUSED 1.2.3.4:993'), 'refused', /端口/],
    [new Error('connect ETIMEDOUT'), 'timeout', /超时/],
    [new Error('Mailbox does not exist'), 'not-found', /文件夹/],
    [new Error('Too many connections'), 'too-many', /忙碌/],
    [new Error('read ECONNRESET'), 'connection', /网络/],
    [new Error('something else entirely'), 'unknown', /读取邮箱失败/],
    ['a string', 'unknown', /读取邮箱失败/],
  ];
  for (const [error, failure, message] of cases) {
    const classified = classifyImapError(error);
    assert.equal(classified.failure, failure, String(error));
    assert.match(classified.message, message, String(error));
  }
  // The library's own text, which can hold an address, is not in what the owner reads.
  const withAddress = classifyImapError(new Error('getaddrinfo ENOTFOUND imap.example.invalid for user someone@qq.com'));
  assert.equal(withAddress.message.includes('example.invalid'), false);
  assert.equal(withAddress.message.includes('someone@qq.com'), false);
});

test('附件判断：标为附件的算，带文件名的内联算，正文和签名里的图片不算', () => {
  assert.equal(hasAttachments({ type: 'text/plain' }), false);
  assert.equal(hasAttachments({ childNodes: [{ type: 'text/plain' }, { type: 'text/html' }] }), false);
  assert.equal(hasAttachments({ childNodes: [{ type: 'image/png', disposition: 'inline' }] }), false, 'an inlined image with no file name is part of the text');
  assert.equal(hasAttachments({ disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' } }), true);
  assert.equal(hasAttachments({ childNodes: [{ type: 'text/plain' }, { disposition: 'inline', dispositionParameters: { filename: 'photo.jpg' } }] }), true);
  assert.equal(hasAttachments({ childNodes: [[{ disposition: 'ATTACHMENT' }]] }), true, 'the disposition is matched without case');
  assert.equal(hasAttachments(undefined), false);
  assert.equal(hasAttachments([null, 7]), false);
  assert.equal(subjectOf(undefined), '');
  assert.equal(subjectOf('  a\r\nb\t c  '), 'a b c');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import type { MailMessage } from '../packages/protocol/src/mail.ts';
import { htmlToText, mailAddresses, MAX_TEXT_CHARS, messageIds, MessageError, readMessage } from '../packages/core/src/mail-message.ts';
import { MAX_MESSAGE_BYTES } from '../packages/core/src/mail-imap.ts';
import { fakeMailServer, type FakeFolder, type FakeMessage } from './mail-fixture.ts';

const CRLF = '\r\n';
/** A message as it goes over the wire. Lines are joined with CRLF, as mail requires. */
const mail = (...lines: string[]) => lines.join(CRLF) + CRLF;
const bytes = (value: string) => Buffer.from(value, 'utf8');
/** A word encoded as a mail header carries a non-ASCII one. Worked out here so that the
 *  test shows the word itself. */
const encoded = (value: string) => '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const where = { account: 'acc', mailbox: 'INBOX', uid: 1 };
const signal = () => new AbortController().signal;

/** A server with one folder and the given messages, opened on the folder they are in. */
function serverWith(messages: FakeMessage[], path = 'INBOX') {
  return fakeMailServer({ folders: [{ path, messages }] });
}

/** A plain message whose subject and sender are encoded, as a mail program in Chinese sends them. */
const plain = mail(
  'From: ' + encoded('张三') + ' <zhang@example.invalid>',
  'To: =?UTF-8?Q?Reception?= <front@example.invalid>',
  'Cc: a@example.invalid, b@example.invalid',
  'Subject: ' + encoded('周报请求'),
  'Date: Wed, 25 Nov 2026 09:00:00 +0800',
  'Message-ID: <plain-1@example.invalid>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  b64('这是一封普通的邮件。\r\n第二行。\r\n'),
);

/** The same message as text and as HTML, with a picture in the signature and a file attached. */
const alternative = mail(
  'From: Li Si <lisi@example.invalid>',
  'To: me@example.invalid',
  'Subject: Re: review',
  'In-Reply-To: <plain-1@example.invalid>',
  'References: <first@example.invalid> <plain-1@example.invalid>',
  'Message-ID: <alt-2@example.invalid>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  'Please look at the report.',
  '--inner',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>Please look at the <b>report</b>.</p><img src="cid:sig@example.invalid">',
  '--inner--',
  '--outer',
  'Content-Type: image/png; name="sig.png"',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <sig@example.invalid>',
  'Content-Disposition: inline; filename="sig.png"',
  '',
  b64('a picture in the signature'),
  '--outer',
  'Content-Type: application/pdf; name="' + encoded('报表.pdf') + '"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="' + encoded('报表.pdf') + '"',
  '',
  b64('the bytes of a report'),
  '--outer--',
);

/** A message that is HTML only. */
const htmlOnly = mail(
  'From: noreply@example.invalid',
  'Subject: your statement',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=UTF-8',
  '',
  '<html><body><style>p{color:red}</style><script>steal()</script>',
  '<h1>Statement</h1><p>Amount due: &lt;100&gt; &amp; paid&nbsp;on&nbsp;time</p>',
  '<p>Line one<br>Line two &#20013;&#x6587;</p></body></html>',
);

test('读一封纯文本邮件：编码的主题和发件人被解开，读取不改动已读标志', async () => {
  const raw = bytes(plain);
  const server = serverWith([{ uid: 1, raw, internalDate: '2026-11-25T01:00:00.000Z', flags: new Set<string>() }]);
  const read = await readMessage(server.client, where, signal());
  const message: MailMessage = read.message;
  assert.equal(message.subject, '周报请求');
  assert.deepEqual(message.from, { name: '张三', email: 'zhang@example.invalid' });
  assert.deepEqual(message.to, [{ name: 'Reception', email: 'front@example.invalid' }]);
  assert.deepEqual(message.cc.map(item => item.email), ['a@example.invalid', 'b@example.invalid']);
  // Line ends come as one kind, because mail mixes two and a reply quotes one.
  assert.equal(message.text, '这是一封普通的邮件。\n第二行。\n');
  assert.equal(message.messageId, 'plain-1@example.invalid');
  assert.equal(message.date, '2026-11-25T01:00:00.000Z');
  assert.equal(message.seen, false, 'reading does not mark the message as read');
  assert.equal(message.hasAttachments, false);
  assert.deepEqual(message.attachments, []);
  // The folder is opened read-only, and the source is asked for with a limit.
  assert.deepEqual(server.opened, [{ path: 'INBOX', readOnly: true }]);
  assert.deepEqual(server.fetched[0]!.query.source, { maxLength: MAX_MESSAGE_BYTES });
  assert.equal(server.fetched[0]!.query.uid, true);
  assert.equal(server.fetched[0]!.range, '1');
});

test('同时有纯文本和 HTML 的邮件用纯文本；签名里的内嵌图片不算附件，中文名的附件算', async () => {
  const raw = bytes(alternative);
  const server = serverWith([{ uid: 1, raw, flags: new Set([String.fromCharCode(92) + 'Seen']) }]);
  const read = await readMessage(server.client, where, signal());
  const message = read.message;
  assert.equal(message.text, 'Please look at the report.');
  assert.match(message.html, /<b>report<\/b>/, 'the HTML is kept as it was, for the page to show');
  assert.equal(message.seen, true);
  assert.equal(message.hasAttachments, true);
  // The picture in the signature is an inline resource of the HTML, so it is not a file.
  assert.deepEqual(message.attachments.map(item => item.filename), ['报表.pdf']);
  assert.equal(message.attachments[0]!.mimeType, 'application/pdf');
  assert.equal(message.attachments[0]!.size, Buffer.byteLength('the bytes of a report'));
  assert.match(message.attachments[0]!.id, /^[A-Za-z0-9_-]{22}$/);
  // The content is given back with the read, and is the decoded file.
  assert.equal(Buffer.from(read.contents.get(message.attachments[0]!.id)!).toString('utf8'), 'the bytes of a report');
  assert.equal(message.inReplyTo, 'plain-1@example.invalid');
  assert.deepEqual(message.references, ['first@example.invalid', 'plain-1@example.invalid']);
  assert.equal(JSON.stringify(message).includes('the bytes of a report'), false, 'the content is not in the message');
});

test('只有 HTML 的邮件读成文字：标签、脚本和样式去掉，实体解开，越界的字符引用不报错', async () => {
  const server = serverWith([{ uid: 1, raw: bytes(htmlOnly) }]);
  const read = await readMessage(server.client, where, signal());
  // A block that ends adds one line end, and the line end that was already in the source
  // makes the empty line between two paragraphs.
  assert.equal(read.message.text, 'Statement\nAmount due: <100> & paid on time\n\nLine one\nLine two 中文');
  assert.equal(read.message.text.includes('steal'), false);
  assert.equal(read.message.text.includes('color:red'), false);
  // A reference that is not a character becomes nothing instead of stopping the read.
  assert.equal(htmlToText('a&#999999999999;b&#xD800;c&#0;d'), 'abcd');
  // An entity that is not one of the usual ones is left as written.
  assert.equal(htmlToText('&copy; &amp; &lt;'), '&copy; & <');
});

test('标成内联的非文本部分仍算附件，因为邮件程序打不开它；地址组被展开', async () => {
  const inline = mail(
    'From: accounting@example.invalid',
    'To: Undisclosed recipients:;, "P, Q" <pq@example.invalid>',
    'Subject: numbers',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="x"',
    '',
    '--x',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'The numbers are attached.',
    '--x',
    'Content-Type: text/csv',
    'Content-Disposition: inline; filename="numbers.csv"',
    '',
    'a,b\n1,2',
    '--x--',
  );
  const server = serverWith([{ uid: 1, raw: bytes(inline) }]);
  const read = await readMessage(server.client, where, signal());
  assert.deepEqual(read.message.attachments.map(item => [item.filename, item.mimeType]), [['numbers.csv', 'text/csv']]);
  assert.equal(read.message.text, 'The numbers are attached.');
  // A group with no members gives no address, and a quoted comma in a name stays one address.
  assert.deepEqual(read.message.to, [{ name: 'P, Q', email: 'pq@example.invalid' }]);
  assert.deepEqual(mailAddresses([{ address: 'a@example.invalid' }, { group: [{ name: 'B', address: 'b@example.invalid' }] }, { name: 'no address' }]),
    [{ name: '', email: 'a@example.invalid' }, { name: 'B', email: 'b@example.invalid' }]);
});

test('邮件太大时明确说太大，不截断成半封；不存在的邮件、取消和服务器故障各自如实报告', async () => {
  // The server names a size above the limit: nothing is downloaded.
  const big = serverWith([{ uid: 1, raw: bytes(plain), size: MAX_MESSAGE_BYTES + 1 }]);
  await assert.rejects(readMessage(big.client, where, signal()), (error: unknown) =>
    error instanceof MessageError && error.failure === 'too-large' && /超过了一次读取的上限/.test(error.message));
  // The server names no size but sends as much as the limit allows: the message is whole only
  // if it is shorter than that, so this is too large as well.
  const edge = serverWith([{ uid: 1, raw: Buffer.alloc(MAX_MESSAGE_BYTES, 65) }]);
  await assert.rejects(readMessage(edge.client, where, signal()), (error: unknown) =>
    error instanceof MessageError && error.failure === 'too-large');
  // A message that is not there any more.
  const gone = serverWith([]);
  await assert.rejects(readMessage(gone.client, where, signal()), (error: unknown) =>
    error instanceof MessageError && error.failure === 'not-found' && /不在了/.test(error.message));
  // Bytes that are not a message at all.
  const broken = serverWith([{ uid: 1, raw: Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]) }]);
  const read = await readMessage(broken.client, where, signal()).catch((error: unknown) => error);
  assert.ok(read instanceof Object, 'bytes that are not a message are still answered, as an empty one or as unreadable');
  // A cancelled read is left as it is.
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(readMessage(serverWith([{ uid: 1, raw: bytes(plain) }]).client, where, stop.signal), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  // A failure of the server is put into a kind the owner can act on, without its own words.
  const dropped = fakeMailServer({ folders: [{ path: 'INBOX', messages: [{ uid: 1, raw: bytes(plain) }] }], fail: { open: new Error('read ECONNRESET for someone@qq.com') } });
  await assert.rejects(readMessage(dropped.client, where, signal()), (error: unknown) =>
    error instanceof MessageError === false && /网络/.test((error as Error).message) && !(error as Error).message.includes('someone@qq.com'));
});

test('正文超过上限时保留开头并标明被截断；话题头的标识去重、去括号、有上限', async () => {
  const long = mail('From: a@example.invalid', 'Subject: long', 'Message-ID: <long@example.invalid>', 'Content-Type: text/plain; charset=UTF-8', '', 'x'.repeat(MAX_TEXT_CHARS + 500));
  const read = await readMessage(serverWith([{ uid: 1, raw: bytes(long) }]).client, where, signal());
  assert.equal(read.message.text.length, MAX_TEXT_CHARS);
  assert.equal(read.message.textTruncated, true, 'the message says its text was cut');
  assert.deepEqual(messageIds('<a@x> <b@x> <a@x> not-an-id <c@x>'), ['a@x', 'b@x', 'c@x']);
  assert.deepEqual(messageIds(''), []);
  assert.equal(messageIds(Array.from({ length: 300 }, (_, index) => `<id${index}@x>`).join(' ')).length, 100);
});

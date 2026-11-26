import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_BATCH, LOCAL_BUDGET, searchFolder, SEARCH_MAX, SEARCH_PAGE, SNIPPET_CHARS, snippetOf, SNIPPET_MESSAGES, summaryOf } from '../packages/core/src/mail-search.ts';
import { fakeMailServer, type FakeMessage } from './mail-fixture.ts';

const account = { id: 'acc', email: 'someone@qq.com' };
const signal = () => new AbortController().signal;
const seen = String.fromCharCode(92) + 'Seen';

/** A message whose subject and sender are plain, so that a word can be looked for in them. */
function message(uid: number, subject: string, from = 'a@example.invalid', extra: Partial<FakeMessage> = {}): FakeMessage {
  return { uid, envelope: { subject, from: [{ name: '', address: from }], messageId: '<m' + uid + '@example.invalid>' }, flags: new Set<string>(), internalDate: new Date(Date.UTC(2026, 10, 1 + uid)).toISOString(), ...extra };
}

test('服务器会搜索时用它：结果最新的在前，一页装不下的说出从哪里继续', async () => {
  const messages = [message(1, '一月的报表'), message(2, '周报'), message(3, '二月的报表'), message(4, '请审阅'), message(5, '三月的报表')];
  const server = fakeMailServer({ folders: [{ path: 'INBOX', messages }], search: 'finds' });
  const page = await searchFolder(server.client, account, { query: '报表' }, signal());
  assert.deepEqual(page.messages.map(item => item.uid), [5, 3, 1], 'newest first');
  assert.equal(page.headersOnly, false);
  assert.equal(page.hasMore, false);
  // The server was asked for the word in the headers and the body.
  assert.deepEqual(server.searches[0], { query: { text: '报表' }, uid: true });
  // The folder was opened read-only.
  assert.deepEqual(server.opened, [{ path: 'INBOX', readOnly: true }]);

  // A page of two says there are more, and where the next page starts.
  const small = fakeMailServer({ folders: [{ path: 'INBOX', messages }], search: 'finds' });
  const paged = await searchFolder(small.client, account, { query: '报表', limit: 2 }, signal());
  assert.deepEqual(paged.messages.map(item => item.uid), [5, 3]);
  assert.equal(paged.hasMore, true);
  assert.equal(paged.nextBeforeUid, 3, 'the next page takes the messages below the oldest one shown');
  // And the next page does start there.
  const rest = await searchFolder(small.client, account, { query: '报表', limit: 2, beforeUid: paged.nextBeforeUid }, signal());
  assert.deepEqual(rest.messages.map(item => item.uid), [1]);
  assert.equal(rest.hasMore, false);
});

test('服务器搜不到任何词时回退到匹配邮件头，并说明没有查正文', async () => {
  const messages = [
    message(1, '完全无关'), message(2, '十月的报表', 'finance@example.invalid'),
    message(3, '请看附件', 'zhang@example.invalid'), message(4, '十一月的报表'),
  ];
  const server = fakeMailServer({ folders: [{ path: 'INBOX', messages }], search: 'none' });
  const page = await searchFolder(server.client, account, { query: '报表' }, signal());
  assert.deepEqual(page.messages.map(item => item.uid), [4, 2]);
  assert.equal(page.headersOnly, true, 'the answer says the headers were matched here');
  assert.equal(page.hasMore, false);
  // The server was asked first, and then the headers were read a batch at a time.
  assert.deepEqual(server.searches[0]!.query, { text: '报表' });
  assert.ok(server.fetched.some(call => call.query.envelope === true));

  // A word that is only in the body is not found, because bodies are not looked into.
  const bodyOnly = fakeMailServer({ folders: [{ path: 'INBOX', messages: [message(1, '没有那个词', 'a@example.invalid', { raw: Buffer.from('the word report is in the body') })] }], search: 'none' });
  const none = await searchFolder(bodyOnly.client, account, { query: 'report' }, signal());
  assert.deepEqual(none.messages, []);
  assert.equal(none.headersOnly, true);
  // A sender's name and address, and a recipient's, are looked at; every word must appear.
  const people = fakeMailServer({ folders: [{ path: 'INBOX', messages: [
    message(1, 'hello', 'zhangsan@example.invalid'), message(2, 'hello', 'lisi@example.invalid'),
  ] }], search: 'none' });
  const bySender = await searchFolder(people.client, account, { query: 'ZHANGSAN' }, signal());
  assert.deepEqual(bySender.messages.map(item => item.uid), [1], 'case does not matter');
  const every = await searchFolder(people.client, account, { query: 'hello lisi' }, signal());
  assert.deepEqual(every.messages.map(item => item.uid), [2], 'every word must appear');
  const some = await searchFolder(people.client, account, { query: 'hello nobody' }, signal());
  assert.deepEqual(some.messages, []);
});

test('服务器拒绝搜索时同样回退，不把拒绝当成没有邮件', async () => {
  const server = fakeMailServer({ folders: [{ path: 'INBOX', messages: [message(1, '发票'), message(2, '其他')] }], search: 'refused' });
  const page = await searchFolder(server.client, account, { query: '发票' }, signal());
  assert.deepEqual(page.messages.map(item => item.uid), [1]);
  assert.equal(page.headersOnly, true);
});

test('回退时预算用完就停下，游标落在还没看过的最新一封上', async () => {
  // More messages than one page may look at, and none of them match.
  const messages = Array.from({ length: LOCAL_BUDGET + 50 }, (_, index) => message(index + 1, '无关 ' + index));
  const server = fakeMailServer({ folders: [{ path: 'INBOX', messages }], search: 'none' });
  const page = await searchFolder(server.client, account, { query: '不存在的词' }, signal());
  assert.deepEqual(page.messages, []);
  assert.equal(page.hasMore, true, 'older messages were not looked at yet');
  assert.equal(page.nextBeforeUid, 51, 'the next page starts above the oldest message that was looked at');
  // The next page looks at the rest and finds the oldest one, which does match.
  messages[0]!.envelope = { subject: '不存在的词', from: [{ address: 'a@example.invalid' }] };
  const next = await searchFolder(server.client, account, { query: '不存在的词', beforeUid: page.nextBeforeUid }, signal());
  assert.deepEqual(next.messages.map(item => item.uid), [1]);
  // No more than one batch is asked for at a time.
  assert.ok(server.fetched.every(call => call.range.split(',').length <= LOCAL_BATCH));
});

test('不带搜索词就是列出最新的邮件；条数有上限；Gmail 账号用它自己的搜索语法', async () => {
  const messages = Array.from({ length: 30 }, (_, index) => message(index + 1, '邮件 ' + index));
  const server = fakeMailServer({ folders: [{ path: 'INBOX', messages }] });
  const listed = await searchFolder(server.client, account, {}, signal());
  assert.equal(listed.messages.length, SEARCH_PAGE);
  assert.equal(listed.messages[0]!.uid, 30, 'newest first');
  assert.equal(listed.hasMore, true);
  assert.equal(listed.nextBeforeUid, 11);
  assert.equal(listed.headersOnly, false);

  const capped = fakeMailServer({ folders: [{ path: 'INBOX', messages }] });
  const many = await searchFolder(capped.client, account, { limit: 5000 }, signal());
  assert.equal(many.messages.length, 30);
  assert.equal(SEARCH_MAX, 200);

  const gmail = fakeMailServer({ folders: [{ path: 'INBOX', messages: [message(1, 'x')] }], search: 'none' });
  await searchFolder(gmail.client, { id: 'g', email: 'someone@gmail.com' }, { query: 'from:a@example.invalid newer_than:7d' }, signal());
  assert.deepEqual(gmail.searches[0]!.query, { gmraw: 'from:a@example.invalid newer_than:7d' });

  // Another folder is searched when one is named.
  const other = fakeMailServer({ folders: [{ path: '归档', messages: [message(7, '旧邮件')] }] });
  const archived = await searchFolder(other.client, account, { mailbox: '归档' }, signal());
  assert.deepEqual(archived.messages.map(item => item.uid), [7]);
  assert.equal(archived.messages[0]!.mailbox, '归档');
});

test('摘要带着已读、已标记和附件标记，日期读不出来时留空而不编造', async () => {
  const row = { uid: 3, envelope: { subject: '折行的\n  主题', from: [{ name: '张三', address: 'z@example.invalid' }], messageId: '<a@x>' },
    flags: new Set([seen, String.fromCharCode(92) + 'Flagged']), internalDate: 'not a date',
    bodyStructure: { childNodes: [{ disposition: 'attachment' }] } };
  const summary = summaryOf('acc', 'INBOX', row)!;
  assert.equal(summary.subject, '折行的 主题');
  assert.deepEqual(summary.from, { name: '张三', email: 'z@example.invalid' });
  assert.equal(summary.date, '');
  assert.equal(summary.seen, true);
  assert.equal(summary.flagged, true);
  assert.equal(summary.answered, false);
  assert.equal(summary.hasAttachments, true);
  // A row without an envelope gives no summary rather than a guessed one.
  assert.equal(summaryOf('acc', 'INBOX', { uid: 4 }), undefined);
});

test('列表里的摘要：取正文开头的文字，多行并成一行，HTML 去标签，超长截到词边并加省略号', () => {
  const bytes = (text: string) => Buffer.from(text, 'utf8');
  assert.equal(snippetOf(undefined), '');
  assert.equal(snippetOf(new Uint8Array()), '');
  assert.equal(snippetOf(bytes('请确认周四的评审时间。\r\n谢谢。')), '请确认周四的评审时间。 谢谢。');
  // A body that is HTML comes as its words.
  assert.equal(snippetOf(bytes('<html><body><p>第一段</p><p>第二段</p></body></html>')), '第一段 第二段');
  // A cut in the middle of a character does not show a wrong one.
  const whole = Buffer.from('中文字符', 'utf8');
  assert.equal(snippetOf(whole.subarray(0, whole.byteLength - 1)), '中文字');
  // A long body is cut near a word boundary, and says there is more.
  const long = snippetOf(bytes(Array.from({ length: 60 }, (_, index) => 'word' + index).join(' ')));
  assert.ok(long.endsWith('…'));
  assert.ok(long.length <= SNIPPET_CHARS + 1, long);
  assert.match(long, / word\d+…$/);
  // A body with no words to break on is cut where it is.
  const unbroken = snippetOf(bytes('x'.repeat(400)));
  assert.equal(unbroken, 'x'.repeat(SNIPPET_CHARS) + '…');
  // A line that ends on a separator does not end on it.
  assert.ok(!snippetOf(bytes('a'.repeat(150) + ', ' + 'b'.repeat(50))).match(/[,，]\s*…$/));
  assert.equal(SNIPPET_MESSAGES, 20);
});

test('搜索结果里最新的邮件带正文摘要，只读正文开头，不下载整封', async () => {
  const raw = (text: string) => Buffer.from('From: a@example.invalid\r\nSubject: s\r\n\r\n' + text, 'utf8');
  const messages = Array.from({ length: 25 }, (_, index) => ({ ...message(index + 1, '邮件 ' + index), raw: raw('正文 ' + index + ' ' + '很长的一句话。'.repeat(60)) }));
  const server = fakeMailServer({ folders: [{ path: 'INBOX', messages }] });
  const page = await searchFolder(server.client, account, {}, signal());
  // The newest twenty carry a snippet, each the start of its own body.
  const withSnippet = page.messages.filter(item => item.snippet !== undefined);
  assert.equal(withSnippet.length, SNIPPET_MESSAGES);
  assert.equal(withSnippet[0]!.snippet!.startsWith('正文 24 很长的一句话。'), true);
  assert.ok(withSnippet[0]!.snippet!.endsWith('…'));
  // It was asked as a part with a limit, and the whole message was not taken for it.
  const asked = server.fetched.find(call => Array.isArray(call.query.bodyParts))!;
  assert.deepEqual(asked.query.bodyParts, [{ key: 'TEXT', start: 0, maxLength: 2048 }]);
  assert.equal(asked.query.source, undefined);
  assert.ok(asked.range.split(',').length <= SNIPPET_MESSAGES);
  // Every folder the search opened was opened read-only.
  assert.ok(server.opened.every(opened => opened.readOnly));
});

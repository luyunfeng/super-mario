import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import { fakeMailServer, type FakeFolder, type FakeMessage } from './mail-fixture.ts';

const seen = String.fromCharCode(92) + 'Seen';

function message(uid: number, subject: string, from = 'a@example.invalid', extra: Partial<FakeMessage> = {}): FakeMessage {
  return { uid, envelope: { subject, from: [{ name: '', address: from }], to: [{ address: 'someone@qq.com' }], messageId: '<m' + uid + '@example.invalid>' },
    flags: new Set<string>(), internalDate: new Date(Date.UTC(2026, 10, 26, 1, uid)).toISOString(), ...extra };
}
const inbox = (messages: FakeMessage[]): FakeFolder => ({ path: 'INBOX', messages });
const work = (messages: FakeMessage[]): FakeFolder => ({ path: '工作', messages });

/** A workbench with one mailbox whose mail is a stand-in. Everything else is real. */
async function start(t: { after(fn: () => void): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mail-inbox-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-mail' });
  // The stand-in server is rebuilt for each change of the mail, and the workbench is pointed at it.
  let current = fakeMailServer({ folders: [inbox([])] });
  server.app.setMailOpen(async () => current.client);
  const account = await server.app.mailAccounts.add({ email: 'someone@qq.com', password: 'an-offline-code', name: '工作邮箱',
    imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { authorization: 'Bearer offline-mail', 'content-type': 'application/json' };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(server.url + '/api/v1' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  };
  const mail = (folders: FakeFolder[]) => { current = fakeMailServer({ folders }); server.app.setMailOpen(async () => current.client); };
  const items = () => server.app.inbox.list().filter(item => item.source === 'mail');
  /** What the owner decides about an item, as the page sends it. */
  const decide = async (action: 'archive' | 'todo', id: string) => call('POST', '/inbox/bulk', { action, items: [{ id, version: server.app.inbox.list().find(item => item.id === id)!.version }] });
  return { server, account, call, mail, items, decide };
}

test('开启后未读邮件进入收件箱；同一话题的回复更新同一条；已读的不进', async t => {
  const f = await start(t);
  assert.equal((await f.call('GET', '/mail/connector')).data.enabled, false, 'off until the owner turns it on');
  assert.equal((await f.call('POST', '/mail/connector/poll')).status, 409, 'reading on demand needs it to be on');
  f.mail([inbox([message(1, '周四的评审', 'zhangsan@example.invalid')])]);
  assert.equal(f.items().length, 0, 'nothing comes in while it is off');

  // Turning it on reads at once.
  const on = await f.call('PUT', '/mail/connector', { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.enabled, true);
  assert.equal(on.data.accounts, 1);
  assert.equal(f.items().length, 1);
  const item = f.items()[0]!;
  assert.equal(item.title, '周四的评审 · zhangsan@example.invalid');
  assert.equal(item.tier, 'fyi', 'mail is information until the owner reads it');
  assert.match(item.reason, /邮箱来信/);
  assert.deepEqual(item.origin?.mail, { account: f.account.id, mailbox: 'INBOX', uid: 1 });
  assert.equal(item.origin?.connector, '邮箱');
  assert.equal(JSON.stringify(item).includes('an-offline-code'), false);

  // A reply joins the thread: one item, now about the newest message.
  f.mail([inbox([message(1, '周四的评审', 'zhangsan@example.invalid'), message(2, 'Re: 周四的评审', 'lisi@example.invalid')])]);
  await f.call('POST', '/mail/connector/poll');
  assert.equal(f.items().length, 1, 'a reply does not open a second item');
  assert.equal(f.items()[0]!.origin?.mail?.uid, 2);
  assert.equal(f.items()[0]!.last, 'INBOX:2');

  // When the newest message of the thread is read in the mailbox, an older unread message of
  // the same thread does not surface in its place.
  f.mail([inbox([message(1, '周四的评审', 'zhangsan@example.invalid'), message(2, 'Re: 周四的评审', 'lisi@example.invalid', { flags: new Set([seen]) })])]);
  await f.call('POST', '/mail/connector/poll');
  assert.equal(f.items()[0]!.origin?.mail?.uid, 2, 'the item is not moved back to the older message');
});

test('主题里有“请”也不会被规则推成需要处理；归档后来信，未读的会让话题重新出现，已读的不会', async t => {
  const f = await start(t);
  f.mail([inbox([message(1, '请审阅合同', 'legal@example.invalid'), message(2, '周报', 'finance@example.invalid')])]);
  await f.call('PUT', '/mail/connector', { enabled: true });
  const byTitle = (title: string) => f.items().find(item => item.title.startsWith(title))!;
  assert.equal(byTitle('请审阅合同').tier, 'fyi', 'a word in a subject does not make mail something to act on');
  assert.equal(byTitle('周报').tier, 'fyi');

  // The owner files one.
  const item = byTitle('请审阅合同');
  const filed = await f.decide('archive', item.id);
  assert.equal(filed.status, 200, JSON.stringify(filed.data));
  assert.ok(f.server.app.inbox.list().find(entry => entry.id === item.id)!.archivedAt);

  // Mail of the same thread that the owner has not read brings the thread back, as a new
  // message in any thread does. It is the newest message that is shown.
  f.mail([inbox([message(1, '请审阅合同', 'legal@example.invalid'), message(3, 'Re: 请审阅合同', 'ceo@example.invalid')])]);
  await f.call('POST', '/mail/connector/poll');
  const after = f.items().find(entry => entry.id === item.id)!;
  assert.equal(after.archivedAt, undefined, 'an unread reply is new mail and comes back');
  assert.equal(after.origin?.mail?.uid, 3, 'and the item still moves on to the newest message');

  // The owner files it again and then reads the newest message in their mail program. The
  // thread stays filed: mail that was read is not new mail.
  await f.decide('archive', item.id);
  f.mail([inbox([message(1, '请审阅合同', 'legal@example.invalid'), message(3, 'Re: 请审阅合同', 'ceo@example.invalid', { flags: new Set([seen]) })])]);
  await f.call('POST', '/mail/connector/poll');
  assert.ok(f.items().find(entry => entry.id === item.id)!.archivedAt, 'a reply that was read does not bring the thread back');
});

test('只收指定文件夹；停用后不再进新的；读不到的邮箱被指名，已有的邮件保留', async t => {
  const f = await start(t);
  f.mail([inbox([message(1, '收件箱里的')]), work([message(2, '工作文件夹里的')])]);
  const on = await f.call('PUT', '/mail/connector', { enabled: true, folders: ['工作'] });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.deepEqual(f.items().map(item => item.origin?.mail?.mailbox), ['工作'], 'only the chosen folder');
  // The folders to choose from are the usual ones the last read found.
  assert.ok(on.data.mailboxes.some((box: { name: string }) => box.name === '工作') === false, 'a folder of no usual role is not offered');

  // Turned off: a new message does not come in, and what is there stays.
  await f.call('PUT', '/mail/connector', { enabled: false });
  f.mail([inbox([message(1, '收件箱里的')]), work([message(2, '工作文件夹里的'), message(3, '停用后来的')])]);
  assert.equal((await f.call('POST', '/mail/connector/poll')).status, 409);
  assert.equal(f.items().length, 1);

  // A mailbox that cannot be read is named, and its mail is not taken for gone.
  await f.call('PUT', '/mail/connector', { enabled: true, folders: ['工作'] });
  // Turning it on reads at once, so the message that came while it was off is now in.
  assert.equal(f.items().length, 2);
  await f.server.app.mailAccounts.add({ email: 'other@163.com', password: 'another-code', name: '个人的',
    imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' });
  f.server.app.setMailOpen(async () => { throw new Error('read ECONNRESET for other@163.com'); });
  await f.call('POST', '/mail/connector/poll');
  const view = (await f.call('GET', '/mail/connector')).data;
  assert.deepEqual(view.failed.map((entry: { name: string }) => entry.name).sort(), ['个人的', '工作邮箱']);
  assert.equal(JSON.stringify(view).includes('ECONNRESET'), false, 'the words of the mail server are not on the view');
  assert.equal(f.items().length, 2, 'the mail that was already there is kept');

  // The setting is checked before it is saved.
  assert.equal((await f.call('PUT', '/mail/connector', { enabled: true, folders: '工作' })).status, 400);
  assert.equal((await f.call('PUT', '/mail/connector', { enabled: 'yes' })).status, 400);
});

test('移除邮箱时，它还没处理的邮件一起撤下；主人已经转成待办的保留', async t => {
  const f = await start(t);
  f.mail([inbox([message(1, '要转待办的', 'a@example.invalid'), message(2, '只是看看的', 'b@example.invalid')])]);
  await f.call('PUT', '/mail/connector', { enabled: true });
  assert.equal(f.items().length, 2);
  const kept = f.items().find(item => item.title.startsWith('要转待办的'))!;
  const turned = await f.decide('todo', kept.id);
  assert.equal(turned.status, 200, JSON.stringify(turned.data));
  const todoId = f.server.app.inbox.list().find(item => item.id === kept.id)!.todoId;
  assert.ok(todoId, 'it became a to-do');

  const removed = await f.call('DELETE', '/mail/accounts/' + f.account.id + '?version=' + f.account.version);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  const left = f.items();
  assert.equal(left.length, 2, 'the items stay as records');
  // The one that became a to-do was filed when it became one, and its to-do is still its own.
  const asTodo = f.server.app.inbox.list().find(item => item.id === kept.id)!;
  assert.equal(asTodo.todoId, todoId, 'the one that became a to-do is left alone');
  assert.ok(f.server.app.store.get('todos', todoId), 'and the to-do itself is there');
  // The other one is closed by the connector, because nothing was decided about it.
  const other = left.find(item => item.id !== kept.id)!;
  assert.ok(other.title.startsWith('只是看看的'));
  assert.ok(other.archivedAt, 'it is closed');
  assert.equal(other.todoId, undefined, 'and it did not become a to-do');
});

test('开关和文件夹保存在数据目录里，重启后连接器带着它们启动，读一次就能接着收', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mail-restart-'));
  const config = { host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-mail' };
  // Both workbenches are closed here and not in a hook. A plugin that is stopped from a hook
  // writes its statistics after the test is over, and that keeps the process alive.
  let second: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const first = await startServer(config);
    await first.app.mailAccounts.add({ email: 'someone@qq.com', password: 'an-offline-code', name: '工作邮箱',
      imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' });
    await first.app.mailConnectorConfigure({ enabled: true, folders: ['INBOX'] });
    await first.close();

    const current = fakeMailServer({ folders: [inbox([message(1, '重启前就收到的', 'a@example.invalid')])] });
    second = await startServer(config);
    second.app.setMailOpen(async () => current.client);
    // What was saved is what the connector runs with.
    const before = second.app.mailConnectorView();
    assert.equal(before.enabled, true);
    assert.deepEqual(before.folders, ['INBOX']);
    assert.equal(second.app.plugins.list().find(p => p.id === 'mail-connector')?.status, 'active');
    // A read on demand goes through the service the running connector offers.
    await second.app.mailPoll();
    let items: ReturnType<typeof second.app.inbox.list> = [];
    for (let i = 0; i < 300 && !items.length; i++) {
      items = second.app.inbox.list().filter(item => item.source === 'mail');
      if (!items.length) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(items.length, 1, 'the mail that was there is read');
    assert.equal(items[0]!.title, '重启前就收到的 · a@example.invalid');
    assert.equal(second.app.mailConnectorView().lastError, undefined);
  } finally {
    await second?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { MAIL_SEND_APPROVAL } from '../packages/core/src/mail-outbox.ts';
import { fakeSmtp } from './mail-smtp-fixture.ts';
import { fakeMailServer } from './mail-fixture.ts';

/** A workbench whose mail servers are stand-ins. Everything else is the real thing. */
async function start(t: { after(fn: () => void): void }, options: { breakAt?: 'after-354'; appendFails?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mail-approval-'));
  const smtp = await fakeSmtp({ noStartTls: true, breakAt: options.breakAt });
  const imap = fakeMailServer({ folders: [{ path: 'INBOX', messages: [] }, { path: 'Sent', messages: [] }] });
  if (options.appendFails) imap.client.append = async () => { throw new Error('Overquota'); };
  const workbench = await createWorkbench({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-mail' });
  // Reading and keeping a copy both go to the stand-in mail server.
  workbench.setMailOpen(async () => imap.client);
  t.after(async () => { await workbench.close(); await smtp.close(); await rm(dir, { recursive: true, force: true }); });
  const account = await workbench.mailAccounts.add({ email: 'someone@qq.com', password: 'the-secret-code', name: '工作邮箱',
    imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecurity: 'none' });
  return { workbench, account, smtp, imap };
}

test('助手提出发邮件后：批准前什么都没发；批准后发出并存副本，拒绝则什么都没发', async t => {
  const f = await start(t);
  const first = f.workbench.proposeMail({ account: f.account.id, to: [{ name: '李四', email: 'lisi@example.invalid' }], subject: '周四的评审', text: '请确认周四的评审。' });
  assert.equal(first.kind, MAIL_SEND_APPROVAL);
  assert.equal(first.status, 'pending');
  // Nothing has gone out, and the approval is one the owner acts on like any other.
  assert.equal(f.smtp.message(), '');
  const listed = f.workbench.approvals.list();
  assert.equal(listed.length, 1);
  assert.match(listed[0]!.details, /收件人：李四 <lisi@example\.invalid>/);

  // The owner approves it the way they approve anything else.
  const approved = await f.workbench.approvals.approve(first.id, first.version);
  assert.equal(approved.status, 'completed', JSON.stringify(approved));
  // The outcome is on the approval, in the owner's terms and with the message id.
  const result = approved.result as { outcome: string; copyKept?: boolean; accepted?: string[]; messageId?: string };
  assert.equal(result.outcome, 'sent', JSON.stringify(result));
  assert.equal(result.copyKept, true);
  assert.deepEqual(result.accepted, ['lisi@example.invalid']);
  assert.match(f.smtp.message(), /Subject: =\?UTF-8\?B\?/);
  assert.match(f.smtp.message(), /<lisi@example\.invalid>/);
  assert.equal(f.imap.appended.length, 1, 'the copy is kept in Sent');
  assert.equal(f.imap.appended[0]!.path, 'Sent');

  // A second one the owner refuses: nothing is sent, and the refusal is the answer.
  const second = f.workbench.proposeMail({ account: f.account.id, to: [{ email: 'wangwu@example.invalid' }], subject: '不发了', text: '这封会被拒绝。' });
  const rejected = await f.workbench.approvals.reject(second.id, second.version);
  assert.equal(rejected.status, 'rejected');
  assert.equal(f.smtp.message().includes('不发了'), false);
});

test('结果未知的发送记在审批上，不会被当成成功，也不会再发一次', async t => {
  const f = await start(t, { breakAt: 'after-354' });
  const approval = f.workbench.proposeMail({ account: f.account.id, to: [{ email: 'lisi@example.invalid' }], subject: '可能已发出', text: '正文。' });
  const done = await f.workbench.approvals.approve(approval.id, approval.version);
  assert.equal(done.status, 'completed');
  const result = done.result as { outcome: string; message: string };
  assert.equal(result.outcome, 'unknown', JSON.stringify(result));
  assert.match(result.message, /不要直接重发/);
  assert.equal(f.imap.appended.length, 0, 'no copy is kept of a message that may not have gone');
  // Approving the same version again is refused, so the message is not sent twice.
  await assert.rejects(f.workbench.approvals.approve(approval.id, approval.version));
  assert.equal(f.smtp.said.filter(line => line === 'DATA').length, 1, 'the message was given to the server once');
});

test('副本存不进去时审批仍记为已发出，并说明没有留副本', async t => {
  const f = await start(t, { appendFails: true });
  const approval = f.workbench.proposeMail({ account: f.account.id, to: [{ email: 'lisi@example.invalid' }], subject: '没有副本', text: '正文。' });
  const done = await f.workbench.approvals.approve(approval.id, approval.version);
  const result = done.result as { outcome: string; copyKept: boolean };
  assert.equal(result.outcome, 'sent');
  assert.equal(result.copyKept, false);
  assert.equal(f.imap.appended.length, 0);
});

test('HTTP：助手和页面都能提出并查看发送审批，密码不出现在任何响应里', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mail-http-approval-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-mail' });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { authorization: 'Bearer offline-mail', 'content-type': 'application/json' };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(server.url + '/api/v1' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, data: JSON.parse(text || 'null') as any, text };
  };
  const account = (await call('POST', '/mail/accounts', { email: 'someone@qq.com', password: 'the-secret-code' })).data;
  const approval = server.app.proposeMail({ account: account.id, to: [{ email: 'lisi@example.invalid' }], subject: '经审批', text: '正文。' });
  assert.equal(approval.kind, MAIL_SEND_APPROVAL);
  // The approval is among the ones the page lists, with what the owner needs to decide.
  const listed = await call('GET', '/approvals');
  assert.ok(JSON.stringify(listed.data).includes('lisi@example.invalid'));
  assert.equal(JSON.stringify(listed.data).includes('the-secret-code'), false);
});

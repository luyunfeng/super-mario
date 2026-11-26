import test from 'node:test';
import assert from 'node:assert/strict';
import type { MailAccount } from '../packages/protocol/src/mail.ts';
import { MAX_RECIPIENTS, SEND_TIMEOUT_MS, SendRefused, sendMail, verifySmtp } from '../packages/core/src/mail-send.ts';
import { fakeSmtp, makeCertificate } from './mail-smtp-fixture.ts';

const account = (port: number, smtpSecurity = 'none'): MailAccount => ({
  id: 'acc', name: '工作邮箱', email: 'someone@qq.com', auth: 'password', username: 'someone@qq.com',
  imapHost: 'imap.qq.com', imapPort: 993, imapSecurity: 'tls', smtpHost: '127.0.0.1', smtpPort: port, smtpSecurity,
  status: 'unknown', hasPassword: true, version: 1, createdAt: '2026-11-26T00:00:00.000Z', updatedAt: '2026-11-26T00:00:00.000Z',
});
const request = () => ({
  account: 'acc', to: [{ name: '李四', email: 'lisi@example.invalid' }], cc: [], bcc: [],
  subject: '周四的评审', text: '请确认周四的评审。\n谢谢。',
});
const signal = () => new AbortController().signal;
const isOutcome = (outcome: string, failure?: string) => (value: { outcome: string; failure?: string }) =>
  value.outcome === outcome && (failure === undefined || value.failure === failure);
const isRefused = (failure: string) => (error: unknown) => error instanceof SendRefused && error.failure === failure;

test('发出一封邮件：收件人、主题、正文和中文都对，密送不进邮件头，密码不进任何记录', async t => {
  const smtp = await fakeSmtp({ noStartTls: true });
  t.after(() => smtp.close());
  const result = await sendMail(account(smtp.port), 'the-secret-code', { ...request(), bcc: [{ name: '', email: 'boss@example.invalid' }] }, signal());
  assert.equal(result.outcome, 'sent', JSON.stringify(result));
  assert.deepEqual(result.accepted, ['lisi@example.invalid', 'boss@example.invalid']);
  assert.deepEqual(result.rejected, []);
  if (result.outcome !== 'sent') return;
  // The id is made under the sender's own domain, so it does not name the machine the workbench is on.
  assert.match(result.messageId, /@qq\.com$/);
  const sent = smtp.message();
  assert.match(sent, /^Subject: =\?UTF-8\?B\?/m, 'a Chinese subject is encoded as the mail standard asks');
  assert.match(sent, /^To: .*<lisi@example\.invalid>/m);
  assert.match(sent, /^From: .*<someone@qq\.com>/m);
  assert.equal(sent.includes('Message-ID: <' + result.messageId + '>'), true, 'the id given back is the one the message carries');
  assert.equal(/^(Bcc|bcc):/m.test(sent), false, 'a blind copy is not named in the message that goes out');
  // The body is base64 in the message, so it is read back before it is compared.
  const body = sent.split(/\r\n\r\n/).slice(1).join('\r\n\r\n');
  const encoded = body.split(/\r\n/).filter(line => !line.startsWith('--') && !/^[A-Za-z-]+:/.test(line)).join('');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8').trim(), '请确认周四的评审。\n谢谢。');
  // The credentials went over the connection and were not kept anywhere. The server would see
  // them base64-encoded, so that form is looked for as well as the plain one.
  const encodedPassword = Buffer.from('\0someone@qq.com\0the-secret-code').toString('base64');
  assert.equal(smtp.said.some(line => line.includes('the-secret-code') || line.includes(encodedPassword) || line.includes(encodedPassword.slice(0, 20))), false,
    'the password is not kept in what the server wrote down');
  assert.equal(JSON.stringify(result).includes('the-secret-code'), false);
  assert.ok(smtp.said.some(line => line.startsWith('AUTH') && line.endsWith('[hidden]')), 'the server was asked to sign in');
});

test('账号要求 STARTTLS 时连接先升级再登录；服务器不提供升级就拒绝发出，密码不走明文', async t => {
  const tls = await makeCertificate();
  if (!tls) { t.skip('本机没有 openssl，无法生成测试证书'); return; }
  const up = await fakeSmtp({ tls });
  t.after(() => up.close());
  const trust = { ca: tls.cert };
  const result = await sendMail({ ...account(up.port, 'starttls'), smtpHost: 'localhost' }, 'code', request(), signal(), trust);
  assert.equal(result.outcome, 'sent', JSON.stringify(result));
  assert.equal(up.upgraded(), true, 'STARTTLS was done before anything else');
  assert.ok(up.said.indexOf('STARTTLS') < up.said.findIndex(line => line.startsWith('AUTH')), 'the upgrade comes before the sign-in');

  // A server with no STARTTLS and an account that requires it: nothing is sent and no password
  // is given over the connection in the clear.
  const plain = await fakeSmtp({ noStartTls: true });
  t.after(() => plain.close());
  const refused = await sendMail({ ...account(plain.port, 'starttls'), smtpHost: 'localhost' }, 'code', request(), signal());
  assert.equal(refused.outcome, 'not-sent');
  assert.equal(refused.failure, 'tls', JSON.stringify(refused));
  assert.equal(plain.said.some(line => line.startsWith('AUTH')), false, 'no sign-in was tried without the upgrade');
  assert.equal(plain.message(), '');
});

test('连接一开始就加密的账号直接加密连接', async t => {
  const tls = await makeCertificate();
  if (!tls) { t.skip('本机没有 openssl，无法生成测试证书'); return; }
  const secure = await fakeSmtp({ secure: true, tls });
  t.after(() => secure.close());
  const result = await sendMail({ ...account(secure.port, 'tls'), smtpHost: 'localhost' }, 'code', request(), signal(), { ca: tls.cert });
  assert.equal(result.outcome, 'sent', JSON.stringify(result));
  assert.equal(secure.said.includes('STARTTLS'), false, 'the connection was encrypted from the start, so there is nothing to upgrade');
});

test('服务器明确拒绝的几种情况都是没发出：登录、发件人、所有收件人、DATA 命令、内容', async t => {
  const cases = [
    { refuseAt: 'auth', failure: 'authentication' }, { refuseAt: 'mail-from', failure: 'refused-by-server' },
    { refuseAt: 'rcpt-to', failure: 'refused-by-server' }, { refuseAt: 'data-command', failure: 'refused-by-server' },
    { refuseAt: 'after-dot', failure: 'refused-by-server' },
  ] as const;
  for (const item of cases) {
    const smtp = await fakeSmtp({ noStartTls: true, refuseAt: item.refuseAt });
    t.after(() => smtp.close());
    const result = await sendMail(account(smtp.port), 'code', request(), signal());
    assert.ok(isOutcome('not-sent', item.failure)(result), item.refuseAt + ' ' + JSON.stringify(result));
    if (result.outcome !== 'not-sent') return;
    assert.match(result.message, /没有发出/, item.refuseAt);
    // A refusal names no address and no server greeting.
    assert.equal(result.message.includes('example.invalid'), false, item.refuseAt);
    assert.equal(result.message.includes('fake.local'), false, item.refuseAt);
  }
});

test('服务器收下邮件后不回应：结果是未知，不是没发出，这样不会被当成可以重发', async t => {
  // This is the one case where sending again would send the mail twice.
  const smtp = await fakeSmtp({ noStartTls: true, breakAt: 'after-354' });
  t.after(() => smtp.close());
  const result = await sendMail(account(smtp.port), 'code', request(), signal());
  assert.equal(result.outcome, 'unknown', JSON.stringify(result));
  assert.match(result.message, /已经收下/);
  assert.match(result.message, /不要直接重发/);
});

test('连接阶段断开是没发出：问候、EHLO、登录、发件人、收件人、DATA 命令', async t => {
  for (const breakAt of ['greeting', 'ehlo', 'auth', 'mail-from', 'rcpt-to', 'data-command'] as const) {
    const smtp = await fakeSmtp({ noStartTls: true, breakAt });
    t.after(() => smtp.close());
    const result = await sendMail(account(smtp.port), 'code', request(), signal());
    assert.equal(result.outcome, 'not-sent', breakAt + ' ' + JSON.stringify(result));
    assert.match(result.message, /没有发出/, breakAt);
    // The server took no message in any of these, so none was kept.
    assert.equal(smtp.message(), '', breakAt);
  }
});

test('内容发完后连接断开，也是未知；服务器用 250 回 DATA 时同样算已开始发出', async t => {
  const smtp = await fakeSmtp({ noStartTls: true, breakAt: 'after-dot' });
  t.after(() => smtp.close());
  const result = await sendMail(account(smtp.port), 'code', request(), signal());
  assert.equal(result.outcome, 'unknown', JSON.stringify(result));
  assert.ok(smtp.message().includes('Subject'), 'the whole message did reach the server');

  // A server that answers DATA with 250: the message starts to leave all the same, so a
  // connection that ends after it is unknown here too.
  const other = await fakeSmtp({ noStartTls: true, breakAt: 'after-dot', dataAnswers250: true });
  t.after(() => other.close());
  const otherResult = await sendMail(account(other.port), 'code', request(), signal());
  assert.equal(otherResult.outcome, 'unknown', JSON.stringify(otherResult));
  assert.ok(other.message().includes('Subject'));
  // And a send to such a server that goes well is sent.
  const fine = await fakeSmtp({ noStartTls: true, dataAnswers250: true });
  t.after(() => fine.close());
  assert.equal((await sendMail(account(fine.port), 'code', request(), signal())).outcome, 'sent');
});

test('主人停止等待：邮件已交给服务器时结果未知，还没有时是没发出', async t => {
  // Stopping after the server took the message: it may have gone, so the answer is the
  // careful one. The server keeps the connection open and never answers, as a stuck one would.
  let stopLate!: AbortController;
  const late = await fakeSmtp({ noStartTls: true, holdAfterMessage: true });
  t.after(() => late.close());
  stopLate = new AbortController();
  const pendingLate = sendMail(account(late.port), 'code', request(), stopLate.signal);
  // The server has the whole message and is holding its answer. Stopping now must end the
  // wait, and must not report the message as sent.
  while (!late.message()) await new Promise(resolve => setTimeout(resolve, 5));
  stopLate.abort();
  const afterData = await pendingLate;
  assert.equal(afterData.outcome, 'unknown', JSON.stringify(afterData));
  // Stopping before the message was taken: nothing left, so it is safe to send again.
  let stopEarly!: AbortController;
  const early = await fakeSmtp({ noStartTls: true, onStep: step => { if (step === 'mail-from') stopEarly.abort(); } });
  t.after(() => early.close());
  stopEarly = new AbortController();
  const beforeData = await sendMail(account(early.port), 'code', request(), stopEarly.signal);
  assert.equal(beforeData.outcome, 'not-sent', JSON.stringify(beforeData));
  assert.match(beforeData.message, /没有发出/);
  assert.equal(early.message(), '', 'the server was never given the message');

  const idle = await fakeSmtp({ noStartTls: true });
  t.after(() => idle.close());
  await assert.rejects(sendMail(account(idle.port), 'code', { ...request(), to: [] }, signal()), isRefused('invalid'));
  await assert.rejects(sendMail(account(idle.port), 'code', { ...request(), to: [{ name: '', email: 'not an address' }] }, signal()), isRefused('invalid'));
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, index) => ({ name: '', email: 'p' + index + '@example.invalid' }));
  await assert.rejects(sendMail(account(idle.port), 'code', { ...request(), to: many }, signal()), isRefused('too-many'));
  await assert.rejects(sendMail(account(idle.port), 'code', { ...request(), subject: '  ', text: '' }, signal()), isRefused('invalid'));
  // None of those made a connection, so the server saw nothing.
  assert.deepEqual(idle.said, []);
});

test('检查发件服务器只登录不发信，登录被拒时如实报告', async t => {
  const good = await fakeSmtp({ noStartTls: true });
  t.after(() => good.close());
  assert.deepEqual(await verifySmtp(account(good.port), 'code', signal()), { ok: true });
  assert.equal(good.message(), '', 'checking sends nothing');
  const bad = await fakeSmtp({ noStartTls: true, refuseAt: 'auth' });
  t.after(() => bad.close());
  const refused = await verifySmtp(account(bad.port), 'wrong', signal());
  assert.equal(refused.ok, false, JSON.stringify(refused));
  if (refused.ok) return;
  assert.equal(refused.failure, 'authentication');
  assert.match(refused.message, /授权码/);
  assert.equal(refused.message.includes('没有发出'), false, 'a check sends nothing, so it does not speak of a message that was not sent');
  assert.equal(bad.said.some(line => line.includes('wrong')), false);
  // The limit on one send is named, so a test that depends on it can say so.
  assert.equal(SEND_TIMEOUT_MS, 60_000);
});

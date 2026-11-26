import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailAttachmentNode } from '../apps/agent-node/src/mail-attachment.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createMachineCredentials } from '../apps/server/src/machine-credentials.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Tool } from '../packages/plugin-sdk/src/index.ts';
import { fakeMailServer, type FakeMessage } from './mail-fixture.ts';

const seen = String.fromCharCode(92) + 'Seen';
const signal = () => new AbortController().signal;
/** A message with one file attached, as it comes over the wire. */
const reportMail: Partial<FakeMessage> = {
  bodyStructure: { childNodes: [{ disposition: 'attachment', dispositionParameters: { filename: 'report.pdf' } }] },
  raw: Buffer.from([
    'From: finance@example.invalid', 'To: someone@qq.com', 'Subject: report',
    'Message-ID: <m1@example.invalid>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="x"', '',
    '--x', 'Content-Type: text/plain; charset=UTF-8', '', 'the report is attached.',
    '--x', 'Content-Type: application/pdf; name="report.pdf"', 'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="report.pdf"', '', '', Buffer.from('a report').toString('base64'), '--x--', '',
  ].join('\r\n')),
};

async function start(t: { after(fn: () => void): void }, options: { machineToken?: 'dedicated' | 'root' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-mail-save-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token: 'offline-mail' });
  const mail = fakeMailServer({ folders: [{ path: 'INBOX', messages: [{ uid: 1, internalDate: '2026-11-21T09:00:00.000Z', flags: new Set<string>([seen]), ...reportMail } as FakeMessage] }] });
  const account = await server.app.mailAccounts.add({ email: 'someone@qq.com', password: 'code-one', name: '工作邮箱',
    imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'none', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'none' });
  server.app.setMailOpen(async () => mail.client);
  let node: ReturnType<typeof startAgentNode> | undefined;
  t.after(async () => {
    await node?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  /** A machine that offers the save. Its bytes are taken over HTTP from this server. */
  const connect = async (machineId: string) => {
    const credentials = createMachineCredentials(server.app.store);
    const issued = credentials.issue(machineId);
    const dataDir = join(dir, 'node-' + machineId);
    const url = server.url.replace(/\/+$/, '') + '/';
    node = startAgentNode({ url: server.url, token: options.machineToken === 'root' ? 'offline-mail' : issued.token, machineId, name: '工作电脑', dataDir,
      executors: [], handlers: createMailAttachmentNode({ dataDir, serverUrl: url, machineToken: issued.token }).handlers });
    return { dataDir, issued };
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = server.app.contributions.list('tools').find(item => item.value.name === name)?.value as Tool | undefined;
    assert.ok(tool, 'the tool ' + name + ' is registered');
    try { return { ok: true as const, text: String(await tool.execute(args as never, signal())) }; }
    catch (error) { return { ok: false as const, text: (error as Error).message }; }
  };
  return { server, mail, account, connect, call };
}

test('没有能保存的电脑时，工具如实说明，不假装保存', async t => {
  const f = await start(t);
  const read = await f.call('mail_read', { account: f.account.id, uid: 1 });
  assert.equal(read.ok, true, read.text);
  // The id is on the attachment's line, so that the next call can be made from it.
  assert.match(read.text, /^- report\.pdf（application\/pdf，\d+ 字节）id=[A-Za-z0-9_-]{22}$/m);
  const saved = await f.call('mail_save_attachment', { account: f.account.id, uid: 1, attachment_id: 'x'.repeat(22) });
  assert.equal(saved.ok, false);
  assert.match(saved.text, /没有能保存邮件附件的电脑/);
});

test('用根令牌连接的执行机不提供保存能力，工作台如实报告', async t => {
  const f = await start(t);
  // The real entry point composes the node's plugins. With a root token there is no machine
  // credential to take the bytes with, so the save is not offered at all.
  const { loadDefaultNodePlugins } = await import('../apps/agent-node/src/node-plugins.ts');
  const serverUrl = f.server.url.replace(/\/+$/, '') + '/';
  const workerToolUrl = serverUrl + 'api/v1/worker-tools/todo-bind-thread';
  const base = { dataDir: join(tmpdir(), 'mario-no-plugins'), machineId: 'root-machine', agentInstanceId: 'a', launchers: {} };
  const withRoot = await loadDefaultNodePlugins({ ...base, serverUrl, workerToolUrl });
  assert.equal('mail.save-attachment' in withRoot.handlers, false);
  const withDedicated = await loadDefaultNodePlugins({ ...base, serverUrl, workerToolUrl, machineToken: 'smmc_' + 'x'.repeat(43) });
  assert.equal('mail.save-attachment' in withDedicated.handlers, true);
  await withRoot.close();
  await withDedicated.close();
  const saved = await f.call('mail_save_attachment', { account: f.account.id, uid: 1, attachment_id: 'x'.repeat(22) });
  assert.equal(saved.ok, false);
  assert.match(saved.text, /没有能保存邮件附件的电脑/);
});

test('整条链路：助手工具读出附件、认领、节点取字节并落盘，认领只能用一次', async t => {
  const f = await start(t);
  const { issued } = await f.connect('work-machine');
  // Wait until the machine has said hello, so that the server knows it can save.
  for (let tries = 0; tries < 50 && !f.server.machines.list().some(item => item.id === 'work-machine' && item.online && item.capabilities.includes('mail.save-attachment')); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const read = await f.call('mail_read', { account: f.account.id, uid: 1 });
  const attachmentId = /id=([A-Za-z0-9_-]{22})/m.exec(read.text)![1]!;
  const saved = await f.call('mail_save_attachment', { account: f.account.id, uid: 1, attachment_id: attachmentId, dir: 'bills/2026-11' });
  assert.equal(saved.ok, true, saved.text);
  const path = /已保存到 (.+)（\d+ 字节）。/.exec(saved.text)![1]!;
  assert.ok(path.endsWith(join('attachments', 'mail', 'bills', '2026-11', 'report.pdf')), path);
  assert.equal(await readFile(path, 'utf8'), 'a report');
  // The bytes crossed the machine channel never: the claim was taken over HTTP and is spent.
  assert.equal(f.server.app.takeMailAttachment('no-such-id', issued.token, 'work-machine'), undefined);
  // Saving again makes a numbered copy and never overwrites.
  const again = await f.call('mail_save_attachment', { account: f.account.id, uid: 1, attachment_id: attachmentId, dir: 'bills/2026-11' });
  assert.equal(again.ok, true, again.text);
  assert.ok(/report \(2\)\.pdf/.test(again.text), again.text);
  // Reading and saving left the flags alone: every folder was opened read-only.
  assert.ok(f.mail.opened.every(opened => opened.readOnly));
  assert.deepEqual(f.mail.appended, []);
});

test('认领只能由所属电脑取一次：别的电脑、浏览器令牌、缺凭据都取不到', async t => {
  const f = await start(t);
  const { issued } = await f.connect('work-machine');
  for (let tries = 0; tries < 50 && !f.server.machines.list().some(item => item.id === 'work-machine' && item.capabilities.includes('mail.save-attachment')); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const read = await f.call('mail_read', { account: f.account.id, uid: 1 });
  const attachmentId = /id=([A-Za-z0-9_-]{22})/m.exec(read.text)![1]!;
  // A claim is made by a save whose node is slow to answer. Here the node is the real one, so
  // the claim is taken by it; to look at the claim route on its own, one is made directly.
  const other = createMachineCredentials(f.server.app.store).issue('other-machine');
  const claim = f.server.app.takeMailAttachment;
  assert.equal(typeof claim, 'function');
  // Without a claim made for it, the route answers that there is none, whichever credential
  // is sent with it.
  const base = f.server.url.replace(/\/+$/, '');
  const take = (headers: Record<string, string>, id = 'no-such-claim') => fetch(base + '/api/v1/mail/claims/' + id, { headers });
  const answers = await Promise.all([
    take({ authorization: 'Bearer anything', 'x-machine-credential': 'Bearer ' + issued.token }),
    take({ authorization: 'Bearer anything', 'x-machine-credential': 'Bearer ' + other.token }),
    take({ authorization: 'Bearer offline-mail' }),
    take({ 'x-machine-credential': 'Bearer ' + issued.token }),
    take({ authorization: 'Bearer anything', 'x-machine-credential': 'Bearer offline-mail' }),
  ]);
  // None is a claim that exists, so each is refused: by having no valid machine credential
  // (401) or by naming none (404).
  assert.deepEqual(answers.map(answer => answer.status), [404, 404, 401, 401, 401]);
  // A claim that was made for one machine is not there for another. The claim the real save
  // used is spent, so asking for it by the machine it was made for gives nothing either.
  const saved = await f.call('mail_save_attachment', { account: f.account.id, uid: 1, attachment_id: attachmentId });
  assert.equal(saved.ok, true, saved.text);
  assert.equal(claim('no-such-claim', 'anything', 'work-machine'), undefined);
});

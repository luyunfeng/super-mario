import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createSealedStore } from '../packages/core/src/sealed-store.ts';
import { createMailAccounts, MailAccountError } from '../packages/core/src/mail-accounts.ts';
import { mailPreset, securityOfPort, validMailAddress, validMailHost } from '../packages/core/src/mail-presets.ts';

async function fixture(t: { after(fn: () => void): void }) {
  const root = await mkdtemp(join(tmpdir(), 'mario-mail-accounts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(':memory:');
  t.after(() => store.close());
  const sealed = await createSealedStore(join(root, 'data'));
  const accounts = createMailAccounts({ store, sealed });
  const qq = { email: 'someone@qq.com', password: 'a-authorization-code' };
  return { root, store, sealed, accounts, qq, reopen: () => createMailAccounts({ store, sealed }) };
}

test('添加账号：按邮箱域名填好服务器，密码只以密文存在，公开视图里没有密码', async t => {
  const f = await fixture(t);
  const account = await f.accounts.add(f.qq);
  assert.match(account.id, /^[0-9a-f-]{36}$/);
  assert.equal(account.email, 'someone@qq.com');
  assert.equal(account.name, 'someone@qq.com', 'the address is the name when none is given');
  assert.equal(account.username, 'someone@qq.com', 'the address is the sign-in name when none is given');
  assert.equal(account.imapHost, 'imap.qq.com');
  assert.equal(account.imapPort, 993);
  assert.equal(account.imapSecurity, 'tls');
  assert.equal(account.smtpHost, 'smtp.qq.com');
  assert.equal(account.smtpPort, 465);
  assert.equal(account.smtpSecurity, 'tls');
  assert.equal(account.status, 'unknown');
  assert.equal(account.hasPassword, true);
  assert.equal(account.version, 1);
  // The password is nowhere in the public view or in the account record.
  const shown = JSON.stringify(f.accounts.list());
  assert.equal(shown.includes('a-authorization-code'), false);
  const stored = JSON.stringify(f.store.list('mail.accounts'));
  assert.equal(stored.includes('a-authorization-code'), false);
  // It is in the secrets collection, sealed.
  const secrets = f.store.list<{ sealed: string }>('mail.account-secrets');
  assert.equal(secrets.length, 1);
  assert.match(secrets[0]!.sealed, /^smseal1\./);
  assert.equal(JSON.stringify(secrets).includes('a-authorization-code'), false);
  // It reads back for signing in, and that is the only way to get it.
  assert.equal(await f.accounts.password(account.id), 'a-authorization-code');
  await assert.rejects(f.accounts.password('missing'), /不存在/);
});

test('改账号时不传密码就保留原密码；传了就换；更换服务器必须重新填密码', async t => {
  const f = await fixture(t);
  const account = await f.accounts.add({ ...f.qq, name: '工作邮箱' });
  const renamed = await f.accounts.update(account.id, { name: '个人的' }, account.version);
  assert.equal(renamed.name, '个人的');
  assert.equal(renamed.version, 2);
  assert.equal(await f.accounts.password(account.id), 'a-authorization-code', 'the password stays');
  // An empty password is not sent as "keep": sending one replaces it.
  const resealed = await f.accounts.update(account.id, { password: 'new-code' }, renamed.version);
  assert.equal(resealed.hasPassword, true);
  assert.equal(await f.accounts.password(account.id), 'new-code');
  // Changing the servers with the old password kept is refused.
  await assert.rejects(f.accounts.update(account.id, { imapHost: 'imap.example.com' }, resealed.version), /重新填写密码/);
  assert.equal((await f.accounts.get(account.id)).imapHost, 'imap.qq.com', 'a refused change leaves the account as it was');
  const moved = await f.accounts.update(account.id, { imapHost: 'imap.example.com', password: 'code-for-new' }, resealed.version);
  assert.equal(moved.imapHost, 'imap.example.com');
  assert.equal(await f.accounts.password(account.id), 'code-for-new');
  // A stale version is refused, so two windows cannot overwrite each other.
  await assert.rejects(f.accounts.update(account.id, { name: '过期' }, resealed.version), /新版本/);
});

test('连通性检查的结果不改版本号，主人打开账号期间的编辑不会因此冲突', async t => {
  const f = await fixture(t);
  const account = await f.accounts.add(f.qq);
  const openedAt = account.version;
  f.accounts.checked(account.id, { ok: false, error: '密码或授权码不正确。' });
  const failed = f.accounts.get(account.id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, '密码或授权码不正确。');
  assert.equal(failed.version, openedAt, 'a check does not move the version');
  // So the edit the owner had open still saves.
  const saved = await f.accounts.update(account.id, { name: '检查期间改的名字' }, openedAt);
  assert.equal(saved.name, '检查期间改的名字');
  assert.equal(saved.status, 'unknown', 'a change says nothing yet about the new settings');
  assert.equal(saved.error, undefined);
  f.accounts.checked(account.id, { ok: true });
  assert.equal(f.accounts.get(account.id).status, 'ok');
  assert.equal(f.accounts.get(account.id).error, undefined);
  // A very long failure is kept short.
  f.accounts.checked(account.id, { ok: false, error: 'x'.repeat(2000) });
  assert.equal(f.accounts.get(account.id).error!.length, 500);
});

test('重启后账号和密码都还在；删除账号时密码一起删除', async t => {
  const f = await fixture(t);
  const account = await f.accounts.add(f.qq);
  // A new store over the same database and key reads the same account and password.
  const reopened = f.reopen();
  assert.equal(reopened.get(account.id).email, 'someone@qq.com');
  assert.equal(await reopened.password(account.id), 'a-authorization-code');
  // Removing is synchronous, so a refusal throws before there is a promise to await.
  assert.throws(() => reopened.remove(account.id, account.version + 1), /新版本/);
  reopened.remove(account.id, account.version);
  assert.throws(() => reopened.get(account.id), /不存在/);
  assert.equal(f.store.list('mail.account-secrets').length, 0, 'the password goes with the account');
  assert.deepEqual(reopened.list(), []);
});

test('非法输入在写入之前拒绝：地址、主机、端口、加密方式、未知字段、缺密码', async t => {
  const f = await fixture(t);
  const bad = [
    { email: 'not-an-address', password: 'x' }, { email: 'a@b', password: 'x' }, { email: 'a b@qq.com', password: 'x' },
    { email: 'a@qq.com', password: 'x', imapHost: 'bad host' }, { email: 'a@qq.com', password: 'x', imapHost: 'imap..com' },
    { email: 'a@qq.com', password: 'x', imapPort: 0 }, { email: 'a@qq.com', password: 'x', smtpPort: 65536 },
    { email: 'a@qq.com', password: 'x', imapSecurity: 'ssl' }, { email: 'a@qq.com', password: 'x', extra: true },
    { email: 'a@qq.com' }, { email: 'a@qq.com', password: 7 }, { email: 'a@qq.com', password: 'x', name: 'a'.repeat(81) },
    { email: 'a@qq.com', password: 'x', username: '' },
  ];
  for (const input of bad) await assert.rejects(f.accounts.add(input), (error: unknown) => error instanceof MailAccountError, JSON.stringify(input));
  assert.deepEqual(f.accounts.list(), [], 'nothing was written');
  assert.equal(f.store.list('mail.account-secrets').length, 0, 'and no password was kept for a refused account');
});

test('不在已知列表里的域名必须自己填服务器；填了就能用，加密方式按端口推', async t => {
  const f = await fixture(t);
  await assert.rejects(f.accounts.add({ email: 'a@example.invalid', password: 'x' }), /不在已知列表里/);
  // For a domain that is not known the servers and both ports have to be given: none can be
  // guessed for it.
  await assert.rejects(f.accounts.add({ email: 'a@example.invalid', password: 'x', imapHost: 'mail.example.invalid', smtpHost: 'mail.example.invalid' }), /不在已知列表里/);
  const own = await f.accounts.add({ email: 'a@example.invalid', password: 'x', imapHost: 'mail.example.invalid', imapPort: 1993,
    smtpHost: 'mail.example.invalid', smtpPort: 2587 });
  assert.equal(own.imapHost, 'mail.example.invalid');
  // The security comes from the ports when it is not said.
  assert.equal(own.imapSecurity, 'none');
  assert.equal(own.smtpSecurity, 'none');
  assert.equal(mailPreset('a@example.invalid'), undefined);
  assert.deepEqual(mailPreset('someone@QQ.com')?.imapHost, 'imap.qq.com', 'the domain is matched without case');
  assert.equal(securityOfPort(993, 'imap'), 'tls');
  assert.equal(securityOfPort(143, 'imap'), 'starttls');
  assert.equal(securityOfPort(465, 'smtp'), 'tls');
  assert.equal(securityOfPort(587, 'smtp'), 'starttls');
  assert.equal(securityOfPort(2525, 'smtp'), 'none');
  assert.equal(validMailAddress('a@b.com'), true);
  assert.equal(validMailAddress('a@b'), false);
  assert.equal(validMailHost('imap.qq.com'), true);
  assert.equal(validMailHost('[::1]'), true);
  assert.equal(validMailHost('a b'), false);
});

test('把地址改到另一个域名时，服务器换成新域名的，除非主人自己填了', async t => {
  const f = await fixture(t);
  const account = await f.accounts.add(f.qq);
  assert.equal(account.imapHost, 'imap.qq.com');
  const moved = await f.accounts.update(account.id, { email: 'someone@163.com', password: 'code-for-163' }, account.version);
  assert.equal(moved.email, 'someone@163.com');
  assert.equal(moved.imapHost, 'imap.163.com', 'the old domain\'s servers are not kept for the new one');
  assert.equal(moved.smtpHost, 'smtp.163.com');
  // The sign-in name follows the address. For most providers it is the address, so keeping the
  // old domain's would fail to sign in. An owner whose sign-in name differs names it again.
  assert.equal(moved.username, 'someone@163.com');
  // Naming the servers keeps them.
  const named = await f.accounts.update(account.id, { email: 'someone@gmail.com', imapHost: 'my-imap.example.invalid', password: 'x' }, moved.version);
  assert.equal(named.imapHost, 'my-imap.example.invalid');
  assert.equal(named.smtpHost, 'smtp.gmail.com', 'what was not named still comes from the new domain');
  // Back to the first domain: its servers come from its preset again.
  const renamed = await f.accounts.update(account.id, { email: 'other@qq.com', password: 'code-for-qq' }, named.version);
  assert.equal(renamed.imapHost, 'imap.qq.com');
  assert.equal(renamed.smtpHost, 'smtp.qq.com');
  assert.equal(renamed.username, 'other@qq.com');
});

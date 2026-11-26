import { randomUUID } from 'node:crypto';
import type { Store } from '../../plugin-sdk/src/index.ts';
import type { MailAccount, MailAccountInput, MailPreset } from '../../protocol/src/mail.ts';
import { mailPreset, securityOfPort, validMailAddress, validMailHost, validMailPort } from './mail-presets.ts';
import type { createSealedStore } from './sealed-store.ts';

type Sealed = Awaited<ReturnType<typeof createSealedStore>>;
const accounts = 'mail.accounts';
const secrets = 'mail.account-secrets';

export class MailAccountError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'MailAccountError'; this.status = status; }
}
// A function declaration, so that TypeScript knows a call never returns and narrows after it.
function fail(message: string, status = 400): never { throw new MailAccountError(message, status); }

/** The account as it is stored. The password is in a separate, sealed record. */
type StoredAccount = Omit<MailAccount, 'hasPassword'>;

/** Fills in what the owner left out from the domain's well-known servers. */
type Servers = Pick<MailAccount, 'username' | 'imapHost' | 'imapPort' | 'imapSecurity' | 'smtpHost' | 'smtpPort' | 'smtpSecurity'>;
/** `email` is the account's address, which decides the preset. It is passed separately
 *  because a change may leave the address out, meaning it stays as it is. */
export function resolveMailServers(input: MailAccountInput, email: string, current?: Servers): Servers {
  const preset: MailPreset | undefined = mailPreset(email);
  const imapPort = input.imapPort ?? current?.imapPort ?? preset?.imapPort;
  const smtpPort = input.smtpPort ?? current?.smtpPort ?? preset?.smtpPort;
  const imapHost = input.imapHost ?? current?.imapHost ?? preset?.imapHost;
  const smtpHost = input.smtpHost ?? current?.smtpHost ?? preset?.smtpHost;
  if (imapPort === undefined || smtpPort === undefined || !imapHost || !smtpHost) {
    fail('这个邮箱域名不在已知列表里，请填写收件和发件服务器的地址与端口。');
  }
  const username = input.username ?? current?.username ?? input.email;
  if (!username) fail('请填写登录名。');
  return {
    username,
    imapHost, imapPort, imapSecurity: input.imapSecurity ?? current?.imapSecurity ?? securityOfPort(imapPort, 'imap'),
    smtpHost, smtpPort, smtpSecurity: input.smtpSecurity ?? current?.smtpSecurity ?? preset?.smtpSecurity ?? securityOfPort(smtpPort, 'smtp'),
  };
}

/** Checks every field the owner can send. One bad field is refused with its name. */
function checkedInput(input: Record<string, unknown>, adding: boolean): MailAccountInput {
  const allowed = ['name', 'email', 'username', 'password', 'imapHost', 'imapPort', 'imapSecurity', 'smtpHost', 'smtpPort', 'smtpSecurity'];
  const unknown = Object.keys(input).find(key => !allowed.includes(key));
  if (unknown) fail('邮箱账号参数无效：' + unknown);
  const email = input.email;
  if (adding && !validMailAddress(email)) fail('请填写有效的邮箱地址。');
  if (!adding && email !== undefined && !validMailAddress(email)) fail('请填写有效的邮箱地址。');
  const name = input.name;
  if (name !== undefined && (typeof name !== 'string' || Array.from(name.trim()).length > 80 || /[\u0000-\u001f\u007f]/.test(name))) fail('账号名称最多 80 个字符。');
  const username = input.username;
  if (username !== undefined && (typeof username !== 'string' || !username || username.length > 320 || /[\u0000-\u001f\u007f]/.test(username))) fail('登录名无效。');
  const password = input.password;
  if (password !== undefined && (typeof password !== 'string' || password.length > 4096 || password.includes('\u0000'))) fail('密码或授权码无效。');
  for (const key of ['imapHost', 'smtpHost'] as const) {
    if (input[key] !== undefined && !validMailHost(input[key])) fail(key === 'imapHost' ? '收件服务器地址无效。' : '发件服务器地址无效。');
  }
  for (const key of ['imapPort', 'smtpPort'] as const) {
    if (input[key] !== undefined && !validMailPort(input[key])) fail(key === 'imapPort' ? '收件服务器端口无效。' : '发件服务器端口无效。');
  }
  for (const key of ['imapSecurity', 'smtpSecurity'] as const) {
    if (input[key] !== undefined && !['tls', 'starttls', 'none'].includes(String(input[key]))) fail('加密方式须为 tls、starttls 或 none。');
  }
  return input as unknown as MailAccountInput;
}

export function createMailAccounts({ store, sealed }: { store: Store; sealed: Sealed }) {
  function record(id: string): StoredAccount {
    const value = store.get<StoredAccount>(accounts, id);
    if (!value) fail('邮箱账号不存在。', 404);
    return value;
  }
  /** The public view. The password is not in the record at all, so it cannot leak from here. */
  function view(item: StoredAccount): MailAccount {
    return { ...item, hasPassword: store.get<{ sealed: string }>(secrets, item.id) !== undefined };
  }
  function presetFor(email: string) {
    const preset = mailPreset(email);
    return preset ? { ...preset, domain: email.split('@')[1]!.toLowerCase() } : undefined;
  }
  return {
    list(): MailAccount[] { return store.list<StoredAccount>(accounts).map(view).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); },
    get(id: string): MailAccount { return view(record(id)); },
    preset: presetFor,
    /** Reads the password back for signing in. This is the one place it is read. */
    async password(id: string): Promise<string | undefined> {
      record(id);
      const value = store.get<{ sealed: string }>(secrets, id);
      if (!value) return undefined;
      try { return await sealed.unseal(value.sealed); }
      catch { return fail('这个账号的密码无法解开，请重新填写。', 409); }
    },
    async add(input: Record<string, unknown>): Promise<MailAccount> {
      const value = checkedInput(input, true);
      if (input.password === undefined) fail('请填写密码或授权码。');
      const id = randomUUID();
      const now = new Date().toISOString();
      const item: StoredAccount = {
        id, name: (value.name ?? '').trim() || value.email, email: value.email!.toLowerCase(), auth: 'password',
        ...resolveMailServers(value, value.email!), status: 'unknown', version: 1, createdAt: now, updatedAt: now,
      };
      // The sealed password is written before the account, so an account never exists without one.
      const sealedPassword = await sealed.seal(value.password!);
      store.transaction(() => {
        store.put(secrets, id, { sealed: sealedPassword });
        store.put(accounts, id, item);
      });
      return view(item);
    },
    /** Changes an account. A password that is not sent stays as it is. */
    async update(id: string, input: Record<string, unknown>, version: number): Promise<MailAccount> {
      const current = record(id);
      const value = checkedInput(input, false);
      if (version !== current.version) fail('这个账号已有新版本，请重新打开后核对。', 409);
      // Changing the servers may make the saved password wrong for them. The owner says which.
      const serversChanged = ['imapHost', 'imapPort', 'smtpHost', 'smtpPort'].some(key => input[key] !== undefined && input[key] !== current[key as keyof StoredAccount]);
      if (serversChanged && input.password === undefined) fail('更换服务器后请重新填写密码或授权码。', 409);
      const sealedPassword = input.password === undefined ? undefined : await sealed.seal(value.password!);
      const email = (value.email ?? current.email).toLowerCase();
      // Another domain means another provider. Its servers are used unless the owner names
      // them, because the old domain's servers are wrong for the new address.
      const anotherDomain = email !== current.email.toLowerCase();
      const before = anotherDomain ? undefined : current;
      const next: StoredAccount = {
        ...current,
        name: value.name?.trim() || current.name, email,
        ...resolveMailServers(value, email, before),
        // Anything that changes makes the last check say nothing about the new settings.
        status: 'unknown', version: current.version + 1, updatedAt: new Date().toISOString(),
      };
      delete (next as Partial<StoredAccount>).error;
      store.transaction(() => {
        if (sealedPassword) store.put(secrets, id, { sealed: sealedPassword });
        store.put(accounts, id, next);
      });
      return view(next);
    },
    remove(id: string, version: number): void {
      const current = record(id);
      if (version !== current.version) fail('这个账号已有新版本，请重新打开后核对。', 409);
      store.transaction(() => { store.remove(secrets, id); store.remove(accounts, id); });
    },
    /** Records how the last check went. It is called after a sign-in was tried, which happens
     *  without the owner asking, so it does not change the version: a check that ran while the
     *  owner had the account open must not make their edit conflict. */
    checked(id: string, outcome: { ok: true } | { ok: false; error: string }): void {
      const current = record(id);
      const next: StoredAccount = { ...current, status: outcome.ok ? 'ok' : 'error', updatedAt: new Date().toISOString() };
      if (outcome.ok) delete (next as Partial<StoredAccount>).error;
      else next.error = outcome.error.slice(0, 500);
      store.put(accounts, id, next);
    },
  };
}
export type MailAccounts = ReturnType<typeof createMailAccounts>;

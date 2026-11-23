import { execFile } from 'node:child_process';
import { createFeishuIntegration } from './feishu.ts';
import type { PersonalBatch, PersonalChatDetail, PersonalCheckpoint } from './feishu.ts';
export type { PersonalBatch, PersonalCheckpoint } from './feishu.ts';

// Only read permissions. Sending as the user is never requested by this flow.
export const PERSONAL_MESSAGE_SCOPES = ['search:message', 'im:message:readonly', 'im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user', 'im:chat:read'];
type Row = Record<string, any>;
export interface PersonalAccount { profile: string; appId: string; openId: string; name: string }
export interface PersonalApplication { profile: string; appId: string; appSecret?: string }
export interface PersonalAuthorization { url: string; code: string; expiresIn: number }
export class PersonalAuthError extends Error {
  readonly kind: 'unavailable' | 'needs_application' | 'permissions' | 'expired' | 'denied' | 'failed' | 'request' | 'timeout' | 'rate_limited' | 'collection' | 'cursor';
  readonly apiCode?: number;
  constructor(kind: PersonalAuthError['kind'], apiCode?: unknown) {
    const code = typeof apiCode === 'number' && Number.isSafeInteger(apiCode) ? apiCode : undefined;
    const message = { unavailable: '服务缺少飞书连接组件，请联系部署者安装 lark-cli 后重试。', needs_application: '请先扫码连接一个飞书应用，再回来授权个人账号。', permissions: '飞书应用尚未获得所需的消息读取权限。请由应用管理员开通权限并发布后，重新授权。', expired: '飞书授权已过期，请重新授权。', denied: '你已取消或拒绝授权，个人消息采集保持关闭。', failed: '飞书授权未完成，请检查网络后重试。', request: '飞书拒绝了消息读取请求：参数校验失败。这是连接程序问题，无需重新授权。', timeout: '读取飞书消息超时，请稍后重试采集。', rate_limited: '飞书暂时限制了读取频率，请稍后重试采集。', cursor: '飞书分页游标已失效，将从原窗口重新读取。', collection: '读取飞书消息未完成，请稍后重试采集。' }[kind];
    super(`${message}${code === undefined ? '' : `（飞书错误码：${code}）`}`);
    this.kind = kind;
    this.apiCode = code;
  }
}
/** Adapter layers retain causes; only this allowlisted classification reaches the UI. */
export function personalProblem(error: unknown): PersonalAuthError | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++, current = current.cause) {
    if (current instanceof PersonalAuthError) return current;
  }
  return undefined;
}
export type PersonalCLI = (args: string[], options: { signal: AbortSignal; input?: string; timeout?: number; cwd?: string; maxFileBytes?: number }) => Promise<Row>;
/** CLI output may contain credentials; only typed, fixed messages cross this boundary. */
export const runPersonalCLI: PersonalCLI = (args, options) => new Promise((resolve, reject) => {
  // Linux applies the bound in the writer, before an untrusted attachment can fill the disk.
  const command = options.maxFileBytes === undefined ? 'lark-cli' : 'prlimit';
  const argv = options.maxFileBytes === undefined ? args : ['--fsize=' + options.maxFileBytes, '--', 'lark-cli', ...args];
  const child = execFile(command, argv, { cwd: options.cwd, signal: options.signal, timeout: options.timeout ?? 30_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
  }, (error, stdout, stderr) => {
    if (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new PersonalAuthError('unavailable'));
      let detail = '', failure: Row = {};
      try { const data = JSON.parse(stderr); failure = data.error ?? {}; detail = JSON.stringify(failure); } catch { /* Do not expose raw CLI output. */ }
      const invalidCursor = /(?:page[_ -]?token|pagination[_ -]?token|cursor).*(?:invalid|expir)|(?:invalid|expir).*?(?:page[_ -]?token|cursor)/i.test(detail);
      const kind = invalidCursor ? 'cursor' : failure.subtype === 'invalid_parameters' || failure.code === 99992402 ? 'request'
        : ['permission_denied', 'missing_scope', 'forbidden'].includes(failure.subtype) ? 'permissions'
        : ['rate_limited', 'too_many_requests'].includes(failure.subtype) || failure.type === 'rate_limit' ? 'rate_limited' : error.killed ? 'timeout'
        : /expired|expire_token/i.test(detail) ? 'expired' : /denied|access_denied|cancel/i.test(detail) ? 'denied'
        : /scope|permission|privilege/i.test(detail) ? 'permissions' : /not.configured|profile.not.found|config.*not.*found/i.test(detail) ? 'needs_application' : 'failed';
      return reject(new PersonalAuthError(kind, failure.code));
    }
    try { const data = JSON.parse(stdout); if (data.ok === false) throw new Error(); resolve(data); }
    catch { reject(new PersonalAuthError('failed')); }
  });
  child.stdin?.on('error', () => { /* Process failures are handled by the execFile callback. */ });
  child.stdin?.end(options.input ?? '');
});

// Comment publication and personal collection must bind to the verified account behind
// a profile. The profile name alone survives signing out and signing in as someone else.
async function verifiedProfile(profile: string, signal: AbortSignal, cli: PersonalCLI) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(profile)) throw new PersonalAuthError('failed');
  signal.throwIfAborted();
  const raw = await cli(['--profile', profile, 'auth', 'status', '--json', '--verify'], {signal});
  signal.throwIfAborted();
  const data = raw.data ?? raw, user = data.identities?.user;
  if (data.identity !== 'user' || data.verified !== true || user?.available !== true ||
      typeof data.appId !== 'string' || !data.appId || typeof user.openId !== 'string' || !user.openId)
    throw new PersonalAuthError('failed');
  const name = typeof user.userName === 'string' && user.userName.trim() ? user.userName : '';
  return {appId: data.appId as string, openId: user.openId as string, name: name as string,
    scopes: typeof user.scope === 'string' ? user.scope.split(/[\s,]+/) as string[] : []};
}

export async function verifyKnowledgeCommentActor(profile: string, signal: AbortSignal) {
  const {appId, openId, name} = await verifiedProfile(profile, signal, runPersonalCLI);
  return {appId, openId, name: name || openId};
}

export interface PersonalProvider {
  application(signal: AbortSignal): Promise<PersonalApplication>;
  begin(application: PersonalApplication, signal: AbortSignal): Promise<PersonalAuthorization>;
  complete(application: PersonalApplication, authorization: PersonalAuthorization, signal: AbortSignal): Promise<PersonalAccount>;
  verify(account: PersonalAccount, signal: AbortSignal): Promise<PersonalAccount>;
  collectBatch?(account: PersonalAccount, signal: AbortSignal, checkpoint?: PersonalCheckpoint): Promise<PersonalBatch>;
  collect(account: PersonalAccount, signal: AbortSignal): Promise<import('../packages/protocol/src/index.ts').InboxThing[]>;
}
export function createPersonalProvider(options: {
  application: () => PersonalApplication | undefined; fallbackApplication?: () => PersonalApplication | undefined; runCLI?: PersonalCLI;
  collectionPageLimit?: number;
}): PersonalProvider {
  const cli = options.runCLI ?? runPersonalCLI;
  // Share only within this provider and verified identity. Cache empty results too
  // so inaccessible chats cannot trigger a detail request on every search page.
  const details = new Map<string, { detail: PersonalChatDetail; expiresAt: number }>();
  async function chatDetail(account: PersonalAccount, signal: AbortSignal, chatId: string): Promise<PersonalChatDetail> {
    signal.throwIfAborted();
    const key = JSON.stringify([account.appId, account.profile, account.openId, chatId]);
    const cached = details.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.detail;
    const detail: PersonalChatDetail = {};
    try {
      const raw = await cli(['--profile', account.profile, '--as', 'user', 'im', 'chats', 'get', '--chat-id', chatId, '--format', 'json'], { signal });
      if (raw.ok === true && raw.identity === 'user') {
        const mode = raw.data?.chat_mode;
        if (mode === 'topic') detail.mode = 'group';
        else if (mode === 'group' || mode === 'p2p') detail.mode = mode;
        const rawCount = raw.data?.user_count;
        const count = typeof rawCount === 'string' && /^\d+$/.test(rawCount) ? Number(rawCount) : rawCount;
        if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) detail.userCount = count;
      }
    } catch {
      // Metadata lookup is optional. Cancellation still propagates below.
    }
    signal.throwIfAborted();
    details.delete(key);
    if (details.size >= 256) details.delete(details.keys().next().value!);
    details.set(key, { detail, expiresAt: Date.now() + 60_000 });
    return detail;
  }
  async function verify(account: PersonalApplication, signal: AbortSignal): Promise<PersonalAccount> {
    const actor = await verifiedProfile(account.profile, signal, cli);
    if (actor.appId !== account.appId) throw new PersonalAuthError('failed');
    if (!PERSONAL_MESSAGE_SCOPES.every(scope => actor.scopes.includes(scope))) throw new PersonalAuthError('permissions');
    return { profile: account.profile, appId: actor.appId, openId: actor.openId, name: actor.name || '飞书用户' };
  }
  return {
    async application(signal) {
      // Workbench application selection takes precedence over the host CLI default.
      const configured = options.application() ?? options.fallbackApplication?.();
      if (configured?.appSecret) {
        // The secret travels through stdin, never argv or the browser.
        await cli(['config', 'init', '--name', configured.profile, '--app-id', configured.appId, '--app-secret-stdin'], { signal, input: configured.appSecret });
        return { profile: configured.profile, appId: configured.appId };
      }
      const raw = await cli([...(configured ? ['--profile', configured.profile] : []), 'config', 'show'], { signal });
      const data = raw.data ?? raw;
      if (configured && (data.appId !== configured.appId || data.profile !== configured.profile)) throw new PersonalAuthError('needs_application');
      if (!data.profile || !/^cli_[A-Za-z0-9]+$/.test(data.appId ?? '')) throw new PersonalAuthError('needs_application');
      return { profile: data.profile, appId: data.appId };
    },
    async begin(application, signal) {
      const raw = await cli(['--profile', application.profile, 'auth', 'login', '--scope', PERSONAL_MESSAGE_SCOPES.join(' '), '--no-wait', '--json'], { signal });
      const data = raw.data ?? raw;
      if (typeof data.verification_url !== 'string' || typeof data.device_code !== 'string' || !data.device_code) throw new PersonalAuthError('failed');
      const url = new URL(data.verification_url);
      if (url.protocol !== 'https:' || !['accounts.feishu.cn', 'accounts.larksuite.com'].includes(url.hostname) || url.username || url.password || url.port) throw new PersonalAuthError('failed');
      return { url: data.verification_url, code: data.device_code, expiresIn: Math.min(900, Math.max(30, Number(data.expires_in) || 240)) };
    },
    async complete(application, authorization, signal) {
      await cli(['--profile', application.profile, 'auth', 'login', '--device-code', authorization.code, '--json'], { signal, timeout: authorization.expiresIn * 1000 });
      return verify(application, signal);
    },
    verify,
    async collectBatch(account, signal, checkpoint) {
      const current = await verify(account, signal);
      if (current.openId !== account.openId) throw new PersonalAuthError('failed');
      const adapter = createFeishuIntegration({ appId: account.appId, appSecret: '', profile: account.profile, personalOpenId: account.openId,
        ...(options.collectionPageLimit ? { personalCollectionPageLimit: options.collectionPageLimit } : {}),
        personalChatDetail: chatId => chatDetail(account, signal, chatId),
        runCLI: args => cli(args, { signal }), onMessage: async () => undefined, onInbox: async () => {} });
      try {
        return await adapter.collectBatch(checkpoint);
      } finally { await adapter.close(); }
    },
    async collect(account, signal) {
      const current = await verify(account, signal);
      if (current.openId !== account.openId) throw new PersonalAuthError('failed');
      // Personal collection has its own lifecycle; it does not open a second bot WebSocket.
      const adapter = createFeishuIntegration({ appId: '', appSecret: '', profile: account.profile, personalOpenId: account.openId,
        personalChatDetail: chatId => chatDetail(account, signal, chatId),
        runCLI: args => cli(args, { signal }), onMessage: async () => undefined, onInbox: async () => {} });
      try {
        return await adapter.collect();
      } finally { await adapter.close(); }
    },
  };
}

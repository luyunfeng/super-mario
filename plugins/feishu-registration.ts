import { deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerApp } from '@larksuiteoapi/node-sdk';

export type RegistrationStage = 'waiting_for_scan' | 'creating_app' | 'configuring' | 'publishing' | 'verifying';
export interface RegistrationStep { code: string; message: string; url: string }
export interface RegistrationProgress { stage: RegistrationStage; url?: string; expiresAt?: string }
export interface RegistrationResult { appId: string; appSecret: string; verified: boolean; outcome?: 'unknown'; missingSteps: RegistrationStep[]; ownerOpenId?: string }
export interface RegistrationTrace {
  step: 'qr-init' | 'qr-poll' | 'cross-login' | 'login-session' | 'console-identity' | 'app-setup' | 'verify-release' | 'verify-subscriptions' | 'verify-permissions';
  httpStatus?: number; platformCode?: number; platformLogId?: string; redirectHost?: string;
  reason?: 'redirect-host' | 'transport' | 'missing-console-identity' | 'missing-qr' | 'invalid-response';
}
export interface RegistrationContext {
  workbench?: boolean;
  trace?(info: RegistrationTrace): void;
  name: string; signal: AbortSignal; progress(info: RegistrationProgress): void;
}
export interface FeishuRegistrationProvider { register(context: RegistrationContext): Promise<RegistrationResult> }
export class RegistrationError extends Error {
  readonly outcome: 'failed' | 'unknown' | 'expired';
  constructor(outcome: 'failed' | 'unknown' | 'expired') { super(`Feishu registration ${outcome}`); this.outcome = outcome; }
}
class PlatformHttpError extends RegistrationError {
  readonly status: number;
  constructor(status: number, method: string) {
    super(status >= 500 && method === 'POST' ? 'unknown' : 'failed');
    this.status = status;
  }
}
class PlatformBusinessRejection extends RegistrationError {
  constructor() { super('failed'); }
}
function isDefiniteCreateRejection(error: unknown) {
  return error instanceof PlatformBusinessRejection || (error instanceof PlatformHttpError && error.status === 404);
}
const open = 'https://open.feishu.cn';
const accounts = 'https://accounts.feishu.cn';
export const FEISHU_BOT_SCOPES = ['im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot', 'contact:user.id:readonly'] as const;
const workbenchScopes = ['im:message.pins:write_only', 'im:message:recall'];
const botEvents = (workbench?: boolean) => workbench ? ['im.message.receive_v1', 'im.message.recalled_v1'] : ['im.message.receive_v1'];
const callbackNames = ['card.action.trigger'];
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const str = (value: unknown) => typeof value === 'string' ? value : '';
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const ids = (value: unknown): string[] => Array.isArray(value) ? value.map(v => typeof v === 'string' ? v : str(row(v).id)).filter(Boolean) : [];
const appIdValid = (id: string) => /^cli_[a-fA-F0-9]{16}$/.test(id);
export function feishuRegistrationSteps(appId?: string, workbench = false): RegistrationStep[] {
  const base = appIdValid(appId ?? '') ? `${open}/app/${appId}` : `${open}/app`;
  return [
    { code: 'permissions', message: `开通并审批机器人权限：${FEISHU_BOT_SCOPES.join('、')}${workbench ? '。工作台卡片另需：' + workbenchScopes.join('、') : ''}`, url: `${base}/auth` },
    { code: 'events', message: '启用机器人能力；事件和卡片回调使用长连接；订阅 im.message.receive_v1 和 card.action.trigger' + (workbench ? '，并订阅 im.message.recalled_v1 以停止已撤回的读群请求' : ''), url: `${base}/event` },
    { code: 'publish', message: '发布版本并等待审批通过，然后核验线上权限；机器人目前禁用', url: `${base}/version` },
  ];
}

function appIcon(): Buffer {
  const chunk = (kind: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(kind), data]);
    let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, content, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(512, 0); header.writeUInt32BE(512, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(512 * (1 + 512 * 3));
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const m = y >= 150 && y <= 360 && ((x >= 110 && x <= 150) || (x >= 362 && x <= 402) || Math.abs(y - (x < 256 ? x + 20 : 532 - x)) < 24 && y <= 280 && x >= 130 && x <= 382);
    const offset = y * 1537 + 1 + x * 3; pixels[offset] = m ? 255 : 37; pixels[offset + 1] = m ? 255 : 99; pixels[offset + 2] = m ? 255 : 235;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

interface Cookie { name: string; value: string; domain: string; path: string; hostOnly: boolean; expiresAt?: number }
// Only these Feishu hosts may receive requests. Redirects are checked before sending any header.
const consoles = new Set(['open.feishu.cn', 'open.larkoffice.com']);
const hosts = new Set([...consoles, 'login.feishu.cn', 'accounts.feishu.cn', 'accounts.larkoffice.com', 'ask.feishu.cn']);
function checkedURL(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) throw new RegistrationError('failed');
  return url;
}
function validCookie(value: unknown): value is Cookie {
  const c = row(value);
  return typeof c.name === 'string' && /^[!#$%&'*+.^_`|~\w-]+$/.test(c.name)
    && typeof c.value === 'string' && !/[\s;\x00-\x1f\x7f]/.test(c.value)
    && typeof c.domain === 'string' && (hosts.has(c.domain) || c.domain === 'feishu.cn' || c.domain === 'larkoffice.com')
    && typeof c.path === 'string' && c.path.startsWith('/') && !/[\r\n]/.test(c.path)
    && typeof c.hostOnly === 'boolean' && (c.expiresAt === undefined || typeof c.expiresAt === 'number' && c.expiresAt > Date.now());
}
function privateWrite(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file); chmodSync(file, 0o600);
}
/** Login cookies never share the bot configuration file. Constructing this provider performs no I/O to Feishu. */
export function createFeishuRegistrationProvider(options: {
  dataDir: string; fetch?: typeof fetch; pollMs?: number; timeoutMs?: number; loginTimeoutMs?: number;
  mode?: 'web' | 'device'; registerApp?: typeof registerApp;
}): FeishuRegistrationProvider {
  const directory = join(options.dataDir, 'private', 'feishu-registration');
  const sessionFile = join(directory, 'session.json');
  let busy = false;
  return {
    async register(context) {
      if (busy) throw new RegistrationError('failed');
      busy = true;
      try {
        if (options.mode === 'device') {
          // Installed official SDK supports registration, but device credentials do not imply a Web login.
          const credentials = await (options.registerApp ?? registerApp)({
            source: 'super-mario', createOnly: true, signal: context.signal,
            appPreset: { name: context.name, desc: 'AI workbench bot' },
            addons: { scopes: { tenant: [...FEISHU_BOT_SCOPES, ...(context.workbench ? workbenchScopes : [])] }, events: { items: { tenant: botEvents(context.workbench) } }, callbacks: { items: callbackNames } },
            onQRCodeReady(info) { context.progress({ stage: 'waiting_for_scan', url: info.url, expiresAt: new Date(Date.now() + info.expireIn * 1000).toISOString() }); },
          });
          context.signal.throwIfAborted();
          return { appId: credentials.client_id, appSecret: credentials.client_secret, verified: false, missingSteps: feishuRegistrationSteps(credentials.client_id, context.workbench) };
        }
        mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
        let cookies: Cookie[] = [];
        if (existsSync(sessionFile)) {
          chmodSync(sessionFile, 0o600);
          try { const saved = row(JSON.parse(readFileSync(sessionFile, 'utf8'))); cookies = Array.isArray(saved.cookies) ? saved.cookies.filter(validCookie) : []; } catch { /* An invalid cache requires a new scan. */ }
        }
        let trace: RegistrationTrace = { step: 'console-identity' };
        const record = (input: Partial<RegistrationTrace>) => {
          trace = { ...trace, ...input }; context.trace?.(trace);
        };
        const begin = (step: RegistrationTrace['step']) => { trace = { step }; context.trace?.(trace); };
        const allowed = (address: string) => {
          try { return checkedURL(address); }
          catch (error) {
            // The location may carry a one-time ticket. Keep only its DNS hostname.
            const host = URL.canParse(address) ? new URL(address).hostname : '';
            record({ reason: 'redirect-host', ...(/^[a-z0-9.-]{1,253}$/i.test(host) ? { redirectHost: host } : {}) });
            throw error;
          }
        };
        async function request(address: string, init: RequestInit = {}): Promise<{ text: string; headers: Headers; url: string }> {
          let url = allowed(address), method = init.method ?? 'GET', body = init.body;
          const boundedSignal = AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)]);
          for (let hop = 0; hop < 10; hop++) {
            boundedSignal.throwIfAborted();
            const headers = new Headers(init.headers);
            if (url.origin !== new URL(address).origin) { headers.delete('x-csrf-token'); headers.delete('x-flow-key'); headers.delete('origin'); headers.delete('referer'); headers.delete('authorization'); }
            const available = cookies.filter(c => validCookie(c) && (c.hostOnly ? url.hostname === c.domain : url.hostname === c.domain || url.hostname.endsWith(`.${c.domain}`)) && (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`)));
            headers.delete('cookie');
            if (available.length) headers.set('cookie', available.sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; '));
            begin(trace.step);
            const response = await (options.fetch ?? fetch)(url.href, { ...init, method, body, headers, redirect: 'manual', signal: boundedSignal }).catch(error => { record({ reason: 'transport' }); throw error; });
            const upstream = response.headers.get('x-tt-logid') || response.headers.get('x-request-id');
            record({ httpStatus: response.status, ...(upstream && /^[A-Za-z0-9_-]{8,96}$/.test(upstream) ? { platformLogId: upstream } : {}) });
            boundedSignal.throwIfAborted();
            for (const header of response.headers.getSetCookie()) {
              const parts = header.split(';').map(v => v.trim()), first = parts.shift() ?? '', equal = first.indexOf('=');
              if (equal < 1) continue;
              const cookie: Cookie = { name: first.slice(0, equal), value: first.slice(equal + 1), domain: url.hostname, path: url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/', hostOnly: true };
              let maxAge: number | undefined;
              for (const part of parts) {
                const index = part.indexOf('='), key = (index < 0 ? part : part.slice(0, index)).toLowerCase(), val = part.slice(index + 1);
                if (key === 'domain') { cookie.domain = val.replace(/^\./, '').toLowerCase(); cookie.hostOnly = false; }
                if (key === 'path') cookie.path = val;
                if (key === 'expires') cookie.expiresAt = Date.parse(val);
                if (key === 'max-age' && /^-?\d+$/.test(val)) maxAge = Number(val);
              }
              if (maxAge !== undefined) cookie.expiresAt = Date.now() + maxAge * 1000;
              // Reject public suffixes, foreign domains, control characters, and sibling-domain injection.
              if (!(url.hostname === cookie.domain || url.hostname.endsWith(`.${cookie.domain}`))) continue;
              const previous = cookies.filter(c => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
              const expired = cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now();
              if (validCookie(cookie)) cookies = [...previous, cookie];
              else if (expired) cookies = previous;
            }
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              const location = response.headers.get('location'); if (!location) throw new RegistrationError('failed');
              const next = allowed(new URL(location, url).href);
              // Console POSTs must never silently replay on a redirect.
              if (method !== 'GET' && method !== 'HEAD') throw new RegistrationError('unknown');
              url = next; await response.body?.cancel(); continue;
            }
            if (!response.ok) { await response.body?.cancel(); throw new PlatformHttpError(response.status, method); }
            const text = await response.text(); boundedSignal.throwIfAborted();
            return { text, headers: response.headers, url: url.href };
          }
          throw new RegistrationError('failed');
        }
        const json = async (address: string, body: unknown, headers: Record<string, string> = {}) => {
          const response = await request(address, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
          let payload: Row;
          try { payload = row(JSON.parse(response.text)); } catch (error) { record({ reason: 'invalid-response' }); throw error; }
          if (Number.isSafeInteger(payload.code)) record({ platformCode: Number(payload.code) });
          if (typeof payload.code === 'number' && payload.code !== 0) throw new PlatformBusinessRejection();
          if (payload.code !== 0) throw new RegistrationError('failed');
          return { data: { ...payload, ...row(payload.data) }, headers: response.headers };
        };
        const pageInfo = async () => {
          begin('console-identity');
          const page = await request(`${open}/app`);
          if (!consoles.has(new URL(page.url).hostname)) {
            record({ reason: 'missing-console-identity' });
            throw new RegistrationError('failed');
          }
          const csrf = page.text.match(/\b(?:window\.csrfToken\s*=|csrfToken\s*:)\s*['"]([^'"]+)['"]/)?.[1];
          // Parse only the balanced JSON object; never evaluate console JavaScript.
          const start = page.text.search(/\bwindow\.user\s*=/);
          let user: Row = {};
          if (start >= 0) {
            const tail = page.text.slice(start), begin = tail.indexOf('{');
            for (let end = begin + 1; begin >= 0 && end < tail.length; end++) if (tail[end] === '}') {
              try { user = row(JSON.parse(tail.slice(begin, end + 1))); break; } catch { /* Continue to the outer object. */ }
            }
          }
          return { csrf, userId: str(user.id ?? user.userId ?? user.user_id), email: str(user.email), origin: new URL(page.url).origin };
        };
        // An unusable cached console login can always be replaced by a fresh scan.
        let page = cookies.length ? await pageInfo().catch(() => undefined) : undefined;
        context.signal.throwIfAborted();
        if (!page?.csrf || !page.userId) {
          cookies = [];
          const loginHeaders = { accept: 'application/json', 'x-api-version': '1.0.28', 'x-app-id': '12', 'x-locale': 'zh-CN', 'x-terminal-type': '2', 'x-device-info': 'device_id=0;device_name=Chrome;device_os=Linux;device_model=Chrome;lark_version=;channel=Release;package_name=feishu;tt_app_id=1658;is_dpop_support=true;is_iframe=false' };
          const loginUrl = (step: 'init' | 'polling') => `${accounts}/accounts/qrlogin/${step}?_r=${Date.now()}`;
          begin('qr-init');
          const initialized = await json(loginUrl('init'), { biz_type: null, redirect_uri: 'https://ask.feishu.cn/' }, loginHeaders);
          const token = str(row(initialized.data.step_info).token), flowKey = initialized.headers.get('x-flow-key');
          if (!token || !flowKey) { record({ reason: 'missing-qr' }); throw new RegistrationError('failed'); }
          const deadline = Date.now() + (options.loginTimeoutMs ?? 120_000);
          // Feishu mobile scanner consumes this JSON payload, not a browser navigation URL.
          context.progress({ stage: 'waiting_for_scan', url: JSON.stringify({ qrlogin: { token } }), expiresAt: new Date(deadline).toISOString() });
          for (;;) {
            context.signal.throwIfAborted(); if (Date.now() >= deadline) throw new RegistrationError('expired');
            // Polling only reads this challenge. A transient transport error must not discard the displayed QR.
            begin('qr-poll');
            const poll = await json(loginUrl('polling'), { biz_type: null }, { ...loginHeaders, 'x-flow-key': flowKey }).catch(error => {
              if (context.signal.aborted || !(error instanceof TypeError || error?.name === 'TimeoutError' || (error instanceof PlatformHttpError && error.status >= 500))) throw error;
              return undefined;
            });
            if (!poll) { await delay(options.pollMs ?? 1500, undefined, { signal: context.signal }); continue; }
            const step = row(poll.data.step_info);
            if (step.status === 5) throw new RegistrationError('expired');
            if (poll.data.next_step === 'enter_app') {
              const cross = str(step.cross_login_uri); if (cross) { begin('cross-login'); await request(cross); }
              begin('login-session');
              await request('https://ask.feishu.cn/'); page = await pageInfo(); break;
            }
            await delay(options.pollMs ?? 1500, undefined, { signal: context.signal });
          }
        }
        if (!page?.csrf || !page.userId) { record({ reason: 'missing-console-identity' }); throw new RegistrationError('failed'); }
        begin('app-setup');
        context.signal.throwIfAborted(); privateWrite(sessionFile, { cookies: cookies.filter(validCookie) });
        const activePage = page;
        const post = async (path: string, body: unknown = {}) => (await json(`${activePage.origin}/developers/v1/${path}`, body, { 'x-csrf-token': activePage.csrf!, origin: activePage.origin, referer: `${activePage.origin}/app` })).data;
        context.progress({ stage: 'creating_app' });
        // Generate our own PNG; the console icon upload accepts raster images.
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(appIcon())], { type: 'image/png' }), 'app.png');
        form.append('uploadType', '4'); form.append('isIsv', 'false'); form.append('scale', JSON.stringify({ width: 512, height: 512 }));
        const upload = await request(`${activePage.origin}/developers/v1/app/upload/image`, { method: 'POST', headers: { 'x-csrf-token': activePage.csrf!, origin: activePage.origin, referer: `${activePage.origin}/app` }, body: form });
        const uploaded = row(JSON.parse(upload.text)); const avatar = str(row(uploaded.data).url ?? uploaded.url);
        if (uploaded.code !== 0 || !avatar) throw new RegistrationError('failed');
        const description = 'AI workbench bot';
        const i18n = { zh_cn: { name: context.name, description } };
        // Only a business rejection or an absent endpoint confirms the create did not succeed.
        async function createApp(path: string, body: Row): Promise<Row> {
          try { return await post(path, body); }
          catch (error) {
            if (isDefiniteCreateRejection(error)) throw error;
            throw new RegistrationError('unknown');
          }
        }
        let created: Row;
        try {
          created = await createApp('manifest/upsert_by_template', { appManifestTemplateID: 'developer_console', createAppUserCustomField: { i18n, avatar, primaryLang: 'zh_cn' }, cid: randomUUID(), HTTPHead: {} });
        } catch (error) {
          if (!isDefiniteCreateRejection(error)) throw error;
          context.signal.throwIfAborted();
          created = await createApp('app/create', { appSceneType: 0, name: context.name, desc: description, avatar, i18n, primaryLang: 'zh_cn' });
        }
        const appId = str(created.ClientID ?? created.clientID ?? created.clientId ?? created.appId);
        if (!appIdValid(appId)) throw new RegistrationError('unknown');
        const appSecret = str((await post(`secret/${appId}`).catch(() => { throw new RegistrationError('unknown'); })).secret);
        if (!appSecret) throw new RegistrationError('unknown');
        const result: RegistrationResult = { appId, appSecret, verified: false, missingSteps: feishuRegistrationSteps(appId, context.workbench) };
        try {
          context.progress({ stage: 'configuring' });
          const catalog = await post(`scope/all/${appId}`);
          const scopes: Array<{ name: string; id: string; bucket?: string }> = [];
          const collect = (value: unknown, bucket?: string): void => {
            if (Array.isArray(value)) { value.forEach(v => collect(v, bucket)); return; }
            const r = row(value), name = str(r.scope_name ?? r.scopeName ?? r.name ?? r.key ?? r.scopeKey), id = str(r.id ?? r.scope_id ?? r.scopeId ?? r.scopeID);
            if (name && id) scopes.push({ name, id, bucket });
            for (const [key, child] of Object.entries(r)) if (child && typeof child === 'object') collect(child, /user/i.test(key) ? 'user' : /app|client|tenant/i.test(key) ? 'tenant' : bucket);
          };
          collect(catalog);
          const tenantScope = (name: string) => scopes.find(s => s.name === name && s.bucket === 'tenant') ?? scopes.find(s => s.name === name && !s.bucket);
          const scopeIds = FEISHU_BOT_SCOPES.map(tenantScope);
          if (scopeIds.some(s => !s)) return result;
          // A tenant without pin management can still use ordinary private chat.
          if (context.workbench) for (const name of workbenchScopes) {
            const scope = tenantScope(name);
            if (scope) scopeIds.push(scope);
          }
          await post(`scope/update/${appId}`, { clientId: appId, appScopeIDs: scopeIds.map(s => s!.id), userScopeIDs: [], scopeIds: [], operation: 'add', isDeveloperPanel: true });
          await post(`robot/switch/${appId}`, { clientId: appId, enable: true });
          await post(`event/switch/${appId}`, { clientId: appId, eventMode: 4 });
          await post(`event/update/${appId}`, { clientId: appId, operation: 'add', events: [], appEvents: botEvents(context.workbench), userEvents: [], eventMode: 4 });
          await post(`callback/switch/${appId}`, { clientId: appId, callbackMode: 4 });
          await post(`callback/update/${appId}`, { clientId: appId, operation: 'add', callbacks: callbackNames, callbackMode: 4 });
          context.progress({ stage: 'publishing' });
          const visibility = { departments: [], members: [activePage.userId], groups: [], isAll: 0 };
          let version: Row;
          try {
            version = await post(`app_version/create/${appId}`, { appVersion: '1.0.0', mobileDefaultAbility: 'bot', pcDefaultAbility: 'bot', changeLog: 'Initial bot release.', visibleSuggest: visibility, blackVisibleSuggest: { ...visibility, members: [] } });
            const versionId = str(version.versionId ?? version.version_id ?? version.id ?? row(version.appVersion).versionId);
            if (!versionId) throw new RegistrationError('unknown');
            await post(`publish/commit/${appId}/${versionId}`, { clientId: appId });
            context.progress({ stage: 'verifying' });
            begin('verify-release');
            // Publication can become visible after the commit response. Repeat only the status read.
            for (let attempt = 0; ; attempt++) {
              const versions = await post(`app_version/list/${appId}`);
              if (rows(versions.versions).some(v => str(v.versionId ?? v.version_id ?? v.id) === versionId && v.versionStatus === 2)) break;
              if (attempt === 4) return result;
              await delay(options.pollMs ?? 1500, undefined, { signal: context.signal });
            }
          } catch { context.signal.throwIfAborted(); result.outcome = 'unknown'; return result; }
          begin('verify-subscriptions');
          const events = await post(`event/${appId}`, { needEventDetail: true });
          const callbacks = await post(`callback/${appId}`);
          const subscribed = [...ids(events.events), ...ids(events.appEvents), ...rows(events.appEventDetails).flatMap(v => ids(v.items)), ...rows(events.eventDetails).flatMap(v => ids(v.items))];
          if (events.eventMode !== 4 || !botEvents(context.workbench).every(e => subscribed.includes(e)) || callbacks.callbackMode !== 4 || !callbackNames.every(e => ids(callbacks.callbacks).includes(e))) return result;
          // Public API readback checks actually granted tenant scopes after publication, not the console catalog.
          begin('verify-permissions');
          const tokenRaw = await request(`${open}/open-apis/auth/v3/tenant_access_token/internal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }) });
          const tokenPayload = row(JSON.parse(tokenRaw.text)); const token = str(tokenPayload.tenant_access_token);
          if (tokenPayload.code !== 0 || !token) return result;
          const permissionRaw = await request(`${open}/open-apis/application/v6/scopes`, { headers: { Authorization: `Bearer ${token}` } });
          const permissions = row(JSON.parse(permissionRaw.text));
          const granted = rows(row(permissions.data).scopes).filter(s => s.grant_status === 1 && s.scope_type !== 'user').map(s => str(s.scope_name));
          if (permissions.code !== 0 || !FEISHU_BOT_SCOPES.every(s => granted.includes(s))) return result;
          result.verified = true; result.missingSteps = [];
          // Resolve the scanner's email with this app's own token. An open_id
          // returned for another application is never trusted as its owner.
          if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(activePage.email)) {
            try {
              const ownerRaw = await request(`${open}/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id`, {
                method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ emails: [activePage.email], include_resigned: false }),
              });
              const ownerPayload = row(JSON.parse(ownerRaw.text));
              const matches = rows(row(ownerPayload.data).user_list).filter(user => typeof user.email === 'string' && user.email.toLowerCase() === activePage.email.toLowerCase());
              if (ownerPayload.code === 0 && matches.length === 1 && /^ou_[A-Za-z0-9]+$/.test(str(matches[0].user_id))) result.ownerOpenId = str(matches[0].user_id);
            } catch { context.signal.throwIfAborted(); /* Explicit pairing remains available if identity cannot be resolved. */ }
          }
          privateWrite(sessionFile, { cookies: cookies.filter(validCookie) });
          return result;
        } catch (error) {
          context.signal.throwIfAborted();
          if (error instanceof RegistrationError && error.outcome === 'unknown') throw error;
          return result;
        }
      } finally { busy = false; }
    },
  };
}

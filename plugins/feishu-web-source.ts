// 网页网关公开 HTTP 接口。status 确认连接，config 返回当前账号及状态更新时间，
// inbox 返回最近一页（最多 60 条，含已处理消息）。轮询期间超出该窗口的消息无法补读。
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { InboxThing } from '../packages/protocol/src/index.ts';

export interface FeishuWebAccount { accountKey: string }
export interface FeishuWebSourceStatus { enabled: boolean; connected: boolean; error?: string; lastReceivedAt?: string }
export interface FeishuWebSourceOptions {
  baseUrl: string;
  token?: string;
  pollIntervalMs?: number;
  onInbox(items: InboxThing[], account: FeishuWebAccount): Promise<void>;
}

// Only these messages may reach the public status. Never include a URL, credential,
// response body, or an exception thrown by a transport or downstream classifier.
class SourceError extends Error {}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }

function identity(value: unknown) {
  const row = record(value);
  const user = string(record(row.account).userId);
  if (!user || !['feishu', 'lark'].includes(String(row.region))) throw new SourceError('网关未提供可核验的网页账号');
  return createHash('sha256').update(JSON.stringify([row.region, user])).digest('hex');
}

function session(value: unknown, accountKey: string) {
  const row = record(value);
  const config = record(row.config);
  if (row.state !== 'connected' || config.listening !== true ||
      identity({ region: config.region, account: row.account }) !== accountKey) {
    throw new SourceError('网页账号连接已变化');
  }
  const since = Date.parse(string(row.updatedAt));
  if (!Number.isFinite(since)) throw new SourceError('网关未提供可核验的账号连接时间');
  return since;
}

function message(value: unknown, since: number, ownerId: string): InboxThing | undefined {
  const row = record(value);
  // The documented inbox has no authoritative fold/mute state for groups or topics.
  // A title, tier or arbitrary payload field cannot establish that a group is eligible.
  const senderId = string(row.senderId);
  if (row.chatType !== 'p2p' || !senderId || senderId === ownerId) return;
  const receivedAt = string(row.receivedAt);
  if (!(Date.parse(receivedAt) > since && Date.parse(string(row.occurredAt)) > since)) return;
  const chatId = string(row.chatId), messageId = string(row.messageId);
  const text = string(record(row.payload).content) || string(row.title);
  if (!chatId || !messageId || !text) return;
  const sender = string(row.senderName) || senderId;
  return {
    thread: 'web:message:' + JSON.stringify([chatId, messageId]), last: messageId,
    title: string(row.chatName) || string(row.title) || chatId, text, receivedAt,
    ...(sender && { sender }), origin: { kind: 'direct', connector: '飞书', chatId },
  };
}

export function createFeishuWebSource(options: FeishuWebSourceOptions) {
  let state: FeishuWebSourceStatus = { enabled: false, connected: false };
  let controller: AbortController | undefined;
  let task = Promise.resolve();
  let previousAccount = '';
  let seen = new Set<string>();

  async function poll(signal: AbortSignal) {
    let base: URL;
    try { base = new URL(options.baseUrl); }
    catch { throw new SourceError('请配置网页网关 HTTP 地址'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.pathname !== '/' || base.username || base.password || base.search || base.hash) {
      throw new SourceError('网页网关地址须为 HTTP 或 HTTPS 服务根地址');
    }
    if (!options.token?.trim()) throw new SourceError('请配置网关签发的网页访问令牌');
    const loopback = base.hostname === 'localhost' || base.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(base.hostname);
    if (base.protocol !== 'https:' && !loopback) throw new SourceError('网页访问令牌仅可通过回环地址或 HTTPS 传递');
    // 网页 API 接受网关签发的 master cookie。令牌只进请求头，不进入 URL。
    const cookie = 'agentdock_web=' + encodeURIComponent(options.token);
    async function read(name: string) {
      const response = await fetch(new URL('/api/lark-avatar/' + name, base), {
        headers: { Cookie: cookie },
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new SourceError('网页网关 HTTP ' + response.status);
      }
      return response.json() as Promise<unknown>;
    }
    const status = record(await read('status'));
    if (status.connected !== true) throw new SourceError('网页网关未登录或监听已停止');
    const accountKey = identity(status);
    const ownerId = string(record(status.account).userId);
    // 网关更换账号时保留历史 inbox。使用网关自己的时间和账号，在读取两侧复核，
    // 不把旧账号的行或跨连接读取的快照交给新账号。
    const since = session(await read('config'), accountKey);
    const rows = await read('inbox');
    if (!Array.isArray(rows)) throw new SourceError('网页网关收件列表格式无效');
    if (session(await read('config'), accountKey) !== since) throw new SourceError('读取期间网页账号连接已变化');
    signal.throwIfAborted();

    if (accountKey !== previousAccount) {
      previousAccount = accountKey;
      seen.clear();
      delete state.lastReceivedAt;
    }
    const snapshot = new Map<string, InboxThing>();
    for (const row of rows) {
      const item = message(row, since, ownerId);
      if (item) snapshot.set(item.thread, item);
    }
    const items = [...snapshot.values()].filter(item => !seen.has(item.thread))
      .sort((a, b) => Date.parse(a.receivedAt!) - Date.parse(b.receivedAt!));
    if (items.length) {
      try { await options.onInbox(items, { accountKey }); }
      catch { throw new SourceError('网页消息写入收件箱失败'); }
      state.lastReceivedAt = items.at(-1)!.receivedAt;
    }
    seen = new Set(snapshot.keys());
    signal.throwIfAborted();
    state.connected = true;
    delete state.error;
  }

  async function listen(signal: AbortSignal) {
    while (!signal.aborted) {
      try { await poll(signal); }
      catch (error) {
        if (signal.aborted) return;
        state.connected = false;
        state.error = error instanceof SourceError ? error.message : '无法读取网页网关，请检查地址、连接和授权';
      }
      await delay(options.pollIntervalMs ?? 15000, undefined, { signal, ref: false }).catch(() => {});
    }
  }
  return {
    status(): FeishuWebSourceStatus { return { ...state }; },
    start(): void {
      if (controller) return;
      controller = new AbortController();
      const { signal } = controller;
      state = { enabled: true, connected: false };
      task = task.then(() => listen(signal));
    },
    async stop(): Promise<void> {
      controller?.abort();
      controller = undefined;
      state.enabled = false;
      state.connected = false;
      delete state.error;
      await task;
    },
  };
}

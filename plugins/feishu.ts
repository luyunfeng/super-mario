import { groupTaskCommand, readGroupCommand, readGroupPost, topicGroupCommand } from './feishu-read-command.ts';
import type { FeishuEditObservation } from './feishu-edit-history.ts';
export type { FeishuEditObservation } from './feishu-edit-history.ts';
import { renderFeishuPost } from './feishu-post.ts';
import { imageSize } from 'image-size';
import { chatImageLimits, type ChatImageInput, type PersonalAiMessage } from '../packages/protocol/src/index.ts';
import { allowedPersonalChats, scopedLanes, searchFilter, unmutedIds, validChatId, type SearchLane } from './feishu-personal-scope.ts';
import { execFile } from 'node:child_process';
import { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import type { InboxThing } from '../packages/protocol/src/index.ts';
import type { CollectedReplyEvidence } from '../packages/protocol/src/index.ts';

/** Factory injection keeps tests offline while exercising the real SDK dispatcher. */
export type FeishuWSFactory = (options: ConstructorParameters<typeof WSClient>[0]) => Pick<WSClient, 'start' | 'close' | 'getConnectionStatus'>;
export interface FeishuMention { self?: true; key?: string; openId?: string; appId?: string; name?: string }
export interface FeishuMessageSource { privatePostImages?:true; privatePost?:true; privateForward?:true; privateFile?:true; privateImage?:true; mentions?: FeishuMention[]; chatId: string; messageId: string; chatType?: string; chatName?: string; senderName?: string; senderId?: string; senderType?: 'user' | 'bot'; mentionedSelf?: boolean; parentId?: string; threadId?: string; rootId?: string }
/** Private resume data. The host commits it only after durable inbox ingestion. */
export interface PersonalCheckpoint {
  version: 1;
  binding: { appId: string; openId: string; profile: string };
  /** An explicit fresh start must also bound later overlapping reads and replays. */
  notBefore?: string;
  lastCompletedThrough?: string;
  // A directory outage may finish private reads while group coverage is pending.
  directThrough?: string;
  groupRetryFrom?: string;
  pages: number;
  window?: { start: string; end: string; lanes: SearchLane[];
    /** Incremental directory traversal is private progress, not a claim that all groups were read. */
    directory?: { done: boolean; retryAt?: number };
    privateRange?: { start: string; end: string };
  };
}
export interface PersonalBatch { editObservations?: FeishuEditObservation[]; aiMessages?: PersonalAiMessage[]; items: InboxThing[]; checkpoint: PersonalCheckpoint; hasMore: boolean; evidence?: CollectedReplyEvidence[] }
export const PERSONAL_COLLECTION_BOUNDARY = '首次读取最近24小时；后续从已完成水位重叠5分钟读取。私聊优先；群聊只选按最近活跃时间排序的前100个会话中，未解散且明确未免打扰的群，最低优先级分批读取。未完成的群读取保留原时间范围，私聊可独立推进。默认分页采集按命中消息独立入箱。不保证全部群、永久历史或任意旧编辑的全量同步。';
/** Pin the window before the first read as well as after each successful ingestion. */
export function preparePersonalCheckpoint(binding: PersonalCheckpoint['binding'], previous?: PersonalCheckpoint): PersonalCheckpoint {
  const sameAccount = previous && (['appId', 'openId', 'profile'] as const).every(key => previous.binding[key] === binding[key]);
  const checkpoint: PersonalCheckpoint = sameAccount ? structuredClone(previous) : { version: 1, binding, pages: 0 };
  const wholeSecond = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const through = checkpoint.directThrough ?? checkpoint.lastCompletedThrough;
  checkpoint.window ??= {
    start: wholeSecond(Math.max(through ? Date.parse(through) - 300_000 : Date.now() - 86_400_000,
      checkpoint.notBefore ? Date.parse(checkpoint.notBefore) : -Infinity)),
    end: wholeSecond(Date.now()), lanes: scopedLanes([]),
  };
  return checkpoint;
}
export type FeishuSentMessageType = 'interactive' | 'text' | 'post';
export interface FeishuSendContext {
  /** A read-only card may deliver its text if the platform explicitly rejects card creation.
   * The host revalidates the recipient and scope immediately before the fallback. */
  beforeTextFallback?: () => void;
  /** Plain reply to an exact source. Guard again after token acquisition and before transport. */
  groupReadReply?: () => void;
  plainText?: boolean;
  beforeSend?: () => void;
  replyKey?: string;
  mention?: { openId: string; name: string };
  card?: Record<string, unknown>;
  replyTo?: string;
  threadId?: string;
  onSent?: (messageId: string, type?: FeishuSentMessageType) => void;
  presentation?: { navigation?: string; title?: string; kind?: 'reply' | 'result' | 'brief' | 'notice'; route?: string };
}
export interface FeishuCardAction { eventId?: string; formValue?: Record<string, unknown>; operatorId: string; chatId: string; messageId: string; value: Record<string, unknown> }
export interface PersonalChatDetail { mode?: 'p2p' | 'group'; userCount?: number }
export interface FeishuOptions {
  personalChatDetail?: (chatId: string) => Promise<PersonalChatDetail>;
  appId: string;
  appSecret: string;
  profile?: string;
  /** Verified personal account identity, distinct from the robot's own mention ID. */
  personalOpenId?: string;
  /** Product polling bounds each persisted batch; legacy adapter callers keep their existing full-route read. */
  personalCollectionPageLimit?: number;
  /** Enable self-identity resolution for precise group mentions; default off. */
  groupMessages?: boolean;
  privateImages?: boolean;
  privateFiles?: boolean;
  privateForwards?: boolean;
  privatePosts?: boolean;
  groupChatIds?: string[];
  readGroup?: boolean;
  /** Forward explicitly addressed /ai requests. The host validates the paired owner. */
  groupTasks?: boolean;
  /** Current topic enrollment, read again when a queued message reaches the host. */
  topicPolicy?: (chatId: string) => { requireOwnerMention: boolean } | undefined;
  onRecall?: (chatId: string, messageId: string) => void;
  /** Exact command group selected by the main bot controller. */
  commandGroupChatId?: string;
  /** A profile only identifies an account; it never grants background collection. */
  collectEnabled?: boolean;
  pollMs?: number;
  /** Bounds SDK reconnect attempts by elapsed time; does not retry messages. Default 5 minutes. */
  reconnectTimeoutMs?: number;
  onMessage: (text: string, source: FeishuMessageSource) => Promise<string | void>;
  onInbox: (things: InboxThing[]) => Promise<void>;
  renderMessage?: (text: string, context?: FeishuSendContext) => Record<string, unknown> | undefined;
  /** Fast, authenticated by the host; never route card callbacks through the model queue. */
  onCardAction?: (action: FeishuCardAction) => Record<string, unknown>;
  fetch?: typeof fetch;
  runCLI?: (args: string[]) => Promise<unknown>;
  wsFactory?: FeishuWSFactory;
}

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const origin = 'https://open.feishu.cn';
class CardContentRejected extends Error {}
class TextFallbackDenied extends Error {}
class FeishuReplyParentGone extends Error { readonly delivery = 'no'; }
/** Only an explicit business rejection of the reply identifies a withdrawn/deleted parent. */
export function isFeishuMessageGone(error: unknown): boolean { return error instanceof FeishuReplyParentGone; }
// These Feishu business errors explicitly reject a message mutation (arguments, chat access,
// credentials, permissions or rate limit). Unrecognized business errors leave the effect unknown.
const messageMutationRejections = new Set([
  230001, 230002, 230003, 230006, 230011, 230013, 230017, 230018, 230019, 230020, 230027, 230429,
  99991400, 99991661, 99991663, 99991664, 99991668, 99991672, 99991679,
]);
class FeishuResponseError extends Error {
  readonly httpStatus: number;
  readonly apiCode?: number;
  readonly path: string;
  constructor(message: string, path: string, httpStatus: number, apiCode?: number) {
    super(message);
    this.path = path;
    this.httpStatus = httpStatus;
    this.apiCode = apiCode;
  }
}

// Match connector metadata only. Quoting the bot or naming a group after it is not provenance.
function botSender(hit: Row) {
  const sender = object(hit.sender);
  const type = string(sender.sender_type) || string(hit.sender_type) || string(sender.type);
  return type === 'app' || type === 'bot' || (!type && sender.id_type === 'app_id');
}
function personalInboxBody(hit: Row): string {
  const text = string(hit.content);
  if ((hit.msg_type ?? hit.message_type) !== 'file') return text;
  let content = hit.content;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { return text || '文件附件'; }
  }
  const name = string(object(content).file_name).split(/[\\/]/).pop()?.replace(/[\p{Cc}\p{Bidi_Control}]/gu, '').trim();
  return name ? '文件附件：' + name : '文件附件';
}

function personalMessageLocation(hit: Row, chat: string) {
  const link = URL.parse(string(hit.message_app_link));
  if (!link || link.protocol !== 'https:' || link.username || link.password ||
      (link.host !== 'applink.feishu.cn' && link.host !== 'applink.larksuite.com')) return;
  const host = link.host;
  const topic = link.pathname === '/client/thread/open';
  if (!topic && link.pathname !== '/client/chat/open') return;
  const query = link.searchParams;
  const position = query.get(topic ? 'thread_position' : 'position');
  if (!position || !/^\d{1,16}$/.test(position) || query.get(topic ? 'open_chat_id' : 'openChatId') !== chat) return;
  const threadId = string(hit.thread_id);
  if (topic && (!/^omt_[\w-]+$/.test(threadId) || query.get('open_thread_id') !== threadId)) return;
  return { host: host as 'applink.feishu.cn' | 'applink.larksuite.com', position, ...(topic && { threadId }) };
}

function meetingMinutes(hit: Row) {
  if (!botSender(hit)) return false;
  const name = string(hit.sender_name) || string(object(hit.sender).name);
  return name === '智能纪要助手' || (hit.chat_type === 'p2p' && hit.chat_name === '智能纪要助手');
}
const collectSender = (hit: Row) => !botSender(hit) || meetingMinutes(hit);

const forwardMedia = new Map(Object.entries({
  image:'[图片]', img:'[图片]', file:'[文件]', media:'[视频]', audio:'[语音消息]', emotion:'[表情]',
  sticker:'[表情]', interactive:'[卡片]', merge_forward:'[合并转发]', share_chat:'[分享的群]', share_user:'[分享的名片]',
}));
function forwardBody(message: Row): string {
  const type = string(message.msg_type);
  if (type !== 'text' && type !== 'post') return type ? forwardMedia.get(type) ?? '[其他消息]' : '';
  let raw: Row;
  try { raw = object(JSON.parse(string(object(message.body).content))); } catch { return ''; }
  if (type === 'post') return renderFeishuPost(raw, message.mentions);
  const mentions = new Map<string,string>();
  for (const value of Array.isArray(message.mentions) ? message.mentions : []) {
    const mention = object(value), name = string(mention.name);
    if (name) mentions.set(string(mention.key), name);
  }
  const text = string(raw.text);
  return text.replace(/@_user_\d+/g, key => mentions.has(key) ? '@' + mentions.get(key) : key).trim();
}
/** Platform timestamps use milliseconds; CLI output may use seconds or ISO dates. */
function isoTime(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value.trim() : '';
  const numeric = typeof value === 'number' || /^[+-]?\d+(?:\.\d+)?$/.test(text);
  let milliseconds = numeric ? Number(value) : Date.parse(text);
  // Contemporary Unix seconds have fewer than 12 digits; do not let Date.parse
  // interpret numeric timestamps as calendar years or implementation-specific dates.
  if (numeric && Math.abs(milliseconds) < 100_000_000_000) milliseconds *= 1000;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) throw new Error('飞书消息 create_time 必须为有效 ISO 日期、Unix 秒或毫秒时间戳');
  return date.toISOString();
}

export function createFeishuIntegration(options: FeishuOptions) {
  let running = false;
  let closed = false;
  let generation = 0;
  let ws: ReturnType<FeishuWSFactory> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let controller = new AbortController();
  let connectionReason = '尚未启动';
  let operationReason: string | undefined;
  let botOpenId: string | undefined;
  let identityReason: string | undefined;
  let token: { value: string; expiresAt: number } | undefined;
  let tokenRequest: Promise<string> | undefined;
  const groupCommands = !!(options.readGroup || options.groupTasks || options.topicPolicy);
  const seen = new Set<string>();
  const queue: Array<{ text: string; source: FeishuMessageSource; generation: number; admit?: () => boolean; transition?: {chatId: string} }> = [];
  const topicTransitions = new Set<{chatId: string}>();
  let drainingGeneration: number | undefined;
  let collecting: Promise<InboxThing[]> | undefined;
  const pollMs = options.pollMs ?? 120_000;
  const reconnectTimeoutMs = options.reconnectTimeoutMs ?? 300_000;

  // SDK errors may contain request configuration. Retain messages only, redact secrets.
  function reason(error: unknown, extraSecrets: string[] = []): string {
    let result = error instanceof Error ? error.message : String(error);
    for (const secret of [options.appSecret, token?.value, ...extraSecrets]) if (secret) result = result.split(secret).join('[redacted]');
    return result.replace(/wss?:\/\/\S+/gi, '[redacted WS endpoint]').replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]').slice(0, 1000);
  }
  const createLogger = (epoch: number) => ({
    error: (...parts: unknown[]) => { if (running && epoch === generation) connectionReason = reason(parts.map(part => part instanceof Error ? part.message : typeof part === 'string' ? part : 'SDK error').join(' ')); },
    warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
  });
  function remember(id: string) {
    seen.add(id);
    if (seen.size > 2048) seen.delete(seen.values().next().value!);
  }
  function assertCredentials() {
    if (!/^cli_[0-9a-fA-F]{16}$/.test(options.appId) || !options.appSecret.trim()) throw new Error('飞书 appId 或 appSecret 未配置或格式错误');
  }
  async function request(path: string, body: Row, bearer?: string, signal = controller.signal, method = 'POST', redirect: RequestRedirect = 'follow'): Promise<Row> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const response = await (options.fetch ?? fetch)(`${origin}${path}`, {
      method, redirect, headers: { 'content-type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body) }), signal: requestSignal,
    });
    requestSignal.throwIfAborted();
    if (!response.ok) {
      const data = object(await response.json().catch(() => undefined));
      requestSignal.throwIfAborted();
      if (response.status === 400 && body.msg_type === 'interactive' && data.code === 230099)
        throw new CardContentRejected('飞书拒绝创建卡片内容');
      if (response.status === 401 && bearer) token = undefined;
      throw new FeishuResponseError(`飞书 HTTP ${response.status}`, path, response.status,
        typeof data.code === 'number' ? data.code : undefined);
    }
    const data = object(await response.json());
    requestSignal.throwIfAborted();
    if (data.code !== 0) {
      if (body.msg_type === 'interactive' && data.code === 230099) throw new CardContentRejected('飞书拒绝创建卡片内容');
      // Do not retry a send: the remote effect may already have happened.
      if (bearer && [99991661, 99991663, 99991664, 99991668].includes(Number(data.code))) token = undefined;
      throw new FeishuResponseError(`飞书 API ${String(data.code)}: ${reason(string(data.msg) || '响应无效', bearer ? [bearer] : [])}`,
        path, response.status, typeof data.code === 'number' ? data.code : undefined);
    }
    return data;
  }
  async function getToken(): Promise<string> {
    assertCredentials();
    if (token && Date.now() < token.expiresAt) return token.value;
    if (!tokenRequest) {
      const epoch = generation, signal = controller.signal;
      const pending = (async () => {
        const data = await request('/open-apis/auth/v3/tenant_access_token/internal', { app_id: options.appId, app_secret: options.appSecret }, undefined, signal);
        if (closed || epoch !== generation) throw new Error('飞书鉴权请求已取消');
        const value = string(data.tenant_access_token);
        if (!value || typeof data.expire !== 'number' || !Number.isFinite(data.expire) || data.expire <= 0) throw new Error('飞书 token 响应缺少 tenant_access_token 或有效 expire');
        token = { value, expiresAt: Date.now() + Math.max(0, data.expire * 1000 - Math.min(60_000, data.expire * 100)) };
        return value;
      })().finally(() => { if (tokenRequest === pending) tokenRequest = undefined; });
      tokenRequest = pending;
    }
    return tokenRequest;
  }
  async function resolveBotIdentity(epoch: number) {
    const signal = controller.signal;
    let bearer: string | undefined;
    try {
      bearer = await getToken();
      if (!running || epoch !== generation) return;
      const data = await request('/open-apis/bot/v3/info', {}, bearer, signal, 'GET');
      if (!running || epoch !== generation) return;
      const id = string(object(data.bot).open_id).trim();
      if (!id) throw new Error('bot info 响应缺少 bot.open_id');
      botOpenId = id;
      identityReason = undefined;
    } catch (error) {
      if (running && epoch === generation) identityReason = `群消息不可用，机器人身份读取失败：${reason(error, bearer ? [bearer] : [])}`;
    }
  }
  async function postMessage(path: string, body: Row & { msg_type: FeishuSentMessageType }, fallback?: { text: string; validate: () => void }, validate?: () => void) {
    const epoch = generation;
    let bearer: string | undefined;
    let type = body.msg_type;
    try {
      if (closed) throw new Error('飞书适配器已关闭');
      const signal = controller.signal;
      bearer = await getToken();
      if (epoch !== generation) throw new Error('飞书发送请求已取消');
      if (closed) throw new Error('飞书适配器已关闭');
      validate?.();
      const data = await request(path, body, bearer, signal, 'POST', validate ? 'error' : 'follow').catch(error => {
        if (!(error instanceof CardContentRejected) || !fallback || closed || epoch !== generation) throw error;
        try { fallback.validate(); }
        catch (denied) { throw new TextFallbackDenied(reason(denied)); }
        type = 'text';
        return request(path, { ...body, msg_type: 'text', content: JSON.stringify({ text: fallback.text }) }, bearer, signal);
      });
      if (closed || epoch !== generation) throw new Error('飞书发送请求已取消');
      const id = string(object(data.data).message_id);
      if (id) remember(id);
      return { id, type };
    } catch (error) {
      if (!closed && epoch === generation && error instanceof FeishuResponseError && error.path === path &&
          path.endsWith('/reply') && (error.apiCode === 230011 || error.apiCode === 230110) &&
          (error.httpStatus < 300 || error.httpStatus === 400 || error.httpStatus === 404)) {
        operationReason = '飞书回复的父消息已撤回或删除。';
        throw new FeishuReplyParentGone(operationReason);
      }
      const message = reason(error, bearer ? [bearer] : []);
      const detail = error instanceof TextFallbackDenied ? '卡片未创建，文本未发送：' + message
        : `发送失败，未自动重试（网络中断时结果可能为 unknown）：${message}`;
      if (!closed && epoch === generation) operationReason = detail;
      if (error instanceof TextFallbackDenied) throw Object.assign(new Error(detail), { delivery: 'no' });
      throw new Error(detail);
    }
  }
  async function send(chatId: string, text: string, context?: FeishuSendContext): Promise<void> {
    if (!chatId.trim() || !text.trim()) throw new Error('飞书发送需要 chatId 和非空文本');
    if (context?.mention) {
      const { openId } = context.mention;
      if (!options.commandGroupChatId || options.commandGroupChatId !== chatId || context.replyTo || context.threadId || context.card) throw new Error('点名消息必须直接发送到当前总指挥群');
      if (!/^ou_[A-Za-z0-9_-]+$/.test(openId)) throw new Error('点名需要发送方可见的目标机器人 openId');
      // Separate structured nodes keep user text literal, including any embedded @ markup.
      const content = { zh_cn: { content: [[{ tag: 'at', user_id: openId }, { tag: 'text', text: ' ' + text }]] } };
      const { id, type } = await postMessage('/open-apis/im/v1/messages?receive_id_type=chat_id', {
        receive_id: chatId, msg_type: 'post', content: JSON.stringify(content),
      });
      if (!id) throw new Error('飞书点名消息缺少 message_id，发送结果未知');
      context.onSent?.(id, type);
      return;
    }
    if (context?.groupReadReply && !context.replyTo) throw new Error('读群结果必须回复触发消息');
    const card = context?.groupReadReply || context?.plainText ? undefined : context?.card ?? options.renderMessage?.(text, context);
    const payload = card ? { msg_type: 'interactive' as const, content: JSON.stringify(card) }
      : { msg_type: 'text' as const, content: JSON.stringify({ text }) };
    const fallback = card && context?.beforeTextFallback ? { text, validate: context.beforeTextFallback } : undefined;
    if (context?.replyTo) {
      const { id, type } = await postMessage(`/open-apis/im/v1/messages/${encodeURIComponent(context.replyTo)}/reply`, {
        ...payload, ...(context.threadId ? { reply_in_thread: true } : {}), ...(context.replyKey && { uuid: context.replyKey }),
      }, fallback, context.groupReadReply ?? context.beforeSend);
      if (context.groupReadReply && !id) throw new Error('读群回复缺少消息回执，发送结果未知');
      if (id) context.onSent?.(id, type);
      return;
    }
    const { id, type } = await postMessage('/open-apis/im/v1/messages?receive_id_type=chat_id', { receive_id: chatId, ...payload, ...(context?.replyKey && { uuid: context.replyKey }) }, fallback, context?.beforeSend);
    if (id) context?.onSent?.(id, type);
  }
  async function readMessageItems(messageId: string, guard: () => void, openId: boolean): Promise<Row[]> {
    if (!messageId || messageId.length > 200 || /[^\w-]/.test(messageId)) throw new Error('飞书消息 ID 无效');
    const epoch = generation, signal = controller.signal;
    const check = () => {
      guard();
      if (!running || closed || epoch !== generation) throw new Error('来源的机器人连接已变化');
    };
    check();
    const bearer = await getToken();
    check();
    const data = await request('/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + (openId ? '?user_id_type=open_id' : ''), {}, bearer, signal, 'GET', 'error');
    check();
    const items = object(data.data).items;
    if (!Array.isArray(items)) throw new Error('飞书未返回原消息');
    return items.map(object);
  }
  async function readVerifiedMessage(chatId: string, messageId: string, guard: () => void, openId=false): Promise<Row | undefined> {
    if (!chatId) return;
    const epoch = generation;
    try {
      const items = await readMessageItems(messageId, guard, openId);
      const message = items[0];
      if (items.length === 1 && message?.message_id === messageId && message.chat_id === chatId && message.deleted !== true) return message;
    } catch {
      guard();
      if (!running || closed || epoch !== generation) throw new Error('来源的机器人连接已变化');
    }
  }
  async function readPrivateForward(chatId: string, messageId: string, senderId: string, guard: () => void): Promise<string> {
    if (!options.privateForwards || !chatId || !senderId) throw new Error('私聊合并转发来源未启用或不完整');
    const epoch = generation;
    const items = await readMessageItems(messageId, guard, true);
    guard();
    if (!running || closed || generation !== epoch) throw new Error('来源的机器人连接已变化');
    const roots = items.filter(row => row.message_id === messageId);
    const root = roots[0], sender = object(root?.sender);
    if (roots.length !== 1 || !root || root.msg_type !== 'merge_forward' || root.chat_id !== chatId ||
        root.chat_type && root.chat_type !== 'p2p' || root.upper_message_id || root.deleted === true || root.updated === true ||
        sender.sender_type !== 'user' || sender.id_type !== 'open_id' || sender.id !== senderId)
      throw new Error('无法核对原始私聊合并转发');
    const children = items.filter(row => row.upper_message_id === messageId && row.deleted !== true && string(row.message_id))
      .map(row => ({row, at: isoTime(row.create_time)}))
      .sort((a, b) => (a.at ?? '~').localeCompare(b.at ?? '~'));
    const ids = new Set<string>(), speakers = new Map<string, number>();
    const lines: string[] = [];
    let length = 0;
    for (const {row, at} of children) {
      const id = string(row.message_id);
      if (ids.has(id)) continue;
      ids.add(id);
      const text = forwardBody(row);
      if (!text) continue;
      const author = object(row.sender), userId = string(author.id);
      let name = '未知发送者';
      if (author.sender_type === 'app') name = '机器人';
      if (author.sender_type === 'user') {
        if (userId && !speakers.has(userId)) speakers.set(userId, speakers.size + 1);
        name = string(author.name).trim() || (userId ? '成员' + speakers.get(userId) : '成员');
      }
      const line = (lines.length ? '\n' : '') + (at ?? '时间未知') + ' ' + name + '：' + text;
      const available = 30_000 - length;
      // UTF-16 slicing first bounds the work even for a very long single text.
      const chars = Array.from(line.slice(0, available * 2 + 2));
      if (chars.length > available) {
        const marker = '\n[聊天记录已截断]';
        return Array.from(lines.join('') + chars.slice(0, available).join('')).slice(0, 30_000 - Array.from(marker).length).join('') + marker;
      }
      lines.push(line);
      length += chars.length;
    }
    if (!lines.length) throw new Error('合并转发没有可读取的直接子消息');
    return lines.join('');
  }
  async function privateAttachmentSource(kind:'file'|'image'|'post',chatId:string,messageId:string,ownerId:string,guard:()=>void) {
    const timeoutMs = kind==='image' ? 15_000 : 300_000; // A post can contain 20 sequential image downloads.
    const epoch=generation, signal=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs)]);
    function check() {
      guard();
      signal.throwIfAborted();
      if (!running || closed || epoch!==generation) throw new Error('附件来源的机器人连接已变化');
    }
    const message=await readVerifiedMessage(chatId,messageId,check,true);
    check();
    const sender=object(message?.sender);
    if (!ownerId || !message || message.updated===true || message.msg_type!==kind || message.upper_message_id ||
        message.chat_type && message.chat_type!=='p2p' || sender.sender_type!=='user' ||
        sender.id_type!=='open_id' || sender.id!==ownerId) throw new Error('无法核对原始私聊附件');
    let content:Row;
    try { content=object(JSON.parse(string(object(message.body).content))); } catch { throw new Error('附件来源无效'); }
    return {content,mentions:message.mentions,messageId,signal,check};
  }
  type AttachmentSource = Awaited<ReturnType<typeof privateAttachmentSource>>;
  async function downloadResource<T>(source:AttachmentSource,kind:'file'|'image',key:string,limit:number,
    consume:(mime:string,stream:AsyncIterable<Uint8Array>)=>Promise<T>):Promise<T> {
    const {messageId,signal,check}=source;
    check();
    const bearer=await getToken();
    check();
    const url=origin+'/open-apis/im/v1/messages/'+encodeURIComponent(messageId)+'/resources/'+encodeURIComponent(key)+'?type='+kind;
    const response=await (options.fetch??fetch)(url,{headers:{Authorization:'Bearer '+bearer},redirect:'error',signal});
    if (!response.ok || !response.body || Number(response.headers.get('content-length'))>limit) {
      await response.body?.cancel();
      throw new Error('附件下载失败或超过大小限制');
    }
    const declared=response.headers.get('content-length');
    const exactBytes=declared && /^\d+$/.test(declared) && !response.headers.get('content-encoding') ? Number(declared) : undefined;
    const reader=response.body.getReader();
    async function* chunks() {
      let size=0;
      for (;;) {
        check();
        const part=await reader.read();
        check();
        if (part.done) {
          if (exactBytes!==undefined && size!==exactBytes) throw new Error('附件下载不完整');
          return;
        }
        size+=part.value.byteLength;
        if (size>limit) throw new Error('附件超过大小限制');
        yield part.value;
      }
    }
    try {
      check();
      const mime=response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
      const result=await consume(mime,chunks());
      check();
      return result;
    } finally { await reader.cancel(); }
  }
  async function readPrivateFile<T>(chatId:string,messageId:string,ownerId:string,guard:()=>void,
    consume:(name:string,mime:string,stream:AsyncIterable<Uint8Array>)=>Promise<T>):Promise<T> {
    const source=await privateAttachmentSource('file',chatId,messageId,ownerId,guard);
    const key=string(source.content.file_key), name=string(source.content.file_name);
    if (!/^file_[\w-]{1,240}$/.test(key) || !name.trim()) throw new Error('原消息缺少有效附件');
    return downloadResource(source,'file',key,200*1024*1024,(mime,stream)=>consume(name,mime,stream));
  }
  async function downloadImage(source:AttachmentSource,key:string,remainingEncodedBytes:number):Promise<ChatImageInput> {
    if (!/^img_[\w-]{1,240}$/.test(key)) throw new Error('原消息缺少有效图片');
    const limit=Math.min(chatImageLimits.bytesPerImage,Math.floor(remainingEncodedBytes/4)*3);
    if (limit<=0) throw new Error('聊天图片超过大小限制');
    return downloadResource(source,'image',key,limit,async(_mime,stream)=>{
      const parts:Uint8Array[]=[];
      for await (const part of stream) parts.push(part);
      const bytes=Buffer.concat(parts);
      let type:string|undefined;
      try {
        const dimensions=imageSize(bytes);
        if (dimensions.width && dimensions.height) type=dimensions.type;
      } catch { /* generic user-visible failure */ }
      if (!type || !['png','jpg','webp','gif'].includes(type)) throw new Error('私聊图片格式不受支持');
      return {mime:type==='jpg'?'image/jpeg':'image/'+type,data:bytes.toString('base64')};
    });
  }
  async function readPrivateImage(chatId:string,messageId:string,ownerId:string,guard:()=>void):Promise<ChatImageInput> {
    const source=await privateAttachmentSource('image',chatId,messageId,ownerId,guard);
    return downloadImage(source,string(source.content.image_key),chatImageLimits.totalBase64Bytes);
  }
  async function readPrivatePostImages(chatId:string,messageId:string,senderId:string,expectedText:string,guard:()=>void):Promise<ChatImageInput[]> {
    if (!options.privatePosts || !options.privateImages) throw new Error('私聊富文本图片未启用');
    const source=await privateAttachmentSource('post',chatId,messageId,senderId,guard);
    const keys:string[]=[];
    const text=renderFeishuPost(source.content,source.mentions,true,key=>{
      if (keys.length===chatImageLimits.count) throw new Error(`每条消息最多可附 ${chatImageLimits.count} 张图片`);
      if (!/^img_[\w-]{1,240}$/.test(key)) throw new Error('原消息缺少有效图片');
      keys.push(key);
    });
    if (!keys.length || text!==expectedText) throw new Error('富文本原文或图片与接收记录不一致');
    const images:ChatImageInput[]=[], fetched=new Map<string,ChatImageInput>();
    let remaining=chatImageLimits.totalBase64Bytes;
    for (const key of keys) {
      source.check();
      const image=fetched.get(key) ?? await downloadImage(source,key,remaining);
      remaining-=image.data.length;
      if (remaining<0) throw new Error('聊天图片超过大小限制');
      images.push(image);
      fetched.set(key,image);
    }
    source.check();
    return images;
  }
  async function topicOfMessage(chatId: string, messageId: string, guard: () => void) {
    const message = await readVerifiedMessage(chatId, messageId, guard);
    guard();
    return string(message?.thread_id).trim() || undefined;
  }
  /** Read exactly the quoted parent with this bot's token. Absence never widens the read to chat history. */
  async function readPrivateQuote(chatId:string,parentId:string,ownerId:string,since:number,before:number,guard:()=>void) {
    const message=await readVerifiedMessage(chatId,parentId,guard,true);
    guard();
    if (!message || !ownerId || message.upper_message_id || message.updated === true ||
        (message.chat_type && message.chat_type !== 'p2p') || !['text','post'].includes(string(message.msg_type))) return;
    const author=object(message.sender);
    if (author.sender_type !== 'user' || author.id_type !== 'open_id' || author.id !== ownerId) return;
    const created=Date.parse(isoTime(message.create_time) ?? '');
    if (!Number.isFinite(created) || !Number.isFinite(since) || !Number.isFinite(before) || created<=since || created>before) return;
    const text=forwardBody(message);
    if (!text) return;
    const chars=[...text];
    return {text:chars.slice(0,4000).join(''),truncated:chars.length>4000};
  }
  async function readTaskQuote(chatId: string, parentId: string, guard: () => void): Promise<string | undefined> {
    const message = await readVerifiedMessage(chatId, parentId, guard);
    guard();
    if (!message || (message.msg_type !== 'text' && message.msg_type !== 'post')) return;
    // Use the parent's own mentions. Media stays a placeholder; this read grants no attachment access.
    return Array.from(forwardBody(message)).slice(0, 300).join('') || undefined;
  }
  async function readReaction(messageId: string, emoji: 'OnIt' | 'DONE', guard: () => void, removeId?: string) {
    const epoch = generation, signal = controller.signal;
    const bearer = await getToken();
    if (!running || epoch !== generation) throw new Error('机器人连接已变化');
    guard();
    const path = '/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + '/reactions';
    const data = await request(removeId ? path + '/' + encodeURIComponent(removeId) : path,
      removeId ? {} : { reaction_type: { emoji_type: emoji } }, bearer, signal, removeId ? 'DELETE' : 'POST', 'error');
    return string(object(data.data).reaction_id);
  }
  async function updateCard(messageId: string, card: Record<string, unknown>, guard?:()=>void) {
    if (!messageId.trim()) throw new Error('卡片更新缺少消息标识');
    const epoch = generation, signal = controller.signal, bearer = await getToken();
    if (closed || epoch !== generation) throw new Error('飞书卡片更新已取消');
    guard?.();
    await request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, { content: JSON.stringify(card) }, bearer, signal, 'PATCH');
    if (closed || epoch !== generation) throw new Error('飞书卡片更新已取消');
  }
  async function changePlatformMessage(action: 'pin' | 'unpin' | 'recall', messageId: string): Promise<void> {
    if (typeof messageId !== 'string' || !messageId || messageId.trim() !== messageId ||
      /[\x00-\x1f\x7f/\\]/.test(messageId) || messageId === '.' || messageId === '..') {
      throw Object.assign(new Error('飞书消息标识无效'), { delivery: 'no' });
    }
    const epoch = generation, signal = controller.signal;
    const enabled = () => running && !closed && generation === epoch;
    if (!enabled()) throw Object.assign(new Error('飞书适配器未启动或已关闭'), { delivery: 'no' });
    let dispatched = false;
    try {
      const resource = action === 'recall' ? 'messages' : 'pins';
      const path = action === 'pin' ? '/open-apis/im/v1/pins' : `/open-apis/im/v1/${resource}/${encodeURIComponent(messageId)}`;
      const bearer = await getToken();
      if (!enabled()) throw new Error('飞书适配器已关闭');
      dispatched = true;
      await request(path, action === 'pin' ? { message_id: messageId } : {}, bearer, signal,
        action === 'pin' ? 'POST' : 'DELETE', 'error');
    } catch (error) {
      // Once submitted, a timeout, gateway failure or malformed reply cannot establish the effect.
      const rejected = error instanceof FeishuResponseError && error.apiCode !== 99991500 && (
        (error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408) ||
        (error.httpStatus < 300 && error.apiCode !== undefined && messageMutationRejections.has(error.apiCode)));
      const delivery = !dispatched || rejected ? 'no' : 'unknown';
      const detail = error instanceof FeishuResponseError
        ? (error.apiCode === undefined ? ` (HTTP ${error.httpStatus})` : ` (API ${error.apiCode})`) : '';
      const permission = dispatched && error instanceof FeishuResponseError &&
        (error.httpStatus === 403 || [230027, 99991672, 99991679].includes(error.apiCode ?? 0))
        ? '。请核对资源归属及权限 ' + (action === 'recall' ? 'im:message:recall' : 'im:message.pins:write_only') : '';
      throw Object.assign(new Error((delivery === 'no' ? '飞书操作未执行' : '飞书操作结果未知') + detail + permission), { delivery });
    }
  }
  async function drain(epoch: number) {
    if (!running || epoch !== generation || drainingGeneration === epoch) return;
    drainingGeneration = epoch;
    try {
      while (running && epoch === generation && queue.length) {
        const item = queue.shift()!;
        if (item.generation !== epoch) continue;
        try {
          if (item.admit && !item.admit()) continue;
          const answer = await options.onMessage(item.text, item.source);
          // A void result means the host owns its asynchronous reply lifecycle.
          if (running && item.generation === generation && typeof answer === 'string' && answer.trim()) {
            await send(item.source.chatId, answer, { replyTo: item.source.messageId, threadId: item.source.threadId });
          }
        } catch (error) { if (running && item.generation === generation) operationReason = `消息处理失败：${reason(error)}`; }
        finally { if (item.transition) topicTransitions.delete(item.transition); }
      }
    } finally { if (drainingGeneration === epoch) drainingGeneration = undefined; }
  }
  function receive(event: unknown, epoch: number) {
    if (!running || epoch !== generation) return;
    const data = object(event);
    const sender = object(data.sender);
    const message = object(data.message);
    // Never feed bot messages (including our own replies) back into the model.
    const messageId = string(message.message_id), chatId = string(message.chat_id);
    if (!messageId || !chatId || seen.has(messageId)) return;
    const group = message.chat_type === 'group';
    const commandGroup = chatId === options.commandGroupChatId;
    const topics = !!options.topicPolicy && group && !commandGroup;
    const threadId = string(message.thread_id);
    const post = group && message.message_type === 'post' && (options.readGroup || options.groupTasks || topics);
    const image = options.privateImages && message.chat_type === 'p2p' && message.message_type === 'image';
    const file = options.privateFiles && message.chat_type === 'p2p' && message.message_type === 'file';
    const privatePost = options.privatePosts && message.chat_type === 'p2p' && message.message_type === 'post' && !!string(object(sender.sender_id).open_id);
    const forward = options.privateForwards && message.chat_type === 'p2p' && message.message_type === 'merge_forward' && !!string(object(sender.sender_id).open_id);
    if (sender.sender_type !== 'user' || (message.message_type !== 'text' && !post && !image && !file && !forward && !privatePost)) return;
    if (group && !commandGroup && !topics && options.groupMessages && !botOpenId) return;
    if (group && !commandGroup && options.commandGroupChatId && !options.groupMessages && !groupCommands) return;
    // Preserve unknown entries too: an unresolved @ must not look like a message with no addressee.
    const mentions = Array.isArray(message.mentions) ? message.mentions.map(raw => {
      const mention = object(raw), id = object(mention.id);
      const openId = string(id.open_id), appId = string(id.app_id);
      return { ...(groupCommands && botOpenId && openId === botOpenId && { self: true as const }), ...(string(mention.key) && { key: string(mention.key) }), ...(openId && { openId }),
        ...(appId && { appId }), ...(string(mention.name) && { name: string(mention.name) }) };
    }) : undefined;
    const pendingSetting = topics && [...topicTransitions].some(change => change.chatId === chatId);
    let text: string | undefined;
    let privatePostImages = false;
    if (forward) text = '[转发的聊天记录]';
    else try {
      const raw = object(JSON.parse(string(message.content)));
      text = privatePost ? renderFeishuPost(raw, message.mentions, true, () => { privatePostImages = true; }) : file ? (/^file_[\w-]{1,240}$/.test(string(raw.file_key)) ? '[文件]' : undefined) : image ? (/^img_[\w-]{1,240}$/.test(string(raw.image_key)) ? '[图片]' : undefined) : post ? readGroupPost(raw, mentions ?? [], { readGroup: options.readGroup, groupTasks: options.groupTasks,
        topicCommands: topics, topicBody: topics && !!threadId && (!!options.topicPolicy?.(chatId) || pendingSetting) }) : string(raw.text);
    } catch { operationReason = '收到无法解析的飞书消息'; return; }
    if (!text?.trim()) return;
    const command = topics && topicGroupCommand(text, mentions);
    const self = !!mentions?.some(m => m.self);
    const read = options.readGroup && readGroupCommand(text, mentions);
    const task = options.groupTasks && groupTaskCommand(text, mentions);
    const listed = options.groupChatIds?.includes(chatId) ?? options.groupMessages;
    function admit() {
      if (!group || commandGroup || !groupCommands) return true;
      const policy = topics ? options.topicPolicy?.(chatId) : undefined;
      if (policy?.requireOwnerMention && !self) return false;
      if (command || (policy && threadId)) return true;
      if (listed && (!options.groupMessages || botOpenId) && (!post || read || task)) return true;
      return self && (!!read && read.addressed || !policy && !!task && task.addressed);
    }
    // A preceding setting change may be waiting on the host. Its result governs this message.
    if (!(pendingSetting && (command || threadId)) && !admit()) return;
    if (queue.length >= 100) { operationReason = '飞书消息队列已满，消息未处理'; return; }
    remember(messageId);
    const source: FeishuMessageSource = {
      ...(privatePostImages ? {privatePostImages:true as const} : {}), ...(privatePost && {privatePost:true}), ...(forward && {privateForward:true}), ...(file && {privateFile:true}), ...(image && {privateImage:true}), chatId, messageId, chatType: string(message.chat_type) || undefined,
      senderId: string(object(sender.sender_id).open_id) || undefined, senderType: 'user',
      // EventDispatcher preserves the SDK's nested id; CLI-normalized mentions differ.
      mentionedSelf: !!botOpenId && !!mentions?.some(mention => mention.openId === botOpenId),
      ...(mentions && { mentions }),
      ...(string(message.chat_name) && { chatName: string(message.chat_name) }),
      ...(string(sender.name) && { senderName: string(sender.name) }),
      ...(string(message.thread_id) ? { threadId: string(message.thread_id) } : {}),
      ...(string(message.parent_id) ? { parentId: string(message.parent_id) } : {}),
      ...(string(message.root_id) ? { rootId: string(message.root_id) } : {}),
    };
    const transition = command ? { chatId } : undefined;
    if (transition) topicTransitions.add(transition);
    queue.push({ text, source, generation: epoch, ...(topics && { admit }), transition });
    // Return immediately so SDK acknowledgement never waits for a model round.
    queueMicrotask(() => { void drain(epoch); });
  }

  async function cliEnvelope(args: string[]): Promise<Row> {
    const epoch = generation, signal = controller.signal;
    const argv = ['--profile', options.profile!, '--as', 'user', 'im', ...args, '--format', 'json'];
    const raw = options.runCLI ? await options.runCLI(argv) : await new Promise<unknown>((resolve, reject) => {
      execFile('lark-cli', argv, {
        timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
      }, (error, stdout, stderr) => {
        if (error) {
          let detail = error.message;
          try { detail = string(object(object(JSON.parse(stderr)).error).message) || detail; } catch { /* Non-JSON process errors retain their message. */ }
          reject(new Error(detail));
        } else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error('lark-cli 返回无效 JSON')); } }
      });
    });
    signal.throwIfAborted();
    if (epoch !== generation) throw new Error('飞书采集请求已取消');
    const envelope = object(raw);
    if (envelope.ok !== true || envelope.identity !== 'user') throw new Error(`lark-cli 必须返回成功的 user 身份结果：${string(object(envelope.error).message) || '身份或响应错误'}`);
    return envelope;
  }
  const readData = async (args: string[]) => object((await cliEnvelope(args)).data);
  async function groupScope() {
    try { return await allowedPersonalChats(readData); }
    catch { controller.signal.throwIfAborted(); return undefined; }
  }
  // A directory scan may span many pages. Recheck just before each body read,
  // including a cursor replay. A different ID set cannot use the old token.
  async function stillUnmuted(ids: string[]) {
    try { return (await unmutedIds(ids, readData)).length === ids.length; }
    catch { controller.signal.throwIfAborted(); return false; }
  }
  async function cliPage(args: string[]): Promise<{ messages: Row[]; data: Row; pagination: Row }> {
    const envelope = await cliEnvelope(args);
    const data = object(envelope.data);
    if (!Array.isArray(data.messages)) throw new Error('lark-cli 响应缺少 data.messages');
    if (data.has_more === true || object(object(envelope.meta).pagination).complete === false) operationReason = '个人消息采集为最近 24 小时的有界窗口；每路搜索和每会话上下文最多 50 条，存在未采集分页';
    return { messages: data.messages.map(object), data, pagination: object(object(envelope.meta).pagination) };
  }
  async function cli(args: string[]): Promise<Row[]> { return (await cliPage(args)).messages; }
  /** One page per route per batch keeps private chats and mentions moving even in busy groups. */
  async function collectBatch(previous?: PersonalCheckpoint): Promise<PersonalBatch> {
    if (options.personalCollectionPageLimit) return collectIncremental(previous, options.personalCollectionPageLimit);
    if (closed || !options.profile || !options.personalOpenId) throw new Error('个人采集缺少已核验账号');
    const binding = { appId: options.appId, openId: options.personalOpenId, profile: options.profile };
    const checkpoint = preparePersonalCheckpoint(binding, previous);
    const window = checkpoint.window!;
    let allowed = await groupScope();
    window.lanes = scopedLanes(allowed ?? [], window.lanes);
    const privateRows: Row[] = [];
    const groupRows: Row[] = [];
    for (const lane of window.lanes) {
      if (lane.done) continue;
      const start = lane.chatIds ? checkpoint.groupRetryFrom ?? window.start : window.start;
      const read = async () => {
        if (lane.chatIds && !(await stillUnmuted(lane.chatIds))) return;
        return cliPage(['+messages-search', '--start', start, '--end', window.end,
        '--page-size', '50', '--no-reactions', ...searchFilter(lane), ...(lane.token ? ['--page-token', lane.token] : [])]);
      };
      let page;
      try { page = await read(); }
      catch (error) {
        // Only a classified invalid/expired cursor allows replay, never arbitrary read failures.
        // Replay stays inside the original window; inbox ingestion already deduplicates stable IDs.
        if (!lane.token || object(error).kind !== 'cursor') throw error;
        if (lane.restarted) throw new Error('飞书分页游标回扫后再次失效，保留原窗口并停止');
        lane.restarted = true; delete lane.token; lane.seen = [];
        page = await read();
      }
      if (!page) {
        allowed = undefined;
        window.lanes = [window.lanes[0]!];
        break;
      }
      const more = page.data.has_more === true || page.pagination.complete === false;
      if (!more && page.data.has_more !== false && page.pagination.complete !== true) throw new Error('飞书分页缺少完成标记，保留原窗口');
      const next = string(page.data.page_token);
      if (more && (!next || next === lane.token || lane.seen.includes(next))) throw new Error('飞书分页缺少下一游标或游标循环，保留原窗口');
      if (more && lane.seen.length >= 4096) throw new Error('飞书窗口分页超过保护上限，保留原窗口');
      lane.done = !more;
      if (more) {
        if (lane.token) lane.seen.push(lane.token);
        lane.token = next;
      } else {
        // Exhausted lanes never resume their cursor. Do not persist a 4097th
        // token while another lane still needs the same window after restart.
        lane.seen = [];
        delete lane.token;
      }
      checkpoint.pages++;
      (lane.chatIds ? groupRows : privateRows).push(...scopedHits(page.messages, lane));
    }
    const scopedMessages = allowed === undefined ? privateRows : privateRows.concat(groupRows);
    // A server cursor can return an old edit or an out-of-window hit. A manual
    // fresh-start boundary applies to both inbox content and reply observation.
    const messages = checkpoint.notBefore ? scopedMessages.filter(hit => {
      const created = isoTime(hit.create_time);
      return created !== undefined && Date.parse(created) >= Date.parse(checkpoint.notBefore!);
    }) : scopedMessages;
    // Collect outgoing metadata before inbox filtering; never send outgoing text
    // to inbox sorting. Selection hints stay bounded and local to the observer.
    const evidence = messageEvidence(messages);
    const { items, aiMessages } = await messageThings(messages, evidence);
    const hasMore = window.lanes.some(lane => !lane.done);
    if (!hasMore) {
      if (allowed === undefined) {
        checkpoint.groupRetryFrom ??= window.start;
        checkpoint.directThrough = window.end;
      } else {
        checkpoint.lastCompletedThrough = window.end;
        delete checkpoint.groupRetryFrom;
        delete checkpoint.directThrough;
      }
      delete checkpoint.window;
    }
    return { items, checkpoint, hasMore, evidence, aiMessages, editObservations: editObservations(messages) };
  }
  /** Large group directories must not hold private messages or durable progress behind a full scan. */
  async function collectIncremental(previous: PersonalCheckpoint | undefined, limit: number): Promise<PersonalBatch> {
    if (closed || !options.profile || !options.personalOpenId) throw new Error('个人采集缺少已核验账号');
    if (!Number.isSafeInteger(limit) || limit < 2 || limit > 10) throw new Error('采集页数限制无效');
    const checkpoint = preparePersonalCheckpoint({ appId: options.appId, openId: options.personalOpenId, profile: options.profile }, previous);
    const window = checkpoint.window!;
    if (!window.directory) {
      // One-time migration: old full-membership lanes are no longer the selected group scope.
      window.lanes = window.lanes.slice(0, 1); window.directory = { done: false };
    }
    const directory = window.directory;
    const direct = window.lanes[0]!;
    if (direct.done) {
      // Group windows retain their original end. A new private window can move independently.
      const end = new Date(Math.floor(Math.max(Date.now(), Date.parse(checkpoint.directThrough ?? window.end)) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const start = new Date(Math.max(Date.parse(checkpoint.directThrough ?? window.end) - 300000,
        checkpoint.notBefore ? Date.parse(checkpoint.notBefore) : -Infinity)).toISOString().replace(/\.\d{3}Z$/, 'Z');
      window.privateRange = { start, end }; direct.done = false; direct.seen = []; delete direct.token; delete direct.restarted;
    }
    const privateRange = window.privateRange ?? { start: window.start, end: window.end };
    const privateRows = await readIncrementalLane(direct, privateRange.start, privateRange.end);
    checkpoint.pages++;
    if (direct.done) { checkpoint.directThrough = privateRange.end; checkpoint.groupRetryFrom ??= window.start; }

    // Group reading is best effort and lowest priority: use only the newest active
    // directory page, never enumerate thousands of old memberships before messages.
    const deferGroups = () => { controller.signal.throwIfAborted(); directory.retryAt = Date.now() + pollMs; };
    if (directory.retryAt && directory.retryAt <= Date.now()) delete directory.retryAt;
    if (direct.done && !directory.retryAt && !directory.done && !window.lanes.slice(1).some(lane => !lane.done)) {
      try {
        const page = await readData(['+chat-list', '--types', 'group', '--sort', 'active_time', '--exclude-muted', '--page-size', '100']);
        if (!Array.isArray(page.chats) || typeof page.has_more !== 'boolean') throw new Error('个人群名单分页无效');
        const known = new Set(window.lanes.flatMap(lane => lane.chatIds ?? []));
        const ids = [...new Set(page.chats.slice(0, 100).filter((chat: Row) => validChatId(chat?.chat_id) && chat.chat_mode !== 'p2p'
          && (chat.chat_status === undefined || chat.chat_status === 'normal')).map((chat: Row) => chat.chat_id as string))].filter(id => !known.has(id));
        const allowed = await unmutedIds(ids, readData);
        window.lanes.push(...scopedLanes(allowed).slice(1).sort((a, b) => Number(b.mentions) - Number(a.mentions)));
        directory.done = true;
      } catch { deferGroups(); }
    }
    const groupRows: Row[] = [];
    let pages = 1;
    for (const lane of window.lanes.slice(1)) {
      if (!direct.done || directory.retryAt || lane.done || pages >= limit) continue;
      try {
        // Settings must still be affirmative immediately before body search, including resumed cursors.
        const allowed = await unmutedIds(lane.chatIds!, readData);
        if (allowed.length !== lane.chatIds!.length) {
          // Split changed scopes into fresh searches. Never attach an old token to new chat IDs.
          lane.done = true; delete lane.token; lane.seen = [];
          window.lanes.push(...scopedLanes(allowed).slice(1).filter(next => next.mentions === lane.mentions));
          continue;
        }
        groupRows.push(...await readIncrementalLane(lane, checkpoint.groupRetryFrom ?? window.start, window.end));
        checkpoint.pages++; pages++;
      } catch { deferGroups(); break; }
    }
    const scoped = privateRows.concat(groupRows);
    const messages = checkpoint.notBefore ? scoped.filter(hit => {
      const at = isoTime(hit.create_time); return at !== undefined && Date.parse(at) >= Date.parse(checkpoint.notBefore!);
    }) : scoped;
    const evidence = messageEvidence(messages);
    const { items, aiMessages } = await messageThings(messages, evidence);
    const hasMore = !directory.done || window.lanes.some(lane => !lane.done);
    if (!hasMore) {
      checkpoint.lastCompletedThrough = window.end;
      if (checkpoint.directThrough && Date.parse(checkpoint.directThrough) > Date.parse(window.end)) checkpoint.groupRetryFrom = window.end;
      else { delete checkpoint.directThrough; delete checkpoint.groupRetryFrom; }
      delete checkpoint.window;
    }
    return { items, checkpoint, hasMore, evidence, aiMessages, editObservations: editObservations(messages) };
  }
  async function readIncrementalLane(lane: SearchLane, start: string, end: string): Promise<Row[]> {
    const read = () => cliPage(['+messages-search', '--start', start, '--end', end,
      '--page-size', '50', '--no-reactions', ...searchFilter(lane), ...(lane.token ? ['--page-token', lane.token] : [])]);
    let page;
    try { page = await read(); } catch (error) {
      if (!lane.token || object(error).kind !== 'cursor' || lane.restarted) throw error;
      lane.restarted = true; delete lane.token; lane.seen = []; page = await read();
    }
    const more = page.data.has_more === true || page.pagination.complete === false;
    if (!more && page.data.has_more !== false && page.pagination.complete !== true) throw new Error('飞书分页缺少完成标记');
    const next = string(page.data.page_token);
    if (more && (!next || next === lane.token || lane.seen.includes(next) || lane.seen.length >= 4096)) throw new Error('飞书分页游标无效，保留已完成进度');
    lane.done = !more;
    if (more) { if (lane.token) lane.seen.push(lane.token); lane.token = next; }
    else { lane.seen = []; delete lane.token; }
    return scopedHits(page.messages, lane);
  }
  function editObservations(messages: Row[]): FeishuEditObservation[] {
    const observations: FeishuEditObservation[] = [];
    for (const hit of messages) {
      const chatId = string(hit.chat_id), messageId = string(hit.message_id);
      const sender = object(hit.sender), senderId = string(sender.id);
      const senderType = string(sender.sender_type) || string(hit.sender_type) || string(sender.type);
      if (!validChatId(chatId) || !/^om_[A-Za-z0-9_-]+$/.test(messageId)
        || !/^ou_[A-Za-z0-9_-]+$/.test(senderId) || senderId === options.personalOpenId
        || (sender.id_type !== undefined && sender.id_type !== 'open_id') || (senderType && senderType !== 'user')) continue;
      const edited = hit.updated === true || hit.edited === true;
      if (hit.deleted === true) {
        // A confirmed recall is terminal, including receipts which omit the timestamp and body.
        observations.push({chatId,messageId,senderId,edited:false,deleted:true,timestamp:''});
        continue;
      }
      if ((hit.msg_type ?? hit.message_type) !== 'text' || typeof hit.content !== 'string') continue;
      // The CLI search shortcut returns converted text. Do not parse author-written JSON as a second envelope.
      let timestamp: string | undefined;
      const rawTime = edited ? hit.update_time : hit.update_time ?? hit.create_time;
      // Locale-dependent dates have no reliable ordering across collector restarts.
      if (typeof rawTime === 'string' && !/^\d+(?:\.\d+)?$/.test(rawTime)
        && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(rawTime)) continue;
      try { timestamp = isoTime(rawTime); }
      catch { continue; }
      if (!timestamp) continue;
      observations.push({chatId,messageId,senderId,text:hit.content,timestamp,edited,deleted:false});
    }
    return observations;
  }
  function messageEvidence(messages: Row[]): CollectedReplyEvidence[] {
    const matches = new Map<string, CollectedReplyEvidence>();
    // Search lanes may return different projections of one message. An omitted reply field
    // adds no evidence. Two explicit, conflicting references cannot establish a parent.
    const parents = new Map<string, Set<string>>();
    for (const hit of messages) {
      if (botSender(hit)) continue; // Meeting notifications are not personal reply evidence.
      const chatId = string(hit.chat_id), messageId = string(hit.message_id);
      const sender = object(hit.sender), senderId = string(sender.id), senderIdType = string(sender.id_type);
      if (!chatId || !messageId || !senderId || !senderIdType) continue;
      let createdAt: string | undefined;
      try { createdAt = isoTime(hit.create_time); } catch { continue; }
      if (!createdAt) continue;
      // CLI v1.0.74 content_convert.go preserves sender, but emits parent_id
      // as reply_to ONLY without thread_id. A thread alone proves no direct reply.
      // Native API parent_id/root_id are accepted when explicitly preserved.
      const key = JSON.stringify([chatId, messageId]);
      const senderKey = JSON.stringify([chatId, messageId, senderIdType, senderId]);
      let refs = parents.get(senderKey);
      for (const field of [hit.parent_id, hit.reply_to]) {
        if (typeof field !== 'string' || !field) continue;
        if (!refs) {
          refs = new Set();
          parents.set(senderKey, refs);
        }
        refs.add(field);
      }
      const parentId = refs?.size === 1 ? refs.values().next().value : undefined;
      const previous = matches.get(key);
      const edited = previous?.edited === true || hit.edited === true || hit.updated === true ? true : hit.updated;
      const deleted = previous?.deleted === true ? true : hit.deleted;
      const rootId = string(hit.root_id), threadId = string(hit.thread_id);
      matches.set(key, {
        source: `feishu:${options.appId}:${options.personalOpenId!}`,
        chatId, messageId, senderId, senderIdType, createdAt,
        ...(parentId ? { parentId } : {}), ...(rootId ? { rootId } : {}), ...(threadId ? { threadId } : {}),
        ...(typeof edited === 'boolean' ? { edited } : {}),
        ...(typeof deleted === 'boolean' ? { deleted } : {}),
        ...(string(hit.chat_name) ? { label: string(hit.chat_name).slice(0, 160) } : {}),
        ...(string(hit.content) ? { preview: string(hit.content).slice(0, 160) } : {}),
      });
    }
    return [...matches.values()];
  }
  // Only scoped search results enter evidence, detail and legacy history reads.
  function scopedHits(rows: Row[], lane: SearchLane): Row[] {
    rows = rows.filter(collectSender);
    if (!lane.chatIds) return rows.filter(hit => hit.chat_type === 'p2p' || !hit.chat_type)
      .map(hit => ({ ...hit, chat_type: 'p2p', explicitDirect: hit.chat_type === 'p2p', personalGroupObserved: false }));
    return rows.filter(hit => lane.chatIds!.includes(string(hit.chat_id)) && hit.chat_type !== 'p2p')
      .map(hit => ({ ...hit, personalGroupObserved: true }));
  }
  async function personalChatOrigin(hit: Row): Promise<Pick<NonNullable<InboxThing['origin']>, 'kind' | 'personalGroupUserCount' | 'personalGroupObserved'>> {
    if (hit.chat_type === 'p2p') return { kind: 'direct' };
    const detail = await options.personalChatDetail?.(string(hit.chat_id));
    const mode = hit.chat_type === 'group' ? 'group' : detail?.mode;
    if (mode === 'p2p') return { kind: 'direct' };
    if (mode !== 'group' && !hit.personalGroupObserved) return { kind: 'unknown' };
    return { kind: 'group', ...(hit.personalGroupObserved === true ? {personalGroupObserved: true as const} : {}), ...(detail?.mode !== 'p2p' && detail?.userCount !== undefined ? { personalGroupUserCount: detail.userCount } : {}) };
  }
  /** Default paged provider: each search hit owns its durable inbox identity.
   * Context changes cannot erase requests on other pages or affect provenance.
   * The host scopes identity by account; three search lanes share these IDs.
   * Legacy collect/collectOnce below retain conversation aggregation and keys;
   * no migration or deletion of existing conversation inbox entries is needed.
   */
  async function messageThings(messages: Row[], evidence: CollectedReplyEvidence[]) {
    const matches = new Map(messages.map(row => [JSON.stringify([row.chat_id, row.message_id]), row]));
    const anchors = new Map(evidence.map(anchor => [JSON.stringify([anchor.chatId, anchor.messageId]), anchor]));
    const changed = new Set(messages.filter(hit => hit.updated === true || hit.edited === true || hit.deleted === true)
      .map(hit => JSON.stringify([hit.chat_id, hit.message_id])));
    const aiMessages: PersonalAiMessage[] = [];
    const things: InboxThing[] = [];
    for (const [key, hit] of matches) {
      const chat = string(hit.chat_id), id = string(hit.message_id);
      if (!chat || !id || hit.deleted === true || anchors.get(key)?.deleted) continue;
      const own = string(object(hit.sender).id) === options.personalOpenId;
      const anchor = anchors.get(key), text = string(hit.content);
      const type = hit.msg_type ?? hit.message_type;
      const aiEligible = anchor && validChatId(chat) && /^om_[a-zA-Z0-9_-]+$/.test(id) && !changed.has(key)
        && (!type || type === 'text') && text.trim() && !botSender(hit);
      if (own && !aiEligible) continue;
      const chatOrigin = await personalChatOrigin(hit);
      if (aiEligible) {
        // A group lane can never become a direct chat through an inconsistent detail response.
        const direct = hit.personalGroupObserved === false && (hit.explicitDirect ||
          (await options.personalChatDetail?.(chat).catch(() => undefined))?.mode === 'p2p');
        const count = chatOrigin.personalGroupUserCount;
        const smallGroup = chatOrigin.personalGroupObserved && count !== undefined && Number.isSafeInteger(count) && count > 0 && count <= 50;
        if (direct || smallGroup) {
          aiMessages.push({ chatId: chat, messageId: id, text, senderId: anchor.senderId, senderIdType: anchor.senderIdType,
            createdAt: anchor.createdAt, ...(anchor.threadId && { threadId: anchor.threadId }), ...(anchor.rootId && { rootId: anchor.rootId }),
            ...(direct ? { kind: 'direct' } : { kind: 'group', groupObserved: true, groupUserCount: count }) });
        }
      }
      if (own) continue;
      const sender = string(hit.sender_name) || string(object(hit.sender).name) || string(object(hit.sender).id) || 'unknown';
      const { kind } = chatOrigin;
      const mentionedMe = !!options.personalOpenId && Array.isArray(hit.mentions) && hit.mentions.some(mention =>
        string(object(mention).id) === options.personalOpenId || string(object(object(mention).id).open_id) === options.personalOpenId);
      things.push({
        origin: { ...chatOrigin, connector: '飞书', chatId: chat, ...(type === 'file' && { feishuFile: true as const }), feishuLocation: personalMessageLocation(hit, chat), ...(string(hit.chat_name) ? { chatName: string(hit.chat_name) } : {}),
          senderName: sender, ...(meetingMinutes(hit) ? { meetingMinutes: true as const } : {}), ...(string(object(hit.sender).id) ? { senderId: string(object(hit.sender).id), senderIdType: string(object(hit.sender).id_type) || 'unknown' } : {}), ...(kind === 'group' ? { mentionedMe } : {}) },
        thread: `feishu:message:${JSON.stringify([chat, id])}`,
        last: `${id}${hit.update_time ? `:${String(hit.update_time)}` : ''}`,
        title: string(hit.chat_name) || chat,
        text: `[${id}] ${sender}: ${personalInboxBody(hit)}`,
        sender, receivedAt: isoTime(hit.create_time),
      });
    }
    return { items: things, aiMessages };
  }
  async function collectOnce(): Promise<InboxThing[]> {
    if (!options.profile?.trim()) return [];
    if (closed) throw new Error('飞书适配器已关闭');
    // The official shortcut performs search + mget; history below adds context.
    // A bounded recent window is deliberate; this is an inbox, not a full archive.
    // Message search rejects fractional seconds with API code 99992402, although
    // Date.toISOString() emits them. Its time filter needs whole-second RFC 3339.
    const start = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const search = async (lane: SearchLane) => scopedHits(await cli(['+messages-search', '--start', start,
      '--page-size', '50', '--no-reactions', ...searchFilter(lane)]), lane);
    const batches = [await search({ done: false, seen: [] })];
    const lanes = scopedLanes(await groupScope() ?? []);
    for (const lane of lanes.slice(1)) {
      if (!(await stillUnmuted(lane.chatIds!))) return enrich(batches[0]!);
      batches.push(await search(lane));
    }
    return enrich(batches.flat());
  }
  async function enrich(messages: Row[]): Promise<InboxThing[]> {
    const matches = [...new Map(messages.map(row => [`${string(row.chat_id)}:${string(row.message_id)}`, row])).values()];
    const groups = new Map<string, Row[]>();
    for (const row of matches) {
      const chat = string(row.chat_id);
      if (!chat || !string(row.message_id) || row.deleted === true) continue;
      if (options.personalOpenId && string(object(row.sender).id) === options.personalOpenId) continue;
      const key = `${chat}:${string(row.thread_id) || 'main'}`;
      const group = groups.get(key) ?? [];
      group.push(row); groups.set(key, group);
    }
    const things: InboxThing[] = [];
    for (const [key, hits] of groups) {
      if (closed) throw new Error('飞书适配器已关闭');
      const hit = hits[0]!;
      const threadId = string(hit.thread_id);
      if (hit.personalGroupObserved && !(await stillUnmuted([string(hit.chat_id)]))) continue;
      const history = await cli(threadId
        ? ['+threads-messages-list', '--thread', threadId, '--order', 'desc', '--page-size', '50', '--no-reactions']
        : ['+chat-messages-list', '--chat-id', string(hit.chat_id), '--order', 'desc', '--page-size', '50', '--no-reactions']);
      const rows = new Map<string, Row>();
      for (const row of [...hits, ...history.filter(row => collectSender(row) && (!row.chat_id || row.chat_id === hit.chat_id))]) if (string(row.message_id) && row.deleted !== true) rows.set(string(row.message_id), row);
      const context = [...rows.values()]
        .map((row): Row => ({ ...row, create_time: isoTime(row.create_time) }))
        .sort((a, b) => (Date.parse(string(a.create_time)) || 0) - (Date.parse(string(b.create_time)) || 0) || string(a.message_id).localeCompare(string(b.message_id)));
      const last = context.at(-1)!;
      const sender = (row: Row) => string(object(row.sender).name) || string(object(row.sender).id) || 'unknown';
      // Mentions refer to the verified personal account, distinct from the bot.
      const chatOrigin = await personalChatOrigin(hit);
      const { kind } = chatOrigin;
      const mentionedMe = kind === 'group' && !!options.personalOpenId && hits.some(row => Array.isArray(row.mentions)
        && row.mentions.some(mention => string(object(mention).id) === options.personalOpenId || string(object(object(mention).id).open_id) === options.personalOpenId));
      things.push({
        origin: { ...chatOrigin, connector: '飞书', chatId: string(hit.chat_id), ...(string(hit.chat_name) ? { chatName: string(hit.chat_name) } : {}), senderName: sender(last), ...(hits.some(meetingMinutes) ? { meetingMinutes: true as const } : {}), ...(kind === 'group' && options.personalOpenId ? { mentionedMe } : {}) },
        thread: `feishu:${key}`, last: `${string(last.message_id)}${last.update_time ? `:${String(last.update_time)}` : ''}`,
        title: string(hit.chat_name) || string(hit.chat_id),
        text: context.map(row => `[${string(row.message_id)}] ${sender(row)}: ${string(row.content)}`).join('\n'),
        sender: sender(last), receivedAt: string(last.create_time) || undefined,
      });
    }
    return things;
  }
  function collect(): Promise<InboxThing[]> {
    if (!collecting) {
      const epoch = generation;
      const pending = collectOnce().catch(error => {
        const detail = `个人消息采集失败：${reason(error)}`;
        if (epoch === generation && !closed) operationReason = detail;
        throw new Error(detail, { cause: error });
      }).finally(() => { if (collecting === pending) collecting = undefined; });
      collecting = pending;
    }
    return collecting;
  }
  async function poll(epoch: number) {
    try {
      const things = await collect();
      if (!running || epoch !== generation) return;
      await options.onInbox(things);
      if (running && epoch === generation) {
        pollTimer = setTimeout(() => { void poll(epoch); }, pollMs);
        pollTimer.unref();
      }
    } catch (error) {
      // Stop on failure; operator may restart after fixing credentials/scopes.
      if (running && epoch === generation) operationReason = `个人消息轮询已停止：${reason(error)}`;
    }
  }
  async function start(): Promise<void> {
    if (running) return;
    try {
      assertCredentials();
      for (const [name, value] of [['pollMs', pollMs], ['reconnectTimeoutMs', reconnectTimeoutMs]] as const) {
        if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`飞书 ${name} 必须为 1–2147483647 之间的整数`);
      }
    }
    catch (error) { connectionReason = reason(error); return; }
    closed = false; running = true; generation++;
    const epoch = generation;
    controller.abort();
    controller = new AbortController();
    token = undefined; tokenRequest = undefined; collecting = undefined;
    botOpenId = undefined;
    identityReason = options.groupMessages || options.commandGroupChatId || groupCommands ? '群消息不可用，正在读取机器人身份' : undefined;
    connectionReason = '正在连接飞书'; operationReason = undefined;
    try {
      const logger = createLogger(epoch);
      const dispatcher = new EventDispatcher({ logger }).register({
        'im.message.receive_v1': event => receive(event, epoch),
        'im.message.recalled_v1': event => {
          if (running && epoch === generation && event.chat_id && event.message_id) options.onRecall?.(event.chat_id, event.message_id);
        },
        'card.action.trigger': (event: unknown) => {
          const data = object(event), context = object(data.context), operator = object(data.operator);
          if (!running || epoch !== generation || !options.onCardAction) return { toast: { type: 'info', content: '卡片入口已失效，请重新发送「工作台」' } };
          try {
            return options.onCardAction({ operatorId: string(operator.open_id), chatId: string(context.open_chat_id),
              messageId: string(context.open_message_id), ...(typeof data.event_id === 'string' && data.event_id && {eventId:data.event_id}), value: object(object(data.action).value),
              ...(object(data.action).form_value ? { formValue: object(object(data.action).form_value) } : {}) });
          } catch { return { toast: { type: 'error', content: '卡片暂时不可用，请重新发送「工作台」' } }; }
        },
      });
      ws = (options.wsFactory ?? (params => new WSClient(params)))({
        appId: options.appId, appSecret: options.appSecret, autoReconnect: true, handshakeTimeoutMs: 15_000, logger,
        onReady: () => { if (running && epoch === generation) { connectionReason = ''; clearTimeout(startupTimer); } },
        onError: error => {
          if (running && epoch === generation) { connectionReason = reason(error); clearTimeout(startupTimer); clearTimeout(reconnectTimer); }
        },
        onReconnecting: () => {
          if (!running || epoch !== generation) return;
          connectionReason = '正在重连飞书';
          // SDK owns reconnect backoff/count. Cap the total outage as the server
          // may supply an unlimited retry count. Never replay sends or callbacks.
          if (reconnectTimer) return;
          reconnectTimer = setTimeout(() => {
            if (running && epoch === generation && ws?.getConnectionStatus().state !== 'connected') {
              connectionReason = '飞书重连超时，已停止重连'; ws?.close({ force: true });
            }
            reconnectTimer = undefined;
          }, reconnectTimeoutMs);
          reconnectTimer.unref();
        },
        onReconnected: () => {
          if (running && epoch === generation) { connectionReason = ''; clearTimeout(startupTimer); clearTimeout(reconnectTimer); reconnectTimer = undefined; }
        },
      });
      const client = ws;
      startupTimer = setTimeout(() => {
        if (running && epoch === generation && client.getConnectionStatus().state !== 'connected') { connectionReason = '飞书连接超时，已停止连接'; client.close({ force: true }); }
      }, 20_000);
      startupTimer.unref();
      // SDK start only initiates connection; readiness comes from lifecycle/status.
      void client.start({ eventDispatcher: dispatcher }).catch(error => {
        if (running && epoch === generation) { connectionReason = reason(error); clearTimeout(startupTimer); client.close({ force: true }); }
      });
    } catch (error) { connectionReason = reason(error); clearTimeout(startupTimer); ws?.close({ force: true }); }
    if (options.groupMessages || options.commandGroupChatId || groupCommands) void resolveBotIdentity(epoch);
    if (options.collectEnabled === true && options.profile?.trim()) void poll(epoch);
  }
  async function close(): Promise<void> {
    running = false; closed = true; generation++;
    clearTimeout(pollTimer); clearTimeout(startupTimer); clearTimeout(reconnectTimer); reconnectTimer = undefined;
    queue.length = 0; topicTransitions.clear();
    controller.abort();
    ws?.close({ force: true }); ws = undefined;
    token = undefined;
    tokenRequest = undefined; collecting = undefined; operationReason = undefined;
    botOpenId = undefined; identityReason = undefined;
    connectionReason = '已关闭';
  }
  function status(): { connected: boolean; reason?: string } {
    const state = ws?.getConnectionStatus().state;
    const connected = running && state === 'connected';
    if (closed) return { connected: false, reason: '已关闭' };
    const channelReason = connected ? undefined : state === 'reconnecting' ? '正在重连飞书' : connectionReason || `飞书连接状态：${state ?? 'idle'}`;
    const detail = [channelReason, identityReason, operationReason].filter(Boolean).join('；');
    return { connected, ...(detail ? { reason: detail } : {}) };
  }
  return { start, close, send, readPrivateQuote, readPrivatePostImages, readPrivateForward, readPrivateImage, readPrivateFile, readTaskQuote, topicOfMessage, readReaction, updateCard, collect, collectBatch, status,
    pinMessage: (id: string) => changePlatformMessage('pin', id),
    unpinMessage: (id: string) => changePlatformMessage('unpin', id),
    recallMessage: (id: string) => changePlatformMessage('recall', id),
  };
}

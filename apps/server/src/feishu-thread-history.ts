import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { Message } from '../../../packages/protocol/src/index.ts';
import { botConversationId } from '../../../packages/core/src/bot-agent-routing.ts';

export type PrivateThread = {
  threadId: string; botId: string; appId: string; revision: number; chatId: string; senderId: string; createdAt: string;
  version?: number; archived?: boolean; title?: string; tags?: string[]; tagsUpdatedBy?: 'user' | 'assistant'; tagsUpdatedAt?: string;
};
type Receipt = {
  channel: string; botId: string; accountId: string; revision: number; target: string;
  parentMessageId?:string; sourceMessageId?:string; replyReference?:{imageSourceId?:string; imagesUnavailable?:boolean;fileSourceId?:string;filesUnavailable?:boolean};
  privateFileBinding?: string; privateImageBinding?: string; privateSenderId?: string; conversationThreadId?: string; group?: unknown; relay?: unknown;
};

// A registered thread may still be empty after /new. Only show utterances with a matching private delivery route.
function threadMessages(store: Pick<Store, 'get' | 'list'>, rows: PrivateThread[]) {
  const conversations = new Map(rows.map(row => [botConversationId({ id: row.botId, scope: { kind: 'global' } }, row.threadId), row]));
  const messages = new Map<string, Message[]>();
  if (!rows.length) return messages;
  for (const message of store.list<Message>('messages')) {
    const row = conversations.get(message.conversationId);
    if (!row || (message.role !== 'user' && message.role !== 'assistant') || message.projectId || message.todoId || (message.origin && message.origin !== 'user')) continue;
    const inputId = message.role === 'user' ? message.id : message.replyTo;
    const route = inputId ? store.get<Receipt>('message.routes', inputId) : undefined;
    if (message.readOnly && !route?.privateImageBinding && !route?.privateFileBinding) continue;
    if (!route || route.channel !== 'feishu' || route.botId !== row.botId || route.accountId !== row.appId
      || route.revision !== row.revision || route.conversationThreadId !== row.threadId || route.group || route.relay
      || route.target !== row.chatId || route.privateSenderId !== row.senderId) continue;
    const list = messages.get(row.threadId) ?? [];
    list.push(message);
    messages.set(row.threadId, list);
  }
  for (const list of messages.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return messages;
}

// Match Unicode White_Space for stored labels and ordered IDs. JavaScript trim() uses a different set.
export function trimUnicodeSpace(raw: string) {
  let left = 0, right = raw.length;
  while (left < right && /\p{White_Space}/u.test(raw[left])) left++;
  while (right > left && /\p{White_Space}/u.test(raw[right - 1])) right--;
  return raw.slice(left, right);
}

export function normalizeThreadTags(input: unknown, max = 10): string[] {
  if (!Array.isArray(input)) throw Object.assign(new Error('标签须为字符串数组'), { status: 400 });
  const tags = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') throw Object.assign(new Error('标签须为字符串'), { status: 400 });
    const tag = trimUnicodeSpace(raw);
    if (!tag) continue;
    if (Array.from(tag).length > 32) throw Object.assign(new Error('每个标签最多 32 个字符'), { status: 400 });
    tags.add(tag);
  }
  if (tags.size > max) throw Object.assign(new Error(`最多可设置 ${max} 个标签`), { status: 400 });
  return [...tags];
}

export function privateThreadTags(store: Pick<Store, 'get' | 'list'>, rows: PrivateThread[]) {
  const tagged = rows.filter(row => row.tags?.length);
  const messages = threadMessages(store, tagged);
  const tags = new Set(tagged.filter(row => messages.has(row.threadId)).flatMap(row => row.tags ?? []));
  return { tags: [...tags].sort((a, b) => a.localeCompare(b)) };
}

function metadata(row: PrivateThread, list: Message[]) {
  const first = list.find(message => message.role === 'user')?.text || '独立对话';
  return { threadId: row.threadId, tags: row.tags ?? [],
    ...(row.tags?.length && row.tagsUpdatedBy && row.tagsUpdatedAt ? { tagsUpdatedBy: row.tagsUpdatedBy, tagsUpdatedAt: row.tagsUpdatedAt } : {}),
    title: row.title || Array.from(first.replace(/\s+/g, ' ')).slice(0, 80).join(''),
    latestAt: list.at(-1)?.createdAt ?? row.createdAt, count: list.length, archived: row.archived === true, version: row.version ?? 0 };
}

function historyEntries(store: Pick<Store, 'get' | 'list'>, rows: PrivateThread[], archived = false, tag?: string) {
  const selected = rows.filter(row => (row.archived === true) === archived && (!tag || row.tags?.includes(tag)));
  const messages = threadMessages(store, selected);
  return selected.flatMap(row => {
    const list = messages.get(row.threadId);
    return list?.length ? [{ info: metadata(row, list), list }] : [];
  }).sort((a, b) => b.info.latestAt.localeCompare(a.info.latestAt) || a.info.threadId.localeCompare(b.info.threadId));
}

function inPreferredOrder<T extends {threadId:string}>(items:T[], order:string[]) {
  if (!order.length) return items;
  const rank = new Map(order.map((id, i) => [id, i]));
  return items.sort((a, b) => (rank.get(a.threadId) ?? order.length) - (rank.get(b.threadId) ?? order.length));
}

export function readPrivateThreadHistory(store: Pick<Store, 'get' | 'list'>, rows: PrivateThread[], archived = false, tag?: string, order: string[] = []) {
  const items = historyEntries(store, rows, archived, tag).map(entry => entry.info);
  return archived ? items : inPreferredOrder(items, order);
}

function* matchingThreads(store: Pick<Store, 'get' | 'list'>, rows: PrivateThread[], query: string, archived: boolean, tag?: string) {
  if (typeof query !== 'string' || !query.trim() || query.length > 500)
    throw Object.assign(new Error('检索词须为 1 至 500 个字符'), { status: 400 });
  const pattern = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  for (const { info, list } of historyEntries(store, rows, archived, tag)) {
    const titleMatch = pattern.test(info.title);
    const hits = [];
    for (let i = list.length - 1; i >= 0 && hits.length < 3; i--) {
      const { id, role, text, createdAt, status } = list[i];
      const match = pattern.exec(text);
      if (!match) continue;
      let start = Math.max(0, match.index - 50);
      let end = Math.min(text.length, match.index + match[0].length + 70);
      // Keep quotes exact, including complete code points on either edge.
      if (start && /[\uDC00-\uDFFF]/.test(text[start])) start--;
      if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end++;
      hits.push({ id, role, excerpt: text.slice(start, end), truncated: start > 0 || end < text.length, status: status ?? null, createdAt });
    }
    if (hits.length || titleMatch) yield { ...info, titleMatch, hits };
  }
}

export function searchPrivateThreadList(store: Pick<Store, 'get' | 'list'>, rows: PrivateThread[], query: string, order:string[] = []) {
  const threads = [], snippets: Record<string,string> = Object.create(null), messageIds: Record<string,string> = Object.create(null);
  for (const { hits, titleMatch, ...thread } of matchingThreads(store, rows, query, false)) {
    threads.push(thread);
    const first = hits[0];
    if (first) {
      const speaker=first.role==='assistant'?'助手':'你';
      snippets[thread.threadId] = speaker+' · '+first.createdAt+'\n'+first.excerpt;
      messageIds[thread.threadId] = first.id;
    }
  }
  return {threads:inPreferredOrder(threads,order), snippets, messageIds};
}

export function searchPrivateThreads(store: Pick<Store, 'get' | 'list'>, rows: PrivateThread[], query: string, archived = false, before: string | null = null, tag?: string) {
  const items = [];
  let pastCursor = before === null;
  for (const info of matchingThreads(store, rows, query, archived, tag)) {
    if (!pastCursor) {
      pastCursor = info.threadId === before;
      continue;
    }
    if (items.length === 20) return { items, nextBefore: items[items.length - 1].threadId };
    items.push(info);
  }
  if (!pastCursor) throw Object.assign(new Error('检索位置已失效，请重新搜索'), { status: 409 });
  return { items, nextBefore: null };
}

export function privateThreadExport(store: Pick<Store, 'get' | 'list'>, row: PrivateThread) {
  const messages = threadMessages(store, [row]).get(row.threadId) ?? [];
  return { title: metadata(row, messages).title, messages };
}

export function readPrivateThreadMetadata(store: Pick<Store, 'get' | 'list'>, row: PrivateThread) {
  return metadata(row, threadMessages(store, [row]).get(row.threadId) ?? []);
}

export function privateThreadPage(store: Pick<Store, 'get' | 'list'>, row: PrivateThread, before: string | null,
  after: string | null = null, around: string | null = null, canReadFiles?: (message: Message) => boolean,
  canReadImages?: (message: Message) => boolean) {
  const cursors = [before, after, around].filter(value => value !== null);
  if (cursors.length > 1) throw Object.assign(new Error('每次只可采用一个消息位置'), { status: 400 });
  const list = threadMessages(store, [row]).get(row.threadId) ?? [];
  let end = list.length, start = Math.max(0, end - 40);
  if (cursors.length) {
    const index = list.findIndex(message => message.id === cursors[0]);
    if (index < 0) throw Object.assign(new Error('消息位置已失效，请重新打开对话'), { status: 409 });
    if (before !== null) {
      end = index;
      start = Math.max(0, end - 40);
    } else {
      start = after !== null ? index + 1 : Math.min(Math.max(0, index - 20), start);
      end = Math.min(list.length, start + 40);
    }
  }
  const page = list.slice(start, end);
  return { ...metadata(row, list), messages: page.map(message => {
    const {id,role,text,createdAt,status,images,files,conversationId,replyTo} = message;
    const route = role === 'user' ? store.get<Receipt>('message.routes', id) : undefined;
    const reference = route?.replyReference;
    const sourceId = reference?.fileSourceId ?? reference?.imageSourceId;
    const source = sourceId ? store.get<Message>('messages',sourceId) : undefined;
    const sourceRoute = source && store.get<Receipt>('message.routes',source.id);
    const showSource = source && source.role === 'user' && source.conversationId === conversationId &&
      route?.parentMessageId && route.parentMessageId === sourceRoute?.sourceMessageId;
    return {id,role,text,createdAt,status,
      ...(showSource && reference?.imageSourceId === source.id && canReadImages?.(source) ? {quotedImageMessageId:source.id} :
        (reference?.imageSourceId || reference?.imagesUnavailable) ? {quotedImagesUnavailable:true} : {}),
      ...(showSource && reference?.fileSourceId === source.id && canReadFiles?.(source) ? {quotedFileMessageId:source.id} :
        (reference?.fileSourceId || reference?.filesUnavailable) ? {quotedFilesUnavailable:true} : {}),
      ...(images?.length && canReadImages?.(message) ? {images,conversationId} : {}),
      ...(files?.length && canReadFiles?.(message) ? {files,conversationId,...(role === 'assistant' && replyTo ? {replyTo} : {})} : {}),
    };
  }),
    nextBefore: start && page.length ? page[0].id : null, nextAfter: end < list.length && page.length ? page[page.length - 1].id : null };
}

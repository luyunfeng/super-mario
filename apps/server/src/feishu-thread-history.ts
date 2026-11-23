import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { Message } from '../../../packages/protocol/src/index.ts';
import { botConversationId } from '../../../packages/core/src/bot-agent-routing.ts';

export type PrivateThread = {
  threadId: string; botId: string; appId: string; revision: number; chatId: string; senderId: string; createdAt: string;
  version?: number; archived?: boolean; title?: string;
};
type Receipt = {
  channel: string; botId: string; accountId: string; revision: number; target: string;
  privateSenderId?: string; conversationThreadId?: string; group?: unknown; relay?: unknown;
};

// A registered thread may still be empty after /new. Only show utterances with a matching private delivery route.
function threadMessages(store: Pick<Store, 'get' | 'list'>, rows: PrivateThread[]) {
  const conversations = new Map(rows.map(row => [botConversationId({ id: row.botId, scope: { kind: 'global' } }, row.threadId), row]));
  const messages = new Map<string, Message[]>();
  if (!rows.length) return messages;
  for (const message of store.list<Message>('messages')) {
    const row = conversations.get(message.conversationId);
    if (!row || message.readOnly || message.projectId || message.todoId || (message.origin && message.origin !== 'user')) continue;
    const inputId = message.role === 'user' ? message.id : message.replyTo;
    const route = inputId && store.get<Receipt>('message.routes', inputId);
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

function metadata(row: PrivateThread, list: Message[]) {
  const first = list.find(message => message.role === 'user')?.text || '独立对话';
  return { threadId: row.threadId, title: row.title || Array.from(first.replace(/\s+/g, ' ')).slice(0, 80).join(''),
    latestAt: list.at(-1)?.createdAt ?? row.createdAt, count: list.length, archived: row.archived === true, version: row.version ?? 0 };
}

export function readPrivateThreadHistory(store: Pick<Store, 'get' | 'list'>, rows: PrivateThread[], archived = false) {
  const selected = rows.filter(row => (row.archived === true) === archived);
  const messages = threadMessages(store, selected);
  return selected.flatMap(row => {
    const list = messages.get(row.threadId);
    return list?.length ? [metadata(row, list)] : [];
  }).sort((a, b) => b.latestAt.localeCompare(a.latestAt) || a.threadId.localeCompare(b.threadId));
}

export function readPrivateThreadMetadata(store: Pick<Store, 'get' | 'list'>, row: PrivateThread) {
  return metadata(row, threadMessages(store, [row]).get(row.threadId) ?? []);
}

export function privateThreadPage(store: Pick<Store, 'get' | 'list'>, row: PrivateThread, before: string | null) {
  const list = threadMessages(store, [row]).get(row.threadId) ?? [];
  const end = before === null ? list.length : list.findIndex(message => message.id === before);
  if (end < 0) throw Object.assign(new Error('消息位置已失效，请重新打开对话'), { status: 409 });
  const start = Math.max(0, end - 40);
  return { ...metadata(row, list), messages: list.slice(start, end).map(({ role, text, createdAt, status }) => ({ role, text, createdAt, status })),
    nextBefore: start ? list[start].id : null };
}

import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { Message } from '../../../packages/protocol/src/index.ts';
import { botConversationId } from '../../../packages/core/src/bot-agent-routing.ts';

export type PrivateThread = {
  threadId: string; botId: string; appId: string; revision: number; chatId: string; senderId: string; createdAt: string;
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

export function readPrivateThreadHistory(store: Pick<Store, 'get' | 'list'>, rows: PrivateThread[]) {
  return Array.from(threadMessages(store, rows), ([threadId, list]) => ({
    threadId, title: (list.find(row => row.role === 'user')?.text || '独立对话').replace(/\s+/g, ' ').slice(0, 80),
    latestAt: list.at(-1)!.createdAt, count: list.length,
  })).sort((a, b) => b.latestAt.localeCompare(a.latestAt) || a.threadId.localeCompare(b.threadId));
}

export function privateThreadPage(store: Pick<Store, 'get' | 'list'>, row: PrivateThread, before: string | null) {
  const list = threadMessages(store, [row]).get(row.threadId) ?? [];
  const end = before === null ? list.length : list.findIndex(message => message.id === before);
  if (end < 0) throw Object.assign(new Error('消息位置已失效，请重新打开对话'), { status: 409 });
  const start = Math.max(0, end - 40);
  return { messages: list.slice(start, end).map(({ role, text, createdAt, status }) => ({ role, text, createdAt, status })),
    nextBefore: start ? list[start].id : null };
}

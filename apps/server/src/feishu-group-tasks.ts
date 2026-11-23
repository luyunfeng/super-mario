import { createHash } from 'node:crypto';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { Todo } from '../../../packages/protocol/src/index.ts';
import type { FeishuMessageSource } from '../../../plugins/feishu.ts';

const collection = 'feishu.group-tasks';
type TaskStore = Pick<Store, 'get' | 'put' | 'transaction'>;
type Delivery = 'pending' | 'unknown' | 'confirmed';
export type TopicHome = { chatId: string; grant: string };
type FrozenTask = { home?: TopicHome; request: string; quote?: string };
type Receipt = {
  botId?: string; appId?: string; task?: FrozenTask;
  binding?: string; senderId?: string; chatId?: string; messageId?: string;
  homeChatId?: string; homeGrant?: string; homeThreadId?: string; todoId?: string; delivery?: Delivery; privateMessageId?: string; handedOff?: boolean; recalled?: boolean;
};
type Gate = () => boolean | void;

// A platform source can create only one task, even if the bot is later paired again.
function sourceKey(botId: string, appId: string, chatId: string, messageId: string) {
  return createHash('sha256').update(JSON.stringify([botId, appId, chatId, messageId])).digest('hex');
}

export function createGroupTasks(store: TaskStore, createTodo: (input: { title: string; notes: string }) => Todo) {
  const active = new Set<string>();
  const read = (key: string) => store.get<Receipt>(collection, key);
  function recall(botId: string, appId: string, chatId: string, messageId: string) {
    if (!botId || !appId || !chatId || !messageId) return;
    const key = sourceKey(botId, appId, chatId, messageId);
    store.transaction(() => {
      const old = read(key);
      if (!old?.recalled) store.put(collection, key, { botId, appId, chatId, messageId, ...old, recalled: true });
    });
  }
  function recalled(botId: string, appId: string, chatId: string, messageId: string) {
    return read(sourceKey(botId, appId, chatId, messageId))?.recalled === true;
  }
  async function open(botId: string, appId: string, binding: string, source: FeishuMessageSource & { quotedText?: string; home?: TopicHome },
    task: string, check: Gate, privateNotify: (todo: Todo, original: FrozenTask) => Promise<string | void>,
    publicNotify: (text: string) => Promise<string | void>, handoff?: (todo: Todo, privateMessageId: string, task: FrozenTask) => Promise<void>) {
    if (!botId || !appId || !binding || !source.chatId || !source.messageId || !source.senderId ||
        source.senderType !== 'user' || source.chatType !== 'group' || !source.mentionedSelf) return;
    const key = sourceKey(botId, appId, source.chatId, source.messageId);
    if (active.has(key)) return;
    active.add(key);
    try {
      const authorized = () => check() !== false && !read(key)?.recalled;
      const record = store.transaction(() => {
        if (!authorized()) return;
        const old = read(key);
        if (old) return old.binding === binding && old.senderId === source.senderId ? old : undefined;
        const words = task.trim();
        const quote = Array.from(source.quotedText?.trim() ?? '').slice(0, 300).join('');
        let todoId: string | undefined;
        if (words) {
          const notes = words + (quote ? '\n\n群内引用（他人发言，仅作背景）\n' + quote : '');
          const todo = createTodo({ title: Array.from(words.replace(/\s+/gu, ' ')).slice(0, 80).join(''), notes });
          todoId = todo.id;
        }
        const record: Receipt = { botId, appId, binding, task: { request: words, ...(quote && { quote }), ...(source.home && { home: source.home }) },
          ...(source.home && { homeChatId: source.home.chatId, homeGrant: source.home.grant }), senderId: source.senderId, chatId: source.chatId, messageId: source.messageId,
          ...(todoId && { todoId }), delivery: 'pending' };
        store.put(collection, key, record);
        return record;
      });
      if (!record || record.handedOff || record.delivery === 'unknown') return;
      const todo = record.todoId ? store.get<Todo>('todos', record.todoId) : undefined;
      if (record.todoId && !todo) return;
      let anchor = record.privateMessageId;
      if (record.delivery === 'pending') {
        const claimed = store.transaction(() => {
          const latest = read(key);
          if (!latest || latest.delivery !== 'pending' || !authorized()) return false;
          // A restart between this write and a platform receipt cannot establish whether the send happened.
          store.put(collection, key, { ...latest, delivery: 'unknown' });
          return true;
        });
        if (!claimed) return;
        let id: string | void;
        try {
          id = todo && record.task ? await privateNotify(todo, record.task) : await publicNotify('请在 /ai 后写下要办理的任务。');
        } catch (error) {
          // Only explicit evidence of no delivery permits a later attempt.
          if (error && typeof error === 'object' && 'delivery' in error && error.delivery === 'no') {
            store.transaction(() => { const last = read(key); if (last && !last.recalled) store.put(collection, key, { ...last, delivery: 'pending' }); });
          }
          throw error;
        }
        if (typeof id !== 'string' || !id.trim()) return;
        anchor = id;
        store.transaction(() => {
          const latest = read(key);
          if (latest) store.put(collection, key, { ...latest, delivery: 'confirmed', ...(todo && { privateMessageId: id }) });
        });
      }
      if (!todo || !anchor || !handoff || !record.task || !authorized()) return;
      // The caller enqueues with a durable key. A restart can repeat this local step without posting another message.
      await handoff(todo, anchor, record.task);
      store.transaction(() => {
        const latest = read(key);
        if (latest) store.put(collection, key, { ...latest, handedOff: true });
      });
    } finally { active.delete(key); }
  }
  function confirmHomeThread(botId: string, appId: string, source: FeishuMessageSource, anchor: string, threadId: string) {
    const key = sourceKey(botId, appId, source.chatId, source.messageId), row = read(key);
    if (!row?.homeGrant || row.privateMessageId !== anchor || row.recalled || (row.homeThreadId && row.homeThreadId !== threadId))
      throw new Error('主话题群绑定与发送回执不匹配。');
    store.put(collection, key, { ...row, homeThreadId: threadId });
  }
  return { open, recall, recalled, confirmHomeThread };
}

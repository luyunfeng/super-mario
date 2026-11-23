import { createHash } from 'node:crypto';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { Todo } from '../../../packages/protocol/src/index.ts';

export type TopicAudience = { binding: string; grant: string; chatId: string; threadId: string };
type Input = TopicAudience & { messageId: string; root: boolean; command: boolean; words: string };
type Turn = { todoId: string; opening: boolean; words: string };
type Receipt = { topic: string; turn?: Turn };
const threads = 'feishu.topic-todos', receipts = 'feishu.topic-turns';

function key(parts: string[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
function topic(a: TopicAudience) {
  const parts = [a.binding, a.grant, a.chatId, a.threadId];
  if (parts.every(s => typeof s === 'string' && s.trim())) return key(parts);
}

export function createTopicTurns(store: Pick<Store, 'get' | 'put' | 'transaction'>,
  createTodo: (input: { title: string; notes: string }) => Pick<Todo, 'id'>) {
  function todoFor(a: TopicAudience) {
    const id = topic(a);
    return id && store.get<string>(threads, id);
  }

  /** The caller supplies the current enrollment grant, including after asynchronous platform calls. */
  function bindHome(input: TopicAudience & { todoId: string }): boolean {
    return store.transaction(() => {
      const id = topic(input);
      if (!id || !input.todoId || store.get<Todo>('todos', input.todoId)?.id !== input.todoId) return false;
      const before = store.get<string>(threads, id);
      if (before) return before === input.todoId;
      store.put(threads, id, input.todoId);
      return true;
    });
  }

  function accept(input: Input): Turn | undefined {
    return store.transaction(() => {
      const id = topic(input);
      if (!id || !input.messageId?.trim()) return;
      // Message IDs stay consumed when the same owner removes and re-enrolls the group.
      // The enrollment grant and thread still have to match before a stored turn can be resumed.
      const event = key([input.binding, input.chatId, input.messageId]);
      const old = store.get<Receipt>(receipts, event);
      let todoId = store.get<string>(threads, id);
      if (old && (old.topic !== id || !old.turn || old.turn.todoId !== todoId)) return;
      if (todoId) {
        const todo = store.get<Todo>('todos', todoId);
        if (!todo || todo.completedAt) {
          store.put(receipts, event, { topic: id } satisfies Receipt);
          return;
        }
      }
      if (old) return old.turn;
      const words = input.words.trim(), opening = !todoId;
      if (!words.replace(/\[(?:图片|视频)\]/gu, '').trim() || (opening && !input.root && !input.command)) {
        store.put(receipts, event, { topic: id } satisfies Receipt);
        return;
      }
      if (!todoId) {
        const chars = Array.from(words);
        const todo = createTodo({ title: Array.from(words.replace(/\s+/gu, ' ')).slice(0, 80).join(''),
          notes: chars.slice(0, 4000).join('') });
        if (!todo.id) throw new Error('创建话题待办时未取得待办 ID');
        todoId = todo.id;
        store.put(threads, id, todoId);
      }
      const turn: Turn = { todoId, opening, words };
      store.put(receipts, event, { topic: id, turn } satisfies Receipt);
      return turn;
    });
  }
  return { accept, bindHome, todoFor };
}

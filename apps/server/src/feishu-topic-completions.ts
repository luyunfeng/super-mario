import { createHash } from 'node:crypto';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { Todo } from '../../../packages/protocol/src/index.ts';

const receipts = 'feishu.topic-completions';
type Route = { inputId: string };
type Options = {
  resolve(todoId: string): Route | undefined;
  send(todoId: string, inputId: string, text: string, key: string, guard: () => void): Promise<string>;
};

/** Notify the original directly registered topic only on a completion seen by this controller. */
export function createTopicCompletions(store: Pick<Store, 'get' | 'put' | 'list' | 'transaction'>, options: Options) {
  const observed = new Map<string, string>();
  for (const todo of store.list<Todo>('todos')) {
    if (todo.completedAt) observed.set(todo.id, todo.completedAt);
  }
  let closed = false;
  const jobs = new Set<Promise<void>>();

  function eligible(todo: Todo | undefined, id: string) {
    return todo?.id === id && todo.projectId === undefined && !todo.groupTask && typeof todo.completedAt === 'string'
      && Number.isFinite(Date.parse(todo.completedAt));
  }
  async function notify(id: string) {
    if (closed) return;
    const todo = store.get<Todo>('todos', id);
    if (!todo?.completedAt) { observed.delete(id); return; }
    const generation = todo.completedAt;
    if (observed.get(id) === generation) return;
    // All changes (including edits to title/notes) share the same event. Don't backfill old or unroutable completions.
    observed.set(id, generation);
    if (!eligible(todo, id)) return;
    const inputId = options.resolve(id)?.inputId;
    if (typeof inputId !== 'string' || !inputId.trim()) return;
    const key = createHash('sha256').update(JSON.stringify([id, generation])).digest('hex');
    const receipt = { todoId: id, completedAt: generation, inputId };
    const claimed = store.transaction(() => {
      if (store.get(receipts, key)) return false;
      store.put(receipts, key, { ...receipt, delivery: 'unknown' });
      return true;
    });
    if (!claimed) return;
    const guard = () => {
      const latest = store.get<Todo>('todos', id);
      if (closed || !eligible(latest, id) || latest?.completedAt !== generation || options.resolve(id)?.inputId !== inputId)
        throw Object.assign(new Error('话题待办的完成状态或原消息已变化。'), { delivery: 'no' });
    };
    let messageId: string;
    try {
      guard();
      messageId = await options.send(id, inputId, '这项待办已完成。', 'feishu-topic-completion:' + key, guard);
    } catch (error) {
      if (error && typeof error === 'object' && 'delivery' in error && error.delivery === 'no')
        store.put(receipts, key, { ...receipt, delivery: 'failed' });
      return;
    }
    if (typeof messageId === 'string' && messageId.trim())
      store.put(receipts, key, { ...receipt, delivery: 'confirmed', messageId });
  }

  return {
    changed(todoId: string): Promise<void> {
      if (closed) return Promise.resolve();
      // Some hosts emit todos.changed inside a transaction. Read its committed result.
      const job = Promise.resolve().then(() => notify(todoId)).finally(() => jobs.delete(job));
      jobs.add(job);
      return job;
    },
    async close() { closed = true; await Promise.allSettled([...jobs]); },
  };
}

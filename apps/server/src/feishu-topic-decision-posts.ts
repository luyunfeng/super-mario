import { createHash } from 'node:crypto';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';

const queues = 'feishu.topic-decision-queues', seen = 'feishu.topic-decision-seen', receipts = 'feishu.topic-decision-posts';
type Queue = { todoId: string; inputId: string; decisions: string[]; due: number; lastAttempt: number | null };
type Options = {
  resolve(todoId: string): { inputId: string } | undefined;
  isCurrent?(todoId: string, decisionId: string): boolean;
  send(todoId: string, inputId: string, text: string, key: string, guard: () => void): Promise<string>;
  settleMs?: number; intervalMs?: number;
};
const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export function createTopicDecisionPosts(store: Pick<Store, 'get' | 'put' | 'list' | 'transaction'>, options: Options) {
  const settle = options.settleMs ?? 3000, interval = options.intervalMs ?? 60_000;
  const timers = new Map<string, { handle: ReturnType<typeof setTimeout>; due: number }>();
  const jobs = new Map<string, Promise<void>>();
  let closed = false, started = false;

  const read = (todoId: string) => store.get<Queue>(queues, todoId);
  function anchor(todoId: string) {
    try { return options.resolve(todoId)?.inputId; } catch { return undefined; }
  }
  function current(todoId: string, decision: string) {
    try { return !options.isCurrent || options.isCurrent(todoId, decision); } catch { return false; }
  }

  function arm(row?: Queue) {
    if (!started || closed || !row?.decisions.length || jobs.has(row.todoId)) return;
    const { todoId, due } = row, old = timers.get(todoId);
    if (old && old.due <= due) return;
    if (old) clearTimeout(old.handle);
    const handle = setTimeout(() => {
      timers.delete(todoId);
      if (closed) return;
      const job = Promise.resolve().then(() => flush(todoId)).then(() => {
        jobs.delete(todoId);
        if (!closed) arm(read(todoId));
      }, () => { jobs.delete(todoId); });
      jobs.set(todoId, job);
      void job.catch(() => {});
    }, Math.max(0, due - Date.now()));
    handle.unref();
    timers.set(todoId, { due, handle });
  }

  async function flush(todoId: string) {
    const batch = store.transaction(() => {
      // changed() may have armed a timer inside a host transaction that subsequently rolled back.
      const row = read(todoId);
      if (!started || closed || !row?.decisions.length || row.due > Date.now()) return;
      store.put(queues, todoId, { ...row, decisions: [], due: 0, lastAttempt: Date.now() });
      if (anchor(todoId) !== row.inputId) return;
      const decisions = row.decisions.filter(id => current(todoId, id));
      if (!decisions.length) return;
      const key = 'feishu-topic-decisions:' + hash([todoId, row.inputId, decisions]);
      if (store.get(receipts, key)) return;
      store.put(receipts, key, { delivery: 'unknown', count: decisions.length });
      return { decisions, inputId: row.inputId, key };
    });
    if (!batch) return;
    const { inputId, decisions, key } = batch;
    const guard = () => {
      if (closed || anchor(todoId) !== inputId || !decisions.every(id => current(todoId, id)))
        throw Object.assign(new Error('待办决定或原话题已变化。'), { delivery: 'no' });
    };
    let messageId: string;
    try {
      guard();
      messageId = await options.send(todoId, inputId, '待办新增 ' + decisions.length + ' 项决定。', key, guard);
    } catch (error) {
      if (error && typeof error === 'object' && 'delivery' in error && error.delivery === 'no')
        store.put(receipts, key, { delivery: 'failed', count: decisions.length });
      return;
    }
    if (typeof messageId === 'string' && messageId.trim())
      store.put(receipts, key, { delivery: 'confirmed', count: decisions.length, messageId });
  }

  return {
    // Startup may temporarily lack live route authority. Only arm timers once the controller has restored its adapters.
    recover(): void {
      if (started || closed) return;
      started = true;
      for (const row of store.list<Queue>(queues)) arm(row);
    },
    changed(todoId: string, decisionId: string): void {
      if (closed || !todoId?.trim() || !decisionId?.trim()) return;
      const row = store.transaction(() => {
        const event = hash([todoId, decisionId]);
        if (store.get(seen, event)) return;
        store.put(seen, event, true);
        const inputId = anchor(todoId);
        if (!inputId?.trim()) return;
        const previous = read(todoId), now = Date.now();
        const decisions = previous?.inputId === inputId ? previous.decisions : [];
        // Bound the first batch of a burst. Its deadline is set by the first event, not extended by the last one.
        if (decisions.length >= 50) return;
        const lastAttempt = previous?.lastAttempt ?? null;
        const due = decisions.length ? previous!.due : Math.max(now + settle, lastAttempt === null ? 0 : lastAttempt + interval);
        const next = { todoId, inputId, decisions: [...decisions, decisionId], due, lastAttempt };
        store.put(queues, todoId, next);
        return next;
      });
      arm(row);
    },
    async close() {
      closed = true;
      for (const { handle } of timers.values()) clearTimeout(handle);
      timers.clear();
      await Promise.allSettled([...jobs.values()]);
    },
  };
}

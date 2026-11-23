import { createHash } from 'node:crypto';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';

const queues = 'feishu.topic-decision-queues', seen = 'feishu.topic-decision-seen', receipts = 'feishu.topic-decision-posts';
type Kind = 'decision' | 'interaction' | 'finished';
type Item = { kind: Kind; id: string };
type Queue = { todoId: string; inputId: string; items: Item[]; due: number; lastAttempt: number | null };
type Options = {
  resolve(todoId: string): { inputId: string } | undefined;
  isCurrent?(todoId: string, id: string, kind: Kind, inputId: string): boolean;
  send(todoId: string, inputId: string, text: string, key: string, guard: () => void): Promise<string>;
  settleMs?: number; intervalMs?: number;
};
const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export function createTopicPosts(store: Pick<Store, 'get' | 'put' | 'list' | 'transaction'>, options: Options) {
  const settle = options.settleMs ?? 3000, interval = options.intervalMs ?? 60_000;
  const timers = new Map<string, { handle: ReturnType<typeof setTimeout>; due: number }>();
  const jobs = new Map<string, Promise<void>>();
  let closed = false, started = false;

  // Previous releases stored only Web decision IDs. Preserve deadlines and the last attempt on upgrade.
  function read(todoId: string): Queue | undefined {
    const row = store.get<Queue & { decisions?: string[] }>(queues, todoId);
    if (!row) return;
    return { todoId: row.todoId, inputId: row.inputId, due: row.due, lastAttempt: row.lastAttempt,
      items: row.items ?? (row.decisions ?? []).map(id => ({kind: 'decision', id})) };
  }
  function anchor(todoId: string) {
    try { return options.resolve(todoId)?.inputId; } catch { return undefined; }
  }
  function current(todoId: string, item: Item, inputId: string) {
    try { return !options.isCurrent || options.isCurrent(todoId, item.id, item.kind, inputId); } catch { return false; }
  }

  function arm(row?: Queue) {
    if (!started || closed || !row?.items.length || jobs.has(row.todoId)) return;
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
      if (!started || closed || !row?.items.length || row.due > Date.now()) return;
      store.put(queues, todoId, { ...row, items: [], due: 0, lastAttempt: Date.now() });
      if (anchor(todoId) !== row.inputId) return;
      const items = row.items.filter(item => current(todoId, item, row.inputId));
      if (!items.length) return;
      const identities = items.every(item => item.kind === 'decision') ? items.map(item => item.id) : items;
      const key = 'feishu-topic-decisions:' + hash([todoId, row.inputId, identities]);
      if (store.get(receipts, key)) return;
      store.put(receipts, key, { delivery: 'unknown', count: items.length });
      return { items, inputId: row.inputId, key };
    });
    if (!batch) return;
    const { inputId, items, key } = batch;
    const guard = () => {
      if (closed || anchor(todoId) !== inputId || !items.every(item => current(todoId, item, inputId)))
        throw Object.assign(new Error('待办状态或原话题已变化。'), { delivery: 'no' });
    };
    let messageId: string;
    try {
      guard();
      const count = items.filter(item => item.kind === 'decision').length;
      const lines = [];
      if (count) lines.push('待办新增 ' + count + ' 项决定。');
      if (items.some(item => item.kind === 'finished')) lines.push('负责会话已结束一轮执行。');
      if (items.some(item => item.kind === 'interaction')) lines.push('负责会话需要主人处理，请到 Web「等你处理」查看。');
      messageId = await options.send(todoId, inputId, lines.join('\n'), key, guard);
    } catch (error) {
      if (error && typeof error === 'object' && 'delivery' in error && error.delivery === 'no') {
        store.transaction(() => {
          store.put(receipts, key, { delivery: 'failed', count: items.length });
          // A request may be answered during the send hook. Keep the other notices only when no I/O occurred.
          const row = read(todoId);
          if (closed || row?.inputId !== inputId || anchor(todoId) !== inputId) return;
          const remaining = items.filter(item => current(todoId, item, inputId));
          if (remaining.length && remaining.length < items.length)
            store.put(queues, todoId, { ...row, items: [...remaining, ...row.items].slice(0, 50),
              due: Math.max(row.due, (row.lastAttempt ?? Date.now()) + interval) });
        });
      }
      return;
    }
    if (typeof messageId === 'string' && messageId.trim())
      store.put(receipts, key, { delivery: 'confirmed', count: items.length, messageId });
  }

  return {
    // Startup may temporarily lack live route authority. Only arm timers once the controller has restored its adapters.
    recover(): void {
      if (started || closed) return;
      started = true;
      for (const row of store.list<Queue>(queues)) arm(read(row.todoId));
    },
    changed(todoId: string, id: string, kind: Kind = 'decision'): void {
      if (closed || !todoId?.trim() || !id?.trim()) return;
      const row = store.transaction(() => {
        const event = hash(kind === 'decision' ? [todoId, id] : [todoId, kind, id]);
        if (store.get(seen, event)) return;
        store.put(seen, event, true);
        const inputId = anchor(todoId);
        if (!inputId?.trim()) return;
        const previous = read(todoId), now = Date.now();
        const items = previous?.inputId === inputId ? previous.items : [];
        // Bound the first batch of a burst. Its deadline is set by the first event, not extended by the last one.
        if (items.length >= 50) return;
        const lastAttempt = previous?.lastAttempt ?? null;
        const due = items.length ? previous!.due : Math.max(now + settle, lastAttempt === null ? 0 : lastAttempt + interval);
        const next = { todoId, inputId, items: [...items, {kind, id}], due, lastAttempt };
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

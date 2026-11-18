import { createHash, randomUUID } from 'node:crypto';
import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';
import type { Json } from '../../protocol/src/index.ts';

export interface EffectRecord {
  id: string; key: string; kind: string; target: string; summary: string; fingerprint: string;
  status: 'sent' | 'confirmed' | 'failed' | 'unknown'; result?: Json; error?: string; updatedAt: string;
}
export class EffectError extends Error {
  status = 409;
  delivery: 'no' | 'unknown';
  constructor(message: string, delivery: 'no' | 'unknown') { super(message); this.delivery = delivery; }
}
/** Claim before I/O. Restarting or repeating an uncertain mutation never resends it. */
export function createEffects({ store, events }: { store: Store; events: EventBus }) {
  let closed = false;
  const jobs = new Map<string, Promise<unknown>>();
  for (const record of store.list<EffectRecord>('effects')) {
    if (record.status === 'sent') store.put('effects', record.key, { ...record, status: 'unknown', error: '服务重启，外部动作结果未确认' });
  }
  function save(record: EffectRecord) {
    store.put('effects', record.key, record);
    events.publish('effects.changed', { id: record.id, status: record.status });
  }
  return {
    list: () => store.list<EffectRecord>('effects'),
    async perform<T>(input: { key: string; kind: string; target: string; summary: string; content?: Json; run: () => Promise<T> }): Promise<T> {
      if (closed) throw new EffectError('外部动作服务已关闭', 'no');
      const fingerprint = createHash('sha256').update(JSON.stringify([input.kind, input.target, input.content ?? input.summary])).digest('hex');
      const previous = store.get<EffectRecord>('effects', input.key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new EffectError('同一动作标识不能用于不同内容', 'no');
        const pending = jobs.get(input.key);
        if (pending) return pending as Promise<T>;
        if (previous.status === 'confirmed') return previous.result as T;
        throw new EffectError(previous.error ?? '该动作已尝试，必须核实结果后再决定下一步', previous.status === 'failed' ? 'no' : 'unknown');
      }
      const record: EffectRecord = { id: randomUUID(), key: input.key, kind: input.kind, target: input.target, summary: input.summary, fingerprint, status: 'sent', updatedAt: new Date().toISOString() };
      save(record);
      const job = Promise.resolve().then(input.run).then(result => {
        // Drop undefined fields before crossing the JSON storage boundary.
        save({ ...record, status: 'confirmed', result: JSON.parse(JSON.stringify(result ?? null)) as Json, updatedAt: new Date().toISOString() });
        return result;
      }, error => {
        const definite = error && typeof error === 'object' && 'delivery' in error && error.delivery === 'no';
        save({ ...record, status: definite ? 'failed' : 'unknown', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
        throw new EffectError(error instanceof Error ? error.message : String(error), definite ? 'no' : 'unknown');
      }).finally(() => jobs.delete(input.key));
      jobs.set(input.key, job);
      return job;
    },
    async close() { closed = true; await Promise.allSettled([...jobs.values()]); },
  };
}

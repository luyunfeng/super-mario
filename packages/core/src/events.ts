import type { AppEvent } from '../../protocol/src/index.ts';
import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';

const eventsCollection = 'core.events';
const metadataCollection = 'core.event-metadata';

export function createEventBus(store: Store, { retentionDays = 30, now = Date.now }: { retentionDays?: number; now?: () => number } = {}): EventBus {
  let cleanedAt = 0;
  const listeners = new Set<(event: AppEvent) => void>();
  return {
    publish(type, data) {
      if (now() - cleanedAt > 86400000) {
        const cutoff = now() - retentionDays * 86400000;
        for (const old of store.list<AppEvent>(eventsCollection)) if (Date.parse(old.createdAt) < cutoff) store.remove(eventsCollection, String(old.id));
        cleanedAt = now();
      }
      const event = store.transaction(() => {
        const id = (store.get<number>(metadataCollection, 'lastId') ?? 0) + 1;
        const event: AppEvent = { id, type, data, createdAt: new Date(now()).toISOString() };
        store.put(eventsCollection, String(id), event);
        store.put(metadataCollection, 'lastId', id);
        return event;
      });
      // Persistence succeeds independently of observers. Snapshot the listeners so
      // subscribing during delivery does not extend the current dispatch.
      for (const listener of [...listeners]) {
        try { void Promise.resolve(listener(structuredClone(event))).catch(() => {}); }
        catch { /* A broken observer must not prevent delivery to the others. */ }
      }
      return event;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    since(id) {
      if (!Number.isSafeInteger(id) || id < 0) throw new TypeError('事件游标必须为非负整数');
      return store.listAfter ? store.listAfter<AppEvent>(eventsCollection, id, 1000) : store.list<AppEvent>(eventsCollection).filter(event => event.id > id).sort((a, b) => a.id - b.id).slice(0,1000);
    },
  };
}

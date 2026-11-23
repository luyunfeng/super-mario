import { createHash } from 'node:crypto';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { TopicAudience } from './feishu-topic-turns.ts';

type Anchor = { messageId: string; mentionedSelf: boolean };
type Entry = Anchor & { audience: string; at: number; ownerMessage?: boolean };
const active = 'feishu.topic-anchors', tracked = 'feishu.topic-anchor-audiences', seen = 'feishu.topic-anchor-events';
const lifetime = 30 * 24 * 60 * 60 * 1000, capacity = 200;
const hash = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const identifier = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && !/\s/u.test(s);
function audienceKey(a: TopicAudience) {
  const parts = [a?.binding, a?.grant, a?.chatId, a?.threadId];
  if (parts.every(identifier)) return hash(parts);
}

export function createTopicAnchors(store: Pick<Store, 'get' | 'put' | 'transaction'>) {
  // Keep message IDs only in the bounded list. Digest-only markers prevent a replay or eviction
  // from making an already managed thread appear eligible for the legacy opening-message fallback.
  function entries(binding: string, now: number) {
    const rows = store.get<Entry[]>(active, binding) ?? [];
    const kept = rows.filter(row => row.at >= now - lifetime);
    if (kept.length !== rows.length) store.put(active, binding, kept);
    return kept;
  }
  const eventKey = (a: TopicAudience, messageId: string) => hash([a.binding, a.chatId, messageId]);

  return {
    remember(a: TopicAudience, messageId: string, mentionedSelf: boolean, ownerMessage = false): void {
      const key = audienceKey(a);
      if (!key || !identifier(messageId) || typeof mentionedSelf !== 'boolean') return;
      store.transaction(() => {
        const event = eventKey(a, messageId);
        // The host calls before topicTurns.accept. Its older durable receipt also
        // covers pre-upgrade events for which this service has no local replay marker.
        if (store.get(seen, event) || store.get('feishu.topic-turns', event)) return;
        const now = Date.now(), rows = entries(a.binding, now).filter(row => row.audience !== key);
        store.put(seen, event, true);
        store.put(tracked, key, true);
        rows.push({ audience: key, messageId, mentionedSelf, ownerMessage, at: now });
        // Arrival order breaks millisecond ties and remains stable across SQLite reopen.
        store.put(active, a.binding, rows.slice(-capacity));
      });
    },
    lookup(a: TopicAudience, requireOwnerMessage = false): Anchor | null | undefined {
      const key = audienceKey(a);
      if (!key) return null;
      return store.transaction(() => {
        const row = entries(a.binding, Date.now()).find(item => item.audience === key);
        if (row && requireOwnerMessage && row.ownerMessage !== true) return null;
        if (row) return { messageId: row.messageId, mentionedSelf: row.mentionedSelf };
        return store.get(tracked, key) ? null : undefined;
      });
    },
    forget(a: TopicAudience, messageId: string): void {
      const key = audienceKey(a);
      if (!key || !identifier(messageId)) return;
      store.transaction(() => {
        const rows = entries(a.binding, Date.now());
        const current = rows.find(row => row.audience === key);
        store.put(seen, eventKey(a, messageId), true);
        if (current && current.messageId !== messageId) return;
        store.put(tracked, key, true);
        if (current) store.put(active, a.binding, rows.filter(row => row.audience !== key));
      });
    },
  };
}

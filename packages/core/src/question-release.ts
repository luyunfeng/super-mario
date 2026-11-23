import type { Message } from '../../protocol/src/index.ts';
import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Card } from './interactions.ts';

const holdMs = 2 * 60_000;
interface Queued { message: Message; sourceId: string }

export function createQuestionRelease(store: Store, host: {
  source(card: Card): {input:Message; audience:string} | undefined;
  audience(message: Message, sourceId: string): string | undefined;
  keep(card: Card, inputId: string, audience: string): boolean;
  changed(id: string): void;
}) {
  // Queue membership belongs to the running process. A persisted pending input
  // left by a crashed runtime is not evidence that this runtime will consume it.
  const queued = new Map<string,Queued>();
  let closed = false;
  const timers = new Map<string,ReturnType<typeof setTimeout>>();
  function hasQueued(source: {input:Message; audience:string}) {
    return [...queued.values()].some(({message,sourceId}) => message.conversationId === source.input.conversationId &&
      store.get<Message>('messages',message.id)?.status === 'pending' && host.audience(message,sourceId) === source.audience);
  }
  function candidate(id:string) {
    const card = store.get<Card>('interactions',id);
    if (!card || card.kind !== 'question' || card.runId || card.status !== 'open' || card.wait === false ||
        card.handler !== 'user' || !(Date.parse(card.expiresAt) > Date.now())) return;
    const source = host.source(card);
    if (source && hasQueued(source)) return {card,source};
  }
  function check(id: string) {
    if (closed || !queued.size) return;
    const before = candidate(id);
    if (!before) return;
    const { card,source } = before;
    const remaining = Date.parse(card.createdAt) + holdMs - Date.now();
    if (!Number.isFinite(remaining)) return;
    if (remaining > 0) {
      if (!timers.has(id)) {
        const timer = setTimeout(() => { timers.delete(id); safeCheck(id); },remaining);
        timer.unref(); timers.set(id,timer);
      }
      return;
    }
    const converted = store.transaction(() => {
      const current = candidate(id);
      if (!current || current.card.version !== card.version || current.source.input.id !== source.input.id ||
          current.source.audience !== source.audience || !(Date.parse(current.card.createdAt) + holdMs <= Date.now())) return false;
      if (!host.keep(current.card,current.source.input.id,current.source.audience)) return false;
      // Existing Web and Feishu forms still authorize this same owner decision.
      store.put('interactions',id,{...current.card,wait:false});
      return true;
    });
    if (converted) host.changed(id);
  }
  let lastWarning: number | undefined;
  function reportFailure(error:unknown) {
    const now=Date.now();
    if (lastWarning !== undefined && now-lastWarning < 60000) return;
    lastWarning=now;
    // Adapter errors can contain text, paths or credentials. Only include a known error-code format.
    const code=error && typeof error==='object' && 'code' in error ? error.code : undefined;
    console.warn('自动转换等待提问时读取或保存失败，队列继续处理。',
      typeof code==='string' && /^(?:ERR_)?SQLITE_[A-Z_]{1,40}$/.test(code) ? code : '');
  }
  function safeCheck(id:string) {
    // Full later-question capacity, invalidated routes, and storage failures
    // leave the old wait intact. They must not reject or delay an incoming turn.
    try { check(id); } catch (error) { reportFailure(error); }
  }
  function clearTimers() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }
  return {
    check: safeCheck,
    queued(message:Message,sourceId:string) {
      if (closed) return () => {};
      queued.set(message.id,{message,sourceId});
      try {
        for (const card of store.list<Card>('interactions')) if (card.status === 'open') safeCheck(card.id);
      } catch (error) { reportFailure(error); }
      return () => {
        queued.delete(message.id);
        if (!queued.size) clearTimers();
      };
    },
    close() {
      closed=true; clearTimers(); queued.clear();
    },
  };
}

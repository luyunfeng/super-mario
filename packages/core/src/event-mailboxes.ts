import { createHash } from 'node:crypto';
import type { BotScope, MailboxEntry } from '../../protocol/src/index.ts';
import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';
import { scopeError, validateBotScope } from './bot-scopes.ts';
import { normalizeInboxOrigin } from './inbox-origin.ts';

type Input = Pick<MailboxEntry, 'direction' | 'scope' | 'botId' | 'eventKey' | 'title' | 'text'> & Partial<Pick<MailboxEntry, 'origin' | 'target' | 'sourceMessageId' | 'replyTo' | 'requiresConfirmation'>>;
type Handler = (entry: MailboxEntry) => Promise<{ id?: string } | void>;
const collection = 'event.mailboxes';
const now = () => new Date().toISOString();
function required(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) scopeError(`${label}不能为空`);
}

/** Durable event envelopes share one store. Confirmation never performs a second delivery. */
export function createEventMailboxes({ store, events }: { store: Store; events: EventBus }) {
  let closed = false;
  let handlers: Partial<Record<'inbox' | 'outbox', Handler>> = {};
  const jobs = new Set<Promise<MailboxEntry>>();
  function changed(entry: MailboxEntry) {
    events.publish('mailboxes.changed', { id: entry.id, direction: entry.direction, botId: entry.botId, scope: entry.scope, status: entry.status });
  }
  function read(id: string, version?: number) {
    if (closed) scopeError('事件信箱已关闭', 503);
    const entry = store.get<MailboxEntry>(collection, id);
    if (!entry) scopeError('信件不存在', 404);
    if (version !== undefined && (!Number.isSafeInteger(version) || version !== entry.version)) scopeError('信件已更新，请刷新后确认', 409);
    return entry;
  }
  function save(entry: MailboxEntry) { store.put(collection, entry.id, entry); changed(entry); return structuredClone(entry); }
  // A process exit cannot prove whether a model/tool or remote send already happened.
  for (const entry of store.list<MailboxEntry>(collection)) {
    if (entry.status === 'processing') save({ ...entry, version: entry.version + 1, status: 'unknown', error: '服务中断，动作结果未知；不会自动重放', updatedAt: now() });
  }
  function editable(entry: MailboxEntry) {
    if (!['pending', 'ready'].includes(entry.status)) scopeError('信件已经处理，不能重复确认或修改', 409);
  }
  const service = {
    setHandlers(next: Partial<Record<'inbox' | 'outbox', Handler>>) { handlers = next; },
    get(id: string) { return structuredClone(read(id)); },
    list(filter: { direction?: string; scope?: string; projectId?: string; todoId?: string; botId?: string; status?: string } = {}) {
      return store.list<MailboxEntry>(collection).filter(entry =>
        (!filter.direction || entry.direction === filter.direction) && (!filter.scope || filter.scope === 'all' || entry.scope.kind === filter.scope)
        && (!filter.projectId || ('projectId' in entry.scope && entry.scope.projectId === filter.projectId))
        && (!filter.todoId || (entry.scope.kind === 'task' && entry.scope.todoId === filter.todoId))
        && (!filter.botId || entry.botId === filter.botId) && (!filter.status || entry.status === filter.status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    put(input: Input): MailboxEntry {
      if (closed) scopeError('事件信箱已关闭', 503);
      if (!input || typeof input !== 'object' || !['inbox', 'outbox'].includes(input.direction)) scopeError('请选择收件箱或发件箱');
      for (const key of ['botId', 'eventKey', 'title', 'text'] as const) required(input[key], key);
      for (const key of ['target', 'sourceMessageId', 'replyTo'] as const) if (input[key] !== undefined) required(input[key], key);
      if (input.requiresConfirmation !== undefined && typeof input.requiresConfirmation !== 'boolean') scopeError('确认设置必须是布尔值');
      const origin = normalizeInboxOrigin(input.origin);
      const scope = validateBotScope(store, input.scope);
      if (input.direction === 'outbox') required(input.target, '发送目标');
      const id = createHash('sha256').update(JSON.stringify([input.botId, input.direction, input.eventKey])).digest('hex');
      const existing = store.get<MailboxEntry>(collection, id);
      if (existing) {
        if ((!existing.origin || existing.origin.kind === 'unknown') && origin && origin.kind !== 'unknown') {
          return save({ ...existing, origin, version: existing.version + 1, updatedAt: now() });
        }
        return existing;
      }
      const requiresConfirmation = scope.kind === 'unmarked' || (input.requiresConfirmation ?? true);
      const entry: MailboxEntry = { id, version: 1, direction: input.direction, scope, botId: input.botId, eventKey: input.eventKey, title: input.title, text: input.text,
        ...(origin ? { origin } : {}),
        ...(input.target ? { target: input.target } : {}), ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}), ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        requiresConfirmation, status: requiresConfirmation ? 'pending' : 'ready', createdAt: now(), updatedAt: now() };
      return save(entry);
    },
    assign(id: string, version: number, scope: BotScope): MailboxEntry {
      const entry = read(id, version); editable(entry);
      return save({ ...entry, scope: validateBotScope(store, scope), status: 'pending', requiresConfirmation: true, version: entry.version + 1, updatedAt: now() });
    },
    async confirm(id: string, version: number): Promise<MailboxEntry> {
      const entry = read(id, version); editable(entry);
      if (entry.scope.kind === 'unmarked') scopeError('请先将未标记信件分配到全局、项目或事项');
      validateBotScope(store, entry.scope);
      const ready = save({ ...entry, status: 'ready', version: entry.version + 1, updatedAt: now() });
      return service.process(id, ready.version);
    },
    reject(id: string, version: number): MailboxEntry {
      const entry = read(id, version); editable(entry);
      return save({ ...entry, status: 'rejected', version: entry.version + 1, updatedAt: now() });
    },
    /** Explicit owner handling records a result without running the inbox handler. */
    resolve(id: string, version: number, resultId: string): MailboxEntry {
      const entry = read(id, version); editable(entry); required(resultId, '处理结果');
      if (entry.direction !== 'inbox') scopeError('只能手动处理收件消息');
      validateBotScope(store, entry.scope);
      if (entry.scope.kind === 'unmarked') scopeError('请先为消息分配范围', 409);
      return save({ ...entry, status: 'completed', resultId, version: entry.version + 1, updatedAt: now() });
    },
    async process(id: string, version?: number): Promise<MailboxEntry> {
      const entry = read(id, version);
      if (entry.status === 'completed') return structuredClone(entry);
      if (entry.status !== 'ready' || entry.scope.kind === 'unmarked') scopeError('信件需要分配范围并由用户确认后才能处理', 409);
      validateBotScope(store, entry.scope);
      const handler = handlers[entry.direction];
      if (!handler) scopeError('信箱处理器尚未连接', 503);
      const claimed = save({ ...entry, status: 'processing', version: entry.version + 1, updatedAt: now() });
      const job = Promise.resolve().then(async () => {
        let next: MailboxEntry;
        try {
          const result = await handler(structuredClone(claimed));
          next = { ...claimed, status: 'completed', ...(result?.id ? { resultId: result.id } : {}), version: claimed.version + 1, updatedAt: now() };
        } catch (error) {
          const delivery = error && typeof error === 'object' && 'delivery' in error ? error.delivery : undefined;
          // A sender must explicitly prove no delivery before calling a failure safe.
          const uncertain = delivery === 'unknown' || (claimed.direction === 'outbox' && delivery !== 'no');
          next = { ...claimed, status: uncertain ? 'unknown' : 'failed', error: error instanceof Error ? error.message : String(error), version: claimed.version + 1, updatedAt: now() };
        }
        // A duplicate can enrich provenance while the handler awaits I/O.
        const latest = store.get<MailboxEntry>(collection, id) ?? claimed;
        return save({ ...next, ...(latest.origin ? { origin: latest.origin } : {}), version: latest.version + 1 });
      });
      jobs.add(job);
      try { return await job; } finally { jobs.delete(job); }
    },
    async close() { closed = true; await Promise.allSettled([...jobs]); handlers = {}; },
  };
  return service;
}

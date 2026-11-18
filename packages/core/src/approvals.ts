import { randomUUID } from 'node:crypto';
import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';
import type { Approval, Json, JsonObject } from '../../protocol/src/index.ts';

export class ApprovalError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  constructor(message: string, status: 400 | 404 | 409 | 503 = 400) {
    super(message);
    this.name = 'ApprovalError';
    this.status = status;
  }
}

type Input = Pick<Approval, 'kind' | 'title' | 'details' | 'params' | 'todoId'>;
const collection = 'approvals';
function text(value: unknown, name: string, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new ApprovalError(`${name}必须为文本`);
}
function snapshot(value: unknown): Json {
  // Reject lossy JSON conversions (undefined, non-finite numbers, class instances,
  // sparse arrays and cycles) rather than approving different parameters silently.
  const ancestors = new Set<object>();
  function check(item: unknown): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new ApprovalError('必须提供有效 JSON');
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) throw new ApprovalError('必须提供普通 JSON 对象');
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) check(item[i]);
    } else {
      for (const value of Object.values(item)) check(value);
    }
    ancestors.delete(item);
  }
  check(value);
  return JSON.parse(JSON.stringify(value)) as Json;
}
function validate(input: Input, allowedKinds?: readonly string[]): Input {
  if (!['dispatch', 'input', 'channel-reply', 'feishu-reply'].includes(input.kind) && !/^plugin:[\w.-]+\.[\w.-]+$/.test(input.kind) && !allowedKinds?.includes(input.kind)) throw new ApprovalError('不支持的审批 kind');
  text(input.title, 'title');
  text(input.details, 'details', true);
  if (input.todoId !== undefined) text(input.todoId, 'todoId');
  if (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)) throw new ApprovalError('params必须为 JSON 对象');
  return { kind: input.kind, title: input.title, details: input.details, params: snapshot(input.params) as JsonObject,
    ...(input.todoId !== undefined ? { todoId: input.todoId } : {}) };
}

/** Own one service per database. close() must finish before closing its store. */
export function createApprovalService({ store, events, execute, publish, allowedKinds }: {
  store: Store;
  events: EventBus;
  publish?: (input: import('../../plugin-sdk/src/index.ts').EventInput) => unknown;
  execute: (approval: Approval) => Promise<Json>;
  allowedKinds?: () => readonly string[];
}) {
  let closed = false;
  const jobs = new Set<Promise<Approval>>();
  function changed(id: string) { events.publish('approvals.changed', { id }); }
  function open() { if (closed) throw new ApprovalError('审批服务已关闭', 503); }
  function current(id: string, version: number): Approval {
    open();
    text(id, 'id');
    if (!Number.isSafeInteger(version) || version < 1) throw new ApprovalError('version必须为正整数');
    const item = store.get<Approval>(collection, id);
    if (!item) throw new ApprovalError('审批不存在', 404);
    if (item.version !== version || item.status !== 'pending') throw new ApprovalError('审批已更新或已提交，请刷新', 409);
    return item;
  }
  // A crash may occur after remote delivery but before persistence. Never replay.
  const recovered = store.transaction(() => {
    const items = store.list<Approval>(collection).filter(item => item.status === 'running');
    for (const item of items) store.put(collection, item.id, { ...item, status: 'unknown',
      error: '服务重启，外部动作结果未知，不自动重试', updatedAt: new Date().toISOString() });
    return items;
  });
  for (const item of recovered) changed(item.id);

  return {
    list(): Approval[] { return store.list<Approval>(collection).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); },
    propose(input: Input): Approval {
      open();
      if (!input || typeof input !== 'object') throw new ApprovalError('审批输入必须为对象');
      const fields = validate(input, allowedKinds?.());
      const now = new Date().toISOString();
      const item: Approval = { ...fields, id: randomUUID(), version: 1, status: 'pending', createdAt: now, updatedAt: now };
      store.put(collection, item.id, item);
      changed(item.id);
      return item;
    },
    edit(id: string, version: number, patch: Partial<Input>): Approval {
      const item = store.transaction(() => {
        const previous = current(id, version);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
          Object.keys(patch).some(key => !['kind', 'title', 'details', 'params', 'todoId'].includes(key))) {
          throw new ApprovalError('无效的审批修改字段');
        }
        if (previous.version === Number.MAX_SAFE_INTEGER) throw new ApprovalError('审批版本已达上限', 409);
        const fields = validate({ ...previous, ...patch }, allowedKinds?.());
        const { todoId: _, ...rest } = previous;
        const next: Approval = { ...rest, ...fields, version: previous.version + 1, updatedAt: new Date().toISOString() };
        store.put(collection, id, next);
        return next;
      });
      changed(id);
      return item;
    },
    async approve(id: string, version: number): Promise<Approval> {
      // Claim synchronously before any await: competing submissions see running.
      const item = store.transaction(() => {
        const previous = current(id, version);
        const next: Approval = { ...previous, status: 'running', updatedAt: new Date().toISOString() };
        store.put(collection, id, next);
        publish?.({type:'approval.decided',typeVersion:1,sourceId:`approval:${id}:v${next.version}`,data:{id,version:next.version,decision:'approved',kind:next.kind},subject:{kind:'approval',id},staleIf:{ref:`approval:${id}`,version:next.version}});
        return next;
      });
      const job = Promise.resolve().then(async () => {
        let next: Approval;
        try {
          const result = snapshot(await execute(structuredClone(item)));
          // completed means the approved action returned. An accepted dispatch is
          // only receipt of that action; it never completes the associated todo.
          next = { ...item, status: 'completed', result, updatedAt: new Date().toISOString() };
        } catch (error) {
          const unknown = error !== null && typeof error === 'object' && (('delivery' in error && error.delivery === 'unknown') || ('deliveryunknown' in error && error.deliveryunknown === true));
          next = { ...item, status: unknown ? 'unknown' : 'failed',
            error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() };
        }
        store.put(collection, id, next);
        changed(id);
        return next;
      });
      jobs.add(job);
      try {
        changed(id);
        return await job;
      } finally { jobs.delete(job); }
    },
    reject(id: string, version: number): Approval {
      const item = store.transaction(() => {
        const previous = current(id, version);
        const next: Approval = { ...previous, status: 'rejected', updatedAt: new Date().toISOString() };
        store.put(collection, id, next);
        publish?.({type:'approval.decided',typeVersion:1,sourceId:`approval:${id}:v${next.version}`,data:{id,version:next.version,decision:'rejected',kind:next.kind},subject:{kind:'approval',id},staleIf:{ref:`approval:${id}`,version:next.version}});
        return next;
      });
      changed(id);
      return item;
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.allSettled([...jobs]);
    },
  };
}

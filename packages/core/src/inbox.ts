import { excludesPersonalGroupFromAutomation } from '../../protocol/src/inbox-origin.ts';
import { createHash } from 'node:crypto';
import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';
import type { InboxItem, InboxSubscriptionPolicy, InboxThing, InboxTriageInput, Project, Todo } from '../../protocol/src/index.ts';
import { normalizeInboxOrigin } from './inbox-origin.ts';

export class InboxError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'InboxError';
    this.status = status;
  }
}

type Triage = { tier: Exclude<InboxItem['tier'],'pending'>; reason: string };
const collection = 'inbox';
const pendingPolicies = 'inbox.pending-subscription-triage';
function required(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new InboxError(`${name}必须为非空文本`);
}
function validateThing(value: unknown): InboxThing {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InboxError('收件箱消息必须为对象');
  const thing = value as Record<string, unknown>;
  for (const key of ['thread', 'last', 'title']) required(thing[key], key);
  if (typeof thing.text !== 'string') throw new InboxError('text必须为文本');
  if (thing.sender !== undefined && typeof thing.sender !== 'string') throw new InboxError('sender必须为文本');
  if (thing.receivedAt !== undefined && (typeof thing.receivedAt !== 'string' || !thing.receivedAt.trim() || Number.isNaN(Date.parse(thing.receivedAt)))) {
    throw new InboxError('receivedAt必须为有效日期');
  }
  let origin: InboxThing['origin'];
  try { origin = normalizeInboxOrigin(thing.origin); }
  catch { throw new InboxError('消息来源格式无效'); }
  // Copy only the public message fields; callers cannot supply lifecycle state.
  return { thread: thing.thread as string, last: thing.last as string, title: thing.title as string, text: thing.text,
    ...(origin ? { origin } : {}),
    ...(thing.sender !== undefined ? { sender: thing.sender as string } : {}),
    ...(thing.receivedAt !== undefined ? { receivedAt: thing.receivedAt as string } : {}) };
}
export function inboxItemId(source: string, thread: string) {
  return createHash('sha256').update(JSON.stringify([source, thread])).digest('hex');
}
export function ruleTriage(thing: InboxTriageInput): Triage {
  if (thing.sourceKind === 'subscription') {
    const policy=thing.subscriptionPolicy;
    switch (policy?.fallbackTier) {
      case 'wait': throw Object.assign(new InboxError('已投递收件箱，等待模型分拣。',503),{code:'INBOX_TRIAGE_WAITING'});
      case 'action': return {tier:'action',reason:'按订阅的备用分拣设置标记为需处理'};
      case 'fyi': return {tier:'fyi',reason:'按订阅的备用分拣设置标记为知会'};
    }
    if (policy?.due===true) return {tier:'action',reason:'来源提供了截止日期，标记为需处理'};
    return {tier:'fyi',reason:'订阅动态，保留为知会，供主人查看'};
  }
  const text = `${thing.title}\n${thing.text}`;
  const keyword = text.match(/请|帮|需要|待办|截止/)?.[0];
  if (keyword) return { tier: 'action', reason: `本地规则：命中“${keyword}”，建议确认后创建待办` };
  if (/^(谢谢|收到|好的|ok|thanks)[！!。 .]*$/i.test(thing.text.trim())) {
    return { tier: 'noise', reason: '本地规则：正文仅为简短确认或致谢' };
  }
  return { tier: 'fyi', reason: '本地规则：没有明确行动语义，保留为知会' };
}
function withTodo(reason: string, todoId?: string): string {
  return todoId ? `${reason}；已关联待办 ${todoId}，不会重复创建` : reason;
}

/** One service per store. Only ingestion is asynchronous; user decisions remain synchronous. */
export function createInboxService({ store, events, createTodo, triage }: {
  store: Store;
  events: EventBus;
  createTodo: (input: Record<string, unknown>) => Todo;
  triage?: (thing: InboxTriageInput) => Promise<Triage>;
}): {
  list(): InboxItem[];
  ingest(source: string, things: InboxThing[], policy?:InboxSubscriptionPolicy): Promise<void>;
  retryPending(): Promise<void>;
  confirm(id: string, version: number, details?: { title: string; notes: string }): { todoId: string };
  archive(id: string, version: number): void;
  assignProject(id: string, version: number, projectId?: string): InboxItem;
  reopen(id: string): void;
  close(): Promise<void>;
} {
  let queue = Promise.resolve();
  let closed = false;
  let retrying:Promise<void>|undefined;
  let lastRetryId:string|undefined;
  function get(id: string): InboxItem {
    required(id, 'id');
    const item = store.get<InboxItem>(collection, id);
    if (!item) throw new InboxError('收件箱条目不存在', 404);
    return item;
  }
  function current(id: string, version: number): InboxItem {
    if (!Number.isSafeInteger(version) || version < 1) throw new InboxError('version必须为正整数');
    const item = get(id);
    if (item.version !== version || item.archivedAt) throw new InboxError('收件箱卡片已更新或已归档，请刷新', 409);
    return item;
  }
  function changed(id: string) { events.publish('inbox.changed', { id }); }
  async function classify(input:InboxTriageInput):Promise<{tier:InboxItem['tier'];reason:string}> {
    try {
      const result = triage ? await triage(structuredClone(input)) : ruleTriage(input);
      if (!result || !['action','fyi','noise'].includes(result.tier) || typeof result.reason!=='string' || !result.reason.trim())
        throw new InboxError('分拣器返回了无效结果',502);
      return {...result,reason:triage ? '注入分拣器：'+result.reason : result.reason};
    } catch (error) {
      if(input.sourceKind==='subscription' && input.subscriptionPolicy?.fallbackTier==='wait' &&
        error instanceof Error && 'code' in error && error.code==='INBOX_TRIAGE_WAITING')
        return {tier:'pending',reason:'已投递收件箱，等待模型分拣。'};
      throw error;
    }
  }
  async function enqueue(work:()=>Promise<void>) {
    const job=queue.then(work);
    queue=job.catch(()=>{});
    await job;
  }
  return {
    list() { return store.list<InboxItem>(collection).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); },
    async ingest(source, things, policy) {
      if (closed) throw new InboxError('收件箱服务已关闭', 503);
      required(source, 'source');
      if (!Array.isArray(things)) throw new InboxError('things必须为数组');
      // Validate and snapshot the entire batch before queueing any writes or model calls.
      const subscriptionPolicy = source.startsWith('subscription:') && policy ? structuredClone(policy) : undefined;
      const batch = things.map(value => {
        const thing = validateThing(value);
        if (thing.origin && !source.startsWith('feishu:')) delete thing.origin.personalGroupObserved;
        return thing;
      });
      await enqueue(async () => {
        for (const thing of batch) {
          const id = inboxItemId(source, thing.thread);
          const existing = store.get<InboxItem>(collection, id);
          if (existing?.last === thing.last) {
            // A duplicate may add verified provenance, but cannot change user decisions.
            const addedCount = thing.origin?.personalGroupUserCount !== undefined && existing.origin?.personalGroupUserCount !== thing.origin.personalGroupUserCount;
            const observed = thing.origin?.personalGroupObserved && !existing.origin?.personalGroupObserved;
            if (observed || addedCount || ((!existing.origin || existing.origin.kind === 'unknown') && thing.origin && thing.origin.kind !== 'unknown')) {
              const origin = { ...existing.origin, ...thing.origin };
              store.put(collection, id, { ...existing, origin, version: existing.version + 1, updatedAt: new Date().toISOString() });
              changed(id);
            }
            continue;
          }
          if (excludesPersonalGroupFromAutomation(thing.origin)) {
            const item: InboxItem = { ...existing, ...thing, id, source, version: (existing?.version ?? 0) + 1,
              tier: existing?.tier ?? 'fyi', reason: existing?.reason ?? '群人数超过50，跳过自动分拣',
              updatedAt: new Date().toISOString() };
            store.put(collection, id, item);
            changed(id);
            continue;
          }
          // Only the ingestion route supplies this hint. Never accept it or other authority claims from an item.
          const triageInput: InboxTriageInput = source.startsWith('subscription:')
            ? {...thing,sourceKind:'subscription',...(subscriptionPolicy && {subscriptionPolicy})} : thing;
          const result=await classify(triageInput);
          // Confirmation may have happened while triage was awaiting a model.
          const previous = store.get<InboxItem>(collection, id);
          const item: InboxItem = { ...thing, id, source, version: (previous?.version ?? 0) + 1,
            tier: result.tier, reason: withTodo(result.reason, previous?.todoId), updatedAt: new Date().toISOString(),
            ...(previous?.todoId ? { todoId: previous.todoId } : {}),
            ...(previous?.projectId ? { projectId: previous.projectId } : {}) };
          if(item.todoId && item.tier==='pending') {
            item.tier='action';
            item.reason=withTodo('主人已确认此线程需要处理',item.todoId);
          }
          store.transaction(()=>{
            store.put(collection,id,item);
            if (item.tier==='pending') store.put(pendingPolicies,id,{id,last:thing.last,policy:subscriptionPolicy});
            else if(previous?.tier==='pending') store.remove(pendingPolicies,id);
          });
          changed(id);
        }
      });
    },
    async retryPending() {
      if(closed || retrying) return retrying;
      const records=store.list<{id:string;last:string;policy:InboxSubscriptionPolicy}>(pendingPolicies)
        .filter(record=>{
          const item=store.get<InboxItem>(collection,record.id);
          return item?.tier==='pending' && !item.archivedAt && !item.todoId && item.last===record.last;
        }).sort((a,b)=>a.id.localeCompare(b.id));
      const start=records.findIndex(record=>!lastRetryId || record.id.localeCompare(lastRetryId)>0);
      const batch=start<1 ? records : [...records.slice(start),...records.slice(0,start)];
      retrying=(async()=>{
        for(const record of batch.slice(0,5)) {
          if(closed) return;
          lastRetryId=record.id;
          // Release the queue between model calls so new arrivals can be processed.
          await enqueue(async()=>{
            const item=store.get<InboxItem>(collection,record.id);
            if(!item || item.archivedAt || item.todoId || item.tier!=='pending' || item.last!==record.last) return;
            const result=await classify({...validateThing(item),sourceKind:'subscription',subscriptionPolicy:record.policy});
            if(result.tier==='pending') return;
            // A user may archive or reassign the card while the classifier is running.
            const current=store.get<InboxItem>(collection,item.id);
            if(!current || current.archivedAt || current.todoId || current.last!==record.last || current.tier!=='pending') return;
            store.transaction(()=>{
              store.put(collection,item.id,{...current,tier:result.tier,reason:result.reason,
                updatedAt:new Date().toISOString(),version:current.version+1});
              store.remove(pendingPolicies,item.id);
            });
            changed(item.id);
          });
        }
      })().finally(()=>{retrying=undefined;});
      return retrying;
    },
    confirm(id, version, details) {
      const result = store.transaction(() => {
        const item = current(id, version);
        if (item.todoId) throw new InboxError('该线程已创建待办', 409);
        // The supplied callback must write to this same store synchronously.
        if (details) { required(details.title, '待办标题'); if (typeof details.notes !== 'string') throw new InboxError('待办说明必须为文本'); }
        const todo = createTodo({ title: details?.title ?? item.title, notes: `${details?.notes ?? item.text}\n\n来源：${item.source}\n线程：${item.thread}`,
          ...(item.projectId ? { projectId: item.projectId } : {}) });
        if (!todo || typeof todo.id !== 'string' || !todo.id.trim()) throw new InboxError('待办创建未返回有效标识', 500);
        const now = new Date().toISOString();
        store.put(collection, id, { ...item, version:item.version+1, todoId: todo.id, archivedAt: now, updatedAt: now,
          ...(item.tier==='pending' ? {tier:'action',reason:withTodo('用户已确认创建待办并归档',todo.id)} :
            {reason:withTodo(`${item.reason}；用户已确认创建待办并归档`, todo.id)}) });
        if(item.tier==='pending') store.remove(pendingPolicies,id);
        return { todoId: todo.id };
      });
      changed(id);
      return result;
    },
    assignProject(id, version, projectId) {
      const result = store.transaction(() => {
        if (!Number.isSafeInteger(version) || version < 1) throw new InboxError('version必须为正整数');
        const item = get(id);
        if (item.version !== version) throw new InboxError('收件箱卡片已更新，请刷新', 409);
        if (projectId !== undefined && projectId !== '') {
          required(projectId, 'projectId');
          const project = store.get<Project>('projects', projectId);
          if (!project || project.archivedAt) throw new InboxError('项目不存在或已归档', 409);
        } else projectId = undefined;
        if (item.todoId) {
          const todo = store.get<Todo>('todos', item.todoId);
          if (!todo || todo.projectId !== projectId) throw new InboxError('请先调整已关联待办的项目，再归类收件箱消息', 409);
        }
        if (item.projectId === projectId) return item;
        const { projectId: _, ...rest } = item;
        const next: InboxItem = { ...rest, ...(projectId ? { projectId } : {}), version: item.version + 1, updatedAt: new Date().toISOString() };
        store.put(collection, id, next);
        changed(id);
        return next;
      });
      return result;
    },
    archive(id, version) {
      const item = current(id, version);
      const now = new Date().toISOString();
      store.put(collection, id, { ...item, version:item.version+1, archivedAt: now, updatedAt: now, reason: `${item.reason}；用户已归档` });
      changed(id);
    },
    async close() { closed = true; await queue; },
    reopen(id) {
      const item = get(id);
      if (!item.archivedAt) return;
      const { archivedAt: _, ...rest } = item;
      store.put(collection, id, { ...rest, version:item.version+1, updatedAt: new Date().toISOString(),
        reason: `${item.reason}；用户重新打开，保留原分拣结论和待办关联` });
      changed(id);
    },
  };
}

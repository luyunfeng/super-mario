import { createHash } from 'node:crypto';
import type { Store, EventBus } from '../../plugin-sdk/src/index.ts';
import type { NormalizedReplyEvidence, Todo } from '../../protocol/src/index.ts';
import { createWaitingReplies } from './waiting-replies.ts';

type Observed = NormalizedReplyEvidence & { id: string; label?: string; preview?: string };
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
const sourceCollection = 'todo.reply-sources';
const sourceKey=(source:string,chatId:string,messageId:string)=>'reply_'+createHash('sha256').update(JSON.stringify([source,chatId,messageId])).digest('hex');
const identifier = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\p{Cc}]/u.test(value);
/** Trusted connectors supply metadata; HTTP and model callers can only select observed IDs. */
export function createReplyTracking({ store, events }: { store: Store; events: EventBus }) {
  const waits = createWaitingReplies({ store, events });
  // Invalidate on the first real ownership/waiting change, even if a user later
  // restores identical text and time. Old-cycle replies must never stop a new wait.
  const off = events.subscribe(event => {
    if (event.type !== 'todos.changed' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
    const id = (event.data as {id?:unknown}).id;
    if (typeof id !== 'string') return;
    const wait = waits.get(id), current = store.get<Todo>('todos', id);
    if (wait?.status === 'waiting' && (!current || current.completedAt || current.waitingOn !== wait.waitingOn || current.reminderAt !== wait.reminderAt || current.projectId !== wait.scope.projectId)) waits.invalidate(id);
  });
  function todo(id: string) { const row = store.get<Todo>('todos', id); if (!row) fail('待办不存在', 404); return row; }
  return {
    close: off,
    // The host calls this within updateTodo's transaction. Observer delivery is
    // only a fallback, since observer errors are deliberately isolated.
    invalidate: waits.invalidate,
    get(id: string) { todo(id); return waits.get(id) ?? null; },
    summary(id: string) {
      const current = todo(id);
      const wait = waits.get(id);
      // A matched reply clears the reminder and advances its generation exactly once.
      // An older match may still describe a prior request, even to the same person.
      return wait && wait.scope.projectId === current.projectId ? {
        status: wait.status, cycle: wait.cycle, waitingOn: wait.waitingOn, startedAt: wait.startedAt,
        currentCycle: wait.reminderVersion === undefined ? null :
          (current.reminderVersion ?? 1) === wait.reminderVersion + (wait.status === 'matched' ? 1 : 0),
        repliedAt: wait.hit?.evidence.createdAt,
      } : null;
    },
    observedSource(source:string,chatId:string,messageId:string) {
      const value=store.get<Observed>(sourceCollection,sourceKey(source,chatId,messageId));
      return value && {senderId:value.senderId,deleted:value.deleted===true};
    },
    observeSource(source: string, input: Array<NormalizedReplyEvidence & { label?: string; preview?: string }>) {
      if (!identifier(source) || !Array.isArray(input) || input.length > 500) fail('消息证据来源无效');
      // Validate the complete batch before any partial record or reminder mutation.
      const batch: Observed[] = input.map(value => {
        for (const key of ['chatId', 'messageId', 'senderId', 'senderIdType'] as const) if (!identifier(value?.[key])) fail('消息证据身份字段无效');
        if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) fail('消息证据时间无效');
        for (const key of ['parentId', 'rootId', 'threadId'] as const) if (value[key] !== undefined && !identifier(value[key])) fail('消息证据引用无效');
        for (const key of ['edited', 'deleted'] as const) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('消息证据状态无效');
        const copy: NormalizedReplyEvidence = { source, chatId: value.chatId, messageId: value.messageId, senderId: value.senderId, senderIdType: value.senderIdType, createdAt: value.createdAt,
          ...(value.parentId ? { parentId: value.parentId } : {}), ...(value.rootId ? { rootId: value.rootId } : {}), ...(value.threadId ? { threadId: value.threadId } : {}),
          ...(value.edited !== undefined ? { edited: value.edited } : {}), ...(value.deleted !== undefined ? { deleted: value.deleted } : {}) };
        return { ...copy, id:sourceKey(source,copy.chatId,copy.messageId),
          ...(typeof value.label === 'string' ? { label: value.label.slice(0, 120) } : {}), ...(typeof value.preview === 'string' ? { preview: value.preview.slice(0, 160) } : {}) };
      });
      return store.transaction(() => {
        let matched = 0, added = 0, invalidated = 0;
        for (const value of batch) {
          const observed=store.get<Observed>(sourceCollection,value.id);
          if (!observed) { store.put(sourceCollection, value.id, value); added++; }
          // A deletion invalidates the first observation, including after sparse or older search replays.
          else if (value.deleted && !observed.deleted) {
            store.put(sourceCollection,value.id,{...observed,deleted:true});
            invalidated++;
          }
          matched += waits.consume(observed?.deleted ? {...value,deleted:true} : value).matched.length;
        }
        if (added || matched || invalidated) events.publish('waiting.replies.changed', { observed: added, matched });
        return { observed: added, matched };
      });
    },
    sources(id: string, query = '') {
      todo(id);
      if (typeof query !== 'string' || query.length > 200) fail('消息搜索内容过长');
      const search = query.trim().toLocaleLowerCase();
      const all = store.list<Observed>(sourceCollection).filter(row => !row.edited && !row.deleted)
        .sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      const values = all.filter(row => !search || [row.preview, row.label, row.messageId, row.chatId].some(text => text?.toLocaleLowerCase().includes(search)));
      const items = values.slice(0, 100), chats = new Set(items.map(row => JSON.stringify([row.source, row.chatId])));
      // A text search selects anchors, not who may answer them. Keep known peer
      // identities for those conversations without copying their message bodies.
      const people = new Map<string, Pick<Observed,'source'|'chatId'|'senderId'|'senderIdType'|'label'>>();
      for (const row of all) if (chats.has(JSON.stringify([row.source,row.chatId]))) {
        const key = JSON.stringify([row.source,row.chatId,row.senderIdType,row.senderId]);
        if (!people.has(key)) people.set(key, { source:row.source,chatId:row.chatId,senderId:row.senderId,senderIdType:row.senderIdType,...(row.label?{label:row.label}:{}) });
      }
      return { items, total: values.length, truncated: values.length > 100, limit: 100, people:[...people.values()].slice(0,500),peopleTruncated:people.size>500 };
    },
    arm(id: string, input: Record<string, unknown>) {
      todo(id);
      if (Object.keys(input).some(key => !['key', 'anchorId', 'expectedSenderId', 'expectedSenderIdType'].includes(key)) || !identifier(input.key) || !identifier(input.anchorId) || !identifier(input.expectedSenderId) || !identifier(input.expectedSenderIdType)) fail('请选择真实消息和等待对象');
      const anchor = store.get<Observed>(sourceCollection, input.anchorId as string);
      if (!anchor || anchor.edited || anchor.deleted) fail('消息证据已失效，请重新选择', 409);
      const person = store.list<Observed>(sourceCollection).some(row => row.source === anchor.source && row.chatId === anchor.chatId && row.senderId === input.expectedSenderId && row.senderIdType === input.expectedSenderIdType && !row.deleted && !row.edited);
      if (!person) fail('等待对象没有此会话的身份依据', 409);
      try {
        return store.transaction(() => {
          const duplicate = waits.list(id).some(wait => wait.key === input.key);
          const value = waits.arm({ todoId: id, key: input.key as string, anchor, expectedSenderId: input.expectedSenderId as string, expectedSenderIdType: input.expectedSenderIdType as string });
          if (!duplicate) events.publish('waiting.replies.changed', { todoId: id, cycle: value.cycle });
          return value;
        });
      } catch (error) { if (error instanceof Error && !('status' in error)) fail(error.message, 409); throw error; }
    },
  };
}

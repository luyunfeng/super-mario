import { randomUUID } from 'node:crypto';
import { outboxItemId } from './outbox.ts';
import { actionTodoLink } from './todo-link.ts';
import { mailboxEntryId } from './event-mailboxes.ts';
import type { EventBus, OutboxItem, Store } from '../../plugin-sdk/src/index.ts';
import type { Approval, Json, MailboxEntry, Message, Todo } from '../../protocol/src/index.ts';
import type { InboxHandlingAction, InboxHandlingRef, InboxHandlingRequest, InboxHandlingSource, InboxHandlingView, InboxSuggestion, InboxSuggestionProgress, InboxReplyDelivery, InboxLinkedTodo, InboxDispatchRun } from '../../protocol/src/inbox-handling.ts';
import type { InboxHandlingState } from '../../protocol/src/inbox-handling.ts';
import type { Run } from '../../protocol/src/index.ts';
import { digest, stableJson } from './eventbox.ts';

export const inboxHandlingApprovalKind = 'plugin:inbox-triage.handle-suggestion' as const;
export interface InboxHandlingOptions {
  store: Store; events: EventBus;
  readSource(ref: InboxHandlingRef): InboxHandlingSource;
  available(): { available: boolean; reason?: string };
  think(source: InboxHandlingSource, conversationId: string, text: string, progress: InboxSuggestionProgress): Promise<Message>;
  proposeApproval(input: Pick<Approval, 'kind' | 'title' | 'details' | 'params'>): Approval;
  rejectApproval?(id:string,version:number):void;
  execute(source: InboxHandlingSource, action: InboxHandlingAction, key: string): Promise<Json>;
}
export class InboxHandlingError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  constructor(message: string, status: 400 | 404 | 409 | 503 = 400) { super(message); this.name = 'InboxHandlingError'; this.status = status; }
}
const suggestions = 'inbox-handling.suggestions', requests = 'inbox-handling.requests', bindings = 'inbox-handling.approvals', conversations = 'inbox-handling.conversations';
type RequestRow = InboxHandlingRequest & { source: InboxHandlingRef; text: string };
type Conversation = { id: string; source: InboxHandlingRef; invalid: boolean; projectId?:string;todoId?:string };
type Binding = { id: string; suggestionId: string; suggestionVersion: number; approval: Approval };
function fail(message: string, status: 400 | 404 | 409 | 503 = 400): never { throw new InboxHandlingError(message, status); }
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('必须提供普通对象');
}
function fields(value: unknown, allowed: string[]) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('不支持的字段');
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail('字段必须为非空文本');
}
function version(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('版本或预计分钟必须为正整数');
}
function refValue(ref: InboxHandlingRef): InboxHandlingRef {
  fields(ref, ['kind', 'id']); text(ref.id);
  if (!['personal', 'mailbox'].includes(ref.kind)) fail('来源类型无效');
  return { kind: ref.kind, id: ref.id };
}
function actionValue(value: unknown): InboxHandlingAction {
  object(value);
  switch (value.kind) {
    case 'todo': fields(value, ['kind', 'title', 'notes']); text(value.title); text(value.notes); break;
    case 'dispatch':
      fields(value, ['kind', 'executorId', 'prompt', 'doneWhen', 'expectMinutes', 'cwd']);
      text(value.executorId); text(value.prompt); text(value.doneWhen); version(value.expectMinutes);
      if ('cwd' in value) text(value.cwd);
      break;
    case 'reply': case 'conclusion': fields(value, ['kind', 'text']); text(value.text); break;
    default: fail('建议动作无效');
  }
  return structuredClone(value) as InboxHandlingAction;
}
function synchronous<T>(callback: () => T): T {
  if (callback.constructor.name === 'AsyncFunction') fail('回调必须同步');
  const result = callback();
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    void Promise.resolve(result).catch(() => {}); fail('回调必须同步');
  }
  return result;
}
function publicRequest(row: RequestRow): InboxHandlingRequest {
  const { source: _, text: __, ...request } = row; return request;
}
function conversationIdentity(value:InboxHandlingSource) {
  return 'inbox-handling:'+digest({kind:value.kind,id:value.id,version:value.version,projectId:value.projectId??null,todoId:value.todoId??null,title:value.title,text:value.text,
    active:value.active,binding:value.binding??null});
}

/** One owner per Store. Host isolates think with no tools; close its runtime before awaiting close here.
 * readSource must include current project/archive/bot validity, never a cached scope.
 * Only the existing ApprovalService execution route may call executeApproved.
 */
export function createInboxHandling(options: InboxHandlingOptions) {
  const { store, events } = options;
  for (const callback of [options.readSource, options.proposeApproval,options.rejectApproval]) {
    if (callback?.constructor.name === 'AsyncFunction') fail('回调必须同步');
  }
  let closed = false;
  const jobs = new Set<Promise<unknown>>();
  function open() { if (closed) fail('收件处理服务已关闭', 503); }
  function changed(id: string, status: string) { events.publish('inbox-handling.changed', { id, status }); }
  function putSuggestion(item: InboxSuggestion) { store.put(suggestions, item.id, item); changed(item.id, item.status); return item; }
  function putRequest(item: RequestRow) { store.put(requests, item.id, item); changed(item.id, item.status); return item; }
  function rejectOldApproval(row:InboxSuggestion){
    if(!row.approvalId||!options.rejectApproval)return;
    const approval = boundApproval(row);
    if(approval?.status==='pending')synchronous(()=>options.rejectApproval!(approval.id,approval.version));
  }
  // A crash cannot prove whether an external call happened. Never replay on startup.
  store.transaction(() => {
    for (const row of store.list<RequestRow>(requests)) if (row.status === 'pending') putRequest({ ...row, status: 'unknown', error: '服务重启，处理结果未知，不自动重试', updatedAt: new Date().toISOString() });
    for (const row of store.list<InboxSuggestion>(suggestions)) if (row.status === 'executing') putSuggestion({ ...row, status: 'unknown', error: '服务重启，执行结果未知，不自动重试', updatedAt: new Date().toISOString() });
  });
  // Invalidation is sticky: returning to an older scope never resurrects its
  // consent or a late model job, even if the host reused a source version.
  function invalidate(ref: InboxHandlingRef, keep?: string) {
    store.transaction(() => {
      for (const row of store.list<Conversation>(conversations)) {
        if (row.source.kind === ref.kind && row.source.id === ref.id && row.id !== keep && !row.invalid) store.put(conversations, row.id, { ...row, invalid: true });
      }
      for (const row of store.list<InboxSuggestion>(suggestions)) {
        if (row.source.kind === ref.kind && row.source.id === ref.id && ['draft', 'submitted'].includes(row.status) && row.conversationId !== keep) {
          putSuggestion({ ...row, status: 'stale', error: '来源已变化或失效', updatedAt: new Date().toISOString() });
          rejectOldApproval(row);
        }
      }
    });
  }
  function invalid(conversationId: string) { return store.get<Conversation>(conversations, conversationId)?.invalid === true; }
  function source(ref: InboxHandlingRef) {
    const input = refValue(ref);
    let value: InboxHandlingSource;
    try { value = structuredClone(synchronous(() => options.readSource(input))); }
    catch { invalidate(input); fail('无法读取当前来源', 409); }
    object(value);
    if (value.kind !== input.kind || value.id !== input.id) fail('来源不匹配', 409);
    version(value.version);
    if (typeof value.title !== 'string' || typeof value.text !== 'string' || typeof value.active !== 'boolean' || typeof value.replyAvailable !== 'boolean') fail('来源无效', 409);
    if (value.projectId !== undefined) text(value.projectId);
    if (value.todoId !== undefined) text(value.todoId);
    // Full content and capability evidence bind each conversation. Optional fields
    // use explicit nulls so the digest is stable across object insertion order.
    const conversationId = conversationIdentity(value);
    invalidate(input, value.active ? conversationId : undefined);
    if (!store.get<Conversation>(conversations, conversationId)) store.put(conversations, conversationId, { id: conversationId, source: input, invalid: !value.active,...(value.projectId?{projectId:value.projectId}:{}),...(value.todoId?{todoId:value.todoId}:{}) } satisfies Conversation);
    return { value, conversationId };
  }
  function writable(current: ReturnType<typeof source>, sourceVersion: number) {
    version(sourceVersion);
    if (current.value.version !== sourceVersion) fail('来源版本已变化，请刷新', 409);
    if (!current.value.active || invalid(current.conversationId)) fail('来源已失效或变化，只能查看', 409);
  }
  function suggestion(current: ReturnType<typeof source>, id: string, expected: number) {
    text(id); version(expected);
    const row = store.get<InboxSuggestion>(suggestions, id);
    if (!row) fail('建议不存在', 404);
    if (row.version !== expected || row.conversationId !== current.conversationId || row.sourceVersion !== current.value.version || !['draft', 'submitted'].includes(row.status)) fail('建议已变化或不可修改，请刷新', 409);
    return row;
  }
  function draft(current: ReturnType<typeof source>, action: InboxHandlingAction): InboxSuggestion {
    const now = new Date().toISOString();
    return putSuggestion({ id: randomUUID(), version: 1, source: refValue({ kind: current.value.kind, id: current.value.id }), sourceVersion: current.value.version,
      conversationId: current.conversationId, action, status: 'draft', createdAt: now, updatedAt: now });
  }
  function approvalParams(row: InboxSuggestion): Approval['params'] {
    const scope=store.get<Conversation>(conversations,row.conversationId);
    return { suggestionId: row.id, suggestionVersion: row.version, source: { ...row.source }, sourceVersion: row.sourceVersion,
      conversationId: row.conversationId, action: { ...row.action }, contentHash: digest(row.action),...(scope?.projectId?{projectId:scope.projectId}:{}),...(scope?.todoId?{todoId:scope.todoId}:{}) };
  }
  function matching(approval: Approval, expected: Approval) {
    return approval.id === expected.id && approval.version === expected.version && approval.kind === inboxHandlingApprovalKind &&
      approval.title === expected.title && approval.details === expected.details && stableJson(approval.params) === stableJson(expected.params);
  }
  function boundApproval(row: InboxSuggestion) {
    if (!row.approvalId) return;
    const binding = store.get<Binding>(bindings, row.approvalId);
    if (binding?.suggestionId !== row.id || binding.suggestionVersion !== row.version) return;
    const approval = store.get<Approval>('approvals', row.approvalId);
    if (approval && matching(approval, binding.approval)) return approval;
  }
  const executionKey = (row: InboxSuggestion) => `inbox-handling:${row.id}:${row.version}`;
  function dispatchRun(row: InboxSuggestion): InboxDispatchRun | undefined {
    if (row.action.kind !== 'dispatch' || !row.approvalId) return;
    const id = store.get<string>('dispatch-keys', executionKey(row));
    if (!id) return;
    const receipt = row.result;
    if (receipt !== undefined && (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.runId !== id)) return;
    const scope = store.get<Conversation>(conversations, row.conversationId);
    const run = store.get<Run>('runs', id);
    if (!scope || scope.source.kind !== row.source.kind || scope.source.id !== row.source.id || !run ||
        run.projectId !== scope.projectId || run.todoId !== scope.todoId) return;
    const webPath = '#projects/' + encodeURIComponent(run.projectId ?? 'all') + '/runs/' + encodeURIComponent(id);
    return { id, status: run.status, updatedAt: run.updatedAt, webPath, webCitation: '[查看执行](' + webPath + ')' };
  }
  function replyDelivery(row: InboxSuggestion): InboxReplyDelivery | undefined {
    if (row.action.kind !== 'reply' || !row.approvalId) return;
    const key = executionKey(row);
    if (row.source.kind === 'personal') {
      const item = store.get<OutboxItem>('outbox.items', outboxItemId('core', key));
      if (!item || item.owner !== 'core' || item.dedupKey !== key || item.relatedTo?.kind !== 'inbox' ||
          item.relatedTo.id !== row.source.id || item.content.text !== row.action.text || !item.channel.startsWith('feishu.personal:')) return;
      const status = ['failed', 'expired', 'cancelled'].includes(item.status) ? 'failed'
        : item.status === 'sent' || item.status === 'unknown' ? item.status : 'pending';
      return { id: item.id, status, updatedAt: item.updatedAt };
    }
    const source = store.get<MailboxEntry>('event.mailboxes', row.source.id);
    if (source?.direction !== 'inbox') return;
    const eventKey = 'inbox-suggestion:' + key;
    const item = store.get<MailboxEntry>('event.mailboxes', mailboxEntryId(source.botId, 'outbox', eventKey));
    if (!item || item.direction !== 'outbox' || item.botId !== source.botId || item.eventKey !== eventKey ||
        item.sourceMessageId !== source.sourceMessageId || item.target !== source.target || item.text !== row.action.text) return;
    const status = item.status === 'completed' ? 'sent' : item.status === 'unknown' ? 'unknown'
      : item.status === 'failed' || item.status === 'rejected' ? 'failed' : 'pending';
    return { id: item.id, status, updatedAt: item.updatedAt };
  }
  function linkedTodo(current: InboxHandlingSource): InboxLinkedTodo | undefined {
    let id = current.todoId;
    if (!id && current.kind === 'mailbox') {
      // A resolved mailbox entry can also point to a reply or conclusion. Only a todo action establishes this link.
      const entry = store.get<MailboxEntry>('event.mailboxes', current.id);
      if (entry?.direction !== 'inbox' || entry.status !== 'completed' || !entry.resultId) return;
      const matched = store.list<InboxSuggestion>(suggestions).some(row =>
        row.source.kind === 'mailbox' && row.source.id === current.id && row.sourceVersion + 1 === entry.version &&
        row.status === 'applied' && row.action.kind === 'todo' &&
        row.result && typeof row.result === 'object' && !Array.isArray(row.result) && row.result.todoId === entry.resultId);
      if (matched) id = entry.resultId;
    }
    if (!id) return;
    const todo = store.get<Todo>('todos', id);
    if (!todo || todo.projectId !== current.projectId) return { status: 'unavailable' };
    return { id, title: todo.title, status: todo.completedAt ? 'completed' : 'open',
      ...(todo.completedAt && { completedAt: todo.completedAt }), ...actionTodoLink(todo) };
  }
  async function runThink(row: RequestRow, initial: ReturnType<typeof source>) {
    try {
      const own = store.list<InboxSuggestion>(suggestions).filter(item => item.conversationId === row.conversationId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
      const recent = own.slice(0, 20).map(item => ({
        id: item.id, version: item.version, kind: item.action.kind, status: item.status, approvalStatus: boundApproval(item)?.status, ...(item.action.kind === 'reply' ? { delivery: replyDelivery(item) } : {}),
        ...(item.action.kind === 'dispatch' ? { run: dispatchRun(item) } : {}),
      }));
      const todo = linkedTodo(initial.value);
      const result = await options.think(structuredClone(initial.value), row.conversationId, row.text, { total: own.length, recent, ...(todo && { linkedTodo: todo }) });
      if (!result || result.conversationId !== row.conversationId || result.role !== 'assistant' || result.status !== 'done' || typeof result.text !== 'string' || typeof result.id !== 'string' || !result.id.trim() || typeof result.createdAt !== 'string') fail('模型返回无效');
      // Validate the entire JSON envelope before writing any suggestions. Plain
      // prose and invalid JSON remain useful history, but never become actions.
      let actions: InboxHandlingAction[] = [];
      try {
        const envelope: unknown = JSON.parse(result.text);
        fields(envelope, ['answer', 'suggestions']); object(envelope);
        if ('answer' in envelope && typeof envelope.answer !== 'string') fail('回答无效');
        if (!Array.isArray(envelope.suggestions) || envelope.suggestions.length > 4) fail('建议数量无效');
        actions = envelope.suggestions.map(actionValue);
      } catch { /* No partial or repaired model actions. */ }
      const current = source(row.source);
      store.transaction(() => {
        const saved = store.get<RequestRow>(requests, row.id);
        if (saved?.status !== 'pending') return;
        const previous = store.get<Message>('messages', result.id);
        if (previous && stableJson(previous) !== stableJson(result)) fail('模型消息冲突');
        store.put('messages', result.id, result);
        if (current.value.active && !invalid(current.conversationId) && current.conversationId === row.conversationId) for (const action of actions) draft(current, action);
        putRequest({ ...saved, status: 'completed', updatedAt: new Date().toISOString() });
      });
    } catch {
      store.transaction(() => {
        const saved = store.get<RequestRow>(requests, row.id);
        if (saved?.status === 'pending') putRequest({ ...saved, status: 'failed', error: '收件分析失败，请稍后重新发起', updatedAt: new Date().toISOString() });
      });
    }
  }
  function track<T>(job: Promise<T>): Promise<T> {
    jobs.add(job);
    void job.then(() => jobs.delete(job), () => jobs.delete(job));
    return job;
  }
  return {
    /** A read-only UI projection of existing requests, approvals and Runs. */
    states():InboxHandlingState[] {
      const drafts=store.list<InboxSuggestion>(suggestions),turns=store.list<RequestRow>(requests),used=new Set([...drafts,...turns].map(row=>row.conversationId));
      const blockedRuns=new Set(store.list<{runId?:string;handler?:string;status:string}>('interactions').filter(card=>card.status==='open'&&card.handler==='user').flatMap(card=>card.runId?[card.runId]:[]));
      for(const approval of store.list<Approval>('approvals').filter(item=>item.status==='pending')){
        const runId=approval.params.runId??(approval.kind==='input'?approval.params.id:undefined);if(typeof runId==='string')blockedRuns.add(runId);
      }
      const result:InboxHandlingState[]=[];
      for(const conversation of store.list<Conversation>(conversations)){
        if(conversation.invalid||!used.has(conversation.id))continue;
        let latest:InboxHandlingSource;try{latest=synchronous(()=>options.readSource(conversation.source));}catch{continue;}
        if(!latest.active||conversationIdentity(latest)!==conversation.id)continue;
        const own=drafts.filter(row=>row.conversationId===conversation.id),pending=own.some(row=>row.status==='draft'||row.status==='submitted'&&boundApproval(row)?.status==='pending');
        const runs = own.map(dispatchRun).filter((run): run is InboxDispatchRun => !!run);
        const active=runs.find(run=>['queued','running'].includes(run.status));
        const blocked=runs.some(run=>blockedRuns.has(run.id));
        const lastTurn=turns.filter(row=>row.conversationId===conversation.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
        const uncertain=own.some(row=>row.status==='unknown')||runs.some(run=>['failed','unknown'].includes(run.status));
        let state:InboxHandlingState={source:conversation.source,stage:'human',label:'等待你处理建议'};
        if(pending||uncertain||blocked)state.label=uncertain?'结果需要你核对':blocked?'执行正在等你决定':'等待你确认建议';
        else if(active)state={...state,stage:active.status==='queued'?'ai':'processing',label:active.status==='queued'?'等待AI执行':'AI正在执行',runId:active.id};
        else if(own.some(row=>row.status==='executing'))state={...state,stage:'processing',label:'正在处理已确认动作'};
        else if(lastTurn?.status==='pending')state={...state,stage:'ai',label:'等待AI分析'};
        else if(lastTurn?.status==='unknown')state.label='分析结果需要你核对';
        else if(runs.length)state.label='执行结束，等待你核对结果';
        result.push(state);
      }
      return result;
    },
    read(ref: InboxHandlingRef): InboxHandlingView {
      open(); const current = source(ref), availability = options.available();
      const history=new Set(store.list<Conversation>(conversations).filter(row=>row.source.kind===ref.kind&&row.source.id===ref.id).map(row=>row.id));
      const todo = linkedTodo(current.value);
      return { source: current.value, ...(todo && { linkedTodo: todo }), conversationId: current.conversationId, available: availability.available && current.value.active && !invalid(current.conversationId),
        ...(!current.value.active || invalid(current.conversationId) ? { reason: '来源已失效，只能查看' } : availability.reason ? { reason: availability.reason } : {}),
        // Owner-facing audit history survives archive/reassignment. The model
        // runtime still sees only the current conversation and its own receipts.
        messages: store.list<Message>('messages').filter(row => history.has(row.conversationId)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)),
        suggestions: store.list<InboxSuggestion>(suggestions).filter(row => row.source.kind===ref.kind&&row.source.id===ref.id).map(row => {
          const approval = boundApproval(row);
          const delivery = replyDelivery(row), run = dispatchRun(row);
          return { ...row, ...(approval && { approvalStatus: approval.status }), ...(delivery && { delivery }), ...(run && { run }) };
        }),
        requests: store.list<RequestRow>(requests).filter(row => row.conversationId === current.conversationId).map(publicRequest) };
    },
    post(ref: InboxHandlingRef, input: { sourceVersion: number; text: string; key: string }): InboxHandlingRequest {
      open(); fields(input, ['sourceVersion', 'text', 'key']); text(input.text); text(input.key);
      const current = source(ref); writable(current, input.sourceVersion);
      const id = digest({ source: refValue(ref), key: input.key });
      const previous = store.get<RequestRow>(requests, id);
      if (previous) { if (previous.text !== input.text) fail('相同 key 的正文不同', 409); return publicRequest(previous); }
      if (!options.available().available) fail('收件分析当前不可用', 503);
      const now = new Date().toISOString();
      const row: RequestRow = { id, source: refValue(ref), text: input.text, key: input.key, conversationId: current.conversationId, status: 'pending', createdAt: now, updatedAt: now };
      store.transaction(() => {
        putRequest(row);
        // The real isolated runtime persists its admitted user Message. Creating
        // another placeholder here would display every user instruction twice.
      });
      track(Promise.resolve().then(() => runThink(row, current)));
      return publicRequest(row);
    },
    // A connector has already awaited the isolated model. Commit its complete
    // batch once, against the same source generation, before exposing drafts.
    saveModelDrafts(ref: InboxHandlingRef, conversationId: string, key: string, requestText: string, actions: InboxHandlingAction[]) {
      open();
      const current = source(ref);
      writable(current, current.value.version);
      if (current.conversationId !== conversationId) fail('来源已变化', 409);
      const validated = actions.map(actionValue);
      const id = digest({ source: refValue(ref), key });
      return store.transaction(() => {
        const previous = store.get<RequestRow>(requests, id);
        if (previous) {
          if (previous.conversationId !== conversationId || previous.status !== 'completed') fail('原请求状态已变化', 409);
          return;
        }
        const now = new Date().toISOString();
        for (const action of validated) draft(current, action);
        putRequest({ id, source: refValue(ref), text: requestText, key, conversationId, status: 'completed', createdAt: now, updatedAt: now });
      });
    },
    save(ref: InboxHandlingRef, input: { sourceVersion: number; action: InboxHandlingAction; id?: string; version?: number }): InboxSuggestion {
      open(); fields(input, ['sourceVersion', 'action', 'id', 'version']);
      const current = source(ref); writable(current, input.sourceVersion); const action = actionValue(input.action);
      return store.transaction(() => {
        if (input.id === undefined) { if (input.version !== undefined) fail('新建议不能指定版本'); return draft(current, action); }
        const row = suggestion(current, input.id, input.version!);
        if (row.version === Number.MAX_SAFE_INTEGER) fail('建议版本已达上限', 409);
        rejectOldApproval(row);
        const { approvalId: _, result: __, error: ___, ...rest } = row;
        return putSuggestion({ ...rest, version: row.version + 1, action, status: 'draft', updatedAt: new Date().toISOString() });
      });
    },
    discard(ref: InboxHandlingRef, input: { sourceVersion: number; id: string; version: number }): InboxSuggestion {
      open(); fields(input, ['sourceVersion', 'id', 'version']);
      text(input.id); version(input.version); version(input.sourceVersion);
      return store.transaction(() => {
        const row = store.get<InboxSuggestion>(suggestions, input.id);
        if (!row || row.source.kind !== ref.kind || row.source.id !== ref.id) fail('建议不存在', 404);
        if (row.version !== input.version || row.sourceVersion !== input.sourceVersion) fail('建议版本已变化，请刷新', 409);
        if (row.status === 'discarded') return row;
        const current = source(ref);
        writable(current, input.sourceVersion);
        if (row.conversationId !== current.conversationId || row.status !== 'draft' || row.approvalId) fail('仅可丢弃未提交的草稿', 409);
        return putSuggestion({ ...row, status: 'discarded', updatedAt: new Date().toISOString() });
      });
    },
    confirm(ref: InboxHandlingRef, input: { sourceVersion: number; id: string; version: number }): Approval {
      open(); fields(input, ['sourceVersion', 'id', 'version']);
      const current = source(ref); writable(current, input.sourceVersion);
      return store.transaction(() => {
        const row = suggestion(current, input.id, input.version);
        if (row.action.kind === 'reply' && !current.value.replyAvailable) fail('当前来源不能发送回复，草稿已保留', 409);
        if (row.status === 'submitted') {
          const saved = boundApproval(row);
          if (saved) return saved;
          fail('审批已变化，请编辑建议后重新确认', 409);
        }
        const label={todo:'创建待办',dispatch:'派发任务',reply:'回复原消息',conclusion:'记录处理结论'}[row.action.kind];
        const action=row.action;
        const details=action.kind==='todo'?`标题：${action.title}\n说明：${action.notes}`:action.kind==='dispatch'?`执行者：${action.executorId}\n目标：${action.prompt}\n验收标准：${action.doneWhen}\n预计分钟：${action.expectMinutes}\n目录：${action.cwd??'默认'}`:action.text;
        const proposal = { kind: inboxHandlingApprovalKind, title: `收件处理：${label}`, details: `来源：${current.value.title}\n来源版本：${row.sourceVersion} · 建议版本：${row.version}\n${details}`, params: approvalParams(row) };
        const approval = synchronous(() => options.proposeApproval(structuredClone(proposal)));
        const saved = approval && store.get<Approval>('approvals', approval.id);
        if (!saved || saved.status !== 'pending' || !matching(saved, approval) || stableJson(saved.params) !== stableJson(proposal.params) || saved.title !== proposal.title || saved.details !== proposal.details) fail('审批创建无效', 409);
        store.put(bindings, approval.id, { id: approval.id, suggestionId: row.id, suggestionVersion: row.version, approval: saved } satisfies Binding);
        putSuggestion({ ...row, status: 'submitted', approvalId: saved.id, updatedAt: new Date().toISOString() });
        return saved;
      });
    },
    executeApproved(approval: Approval): Promise<Json> {
      // Validation/claim happen synchronously before execute can observe anything.
      // Never keep a SQLite transaction open across remote I/O.
      open();
      const binding = store.get<Binding>(bindings, approval.id);
      const saved = store.get<Approval>('approvals', approval.id);
      if (!binding || !saved || saved.status !== 'running' || approval.status !== 'running' || !matching(saved, binding.approval) || !matching(approval, saved)) fail('审批已变化或未执行', 409);
      const row = store.get<InboxSuggestion>(suggestions, binding.suggestionId);
      if (!row) fail('建议不存在', 409);
      const current = source(row.source); writable(current, row.sourceVersion);
      const claimed = store.transaction(() => {
        const latest = suggestion(current, row.id, binding.suggestionVersion);
        if (latest.status !== 'submitted' || latest.approvalId !== saved.id || stableJson(approvalParams(latest)) !== stableJson(saved.params)) fail('审批内容已变化', 409);
        if (latest.action.kind === 'reply' && !current.value.replyAvailable) fail('当前来源不能发送回复', 409);
        return putSuggestion({ ...latest, status: 'executing', updatedAt: new Date().toISOString() });
      });
      return track((async () => {
        try {
          const result = await options.execute(structuredClone(current.value), structuredClone(claimed.action), executionKey(claimed));
          // Reject lossy/non-JSON receipts. Remote effects may already have happened.
          stableJson(result);
          store.transaction(() => putSuggestion({ ...claimed, status: 'applied', result, updatedAt: new Date().toISOString() }));
          return result;
        } catch (error) {
          const noDelivery = !!error && typeof error === 'object' && 'delivery' in error && error.delivery === 'no';
          store.transaction(() => putSuggestion({ ...claimed, status: noDelivery ? 'draft' : 'unknown', error: noDelivery ? '动作未送达，请编辑并重新确认' : '外部动作结果未知，不自动重试', updatedAt: new Date().toISOString() }));
          const safe = new InboxHandlingError(noDelivery ? '动作未送达' : '外部动作结果未知，不自动重试', 409);
          throw Object.assign(safe, { delivery: noDelivery ? 'no' : 'unknown' });
        }
      })());
    },
    async close(): Promise<void> { closed = true; await Promise.allSettled([...jobs]); },
  };
}

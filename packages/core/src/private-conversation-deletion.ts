import { removeChatFileUploads } from './chat-files.ts';
import { removeChatImages } from './chat-images.ts';
import type { Store, ScheduleInfo } from '../../plugin-sdk/src/index.ts';
import type { AppEvent, Approval, Message, Run, Todo } from '../../protocol/src/index.ts';
import type { ScheduledWorkRecord } from '../../protocol/src/scheduled-work.ts';
import type { AgentTurnTrace } from './agent-traces.ts';
import { TRACE_COLLECTION } from './agent-traces.ts';
import type { Card } from './interactions.ts';
import type { Plan } from './plans.ts';
import type { Job } from './knowledge-curator.ts';
import type { FollowupRecord } from './followups.ts';

const webThread=/^web:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const webTombstones='web-conversations.deleted';
type DeletedWebThread={id:string;version:number;cleanupPending:boolean};

/** Called in the same transaction as the channel tombstone. Business records retain their own history. */
export function forgetPrivateConversation(store: Store, conversationId: string) {
  if (!webThread.test(conversationId) && !/^bot:.+:[a-f0-9]{64}:thread:[a-f0-9]{64}$/.test(conversationId))
    throw Object.assign(new Error('只允许删除独立对话'), { status: 400 });
  const busy = (reason: string): never => { throw Object.assign(new Error(reason), { status: 409 }); };
  const messages = store.list<Message>('messages').filter(m => m.conversationId === conversationId);
  const ids = new Set(messages.map(m => m.id));
  const belongs = (id: unknown) => typeof id === 'string' && ids.has(id);
  if (messages.some(m => m.status === 'pending')) busy('对话中还有未结束的消息');
  const runs = store.list<Run>('runs').filter(r => r.conversationId === conversationId || belongs(r.sourceMessageId));
  if (runs.some(r => ['queued', 'running', 'unknown'].includes(r.status))) busy('对话仍有进行中或待核实的执行');
  const runIds = new Set(runs.map(r => r.id));
  if (store.list<Job>('knowledge.sources').some(j => belongs(j.sourceMessageId) &&
    ['queued', 'running', 'unknown', 'awaiting_approval'].includes(j.status))) busy('对话仍有进行中或待核实的知识整理');
  const traces = store.list<AgentTurnTrace>(TRACE_COLLECTION).filter(trace => trace.conversationId === conversationId);
  const ownedTodos = new Set(runs.flatMap(r => r.todoId ? [r.todoId] : []));
  // Older tools recorded a creation receipt in the turn trace before todo.origins existed.
  for (const trace of traces) {
    for (const call of trace.toolCalls ?? []) {
      if (call.name !== 'todo_create' || !call.result || call.isError) continue;
      let result;
      try { result = JSON.parse(call.result)?.details; } catch { continue; }
      if (result?.created === true && typeof result.id === 'string') ownedTodos.add(result.id);
    }
  }
  if (store.list<Todo>('todos').some(t => !t.completedAt && (store.get<{conversationId: string}>('todo.origins', t.id)?.conversationId === conversationId
    || ownedTodos.has(t.id)))) busy('对话仍关联未完成的待办');
  if (store.list<Card>('interactions').some(c => c.status === 'open' && (runIds.has(c.runId ?? '')
    || belongs(store.get<{inputId?: string}>('interaction-origins', c.id)?.inputId)))) busy('对话还有待处理的交互');
  if (store.list<Approval>('approvals').some(a => ['pending', 'running', 'unknown'].includes(a.status) &&
    (a.params.conversationId === conversationId || belongs(a.params.sourceMessageId) || runIds.has(String(a.params.id)) ||
      store.get<{conversationId: string}>('approval.origins', a.id)?.conversationId === conversationId))) busy('对话还有待处理的审批');
  if (store.list<Plan>('plans').some(p => ['pending', 'running', 'unknown'].includes(p.status) &&
    store.get<{conversationId?: string}>('plan-origins', p.id)?.conversationId === conversationId)) busy('对话还有待处理的计划');
  const scheduled = store.list<ScheduledWorkRecord>('scheduled-work.requests').filter(r => r.sourceMessage.conversationId === conversationId);
  if (scheduled.some(r => {
    if (r.status === 'cancelled') return false;
    if (r.status === 'pending') return store.get<Approval>('approvals', r.approvalId)?.status !== 'rejected';
    const schedule = r.scheduleId && store.get<ScheduleInfo>('eventbox.schedules', r.scheduleId);
    return !schedule || !['cancelled', 'done'].includes(schedule.status);
  })) busy('对话仍有定时工作');
  if (store.list<FollowupRecord>('agent.followups').some(r => r.status === 'active' && r.sourceConversationId === conversationId))
    busy('对话仍有主动跟进安排');

  // An open question blocks deletion above. A terminal relay waiting to retry
  // loses its destination with this thread and must not retain quoted answers.
  for (const row of store.list<{id:string;inputId:string}>('interaction.later-questions')) {
    if (belongs(row.inputId)) store.remove('interaction.later-questions',row.id);
  }
  for (const origin of store.list<import('./agent-input.ts').OfficeFileOrigin>('office.file-origins')) {
    const docId=origin.ref.officeDocumentId;
    if (docId && belongs(origin.sourceId)) {
      store.remove('office.file-origins',docId);
      store.remove('office.documents',docId);
      store.remove('office.files',docId);
    }
  }
  removeChatFileUploads(store,conversationId);
  for (const m of messages) {
    removeChatImages(store,m);
    if(m.requestId)store.remove('message.requests',JSON.stringify([conversationId,m.requestId]));
    store.remove('message.tool-starts',m.id);
    store.remove('retryableFailures',m.id);
    store.remove('messages', m.id);
    store.remove('input-paused', m.id);
    store.remove('conversation.question-continuations', m.id);
  }
  for (const row of store.entries?.<string>('conversation.last-direct-input') ?? []) {
    if (belongs(row.value)) store.remove('conversation.last-direct-input', row.id);
  }
  for (const trace of traces) store.remove(TRACE_COLLECTION, trace.id);
  for (const record of scheduled) {
    // The schedule is independently visible. Discard the cached copy of the source message.
    const m = record.sourceMessage;
    store.put('scheduled-work.requests', record.id, { ...record, sourceMessage: {
      id: m.id, conversationId, role: m.role, text: '', status: m.status, createdAt: m.createdAt,
    } });
  }
  for (const event of store.list<AppEvent>('core.events')) {
    if (event.type !== 'agent.error' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) continue;
    if (event.data.conversationId === conversationId) store.remove('core.events', String(event.id));
  }
  store.remove('conversation.model-picks', conversationId);
}


/** Filesystem cleanup follows the committed tombstone, including after an interrupted shutdown. */
export function createWebThreadCleanup(store:Store,forget:(id:string)=>Promise<void>){
  const jobs=new Map<string,Promise<void>>();
  let closed=false, timer:ReturnType<typeof setTimeout>|undefined;
  function retry(){
    if(closed || timer)return;
    timer=setTimeout(()=>{timer=undefined;void recover();},300_000);
    timer.unref();
  }
  function clean(id:string):Promise<void>{
    const record=store.get<DeletedWebThread>(webTombstones,id);
    if(!record?.cleanupPending)return Promise.resolve();
    if(record.id!==id || !webThread.test('web:'+id) || store.get('web-conversations',id))
      return Promise.reject(Object.assign(new Error('独立对话删除记录不匹配'),{status:409}));
    const active=jobs.get(id);
    if(active)return active;
    const job=Promise.resolve().then(()=>forget(id)).then(()=>{
      store.put(webTombstones,id,{...record,cleanupPending:false});
    }).catch(()=>{
      retry();
      throw Object.assign(new Error('对话已删除，磁盘记录尚待清理；可用原版本再次核对'),{status:503});
    }).finally(()=>jobs.delete(id));
    jobs.set(id,job);
    return job;
  }
  async function recover(){
    for(const row of store.list<DeletedWebThread>(webTombstones)){
      if(closed)break;
      if(row.cleanupPending)await clean(row.id).catch(retry);
    }
  }
  return {clean,recover,async close(){
    closed=true;clearTimeout(timer);await Promise.allSettled(jobs.values());
  }};
}

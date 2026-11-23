import type { Store, EventBus } from '../../plugin-sdk/src/index.ts';
import type { Approval, BotScope, Json, Message, ScheduledWorkInput, ScheduledWorkRecord, ScheduledWorkScope } from '../../protocol/src/index.ts';
import { createScheduledWork } from './scheduled-work.ts';
import type { createSchedules } from './schedules.ts';
import type { createApprovalService } from './approvals.ts';
import { validateBotScope } from './bot-scopes.ts';
import { digest, stableJson } from './eventbox.ts';
function fail(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
/** Public projection and actual user provenance around existing approval/schedule coordination. */
export function createScheduledWorkService(options: {
  store: Store; events: EventBus; schedules: ReturnType<typeof createSchedules>;
  approvals: ReturnType<typeof createApprovalService>; currentInput(): Message | undefined;
  authorize(scope: ScheduledWorkScope, source: Message): void; enabled(): boolean; ready(): boolean;
  facts(scope: BotScope): Json;
}) {
  const { store, events } = options;
  const manager = createScheduledWork({ store, events, schedules: options.schedules,
    proposeApproval: input => options.approvals.propose(input), authorize: options.authorize, enabled: options.enabled,
    brief(input) {
      input.assertCurrent();
      const scope: BotScope = input.scope.todoId ? { kind:'task',todoId:input.scope.todoId,...(input.scope.projectId?{projectId:input.scope.projectId}:{}) }
        : input.scope.projectId ? { kind:'project',projectId:input.scope.projectId } : {kind:'global'};
      const facts = options.facts(scope) as Record<string, any>;
      const counts = facts.runs?.counts ?? {};
      const text = `${input.title}\n开放待办：${facts.todos?.total ?? 0}\n执行中：${(counts.running??0)+(counts.queued??0)}\n执行失败：${counts.failed??0}\n结果未知：${counts.unknown??0}\n待你决定：${facts.needsYou?.total??0}\n记录时间：${facts.capturedAt}\n仅汇总已接入的事实，执行结束与待办验收分别计算。`;
      const id = `scheduled-brief:${input.occurrenceKey}`;
      store.transaction(() => {
        input.assertCurrent();
        if (!store.get('messages', id)) {
          const message: Message = { id, role:'assistant',origin:'notification',conversationId:'main',text,status:'done',createdAt:new Date().toISOString(),
            ...(input.scope.projectId?{projectId:input.scope.projectId}:{}),...(input.scope.todoId?{todoId:input.scope.todoId}:{}) };
          store.put('messages',id,message); events.publish('messages.changed',{messageId:id,conversationId:'main'});
        }
      });
      return { messageId:id, scheduledFor:input.scheduledFor };
    },
  });
  const scopeOf = (input: {projectId?:string;todoId?:string}): BotScope => validateBotScope(store,input.todoId ? {kind:'task',todoId:input.todoId,...(input.projectId?{projectId:input.projectId}:{})} : input.projectId ? {kind:'project',projectId:input.projectId} : {kind:'global'});
  function normalized(input: Record<string,unknown>, source?: Message): ScheduledWorkInput {
    const requested = { ...input };
    if (requested.projectId === undefined && source?.projectId) requested.projectId = source.projectId;
    if (requested.todoId === undefined && source?.todoId) requested.todoId = source.todoId;
    const scope = scopeOf(requested as any);
    return { ...requested, ...('projectId' in scope ? {projectId:scope.projectId}:{}), ...(scope.kind==='task'?{todoId:scope.todoId}:{}) } as unknown as ScheduledWorkInput;
  }
  function actor() {
    const source = options.currentInput();
    if (!source || source.role!=='user' || source.readOnly || source.origin && source.origin!=='user') fail('周期工作需要当前用户明确输入',403);
    return source;
  }
  function cleanup(rows = manager.list()) {
    for (const row of rows) if (row.status==='cancelled') {
      for (const id of [row.approvalId,...row.occurrences.flatMap(o=>o.approvalId?[o.approvalId]:[])]) {
        const approval=store.get<Approval>('approvals',id);
        if (approval?.status==='pending') options.approvals.reject(id,approval.version);
      }
    }
  }
  function publicRows(input:Record<string,unknown>={}) {
    const scope=scopeOf(input as any), rows=manager.list(); cleanup(rows);
    const selected=rows.filter(row=>scope.kind==='global' || row.input.projectId===('projectId' in scope?scope.projectId:undefined) && (scope.kind!=='task'||row.input.todoId===scope.todoId));
    const schedules = new Map(options.schedules.forOwner('daily-brief').list().map(schedule => [schedule.id, schedule]));
    const now = Date.now();
    const upcoming = selected.flatMap(row => {
      const schedule = row.scheduleId ? schedules.get(row.scheduleId) : undefined;
      if (row.status !== 'active' || schedule?.status !== 'active' || !schedule.nextAt || !(Date.parse(schedule.nextAt) >= now)) return [];
      return [{ id: row.id, title: row.input.title, nextAt: schedule.nextAt }];
    }).sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt) || a.id.localeCompare(b.id)).slice(0, 3);
    return { items:selected.slice(0,100).map(row=>{
      const schedule=row.scheduleId ? schedules.get(row.scheduleId) : undefined, history=[...row.occurrences].sort((a,b)=>b.scheduledFor.localeCompare(a.scheduledFor));
      return {id:row.id,version:row.version,title:row.input.title,status:row.status,projectId:row.input.projectId,todoId:row.input.todoId,schedule:row.input.schedule,action:row.input.action,
        approvalId:row.approvalId,approvalStatus:store.get<Approval>('approvals',row.approvalId)?.status,
        source:{messageId:row.sourceMessage.id,createdAt:row.sourceMessage.createdAt},
        nextAt:schedule?.nextAt,scheduleStatus:schedule?.status,scheduleVersion:schedule?.version,
        occurrences:history.slice(0,20).map(o=>({key:o.key,scheduledFor:o.scheduledFor,status:o.status,approvalId:o.approvalId,
          approvalStatus:o.approvalId?store.get<Approval>('approvals',o.approvalId)?.status:undefined,result:o.result,
          kind:row.input.action.kind,...(o.error?{error:'结果未知，请核对原记录'}:{})})),occurrenceTotal:history.length,occurrencesTruncated:history.length>20};
    }),upcoming,total:selected.length,truncated:selected.length>100,limit:100 };
  }
  function propose(input:Record<string,unknown>,fromAgent=false) {
    return store.transaction(()=>{
      const source=fromAgent?actor():undefined, value=normalized(input,source);
      let actual=source;
      if (!actual) {
        if (typeof value.key!=='string'||!value.key.trim()) fail('请提供请求标识',400);
        const scope=scopeOf(value),text=stableJson(value as unknown as Json),id=`scheduled-input:${digest([scope,value.key])}`;
        const old=store.get<Message>('messages',id);
        const conversationId=value.projectId?`project:${value.projectId}:work`:'main';
        if (old && (old.role!=='user'||old.origin!=='user'||old.text!==text||old.conversationId!==conversationId||old.projectId!==value.projectId||old.todoId!==value.todoId)) fail('同一请求标识已有不同内容');
        actual=old??{id,role:'user',origin:'user',text,status:'done',conversationId,createdAt:new Date().toISOString(),...(value.projectId?{projectId:value.projectId}:{}),...(value.todoId?{todoId:value.todoId}:{})};
        if (!old) {store.put('messages',id,actual);events.publish('messages.changed',{messageId:id,conversationId});}
      }
      options.authorize({action:value.action,...(value.projectId?{projectId:value.projectId}:{}),...(value.todoId?{todoId:value.todoId}:{})},actual);
      const approval=manager.propose(value,actual.id); events.publish('scheduled.work.changed',{approvalId:approval.id}); return approval;
    });
  }
  function changeTiming(input: Record<string, unknown>, fromAgent = false) {
    const { id, version, scheduleVersion, paused } = input;
    if (typeof id !== 'string' || typeof version !== 'number' || !Number.isSafeInteger(version)
      || typeof scheduleVersion !== 'number' || !Number.isSafeInteger(scheduleVersion) || typeof paused !== 'boolean') fail('需要当前工作版本、调度版本和暂停状态', 400);
    if (fromAgent) {
      const row = manager.list().find(row => row.id === id);
      if (!row) fail('周期工作不存在', 404);
      options.authorize({ action: row.input.action, projectId: row.input.projectId, todoId: row.input.todoId }, actor());
    }
    return manager.setPaused(id, version, scheduleVersion, paused);
  }
  function cancel(input:Record<string,unknown>,fromAgent=false) {
    return store.transaction(()=>{
      const row=manager.list().find(r=>r.id===input.id);if(!row)fail('周期工作不存在',404);
      if(row.version!==input.version)fail('周期工作版本已变化，请核对后取消');
      if(fromAgent)options.authorize({action:row.input.action,...(row.input.projectId?{projectId:row.input.projectId}:{}),...(row.input.todoId?{todoId:row.input.todoId}:{})},actor());
      manager.cancel(row.id);cleanup();events.publish('scheduled.work.changed',{id:row.id});return {id:row.id,status:'cancelled'};
    });
  }
  const off=events.subscribe(event=>{if(['projects.changed','todos.changed','plugins.changed','feishu.bots.changed','bots.changed'].includes(event.type)){manager.sync();cleanup();}});
  return { list:publicRows,propose,cancel,changeTiming,approveCreation:manager.approveCreation,assertDispatchCurrent:manager.assertDispatchCurrent,
    sync(){manager.sync();cleanup();},async handle(event:Parameters<typeof manager.handle>[0]){
      if(!options.ready())return {status:'retry' as const,reason:'channel_bindings_initializing',afterSec:1,deferred:true};
      const result=await manager.handle(event);cleanup();return result;
    },close(){off();manager.close();},
  };
}

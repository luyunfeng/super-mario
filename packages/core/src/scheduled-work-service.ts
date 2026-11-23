import type { Store, EventBus, ScheduleInfo } from '../../plugin-sdk/src/index.ts';
import type { Approval, BotScope, Json, Message, Run, ScheduledWorkInput, ScheduledWorkOccurrence, ScheduledWorkRecord, ScheduledWorkScope } from '../../protocol/src/index.ts';
import { createScheduledWork } from './scheduled-work.ts';
import { nextOccurrence, previewCron, type createSchedules } from './schedules.ts';
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
  function dispatchReceipt(work: ScheduledWorkRecord, occurrence: ScheduledWorkOccurrence) {
    if (!occurrence.approvalId) return {};
    const approval = store.get<Approval>('approvals', occurrence.approvalId);
    if (!approval || approval.kind !== 'dispatch' || approval.params.scheduledWorkOccurrence !== occurrence.key) return {};
    const runId = store.get<string>('dispatch-keys', `approval:${approval.id}:${occurrence.approvalVersion}`);
    const run = runId ? store.get<Run>('runs', runId) : undefined;
    const matches = run && run.projectId === work.input.projectId && run.todoId === work.input.todoId
      && run.sourceMessageId === work.sourceMessage.id;
    return { approvalStatus: approval.status, ...(matches ? { run: { id: run.id, status: run.status } } : {}) };
  }
  function historicalKind(work: ScheduledWorkRecord, occurrence: ScheduledWorkOccurrence) {
    if (occurrence.actionKind) return occurrence.actionKind;
    // Older records lack the snapshot. Receipts identify the original action across plan revisions.
    if (occurrence.approvalId || occurrence.dispatchParams) return 'dispatch';
    const receipt = occurrence.result;
    if (receipt && typeof receipt === 'object' && !Array.isArray(receipt)
      && receipt.messageId === 'scheduled-brief:' + occurrence.key) return 'brief';
    if (occurrence.workVersion === work.version) return work.input.action.kind;
    return 'unknown';
  }
  function historyPage(work: ScheduledWorkRecord, occurrences: ScheduledWorkOccurrence[], schedule?: ScheduleInfo, after?: string) {
    // The scheduler persists cutoff separately from delivered work. Include it in the same cursor order.
    const history: (ScheduledWorkOccurrence & { endedAt?: string })[] = occurrences.filter(o => !o.ownerSkipToken || Date.parse(o.scheduledFor) <= Date.now());
    if (schedule?.endedAt && schedule.until) history.push({
      key: 'ended:' + schedule.id, workId: work.id, workVersion: work.version, scheduleId: schedule.id, scheduleVersion: schedule.version,
      scheduledFor: new Date(schedule.until).toISOString(), status: 'skipped', endedAt: schedule.endedAt,
    });
    history.sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor) || b.key.localeCompare(a.key));
    const start = after === undefined ? 0 : history.findIndex(o => o.key === after) + 1;
    if (after !== undefined && !start) fail('当前计划找不到所选触发记录', 404);
    const page = history.slice(start, start + 20);
    const more = start + page.length < history.length;
    return {
      occurrences: page.map(o => ({ blockedBy: o.blockedBy, endedAt: o.endedAt, workVersion: o.workVersion, key: o.key, scheduledFor: o.scheduledFor, status: o.status, approvalId: o.approvalId,
        ...(o.handledAt ? { handledAt: o.handledAt, delayMs: Date.parse(o.handledAt) - Date.parse(o.scheduledFor) } : {}),
        ...dispatchReceipt(work, o),
        result: o.result, ...(o.ownerSkipToken ? { ownerSkipped: true } : {}), kind: historicalKind(work, o), ...(o.error ? { error: '结果未知，请核对原记录' } : {}) })),
      occurrenceTotal: history.length, occurrencesTruncated: more, nextOccurrenceKey: more ? page[page.length - 1].key : null,
    };
  }
  function readHistory(input: Record<string, unknown>) {
    const work = scopedWork(input);
    if (input.after !== undefined && typeof input.after !== 'string') fail('触发记录标识无效', 400);
    const occurrences = store.list<ScheduledWorkOccurrence>('scheduled-work.occurrences').filter(o => o.workId === work.id);
    const schedule = work.scheduleId ? options.schedules.forOwner('daily-brief').list().find(item => item.id === work.scheduleId) : undefined;
    return historyPage(work, occurrences, schedule, input.after);
  }
  function publicRows(input:Record<string,unknown>={}) {
    const offset = input.offset === undefined ? 0 : input.offset;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) fail('分页起点须为非负整数', 400);
    const repeat = input.repeat;
    if (repeat !== undefined && repeat !== 'once' && repeat !== 'repeating') fail('无效的计划频率筛选', 400);
    const limit = 100;
    const scope=scopeOf(input as any), rows=manager.list(); cleanup(rows);
    const selected=rows.filter(row=>scope.kind==='global' || row.input.projectId===('projectId' in scope?scope.projectId:undefined) && (scope.kind!=='task'||row.input.todoId===scope.todoId));
    const schedules = new Map(options.schedules.forOwner('daily-brief').list().map(schedule => [schedule.id, schedule]));
    const now = Date.now();
    function pendingSkip(row: typeof selected[number], schedule: ReturnType<typeof schedules.get>) {
      if (schedule?.status !== 'active' || !(Date.parse(schedule.nextAt) > now)) return undefined;
      return row.occurrences.find(o => o.ownerSkipToken && o.scheduleId === schedule.id && o.scheduledFor === schedule.nextAt && o.scheduleVersion === schedule.version);
    }
    const upcomingByWork = new Map(selected.flatMap(row => {
      const schedule = row.scheduleId ? schedules.get(row.scheduleId) : undefined;
      if (row.status !== 'active' || schedule?.status !== 'active' || !schedule.nextAt || !(Date.parse(schedule.nextAt) >= now)) return [];
      const nextAt = pendingSkip(row, schedule) ? nextOccurrence(schedule, Date.parse(schedule.nextAt)) : schedule.nextAt;
      if (schedule.until && Date.parse(nextAt) >= Date.parse(schedule.until)) return [];
      return [[row.id, { id: row.id, title: row.input.title, nextAt }] as const];
    }));
    const upcoming = [...upcomingByWork.values()].sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt) || a.id.localeCompare(b.id)).slice(0, 3);
    const repeating = repeat === 'once' ? [] : selected.filter(row => row.input.schedule.kind !== 'once');
    const once = repeat === 'repeating' ? [] : selected.flatMap(row => row.input.schedule.kind === 'once'
      ? [{ row, at: Date.parse(row.input.schedule.at) }] : []).sort((a, b) => a.at - b.at);
    const ordered = repeating.concat(once.map(item => item.row));
    const page = ordered.slice(offset, offset + limit);
    const nextOffset = offset + page.length < ordered.length ? offset + page.length : null;
    return { items:page.map(row=>{
      const schedule=row.scheduleId ? schedules.get(row.scheduleId) : undefined;
      const skipToken = pendingSkip(row, schedule)?.ownerSkipToken;
      return {id:row.id,version:row.version,title:row.input.title,status:row.status,projectId:row.input.projectId,todoId:row.input.todoId,schedule:row.input.schedule,action:row.input.action,
        approvalId:row.approvalId,approvalStatus:store.get<Approval>('approvals',row.approvalId)?.status,
        source:{messageId:row.sourceMessage.id,createdAt:row.sourceMessage.createdAt},
        nextActionAt:upcomingByWork.get(row.id)?.nextAt ?? (row.status === 'active' && skipToken && schedule?.until ? null : undefined),
        nextAt:row.status === 'active' && schedule?.status === 'active' && (!schedule.until || Date.parse(schedule.nextAt) < Date.parse(schedule.until)) ? schedule.nextAt : undefined,skipToken,scheduleStatus:schedule?.status,scheduleVersion:schedule?.version,
        ...historyPage(row, row.occurrences, schedule)};
    }),upcoming,total:ordered.length,offset,nextOffset,truncated:nextOffset !== null,limit };
  }
  function scopedWork(input: Record<string, unknown>) {
    const scope = scopeOf(input as { projectId?: string; todoId?: string });
    if (typeof input.workId !== 'string') fail('需要计划标识', 400);
    const work = store.get<ScheduledWorkRecord>('scheduled-work.requests', input.workId);
    if (!work
      || scope.kind === 'unmarked' || (scope.kind !== 'global' && scope.projectId !== work.input.projectId)
      || (scope.kind === 'task' && scope.todoId !== work.input.todoId)) fail('当前范围找不到这次触发记录', 404);
    return work;
  }
  function readBrief(input: Record<string, unknown>) {
    const work = scopedWork(input);
    if (typeof input.occurrenceKey !== 'string') fail('需要触发记录标识', 400);
    const occurrence = store.get<ScheduledWorkOccurrence>('scheduled-work.occurrences', input.occurrenceKey);
    if (!occurrence || occurrence.workId !== work.id || occurrence.key !== input.occurrenceKey) fail('当前范围找不到这次触发记录', 404);
    const id = 'scheduled-brief:' + occurrence.key;
    const result = occurrence.result;
    const message = store.get<Message>('messages', id);
    if (occurrence.status !== 'completed' || !result || typeof result !== 'object' || Array.isArray(result)
      || result.messageId !== id || !message || message.id !== id || message.origin !== 'notification'
      || message.role !== 'assistant' || message.conversationId !== 'main' || message.status !== 'done'
      || message.projectId !== work.input.projectId || message.todoId !== work.input.todoId) fail('本次触发没有可核对的简报原文', 404);
    return { messageId: id, scheduledFor: occurrence.scheduledFor, createdAt: message.createdAt, text: message.text };
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
  function skipNext(input: Record<string, unknown>, fromAgent = false) {
    const { id, version, scheduleVersion, at, undoToken } = input;
    if (typeof id !== 'string' || typeof version !== 'number' || !Number.isSafeInteger(version)
      || typeof scheduleVersion !== 'number' || !Number.isSafeInteger(scheduleVersion) || typeof at !== 'string'
      || (undoToken !== undefined && typeof undoToken !== 'string')) fail('需要计划版本、调度版本和目标触发时间', 400);
    if (fromAgent) {
      const row = store.get<ScheduledWorkRecord>('scheduled-work.requests', id);
      if (!row) fail('周期工作不存在', 404);
      options.authorize({ action: row.input.action, projectId: row.input.projectId, todoId: row.input.todoId }, actor());
    }
    return manager.skipNext(id, version, scheduleVersion, at, undoToken);
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
  return { list:publicRows, previewCron(input: Record<string, unknown>) {
    if (!options.enabled()) fail('定时工作插件已停用', 409);
    return previewCron(input);
  }, readHistory,readBrief,propose,cancel,skipNext,changeTiming,approveCreation:manager.approveCreation,assertDispatchCurrent:manager.assertDispatchCurrent,
    sync(){manager.sync();cleanup();},async handle(event:Parameters<typeof manager.handle>[0]){
      if(!options.ready())return {status:'retry' as const,reason:'channel_bindings_initializing',afterSec:1,deferred:true};
      const result=await manager.handle(event);cleanup();return result;
    },close(){off();manager.close();},
  };
}

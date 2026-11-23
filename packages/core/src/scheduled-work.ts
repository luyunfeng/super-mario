import { randomUUID } from 'node:crypto';
import type { DurableEvent, EventBus, EventResult, ScheduleInput, Store } from '../../plugin-sdk/src/index.ts';
import type { Approval, Json, JsonObject, Message, Project, Run, Todo } from '../../protocol/src/index.ts';
import type { ScheduledWorkInput, ScheduledWorkOccurrence, ScheduledWorkRecord, ScheduledWorkScope } from '../../protocol/src/scheduled-work.ts';
import type { createSchedules } from './schedules.ts';
import { ApprovalError } from './approvals.ts';
import { assertBackgroundExecution, digest } from './eventbox.ts';

const records = 'scheduled-work.requests';
const occurrences = 'scheduled-work.occurrences';
const owner = 'daily-brief';
export const scheduledWorkApprovalKind = 'plugin:daily-brief.scheduled-work' as const;
const fail = (message: string): never => { throw new ApprovalError(message, 409); };
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
// The runtime updates turn status after tools return. That is presentation state,
// not a change to the user's text, identity, read-only flag or routing evidence.
function sourceEvidence(message: Message) { const { status: _, ...evidence } = message; return evidence; }
function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) fail(`${name}不能为空`);
}
function fields(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('包含无效或非宿主字段');
}

/** All callbacks except brief are synchronous and share the same Store transaction.
 * authorize must recheck the original user/bot binding against the requested scope,
 * throwing or returning false on revocation. A schedule is never an execution grant.
 * Host: route creation kind before generic plugin handling; call assertDispatchCurrent
 * immediately before ordinary dispatch, without an await between check and dispatch.
 * brief may await read-only computation; it must call input.assertCurrent() immediately
 * before any synchronous message commit, with no intervening await. The post-await
 * check here protects the receipt but cannot undo side effects inside a callback.
 */
export function createScheduledWork({ store, events, schedules, proposeApproval, brief, authorize, enabled, now = Date.now }: {
  store: Store; events: EventBus; schedules: Pick<ReturnType<typeof createSchedules>, 'forOwner'>;
  proposeApproval: (input: Pick<Approval, 'kind' | 'title' | 'details' | 'params' | 'todoId'>) => Approval;
  brief: (input: { scope: ScheduledWorkScope; sourceMessage: Message; occurrenceKey: string; scheduledFor: string; title: string; assertCurrent: () => void }) => Promise<Json> | Json;
  authorize: (scope: ScheduledWorkScope, sourceMessage: Message) => void | boolean;
  enabled: () => boolean; now?: () => number;
}) {
  const api = schedules.forOwner(owner);
  let closed = false;
  const all = () => store.list<ScheduledWorkRecord>(records);
  const scope = (r: ScheduledWorkRecord): ScheduledWorkScope => ({ action: r.input.action, ...(r.input.projectId ? { projectId: r.input.projectId } : {}), ...(r.input.todoId ? { todoId: r.input.todoId } : {}) });
  function check(r: ScheduledWorkRecord) {
    if (closed || !enabled() || store.get<{ enabled: boolean }>('eventbox.owners', owner)?.enabled === false) fail('周期工作已停用');
    const source = store.get<Message>('messages', r.sourceMessage.id);
    if (!source || source.role !== 'user' || source.readOnly || (source.origin !== undefined && source.origin !== 'user') || !same(sourceEvidence(source), sourceEvidence(r.sourceMessage))) fail('原用户来源已失效');
    const { projectId, todoId } = r.input;
    const todo = todoId ? store.get<Todo>('todos', todoId) : undefined;
    if (todoId && (!todo || todo.completedAt || todo.projectId !== projectId)) fail('关联待办已完成或范围改变');
    const project = projectId ? store.get<Project>('projects', projectId) : undefined;
    if (projectId && (!project || project.archivedAt)) fail('关联项目已归档或不存在');
    // A Promise is truthy; accepting one silently bypasses authorization. Reject
    // native async callbacks before they start, and observe other thenable rejections.
    if (authorize.constructor.name === 'AsyncFunction') fail('authorize 必须同步返回');
    const authorization = authorize(structuredClone(scope(r)), structuredClone(source!));
    if (authorization != null && typeof (authorization as unknown as { then?: unknown }).then === 'function') {
      void Promise.resolve(authorization).catch(() => {});
      fail('authorize 必须同步返回');
    }
    if (authorization !== undefined && authorization !== true) fail('原用户来源不再授权此范围');
  }
  function clearPendingSkip(r: ScheduledWorkRecord, s: ReturnType<typeof api.list>[number] | undefined) {
    if (!s || Date.parse(s.nextAt) <= now()) return;
    const key = digest([s.id, r.scheduleVersion, s.nextAt]);
    if (store.get<ScheduledWorkOccurrence>(occurrences, key)?.ownerSkipToken) store.remove(occurrences, key);
  }
  function stop(r: ScheduledWorkRecord) {
    const s = api.list().find(s => s.id === r.scheduleId);
    clearPendingSkip(r, s);
    if (s && s.status !== 'cancelled') api.cancel(s.id, s.version);
    store.put(records, r.id, { ...r, status: 'cancelled' });
  }
  function sync() {
    if (closed) return;
    for (const r of all().filter(r => r.status !== 'cancelled')) {
      try { check(r); } catch { stop(r); }
    }
  }
  function input(value: ScheduledWorkInput): ScheduledWorkInput {
    fields(value, ['key', 'title', 'schedule', 'action', 'projectId', 'todoId']);
    text(value.key, 'key'); text(value.title, 'title');
    for (const id of [value.projectId, value.todoId]) if (id !== undefined) text(id, '范围');
    const s = value.schedule;
    const keys = s?.kind === 'once' ? ['kind', 'at', 'tz'] : s?.kind === 'interval' ? ['kind', 'everySec', 'anchorAt', 'tz', 'until'] : ['kind', 'cron', 'tz', 'until'];
    fields(s, keys);
    if (s.tz !== undefined) {
      text(s.tz, 'tz');
      try { new Intl.DateTimeFormat('en', { timeZone: s.tz }).format(); } catch { fail('IANA 时区无效'); }
    }
    fields(value.action, value.action?.kind === 'brief' ? ['kind'] : ['kind', 'executorId', 'prompt', 'doneWhen', 'expectMinutes', 'cwd']);
    const a = value.action;
    if (a.kind === 'dispatch') {
      text(a.executorId, 'executorId'); text(a.prompt, 'prompt'); text(a.doneWhen, 'doneWhen');
      if (!Number.isFinite(a.expectMinutes) || a.expectMinutes <= 0 || a.expectMinutes > 10080) fail('预计时长无效');
      if (a.cwd !== undefined) text(a.cwd, 'cwd');
    } else if (a.kind !== 'brief') fail('工作类型无效');
    // Reuse ScheduleApi's complete validation without persisting an effective schedule.
    // Rolling back the temporary row also preserves legacy daily brief settings.
    const rollback = {};
    let validated: ScheduleInput | undefined;
    try {
      store.transaction(() => {
        const trial = api.create({ ...s, name: `scheduled-work-validation:${digest(value)}`, missed: 'coalesce' });
        validated = trial;
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    const result = structuredClone(value);
    if (result.schedule.kind === 'interval') result.schedule.anchorAt = validated!.anchorAt;
    return result;
  }
  function propose(value: ScheduledWorkInput, sourceMessageId: string): Approval {
    return store.transaction(() => {
      const source = store.get<Message>('messages', sourceMessageId);
      if (!source) return fail('原用户来源不存在');
      const normalized = input(value);
      const id = digest([sourceMessageId, normalized.key]);
      const old = store.get<ScheduledWorkRecord>(records, id);
      // Reusing the same original message cannot launder edited instructions into
      // a newly approved revision. Only runtime status is mutable evidence.
      if (all().some(r => r.sourceMessage.id === sourceMessageId && !same(sourceEvidence(source), sourceEvidence(r.sourceMessage)))) fail('原用户来源已改变');
      const r: ScheduledWorkRecord = { id, version: (old?.version ?? 0) + 1, input: normalized, sourceMessage: source,
        approvalId: '', approvalVersion: 1, approvalParams: {}, status: 'pending' };
      check(r);
      // Omitted interval anchor inherits the original preview anchor for replay.
      if (old && value.schedule.kind === 'interval' && value.schedule.anchorAt === undefined && old.input.schedule.kind === 'interval') normalized.schedule = { ...normalized.schedule, anchorAt: old.input.schedule.anchorAt } as typeof normalized.schedule;
      if (old && same(old.input, normalized) && old.status !== 'cancelled') {
        const approval = store.get<Approval>('approvals', old.approvalId);
        if (approval) return approval;
        return fail('创建审批证据丢失');
      }
      if (old) stop(old);
      const params: JsonObject = { ...(normalized.projectId ? { projectId: normalized.projectId } : {}), scheduledWorkId: id, workVersion: r.version, sourceMessageId, input: normalized as unknown as Json };
      const approval = proposeApproval({ kind: scheduledWorkApprovalKind, title: `创建周期工作：${normalized.title}`, details: JSON.stringify(normalized), params, ...(normalized.todoId ? { todoId: normalized.todoId } : {}) });
      store.put(records, id, { ...r, approvalId: approval.id, approvalVersion: approval.version, approvalParams: params });
      return approval;
    });
  }
  function approved(value: Approval) {
    const actual = store.get<Approval>('approvals', value.id);
    if (!actual || !same(actual, value) || !['running', 'completed'].includes(actual.status)) fail('必须由审批执行入口调用');
    return actual!;
  }
  function approveCreation(value: Approval): JsonObject {
    return store.transaction(() => {
      const a = approved(value);
      const r = all().find(r => r.approvalId === a.id);
      if (!r || a.kind !== scheduledWorkApprovalKind || a.version !== r.approvalVersion || !same(a.params, r.approvalParams) || a.todoId !== r.input.todoId || r.status === 'cancelled') return fail('创建预览版本或内容已改变');
      check(r);
      if (r.scheduleId) {
        current(r, true);
        return { scheduleId: r.scheduleId, version: r.initialScheduleVersion ?? r.scheduleVersion! };
      }
      const s = api.create({ ...r.input.schedule, name: `scheduled-work:${r.id}:v${r.version}`, missed: 'coalesce', payload: { scheduledWork: true, workId: r.id, workVersion: r.version } });
      store.put(records, r.id, { ...r, status: 'active', scheduleId: s.id, scheduleVersion: s.version });
      return { scheduleId: s.id, version: s.version };
    });
  }
  function current(r: ScheduledWorkRecord, allowPaused = false) {
    check(r);
    const creation = store.get<Approval>('approvals', r.approvalId);
    if (!creation || creation.kind !== scheduledWorkApprovalKind || creation.version !== r.approvalVersion
      || !['running', 'completed', 'unknown'].includes(creation.status) || !same(creation.params, r.approvalParams)
      || creation.todoId !== r.input.todoId) return fail('原创建审批证据已改变');
    const s = api.list().find(s => s.id === r.scheduleId);
    if (r.status !== 'active' || !s || s.version !== r.scheduleVersion || !(s.status === 'active' || s.status === 'done' || (allowPaused && s.status === 'paused'))
      || !same(s.payload, { scheduledWork: true, workId: r.id, workVersion: r.version })) return fail('周期工作版本已失效');
    return s;
  }
  // Pausing changes delivery generations, but an already claimed occurrence retains its approval.
  function samePlan(r: ScheduledWorkRecord, o: ScheduledWorkOccurrence) {
    return r.version === o.workVersion && r.scheduleId === o.scheduleId && r.scheduleVersion !== undefined
      && o.scheduleVersion >= (r.initialScheduleVersion ?? r.scheduleVersion) && o.scheduleVersion <= r.scheduleVersion;
  }
  function setPaused(id: string, version: number, scheduleVersion: number, paused: boolean) {
    return store.transaction(() => {
      const r = store.get<ScheduledWorkRecord>(records, id);
      if (!r || r.version !== version || r.scheduleVersion !== scheduleVersion) return fail('计划版本已变化，请核对当前计划');
      const s = current(r, true);
      if (s.status !== (paused ? 'active' : 'paused')) return fail('此计划当前不能' + (paused ? '暂停' : '恢复'));
      clearPendingSkip(r, s);
      const next = api.update(s.id, { status: paused ? 'paused' : 'active' }, s.version);
      store.put(records, id, { ...r, initialScheduleVersion: r.initialScheduleVersion ?? s.version, scheduleVersion: next.version });
      events.publish('scheduled.work.changed', { id });
      return { id, scheduleVersion: next.version, scheduleStatus: next.status };
    });
  }
  function skipNext(id: string, version: number, scheduleVersion: number, at: string, undoToken?: string) {
    return store.transaction(() => {
      const work = store.get<ScheduledWorkRecord>(records, id);
      if (!work || work.version !== version || work.scheduleVersion !== scheduleVersion) return fail('计划版本已变化，请重新核对');
      const schedule = current(work);
      if (schedule.kind === 'once' || schedule.status !== 'active' || schedule.nextAt !== at || Date.parse(at) <= now()
        || (schedule.until && Date.parse(at) >= Date.parse(schedule.until)))
        return fail('该次触发时间已改变或不支持跳过');
      // Reserve the same key that due delivery claims. Catch-up and replay cannot execute this slot.
      const key = digest([schedule.id, schedule.version, at]);
      const marked = store.get<ScheduledWorkOccurrence>(occurrences, key);
      if (undoToken !== undefined) {
        if (!marked?.ownerSkipToken || marked.ownerSkipToken !== undoToken) return fail('跳过标记已改变，请重新核对');
        store.remove(occurrences, key);
      } else if (!marked) {
        store.put<ScheduledWorkOccurrence>(occurrences, key, { key, workId: id, workVersion: version, scheduleId: schedule.id,
          scheduleVersion, scheduledFor: at, status: 'skipped', ownerSkipToken: randomUUID() });
      } else if (!marked.ownerSkipToken) return fail('该次触发已有执行记录');
      events.publish('scheduled.work.changed', { id });
      return { id, at, skipped: undoToken === undefined };
    });
  }
  function blocked(r: ScheduledWorkRecord): boolean {
    return store.list<ScheduledWorkOccurrence>(occurrences).filter(o => o.workId === r.id).some(o => {
      if (o.status === 'claimed' || o.status === 'unknown') return true;
      if (!o.approvalId) return false;
      const a = store.get<Approval>('approvals', o.approvalId);
      if (!a || ['running', 'unknown'].includes(a.status)) return true;
      // Invalidated pending approvals can no longer execute. Unknown/running
      // actions and active Runs remain blockers even across plan revisions.
      if (a.status === 'pending') return samePlan(r, o);
      const runId = store.get<string>('dispatch-keys', `approval:${a.id}:${a.version}`) ?? (a.result as JsonObject | undefined)?.runId;
      const run = typeof runId === 'string' ? store.get<Run>('runs', runId) : undefined;
      // A completed receipt without a traceable Run is uncertain, never evidence to repeat.
      return a.status === 'completed' && !run || !!run && ['queued', 'running', 'unknown'].includes(run.status);
    });
  }
  async function handle(event: DurableEvent): Promise<EventResult> {
    if (closed || event.type !== 'schedule.due' || event.typeVersion !== 1 || event.source !== 'core') return { status: 'skip', reason: 'not_scheduled_work' };
    // DeliveredEvent adds attempt; compare only durable evidence, never delivery metadata.
    const persisted = store.get<DurableEvent>('eventbox.events', event.id);
    try {
      if (!persisted || !same(persisted, Object.fromEntries(Object.keys(persisted).map(k => [k, event[k as keyof DurableEvent]]))))
        return { status: 'skip', reason: 'unverified_schedule_event' };
    } catch {
      return { status: 'skip', reason: 'unverified_schedule_event' };
    }
    sync();
    const d = event.data as JsonObject | null;
    const p = d?.payload as JsonObject | undefined;
    if (!p || p.scheduledWork !== true || d?.owner !== owner) return { status: 'skip', reason: 'not_scheduled_work' };
    let claim: { r: ScheduledWorkRecord; o: ScheduledWorkOccurrence } | undefined;
    try {
      claim = store.transaction(() => {
        const r = typeof p.workId === 'string' ? store.get<ScheduledWorkRecord>(records, p.workId) : undefined;
        if (!r || p.workVersion !== r.version) return undefined;
        const s = current(r);
        if (s.until && now() >= Date.parse(s.until)) return undefined;
        if (s.id !== d.scheduleId || s.version !== d.scheduleVersion || !same(p, s.payload) || d.name !== s.name
          || event.subject?.kind !== 'schedule' || event.subject.id !== s.id || event.staleIf?.ref !== `schedule:${s.id}` || event.staleIf.version !== s.version
          || typeof d.scheduledFor !== 'string' || !Number.isFinite(Date.parse(d.scheduledFor)) || !s.lastFiredFor || Date.parse(d.scheduledFor) > Date.parse(s.lastFiredFor)
          || event.sourceId !== `schedule:${s.id}:v${s.version}:${d.scheduledFor}`) return undefined;
        const key = digest([s.id, s.version, d.scheduledFor]);
        if (store.get(occurrences, key)) return undefined;
        const o: ScheduledWorkOccurrence = { key, workId: r.id, workVersion: r.version, scheduleId: s.id, scheduleVersion: s.version, scheduledFor: d.scheduledFor, handledAt: new Date(now()).toISOString(), status: 'claimed' };
        if (blocked(r)) { store.put(occurrences, key, { ...o, status: 'skipped' }); return undefined; }
        if (r.input.action.kind === 'dispatch') {
          const { kind: _, ...action } = r.input.action;
          const params: JsonObject = { ...action, sourceMessageId: r.sourceMessage.id, conversationId: r.sourceMessage.conversationId,
            ...(r.input.projectId ? { projectId: r.input.projectId } : {}), ...(r.input.todoId ? { todoId: r.input.todoId } : {}), scheduledWorkOccurrence: key };
          const a = proposeApproval({ kind: 'dispatch', title: r.input.title, details: `周期工作到期：${o.scheduledFor}`, params, ...(r.input.todoId ? { todoId: r.input.todoId } : {}) });
          Object.assign(o, { status: 'completed', approvalId: a.id, approvalVersion: a.version, dispatchParams: params });
        }
        store.put(occurrences, key, o);
        return { r, o };
      });
    } catch (error) {
      return error instanceof ApprovalError
        ? { status: 'skip', reason: `stale_scheduled_work: ${error.message}` }
        : { status: 'failed', reason: `scheduled_work_failed: ${String(error)}` };
    }
    if (!claim) return { status: 'skip', reason: 'stale_or_covered_scheduled_work' };
    const { r, o } = claim;
    if (r.input.action.kind === 'dispatch') return { status: 'done', outcome: { approvalId: o.approvalId! } };
    const assertCurrent = () => {
      assertBackgroundExecution();
      // Check closed before reading the store: close may precede database shutdown.
      if (closed) fail('周期工作已关闭');
      const live = store.get<ScheduledWorkRecord>(records, r.id);
      if (!live || !samePlan(live, o)) fail('周期工作版本已失效');
      current(live!, true);
      if (store.get<ScheduledWorkOccurrence>(occurrences, o.key)?.status !== 'claimed') fail('周期工作执行范围已失效');
    };
    try {
      assertCurrent();
      const result = await brief({ scope: structuredClone(scope(r)), sourceMessage: structuredClone(r.sourceMessage), occurrenceKey: o.key, scheduledFor: o.scheduledFor, title: r.input.title, assertCurrent });
      assertCurrent();
      store.put(occurrences, o.key, { ...o, status: 'completed', result });
      return { status: 'done', outcome: result };
    } catch (error) {
      if (!closed) store.put(occurrences, o.key, { ...o, status: 'unknown', error: String(error) });
      return { status: 'failed', reason: 'scheduled_brief_unknown' };
    }
  }
  /** Ordinary dispatch approvals return undefined. Reserved markers without original
   * persisted evidence throw, including edited markers, source, action and scope. */
  function assertDispatchCurrent(value: string | Approval): ScheduledWorkOccurrence | undefined {
    sync();
    const a = typeof value === 'string' ? store.get<Approval>('approvals', value) : value;
    if (!a) return fail('审批不存在');
    const o = store.list<ScheduledWorkOccurrence>(occurrences).find(o => o.approvalId === a.id);
    if (!o && a.params.scheduledWorkOccurrence === undefined) return undefined;
    const actual = store.get<Approval>('approvals', a.id);
    if (!o || !actual || !same(actual, a) || a.kind !== 'dispatch' || !['pending', 'running'].includes(a.status)
      || a.version !== o.approvalVersion || !same(a.params, o.dispatchParams)) return fail('周期派发审批证据已失效');
    const r = store.get<ScheduledWorkRecord>(records, o.workId);
    if (!r || r.version !== o.workVersion || a.todoId !== r.input.todoId) return fail('周期派发范围已失效');
    current(r, true);
    if (!samePlan(r, o)) return fail('周期派发调度已改变');
    return o;
  }
  const off = events.subscribe(e => { if (['projects.changed', 'todos.changed', 'plugins.changed'].includes(e.type)) sync(); });
  sync();
  return { propose, skipNext, setPaused, approveCreation, handle, assertDispatchCurrent, sync,
    list() {
      sync();
      const history = store.list<ScheduledWorkOccurrence>(occurrences);
      return all().map(r => ({ ...r, occurrences: history.filter(o => o.workId === r.id) }));
    },
    cancel(id: string) { if (closed) fail('周期工作已关闭'); store.transaction(() => { const r = store.get<ScheduledWorkRecord>(records, id); if (!r) fail('周期工作不存在'); stop(r!); }); },
    close() {
      if (closed) return;
      closed = true;
      off();
      // Persist uncertainty before the host closes SQLite; late callbacks must not write.
      for (const o of store.list<ScheduledWorkOccurrence>(occurrences).filter(o => o.status === 'claimed'))
        store.put(occurrences, o.key, { ...o, status: 'unknown', error: '周期工作关闭，执行结果待核实' });
    },
  };
}

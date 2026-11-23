import type { ExecutionReviewEvidence } from '../../protocol/src/todo-history.ts';
import { createHash } from 'node:crypto';
import { runScopeEvidence } from './run-scope.ts';
import { reworkPrompt } from './prompts.ts';
import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';
import type { Message, Run, Todo } from '../../protocol/src/index.ts';

export const reworkRestartError = '服务重启，派发结果未知，不自动重试';

export class RunReviewError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = 'RunReviewError';
    this.status = status;
  }
}
export interface RunReview {
  todoId: string;
  version: number;
  /** Number of rework intents, including dispatches with unknown outcomes. */
  round: number;
  runId: string;
  evidenceVersion: string;
  doneWhen: string;
  status: 'pending' | 'accepted' | 'dispatching' | 'unknown' | 'reopened';
  runIds: string[];
  unknownReason?: 'restart' | 'dispatch' | 'receipt';
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export type ReviewEvidenceReader = (run: Run) => ExecutionReviewEvidence | undefined;
export interface RunReviewDecision {
  todoId: string;
  version: number;
  runId: string;
  evidenceVersion: string;
  action: 'accept' | 'rework';
  defects?: string;
}
interface Intent {
  decidedAt?: string;
  request: RunReviewDecision;
  key: string;
  input?: Record<string, unknown>;
  result: RunReview;
}
const reviews = 'run-reviews';
const intents = 'run-review.intents';
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new RunReviewError(`${field}必须为非空文本`);
}
function hash(value: unknown): string {
  // Stable across SQLite serialization and object property ordering.
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return item;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

// Display names and cleanup receipts may change after the delivery was accepted.
function evidenceVersion(run: Run): string {
  if (!run.worktree) return hash(run);
  const { name, removedAt, branchDeletedAt, ...worktree } = run.worktree;
  return hash({ ...run, worktree });
}

/** One service per Store. The host must inject a synchronous completion guard
 * using this Store, and dispatch must recheck source scope without approval bypass.
 * Events are notifications after commit; they do not authorize external actions.
 */
export function createRunReview({ store, events, dispatch, completeTodo, maxReworks = () => 2 }: {
  store: Store;
  events: EventBus;
  dispatch: (input: Record<string, unknown>, key: string) => Run;
  completeTodo: (id: string) => unknown;
  maxReworks?: () => number;
}) {
  function limit() {
    const value = maxReworks();
    if (!Number.isSafeInteger(value) || value < 0 || value > 10) throw new RunReviewError('maxReworks必须为0到10的整数');
    return value;
  }
  limit();
  function run(id: string): Run {
    const value = store.get<Run>('runs', id);
    if (!value) throw new RunReviewError('执行记录不存在', 404);
    return value;
  }
  function get(todoId: string): RunReview & { evidenceInvalidated?: true } {
    text(todoId, 'todoId');
    const value = store.get<RunReview>(reviews, todoId);
    if (!value) throw new RunReviewError('验收记录不存在', 404);
    const current = run(value.runId);
    const scope = value.status === 'pending' && runScopeEvidence(store, current);
    return { ...value, ...(scope && {doneWhen:scope.currentDoneWhen}), evidenceVersion: evidenceVersion(current),
      ...(currentStatus(value) === 'invalidated' && { evidenceInvalidated: true as const }) };
  }
  function binding(todoId: string, value: Run, expectedDoneWhen?: string, allowCompleted = false) {
    const todo = store.get<Todo>('todos', todoId);
    if (!todo) throw new RunReviewError('待办不存在', 404);
    if (todo.completedAt && !allowCompleted) throw new RunReviewError('待办已完成', 409);
    if (value.todoId !== todoId || value.projectId !== todo.projectId) throw new RunReviewError('Run与Todo或项目不匹配', 409);
    text(value.doneWhen, 'doneWhen');
    if (expectedDoneWhen !== undefined && value.doneWhen !== expectedDoneWhen) throw new RunReviewError('验收标准已改变', 409);
    if (value.sourceMessageId !== undefined) {
      const source = store.get<Message>('messages', value.sourceMessageId);
      // A global user request in main may delegate into a project. Explicit
      // project/Todo scope still applies; dispatch owns the final robot guard.
      const projectMatches = source && (source.projectId === value.projectId
        || (source.conversationId === 'main' && source.projectId === undefined));
      if (!source || source.role !== 'user' || source.origin === 'result' || source.origin === 'notification' || source.readOnly
        || !projectMatches || source.conversationId !== value.conversationId
        || (source.todoId !== undefined && source.todoId !== todoId)) throw new RunReviewError('来源消息证据与执行范围不匹配', 409);
    }
  }
  function completionEvidence(value: Run): void {
    const source = value.resultSource;
    // Declarations are supplied by the host, including for legacy native Runs.
    // Observation/demo labels cannot become completion evidence by declaration.
    const realSource = typeof source === 'string' && source.trim() !== ''
      && !['demo', 'screen', 'runner', 'terminal-idle', 'idle', 'unknown'].includes(source.trim().toLowerCase())
      && (source === 'real' || value.nativeResultSources?.includes(source));
    if (value.status !== 'completed' || !realSource || !value.output?.trim()) {
      throw new RunReviewError('需要真实completed及有效来源和完成证据', 409);
    }
    if (!value.nativeResume) return;
    if (!value.nativeSessionId || value.nativeSessionId !== value.nativeResume.nativeSessionId) {
      throw new RunReviewError('原生会话编号缺失或与恢复请求不符。', 409);
    }
    const executor = value.nativeResume.executorId;
    const remoteMatch = value.machineId && value.executorId === `${value.machineId}/${executor}`;
    if (!executor || (value.executorId !== executor && !remoteMatch)) {
      throw new RunReviewError('执行者与恢复请求或绑定电脑不符。', 409);
    }
  }
  function assertCanComplete(todoId: string): void {
    text(todoId, 'todoId');
    const item = store.get<RunReview>(reviews, todoId);
    if (!item) return;
    const value = run(item.runId);
    if (item.status !== 'accepted' || !item.runIds.includes(item.runId) || item.evidenceVersion !== evidenceVersion(value)) {
      throw new RunReviewError('需要当前Run证据的有效验收', 409);
    }
    // The host may invoke the guard before or after writing completedAt in its
    // transaction. Completion does not invalidate otherwise matching ownership.
    binding(todoId, value, item.doneWhen, true);
    completionEvidence(value);
  }
  function currentStatus(item: RunReview): ExecutionReviewEvidence['status'] {
    if (item.status !== 'accepted') return item.status;
    try { assertCanComplete(item.todoId); }
    catch (error) {
      if (!(error instanceof RunReviewError)) throw error;
      return 'invalidated';
    }
    return 'accepted';
  }
  function changed(todoId: string) { events.publish('run-review.changed', { todoId }); }
  // Recovery changes only the ledger. It never invokes dispatch, even if a key
  // could resolve to an already-created Run; the host can investigate that key.
  store.transaction(() => {
    for (const item of store.list<RunReview>(reviews)) {
      if (item.status !== 'dispatching') continue;
      const next: RunReview = { ...item, status: 'unknown', unknownReason: 'restart', error: reworkRestartError, updatedAt: new Date().toISOString() };
      store.put(reviews, item.todoId, next);
      for (const intent of store.list<Intent>(intents)) {
        if (intent.result.todoId === item.todoId && intent.result.status === 'dispatching') store.put(intents, intent.key, { ...intent, decidedAt: intent.decidedAt ?? intent.result.updatedAt, result: next });
      }
    }
  });

  return {
    get,
    assertCanComplete,
    /** Evidence for one visible execution. A later round cannot accept an older Run. */
    evidenceForRun(value: Run) {
      if (!value.todoId) return undefined;
      const todo = store.get<Todo>('todos', value.todoId);
      const item = store.get<RunReview>(reviews, value.todoId);
      if (!item || item.runId !== value.id || !todo || todo.projectId !== value.projectId) return undefined;
      return { status: currentStatus(item), version: item.version, updatedAt: item.updatedAt };
    },
    /** Call only for completed -> reopened, inside the host's Todo transaction.
     * No event is published here: the outer transaction has not committed yet.
     */
    onReopen(todoId: string): void {
      text(todoId, 'todoId');
      store.transaction(() => {
        const item = store.get<RunReview>(reviews, todoId);
        if (!item) return;
        if (item.status !== 'accepted') throw new RunReviewError('仅已验收的完成待办可重开', 409);
        store.put(reviews, todoId, { ...item, status: 'reopened', version: item.version + 1, updatedAt: new Date().toISOString() });
      });
    },
    list(): RunReview[] { return store.list<RunReview>(reviews).map(item => get(item.todoId)); },
    attach(input: { todoId: string; runId: string; version?: number }): RunReview {
      if (!input || typeof input !== 'object') throw new RunReviewError('关联输入必须为对象');
      text(input.todoId, 'todoId'); text(input.runId, 'runId');
      const next = store.transaction(() => {
        const previous = store.get<RunReview>(reviews, input.todoId);
        const version = input.version ?? (previous ? -1 : 0);
        if (!Number.isSafeInteger(version) || version < 0) throw new RunReviewError('已有验收需提供精确version');
        if (version !== (previous?.version ?? 0)) throw new RunReviewError('验收版本已更新', 409);
        const value = run(input.runId);
        if (previous?.status === 'reopened' && previous.runIds.includes(input.runId)) throw new RunReviewError('重开后必须关联从未验收过的新Run', 409);
        if (previous?.runId === input.runId) return get(input.todoId);
        binding(input.todoId, value, previous?.status === 'pending' ? get(input.todoId).doneWhen : previous?.doneWhen);
        if (previous && (!['pending', 'reopened'].includes(previous.status) || previous.runIds.includes(input.runId))) throw new RunReviewError('不能覆盖已提交或历史轮次', 409);
        const now = new Date().toISOString();
        const item: RunReview = { todoId: input.todoId, version: version + 1, round: previous?.status === 'reopened' ? 0 : previous?.round ?? 0,
          runId: value.id, evidenceVersion: evidenceVersion(value), doneWhen: value.doneWhen!, status: 'pending',
          runIds: [...(previous?.runIds ?? []), value.id], createdAt: previous?.createdAt ?? now, updatedAt: now };
        store.put(reviews, item.todoId, item);
        return item;
      });
      changed(input.todoId);
      return next;
    },
    decide(input: RunReviewDecision): RunReview {
      if (!input || typeof input !== 'object') throw new RunReviewError('验收决定必须为对象');
      text(input.todoId, 'todoId'); text(input.runId, 'runId'); text(input.evidenceVersion, 'evidenceVersion');
      if (!Number.isSafeInteger(input.version) || input.version < 1) throw new RunReviewError('version必须为正整数');
      if (!['accept', 'rework'].includes(input.action)) throw new RunReviewError('action必须为accept或rework');
      if (input.action === 'rework') {
        text(input.defects, 'defects');
        if (input.defects.trim().length < 4 || ['不满意', '重新做', '请重新做', '需要返工'].includes(input.defects.trim())) {
          throw new RunReviewError('defects需说明具体缺陷');
        }
      }
      // Copy supported fields only; explicit action is never inferred from prose.
      const request: RunReviewDecision = { todoId: input.todoId, version: input.version, runId: input.runId,
        evidenceVersion: input.evidenceVersion, action: input.action, ...(input.action === 'rework' ? { defects: input.defects!.trim() } : {}) };
      const key = `run-review:${hash(request)}`;
      const claim = store.transaction(() => {
        const previousReceipt = store.get<Intent>(intents, key);
        if (previousReceipt) return { receipt: previousReceipt, replay: true, notify: false };
        const item = get(input.todoId);
        if (item.version !== input.version || item.runId !== input.runId || item.evidenceVersion !== input.evidenceVersion || item.status !== 'pending') {
          throw new RunReviewError('验收版本、轮次或证据已更新，请刷新', 409);
        }
        const value = run(item.runId);
        binding(item.todoId, value, item.doneWhen);
        const now = new Date().toISOString();
        if (input.action === 'accept') {
          completionEvidence(value);
          const result: RunReview = { ...item, version: item.version + 1, status: 'accepted', updatedAt: now };
          store.put(reviews, item.todoId, result);
          const receipt: Intent = { request, decidedAt: now, key, result };
          store.put(intents, key, receipt);
          const completed = completeTodo(item.todoId);
          if (completed != null && typeof (completed as { then?: unknown }).then === 'function') {
            void Promise.resolve(completed).catch(() => {});
            throw new RunReviewError('completeTodo必须同步完成');
          }
          return { receipt, replay: true, notify: true };
        }
        if (!['completed', 'failed'].includes(value.status)) throw new RunReviewError('仅completed或failed可返工，unknown不自动重试', 409);
        const maxRounds = limit();
        if (item.round >= maxRounds) throw new RunReviewError('已达到返工上限', 409);
        if (typeof value.expectMinutes !== 'number' || !Number.isFinite(value.expectMinutes) || value.expectMinutes <= 0 || value.expectMinutes > 10080) throw new RunReviewError('返工需要有效预计耗时', 409);
        const result: RunReview = { ...item, version: item.version + 1, round: item.round + 1, status: 'dispatching', updatedAt: now };
        // Preserve provenance for the host's final scope guard, never an approved
        // flag or nativeResume. A rework always starts a new piece of work.
        const scope = runScopeEvidence(store, value);
        const priorScopeChanged = !scope && item.runIds.slice(-(item.round + 1), -1).some(id => {
          const prior = store.get<Run>('runs', id);
          return prior?.todoId === item.todoId && prior.projectId === value.projectId && !!runScopeEvidence(store, prior);
        });
        const params: Record<string, unknown> = { prompt: reworkPrompt(value, request.defects!, result.round, maxRounds, scope, priorScopeChanged),
          executorId: value.executorId, conversationId: value.conversationId, todoId: item.todoId,
          doneWhen: item.doneWhen, expectMinutes: value.expectMinutes,
          ...(value.projectId !== undefined ? { projectId: value.projectId } : {}),
          ...(value.cwd !== undefined ? { cwd: value.cwd } : {}),
          ...(value.sourceMessageId !== undefined ? { sourceMessageId: value.sourceMessageId } : {}),
          executionMode: value.executionMode ?? 'task' };
        const receipt: Intent = { request, decidedAt: now, key, input: params, result };
        store.put(reviews, item.todoId, result);
        store.put(intents, key, receipt);
        return { receipt, replay: false, notify: false };
      });
      if (claim.replay) {
        if (claim.notify) changed(input.todoId);
        return structuredClone(claim.receipt.result);
      }
      // Intent committed before calling arbitrary observers or dispatch code.
      let result = claim.receipt.result;
      let unknownReason: 'dispatch' | 'receipt' = 'dispatch';
      try {
        const dispatched = dispatch(structuredClone(claim.receipt.input!), key);
        unknownReason = 'receipt';
        if (!dispatched || typeof dispatched.id !== 'string' || !dispatched.id.trim() || result.runIds.includes(dispatched.id)) throw new Error('派发未返回新的有效Run');
        const actual = run(dispatched.id);
        binding(result.todoId, actual, result.doneWhen);
        const params = claim.receipt.input!;
        for (const field of ['prompt', 'executorId', 'projectId', 'cwd', 'conversationId', 'sourceMessageId', 'executionMode', 'expectMinutes'] as const) {
          if (actual[field] !== params[field]) throw new Error(`派发回执${field}不匹配`);
        }
        if (actual.nativeResume) throw new Error('返工不能使用nativeResume');
        result = { ...result, runId: actual.id, runIds: [...result.runIds, actual.id], evidenceVersion: evidenceVersion(actual), status: 'pending', updatedAt: new Date().toISOString() };
      } catch (error) {
        result = { ...result, status: 'unknown', unknownReason, error: `派发结果未知，不自动重试：${error instanceof Error ? error.message : String(error)}`, updatedAt: new Date().toISOString() };
      }
      store.transaction(() => {
        store.put(reviews, result.todoId, result);
        store.put(intents, key, { ...claim.receipt, result });
      });
      changed(result.todoId);
      return structuredClone(result);
    },
  };
}

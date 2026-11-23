import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Project, Run, Todo } from '../../protocol/src/index.ts';

export type RunScopeSource = {kind: 'web' | 'assistant'; messageId?: string};
export interface RunScopeChange {
  expectedVersion: number;
  expectedDoneWhen: string;
  doneWhen: string;
  reason: string;
  expectMinutes?: number;
}
export interface RunScopeEvent {
  version: number;
  before: string;
  after: string;
  previousExpectMinutes?: number;
  expectMinutes?: number;
  reason: string;
  source: RunScopeSource;
  createdAt: string;
}
const collection = 'run.scope-history';

function originalCriteria(run: Run, first: RunScopeEvent | undefined) {
  return first
    ? {doneWhen: first.before || undefined, expectMinutes: first.previousExpectMinutes}
    : {doneWhen: run.doneWhen, expectMinutes: run.expectMinutes};
}

/** Dispatch retries compare the original request even after a task moves or the execution finishes. */
export function initialRunCriteria(store: Store, run: Run) {
  const history = store.get<RunScopeEvent[]>(collection, run.id);
  return originalCriteria(run, history?.[0]);
}

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), {status});
}

export function createRunScopes(store: Store) {
  function facts(runId: string) {
    const run = store.get<Run>('runs', runId);
    if (!run || run.id !== runId || !run.todoId) fail('找不到关联待办的执行记录。', 404);
    const todo = store.get<Todo>('todos', run.todoId);
    if (!todo || todo.id !== run.todoId || todo.projectId !== run.projectId) fail('执行与待办不属于同一范围。', 404);
    return {run, todo};
  }

  function lines(text: string) {
    return new Set(text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean));
  }
  function snapshot(run: Run, todo: Todo, history: RunScopeEvent[]) {
    const initial = originalCriteria(run, history[0]);
    return {
      runId: run.id, todoId: todo.id, status: run.status, projectId: run.projectId, version: history.length,
      initialDoneWhen: initial.doneWhen ?? '',
      initialExpectMinutes: initial.expectMinutes,
      doneWhen: run.doneWhen ?? '', expectMinutes: run.expectMinutes,
      history: history.map(event => {
        const before = lines(event.before), after = lines(event.after);
        return {...event, added:[...after].filter(line => !before.has(line)), dropped:[...before].filter(line => !after.has(line))};
      }),
    };
  }
  function read(runId: string) {
    return store.transaction(() => {
      const {run, todo} = facts(runId);
      return snapshot(run, todo, store.get<RunScopeEvent[]>(collection, run.id) ?? []);
    });
  }
  function revise(runId: string, input: RunScopeChange, source: RunScopeSource) {
    if (!input || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
        typeof input.expectedDoneWhen !== 'string' || typeof input.doneWhen !== 'string' || !input.doneWhen.trim() ||
        typeof input.reason !== 'string' || !input.reason.trim()) fail('请提供读取时的版本和标准、新标准与变更原因。', 400);
    if (input.expectMinutes !== undefined && (!Number.isFinite(input.expectMinutes) || input.expectMinutes <= 0 || input.expectMinutes > 10080)) {
      fail('预计时长必须为一周内的正数分钟。', 400);
    }
    if (!source || !['web','assistant'].includes(source.kind) ||
        (source.messageId !== undefined && (typeof source.messageId !== 'string' || !source.messageId.trim()))) fail('变更来源无效。', 400);
    const after = input.doneWhen.trim(), reason = input.reason.trim();
    return store.transaction(() => {
      const {run, todo} = facts(runId);
      const project = run.projectId && store.get<Project>('projects', run.projectId);
      if (run.projectId && (!project || project.id !== run.projectId || project.archivedAt)) fail('项目不存在或已归档。', 409);
      if (run.status !== 'running' || todo.completedAt) fail('只能调整未完成待办中正在运行的执行。', 409);
      const history = store.get<RunScopeEvent[]>(collection, run.id) ?? [];
      const last = history.at(-1);
      const before = run.doneWhen ?? '';
      const expectMinutes = input.expectMinutes ?? run.expectMinutes;
      // Accept a lost-response retry only while its exact result is still the current revision.
      if (last && input.expectedVersion === last.version - 1 && input.expectedDoneWhen === last.before &&
          after === last.after && reason === last.reason && last.source.kind === source.kind && last.source.messageId === source.messageId &&
          (input.expectMinutes ?? last.previousExpectMinutes) === last.expectMinutes && before === last.after && run.expectMinutes === last.expectMinutes) {
        return snapshot(run, todo, history);
      }
      if (input.expectedVersion !== history.length || input.expectedDoneWhen !== before) fail('执行标准已更新，请刷新再修改。', 409);
      if (after === before && expectMinutes === run.expectMinutes) fail('验收标准及预计时长均未改变。', 400);
      if (history.length >= 40) fail('本次执行已调整 40 次，请另行派工。', 409);
      const createdAt = new Date().toISOString();
      history.push({
        version: history.length + 1, before, after, previousExpectMinutes: run.expectMinutes, expectMinutes, reason,
        source: {kind: source.kind, ...(source.messageId && {messageId: source.messageId})}, createdAt,
      });
      const next = {...run, doneWhen: after, expectMinutes, updatedAt: createdAt};
      store.put('runs', run.id, next);
      store.put(collection, run.id, history);
      return snapshot(next, todo, history);
    });
  }
  return {read, revise};
}

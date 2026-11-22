import type { RunReview, RunReviewDecision } from './run-review.ts';
import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Run, Todo } from '../../protocol/src/index.ts';
import type { TodoHistory } from '../../protocol/src/todo-history.ts';

/** Derive history from existing facts; do not copy task state into a second ledger. */
export function readTodoHistory(store: Pick<Store, 'get' | 'list'>, id: string, before?: string): TodoHistory {
  const todo = store.get<Todo>('todos', id);
  if (!todo) throw Object.assign(new Error('待办不存在'), { status: 404 });
  // A moved todo cannot bring the previous project's execution evidence into its new scope.
  const runs = store.list<Run>('runs').filter(run => run.todoId === id && run.projectId === todo.projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const end = before === undefined ? runs.length : runs.findIndex(run => run.id === before);
  if (end < 0) throw Object.assign(new Error('历史位置已失效，请重新读取'), { status: 400 });
  const start = Math.max(0, end - 20);
  const scopedIds = new Set(runs.map(run => run.id));
  const decisions = store.list<{ request: RunReviewDecision; result: RunReview }>('run-review.intents');
  return {
    todo: { id, title: todo.title, projectId: todo.projectId, completedAt: todo.completedAt }, total: runs.length,
    rounds: runs.slice(start, end).map((run, index) => ({
      number: start + index + 1,
      run: { id: run.id, executorId: run.executorId, prompt: run.prompt, status: run.status, createdAt: run.createdAt,
        updatedAt: run.updatedAt, doneWhen: run.doneWhen, resultSource: run.resultSource,
        output: run.output.slice(0, 4000), error: run.error?.slice(0, 2000) },
      outputTruncated: run.output.length > 4000,
      decisions: decisions.filter(item => item.request.todoId === id && item.request.runId === run.id)
        .map(({ request, result }) => {
          const decision = { action: request.action, defects: request.defects, at: result.updatedAt };
          if (request.action !== 'rework') return decision;
          if (result.status === 'dispatching' || result.status === 'unknown') return { ...decision, dispatchStatus: result.status };
          // Only a committed receipt identifies the successor, even when later rounds exist.
          if (result.status === 'pending' && result.todoId === id && result.runId !== run.id && scopedIds.has(result.runId)) {
            return { ...decision, reworkRunId: result.runId };
          }
          return decision;
        }),
    })).reverse(),
    ...(start > 0 ? { nextBefore: runs[start]!.id } : {}),
  };
}

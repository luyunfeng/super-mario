import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Run, Todo } from '../../protocol/src/index.ts';

/** Resolve against one snapshot. A reused session or multiple active owners makes the assignment ambiguous. */
export function responsibleSessionTodos(store: Pick<Store, 'list'>) {
  const owners = new Map<string, Todo | null>();
  const key = (...parts: string[]) => JSON.stringify(parts);
  for (const todo of store.list<Todo>('todos')) {
    if (!todo.completedAt && todo.responsibleSession) {
      const id = key(todo.responsibleSession.machineId, todo.responsibleSession.sessionId);
      owners.set(id, owners.has(id) ? null : todo);
    }
  }
  // A tie between different runs is ambiguous, even when their recorded timestamps are identical.
  const latest = new Map<string, { createdAt: string; runId?: string }>();
  function index(id: string, run: Run) {
    const previous = latest.get(id);
    if (!previous || previous.createdAt < run.createdAt) latest.set(id, {createdAt: run.createdAt, runId: run.id});
    else if (previous.createdAt === run.createdAt && previous.runId !== run.id) previous.runId = undefined;
  }
  for (const run of store.list<Run>('runs')) {
    if (!run.machineId) continue;
    if (run.sessionId) index(key(run.machineId, run.sessionId), run);
    const native = run.nativeSessionId ?? run.nativeResume?.nativeSessionId;
    if (native) index(key(run.machineId, run.executorId, native), run);
  }
  return (run: Run) => {
    if (!run.id || !run.machineId || !run.sessionId) return;
    const session = key(run.machineId, run.sessionId);
    const owner = owners.get(session);
    if (!owner || owner.projectId !== run.projectId || owner.responsibleSession?.runId !== run.id ||
      (run.todoId !== undefined && run.todoId !== owner.id) || latest.get(session)?.runId !== run.id) return;
    if (run.nativeSessionId && latest.get(key(run.machineId, run.executorId, run.nativeSessionId))?.runId !== run.id) return;
    return owner;
  };
}

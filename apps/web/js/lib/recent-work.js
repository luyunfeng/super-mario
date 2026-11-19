// Reading a result must not remove it from history. Seen state is deliberately irrelevant.
export const RECENT_WORK_MS = 24 * 60 * 60 * 1000;
export function recentWork(snapshot, projectId = '', now = Date.now()) {
  const recent = value => Number.isFinite(Date.parse(value)) && Date.parse(value) > now - RECENT_WORK_MS && Date.parse(value) <= now;
  const inScope = item => !projectId || item.projectId === projectId;
  const newest = (a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id);
  return [
    ...(snapshot?.todos ?? []).filter(todo => inScope(todo) && recent(todo.completedAt))
      .map(todo => ({ id: 'todo:' + todo.id, kind: 'todo', at: todo.completedAt, value: todo })),
    ...(snapshot?.runs ?? []).filter(run => inScope(run) && run.status === 'completed' && recent(run.updatedAt))
      .map(run => ({ id: 'run:' + run.id, kind: 'run', at: run.updatedAt, value: run })),
  ].sort(newest);
}

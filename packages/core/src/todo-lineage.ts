import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Todo } from '../../protocol/src/index.ts';

type LineageStep = Pick<Todo, 'id'|'title'|'continuesTodoId'|'continuationReason'|'createdAt'|'completedAt'|'responsibleSession'> &
  { current: boolean };

/** Display all genuine continuation branches. Task hierarchy, dependency links and run history do not establish a handoff. */
export function todoLineage(store: Pick<Store,'get'|'list'|'entries'>, todoId: string): LineageStep[] {
  const current = store.get<Todo>('todos', todoId);
  if (!current || current.id !== todoId) return [];
  const rootId = current.continuationRootId ?? current.id;
  const root = store.get<Todo>('todos', rootId);
  if (!root || root.id !== rootId || root.projectId !== current.projectId || root.continuesTodoId !== undefined ||
    (root.continuationRootId !== undefined && root.continuationRootId !== rootId)) return [];

  const projectId = current.projectId;
  const byParent = new Map<string, Todo[]>();
  function index(id: string, todo?: Todo) {
    if (!todo || todo.id !== id || todo.projectId !== projectId || todo.continuationRootId !== rootId || !todo.continuesTodoId) return;
    const children = byParent.get(todo.continuesTodoId) ?? [];
    children.push(todo);
    byParent.set(todo.continuesTodoId, children);
  }
  if (store.entries) {
    for (const {id,value} of store.entries<Todo>('todos')) index(id,value);
  } else {
    // Older stores list document values only. Read each candidate by key before accepting its claimed identity.
    for (const row of store.list<Todo>('todos')) {
      if (row?.continuationRootId === rootId) index(row.id,store.get<Todo>('todos',row.id));
    }
  }
  // Map iteration also visits newly added children, without recursing on a long chain.
  const members = new Map([[rootId, root]]);
  for (const parent of members.keys()) {
    for (const child of byParent.get(parent) ?? []) {
      if (!members.has(child.id)) members.set(child.id,child);
    }
  }
  if (members.size < 2 || !members.has(todoId)) return [];
  // Creation is the time the immutable continuation link was established. Older ISO offsets may differ.
  const time = (todo: Todo) => Date.parse(todo.createdAt) || 0;
  return [...members.values()].sort((a,b) => time(a)-time(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(todo => ({
    id:todo.id, title:todo.title, current:todo.id === todoId, createdAt:todo.createdAt,
    ...(todo.continuesTodoId && {continuesTodoId:todo.continuesTodoId}),
    ...(todo.continuationReason && {continuationReason:todo.continuationReason}),
    ...(todo.completedAt && {completedAt:todo.completedAt}),
    ...(todo.responsibleSession && {responsibleSession:{runId:todo.responsibleSession.runId,
      machineId:todo.responsibleSession.machineId, sessionId:todo.responsibleSession.sessionId}}),
  }));
}

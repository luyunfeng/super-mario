import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Run, Todo } from '../../protocol/src/index.ts';

export type TodoOriginSource = {id:string; conversationId:string; text?:string};
type OriginKind = 'feishu' | 'web' | 'assistant' | 'system' | 'continuation';
type Origin = {
  todoId: string; title: string; notes?: string; kind: OriginKind | 'reconstructed'; createdAt: string;
  sourceMessageId?: string; requestText?: string; continuationReason?: string;
};
type StoredOrigin = { projectId?: string; conversationId?: string; origin: Origin };
type Criterion = {todoId: string; runId: string; createdAt: string; doneWhen: string; expectMinutes?: number; executorId: string};
const origins = 'todo.brief-origins';

function snapshot(todo: Todo, kind: Origin['kind']): Origin {
  return {todoId:todo.id, title:todo.title, kind, createdAt:todo.createdAt,
    ...(todo.notes && {notes:todo.notes}), ...(todo.continuationReason && {continuationReason:todo.continuationReason})};
}

/** Call inside creation's transaction. A retry or later edit must not replace what was known at creation. */
export function recordTodoOrigin(store: Store, todo: Todo, kind: OriginKind, source?: TodoOriginSource): void {
  store.transaction(() => {
    if (store.get(origins,todo.id)) return;
    const origin = snapshot(todo,kind);
    // The live group task can carry third-party context. Keep it out of the frozen owner brief.
    if (kind === 'feishu') delete origin.notes;
    if (source?.id && source.conversationId) {
      origin.sourceMessageId = source.id;
      // Only the host can supply a verified, same-scope owner's quote. Never fetch private content from the reference.
      if (source.text) origin.requestText = Array.from(source.text).slice(0,2000).join('');
    }
    store.put(origins,todo.id,{projectId:todo.projectId, conversationId:source?.conversationId, origin} satisfies StoredOrigin);
  });
}

function ancestors(store: Store, current: Todo): Todo[] {
  const rootId = current.continuationRootId;
  if (!current.continuesTodoId || !rootId || current.id === rootId) return [current];
  const path = [current], seen = new Set([current.id]);
  let child = current;
  while (child.continuesTodoId) {
    const parent = store.get<Todo>('todos',child.continuesTodoId);
    if (!parent || parent.id !== child.continuesTodoId || parent.projectId !== current.projectId ||
      (parent.continuationRootId ?? parent.id) !== rootId || seen.has(parent.id)) break;
    path.push(parent);
    if (parent.id === rootId) {
      if (parent.continuesTodoId === undefined) return path;
      break;
    }
    seen.add(parent.id);
    child = parent;
  }
  // A partial path does not prove a common source. Keep the selected task's own records.
  return [current];
}

export function todoBrief(store: Store, todoId: string, includeAncestors = true, viewerConversationId?: string):
  {origin: Origin; criteria: Criterion[]; reconstructed: boolean} {
  const current = store.get<Todo>('todos',todoId);
  if (!current || current.id !== todoId) throw Object.assign(new Error('待办不存在。'),{status:404});
  const path = includeAncestors ? ancestors(store,current) : [current];
  const root = path[path.length-1]!;
  const saved = store.get<StoredOrigin>(origins,root.id);
  const original = saved?.projectId === root.projectId && saved?.origin?.todoId === root.id &&
    saved.origin.createdAt === root.createdAt ? saved.origin : undefined;
  const ids = new Set(path.map(todo => todo.id));
  const projectId = current.projectId;
  const criteria: Criterion[] = [];
  function collect(id: string, run?: Run) {
    if (!run || run.id !== id || !run.todoId || !ids.has(run.todoId) || run.projectId !== projectId ||
      typeof run.doneWhen !== 'string' || !run.doneWhen.trim()) return;
    criteria.push({todoId:run.todoId, runId:id, createdAt:run.createdAt, doneWhen:run.doneWhen, executorId:run.executorId,
      ...(typeof run.expectMinutes === 'number' && Number.isFinite(run.expectMinutes) && run.expectMinutes > 0 && {expectMinutes:run.expectMinutes})});
  }
  if (store.entries) {
    for (const {id,value} of store.entries<Run>('runs')) collect(id,value);
  } else {
    const candidates = new Set(store.list<Run>('runs').filter(run => run?.todoId && ids.has(run.todoId)).map(run => run.id));
    for (const id of candidates) collect(id,store.get<Run>('runs',id));
  }
  criteria.sort((a,b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || a.runId.localeCompare(b.runId));
  const origin = original ? {...original} : snapshot(root,'reconstructed');
  // A bot may know why its task was created without access to another conversation's reference or quote.
  if (viewerConversationId !== undefined && viewerConversationId !== saved?.conversationId) {
    delete origin.sourceMessageId;
    delete origin.requestText;
  }
  return {origin, criteria, reconstructed:!original};
}

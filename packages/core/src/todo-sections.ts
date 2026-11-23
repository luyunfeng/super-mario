import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Approval, Run, SupervisionSignal, Todo } from '../../protocol/src/index.ts';

export type TodoSection = '需要你' | '逾期' | '今天' | '等待中' | '之后' | '某天' | '刚完成' | '已完成';

type TodoSectionRow = Todo & { childProgress?: { completed: number; total: number } };

/** Server-owned projection. A failed run is not evidence that its todo needs a decision. */
export function todoSections(todos: Todo[], now = new Date(), needsYouIds: readonly string[] = []): Record<TodoSection, TodoSectionRow[]> {
  if (!Number.isFinite(now.getTime())) throw new TypeError('分组时间无效');
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const today = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const needsYou = new Set(needsYouIds);
  const sections: Record<TodoSection, TodoSectionRow[]> = { '需要你': [], '逾期': [], '今天': [], '等待中': [], '之后': [], '某天': [], '刚完成': [], '已完成': [] };
  // Count the full set before the client narrows a section by date or search.
  const byId = new Map(todos.map(todo => [todo.id, todo]));
  const counts = new Map<string, { completed: number; total: number }>();
  for (const child of todos) {
    if (!child.parentTodoId) continue;
    const parent = byId.get(child.parentTodoId);
    if (!parent || parent.projectId !== child.projectId || parent.id === child.id) continue;
    const progress = counts.get(parent.id) ?? { completed: 0, total: 0 };
    progress.total++;
    if (child.completedAt) progress.completed++;
    counts.set(parent.id, progress);
  }
  for (const todo of todos) {
    const due = todo.dueAt ? Date.parse(todo.dueAt) : NaN;
    let section: TodoSection;
    if (todo.completedAt) section = Date.parse(todo.completedAt) >= start.getTime() ? '刚完成' : '已完成';
    else if (needsYou.has(todo.id)) section = '需要你';
    else if (todo.dueDay ? todo.dueDay < today : due < start.getTime()) section = '逾期';
    else if (todo.waitingOn?.trim()) section = '等待中';
    else if (todo.dueDay ? todo.dueDay === today : due < end.getTime()) section = '今天';
    else if (Number.isFinite(due)) section = '之后';
    else section = '某天';
    const childProgress = counts.get(todo.id);
    sections[section].push(childProgress ? { ...todo, childProgress } : todo);
  }
  return sections;
}

/** Only explicit open decisions count; a failed execution alone never invents a request. */
export function todoDecisionIds(store: Pick<Store, 'list'>): string[] {
  const ids = new Set<string>();
  for (const approval of store.list<Approval>('approvals')) if (approval.status === 'pending') {
    const id = approval.todoId ?? approval.params.todoId; if (typeof id === 'string') ids.add(id);
  }
  const runs = new Map(store.list<Run>('runs').map(run => [run.id, run]));
  for (const question of store.list<{status:string;handler:string;runId?:string}>('interactions')) if (question.status === 'open' && question.handler === 'user') {
    const id = question.runId && runs.get(question.runId)?.todoId; if (id) ids.add(id);
  }
  for (const signal of store.list<SupervisionSignal>('supervision.signals')) if (signal.kind === 'needs_you' && !signal.resolvedAt && signal.todoId) ids.add(signal.todoId);
  return [...ids];
}

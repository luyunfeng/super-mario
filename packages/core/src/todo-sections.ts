import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Approval, Run, SupervisionSignal, Todo } from '../../protocol/src/index.ts';

export type TodoSection = '需要你' | '逾期' | '今天' | '等待中' | '之后' | '某天' | '刚完成' | '已完成';

/** Server-owned projection. A failed run is not evidence that its todo needs a decision. */
export function todoSections(todos: Todo[], now = new Date(), needsYouIds: readonly string[] = []): Record<TodoSection, Todo[]> {
  if (!Number.isFinite(now.getTime())) throw new TypeError('分组时间无效');
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const needsYou = new Set(needsYouIds);
  const sections: Record<TodoSection, Todo[]> = { '需要你': [], '逾期': [], '今天': [], '等待中': [], '之后': [], '某天': [], '刚完成': [], '已完成': [] };
  for (const todo of todos) {
    const due = todo.dueAt ? Date.parse(todo.dueAt) : NaN;
    let section: TodoSection;
    if (todo.completedAt) section = Date.parse(todo.completedAt) >= start.getTime() ? '刚完成' : '已完成';
    else if (needsYou.has(todo.id)) section = '需要你';
    else if (Number.isFinite(due) && due < start.getTime()) section = '逾期';
    else if (todo.waitingOn?.trim()) section = '等待中';
    else if (Number.isFinite(due) && due < end.getTime()) section = '今天';
    else if (Number.isFinite(due)) section = '之后';
    else section = '某天';
    sections[section].push(todo);
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

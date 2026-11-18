import type { BotScope, Project, Todo } from '../../protocol/src/index.ts';
import type { Store } from '../../plugin-sdk/src/index.ts';

export function scopeError(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
/** Resolve task ownership from stored facts; never trust a caller's project label. */
export function validateBotScope(store: Store, input: unknown, options: { allowArchived?: boolean } = {}): BotScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) scopeError('请选择消息范围');
  const scope = input as Record<string, unknown>;
  const fields = scope.kind === 'project' ? ['kind', 'projectId'] : scope.kind === 'task' ? ['kind', 'projectId', 'todoId'] : ['kind'];
  if (Object.keys(scope).some(key => !fields.includes(key))) scopeError('范围包含未知字段');
  if (scope.kind === 'global' || scope.kind === 'unmarked') return { kind: scope.kind };
  if (scope.kind === 'project') {
    if (typeof scope.projectId !== 'string' || !scope.projectId.trim()) scopeError('请选择项目');
    const project = store.get<Project>('projects', scope.projectId);
    if (!project || project.archivedAt && !options.allowArchived) scopeError('项目不存在或已归档', 409);
    return { kind: 'project', projectId: project.id };
  }
  if (scope.kind === 'task') {
    if (typeof scope.todoId !== 'string' || !scope.todoId.trim()) scopeError('请选择事项');
    const todo = store.get<Todo>('todos', scope.todoId);
    if (!todo) scopeError('事项不存在', 404);
    if (scope.projectId !== undefined && scope.projectId !== todo.projectId) scopeError('事项不属于所选项目');
    if (todo.projectId) validateBotScope(store, { kind: 'project', projectId: todo.projectId }, options);
    return { kind: 'task', todoId: todo.id, ...(todo.projectId ? { projectId: todo.projectId } : {}) };
  }
  return scopeError('消息范围无效');
}

export function sameBotScope(a: BotScope, b: BotScope): boolean {
  return a.kind === b.kind && ('projectId' in a ? a.projectId : undefined) === ('projectId' in b ? b.projectId : undefined)
    && ('todoId' in a ? a.todoId : undefined) === ('todoId' in b ? b.todoId : undefined);
}

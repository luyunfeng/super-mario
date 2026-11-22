import type { Extension, ExtensionContext, Json, Store } from '../packages/plugin-sdk/src/index.ts';
import type { Project } from '../packages/protocol/src/index.ts';

type Instructions = { projectId: string; notes: string; revision: number; updatedAt: string | null };

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function readProject(store: Store, projectId: string) {
  const project = store.get<Project>('projects', projectId);
  if (!project || project.id !== projectId) fail(404, '项目不存在');
  return project;
}

function readNotes(store: Store, projectId: string): Instructions {
  return store.get<Instructions>('project-instructions', projectId) ?? { projectId, notes: '', revision: 0, updatedAt: null };
}

function manage({ store, events }: ExtensionContext, input: Json): Json {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '项目说明参数必须为对象');
  const { projectId, action } = input;
  if (typeof projectId !== 'string' || !projectId.trim()) fail(400, '项目 ID 无效');
  if (action !== 'read' && action !== 'save') fail(400, '项目说明操作无效');
  const fields = action === 'read' ? ['action', 'projectId'] : ['action', 'projectId', 'revision', 'notes'];
  if (Object.keys(input).some(key => !fields.includes(key))) fail(400, '项目说明操作包含未知字段');
  if (action === 'read') {
    readProject(store, projectId);
    return readNotes(store, projectId);
  }
  const { revision, notes } = input;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
    fail(400, '项目说明版本无效');
  if (typeof notes !== 'string') fail(400, '项目说明须为文本');
  const value = notes.replace(/\r\n?/g, '\n');
  if (value.length > 8000 || Array.from(value).length > 4000) fail(400, '项目说明不能超过 4000 个字符');
  if (/(?![\n\t])[\p{Cc}\p{Cs}]/u.test(value)) fail(400, '项目说明含无效控制字符');
  const content = value.trim() ? value : '';
  return store.transaction(() => {
    if (readProject(store, projectId).archivedAt) fail(409, '已归档项目的说明只读');
    const current = readNotes(store, projectId);
    if (current.revision !== revision) fail(409, '项目说明已更新，请重新加载');
    if (current.notes === content) return current;
    // Keep the cleared record so an older editor cannot overwrite a later change.
    const next = { projectId, notes: content, revision: revision + 1, updatedAt: new Date().toISOString() };
    store.put('project-instructions', projectId, next);
    events.publish('project-instructions.changed', { projectId, revision: next.revision });
    return next;
  });
}

export const projectInstructions: Extension = {
  id: 'project-instructions', name: '项目工作指令', capabilities: ['project.instructions'],
  permissions: ['service.provide:project-instructions.manage', 'store.read', 'store.write', 'events.publish'],
  activate(context) {
    context.provide('project-instructions.manage', input => manage(context, input));
  },
};

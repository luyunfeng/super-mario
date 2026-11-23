import type { Extension, Json, Store } from '../packages/plugin-sdk/src/index.ts';

type Conversation = { id: string; title: string; projectId?: string; createdAt: string; version?: number; archived?: boolean; creationTitle?: string };
function view(row: Conversation) {
  const { id, title, projectId, createdAt, archived = false, version = 1 } = row;
  return { id, title, ...(projectId && { projectId }), createdAt, archived, version };
}
const fields = {
  list: ['projectId', 'archived'], create: ['id', 'projectId', 'title'],
  get: ['id', 'projectId'], update: ['id', 'title', 'version', 'archived'],
} as const;
const collection = 'web-conversations';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function projectStatus(store: Pick<Store,'get'>, projectId?: string) {
  if (projectId === undefined) return 'available';
  const project = store.get<{ id: string; archivedAt?: string }>('projects', projectId);
  if (!project || project.id !== projectId) return 'missing';
  return project.archivedAt ? 'archived' : 'available';
}

function requireProject(store: Store, projectId?: string) {
  const status = projectStatus(store, projectId);
  if (status === 'missing') fail(404, '项目不存在');
  if (status === 'archived') fail(409, '项目已归档');
}

export function webConversationMatches(store: Pick<Store,'get'>, id: string, projectId?: string): boolean {
  if (typeof id !== 'string' || !uuidV4.test(id)) return false;
  const key = id.toLowerCase();
  const row = store.get<Conversation>(collection, key);
  return row?.id === key && !row.archived && row.projectId === projectId && projectStatus(store, projectId) === 'available';
}

export const webConversationsExtension: Extension = {
  id: 'web-conversations', name: '独立 Web 对话', capabilities: ['web-conversations.manage'],
  permissions: ['service.provide:web-conversations.manage', 'store.read', 'store.write', 'events.publish'],
  activate({ store, events, provide }) {
    provide('web-conversations.manage', (input): Json => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '独立对话参数无效');
      const { action, projectId } = input;
      if (action !== 'list' && action !== 'create' && action !== 'get' && action !== 'update') fail(400, '独立对话操作无效');
      const allowed: readonly string[] = ['action', ...fields[action]];
      if (Object.keys(input).some(key => !allowed.includes(key))) fail(400, '独立对话包含未知字段');
      if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim())) fail(400, '项目 ID 无效');
      if (input.archived !== undefined && typeof input.archived !== 'boolean') fail(400, '归档状态无效');
      if (action === 'list') {
        requireProject(store, projectId);
        return { items: store.list<Conversation>(collection).filter(row => row.projectId === projectId && (row.archived ?? false) === (input.archived ?? false)).reverse().map(view) };
      }
      if (typeof input.id !== 'string' || !uuidV4.test(input.id)) fail(400, '对话 ID 须为 UUID v4');
      const id = input.id.toLowerCase();
      if (action === 'get') {
        const row = store.get<Conversation>(collection, id);
        if (!row || (projectId !== undefined && row.projectId !== projectId)) fail(404, '独立对话不存在');
        requireProject(store, row.projectId);
        return view(row);
      }
      const titleValue = input.title;
      if (titleValue !== undefined && (typeof titleValue !== 'string' || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(titleValue) || [...titleValue.trim()].length > 80))
        fail(400, '对话标题须为单行文字，最多 80 个字符');
      const title = titleValue?.trim() || '新对话';
      return store.transaction(() => {
        const existing = store.get<Conversation>(collection, id);
        if (action === 'update') {
          if (!Number.isSafeInteger(input.version) || typeof input.version !== 'number' || input.version < 1 ||
              (titleValue === undefined && input.archived === undefined)) fail(400, '请提供当前版本和要修改的字段');
          if (!existing) fail(404, '独立对话不存在');
          requireProject(store, existing.projectId);
          const current = view(existing);
          if (input.version !== current.version) fail(409, '对话已更新，请重新读取');
          const archived = typeof input.archived === 'boolean' ? input.archived : current.archived;
          const nextTitle = titleValue === undefined ? current.title : title;
          if (archived === current.archived && nextTitle === current.title) return current;
          if (archived && !current.archived && store.list<{ conversationId: string; role: string; status?: string }>('messages')
              .some(m => m.conversationId === 'web:' + id && m.role === 'user' && m.status === 'pending')) fail(409, '对话有消息待处理，请结束后再归档');
          const updated = { ...existing, title: nextTitle, archived, version: current.version + 1, creationTitle: existing.creationTitle ?? existing.title };
          store.put(collection, id, updated);
          events.publish('web-conversations.changed', { id, ...(existing.projectId && {projectId:existing.projectId}) });
          return view(updated);
        }
        requireProject(store, projectId);
        if (existing) {
          if (existing.projectId !== projectId || (existing.creationTitle ?? existing.title) !== title) fail(409, '此对话 ID 已用于其他创建请求');
          return view(existing);
        }
        const identity = { id, ...(projectId && { projectId }) };
        const row = { ...identity, title, creationTitle: title, version: 1, archived: false, createdAt: new Date().toISOString() };
        store.put(collection, id, row);
        events.publish('web-conversations.changed', identity);
        return view(row);
      });
    });
  },
};

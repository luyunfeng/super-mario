import { createHash, randomBytes } from 'node:crypto';
import type { Extension, Json, Store } from '../packages/plugin-sdk/src/index.ts';

import type { Message, Project } from '../packages/protocol/src/index.ts';

type SavedSearch = { id: string; name: string; query: string };
type SearchBook = {
  revision: number;
  searches: SavedSearch[];
  deleted: { index: number; item: SavedSearch } | null;
};

const fields = {
  list: [], add: ['revision', 'name', 'query'], update: ['revision', 'id', 'name', 'query'],
  delete: ['revision', 'id'], move: ['revision', 'id', 'beforeId'], undo: ['revision'],
} as const;

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function read(store: Store): SearchBook {
  return store.get<SearchBook>('conversation-search', 'saved') ?? { revision: 0, searches: [], deleted: null };
}

function snapshot(book: SearchBook) {
  return { revision: book.revision, searches: book.searches, canUndo: book.deleted !== null };
}

function validatedText(name: Json | undefined, query: Json | undefined) {
  const label = typeof name === 'string' ? name.trim() : '';
  const value = typeof query === 'string' ? query.trim() : '';
  if (!label || [...label].length > 64 || /[\p{Cc}\p{Cs}]/u.test(label))
    fail(400, '名称须为 1 至 64 个字符，且不能包含控制字符');
  if (!value || value.startsWith('>') || Buffer.byteLength(value) > 1024 || /[\p{Cc}\p{Cs}]/u.test(value))
    fail(400, '查询不能为空、以 > 开头、含控制字符或超过 1024 字节');
  return { name: label, query: value };
}

function indexOf(searches: SavedSearch[], id: Json | undefined) {
  if (typeof id !== 'string' || !id.trim()) fail(400, '缺少有效的检索 ID');
  const index = searches.findIndex(item => item.id === id);
  if (index === -1) fail(404, '未找到保存的检索');
  return index;
}

function savedSearches(store: Store, input: Json): Json {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.action !== 'string' || !Object.hasOwn(fields, input.action)) fail(400, '检索操作无效');
  const action = input.action as keyof typeof fields;
  const allowed: readonly string[] = fields[action];
  if (Object.keys(input).some(key => key !== 'action' && !allowed.includes(key))) fail(400, '检索操作包含未知字段');
  if (action === 'list') return snapshot(read(store));
  const { revision } = input;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
    fail(400, '检索版本无效');

  // Revision, order and the single undo entry are persisted together.
  return store.transaction(() => {
    const book = read(store);
    if (book.revision !== revision) fail(409, '保存的检索已更新，请刷新后重试');
    const searches = [...book.searches];
    let deleted: SearchBook['deleted'] = null;
    if (action === 'undo') {
      if (!book.deleted) fail(404, '没有可撤销的删除');
      searches.splice(book.deleted.index, 0, book.deleted.item);
    } else if (action === 'delete') {
      const index = indexOf(searches, input.id);
      deleted = { index, item: searches.splice(index, 1)[0] };
    } else if (action === 'move') {
      const index = indexOf(searches, input.id);
      if (input.id === input.beforeId) fail(400, '不能将检索移到自身之前');
      const [item] = searches.splice(index, 1);
      const before = input.beforeId === undefined ? searches.length : indexOf(searches, input.beforeId);
      searches.splice(before, 0, item);
    } else {
      const text = validatedText(input.name, input.query);
      const index = action === 'update' ? indexOf(searches, input.id) : -1;
      if (searches.some((item, i) => i !== index && item.name.toLowerCase() === text.name.toLowerCase()))
        fail(409, '已有同名检索');
      if (action === 'add') {
        if (searches.length >= 50) fail(400, '最多可保存 50 条检索');
        searches.push({ id: 'search_' + randomBytes(12).toString('hex'), ...text });
      } else {
        searches[index] = { id: searches[index].id, ...text };
      }
    }
    const next = { revision: revision + 1, searches, deleted };
    store.put('conversation-search', 'saved', next);
    return snapshot(next);
  });
}

function readableMessage(message: Message, project: Project, excludeId: unknown): boolean {
  return !project.archivedAt && message.id !== excludeId &&
    message.conversationId === 'project:' + project.id + ':work' && (!message.projectId || message.projectId === project.id) &&
    ['user', 'assistant'].includes(message.role) && (!message.origin || message.origin === 'user');
}

function projectMessages(store: Store, input: Json, excludeId?: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '检索参数无效');
  const { query, before, limit = 5, mode = 'phrase' } = input;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 25) fail(400, '每页须为 1 至 25 条');
  if (before !== undefined && (typeof before !== 'string' || !before)) fail(400, '消息游标无效');
  if (typeof query !== 'string' || !query.trim() || query.length > 500) fail(400, '检索词须为 1 至 500 个字符');
  if (mode !== 'phrase' && mode !== 'keywords') fail(400, '检索方式无效');
  const terms = mode === 'keywords' ? [...new Set(query.trim().split(/\s+/u))] : [query.trim()];
  if (terms.length > 8) fail(400, '最多可组合 8 个关键词');
  const scope = input.projectId;
  if (scope !== undefined && (typeof scope !== 'string' || !scope.trim())) fail(400, '项目 ID 无效');
  const projects = new Map(store.list<Project>('projects').filter(p => !p.archivedAt && (scope === undefined || p.id === scope)).map(p => ['project:' + p.id + ':work', p]));
  const hits = [];
  const patterns = terms.map(term => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'));
  let pastCursor = before === undefined;
  for (const message of store.list<Message>('messages').reverse()) {
    const project = projects.get(message.conversationId);
    if (!project || !readableMessage(message, project, excludeId)) continue;
    const matches = [];
    for (const pattern of patterns) {
      const match = pattern.exec(message.text);
      if (!match) break;
      matches.push(match);
    }
    if (matches.length !== patterns.length) continue;
    if (!pastCursor) {
      pastCursor = message.id === before;
      continue;
    }
    if (hits.length === limit) return { hits, nextBefore: hits[hits.length - 1].id };
    // Keep disjoint excerpts separate so a quotation cannot bridge omitted text.
    const excerpts = matches.sort((a, b) => a.index - b.index).map(match => {
      const start = match.index, end = start + match[0].length;
      return { before: message.text.slice(Math.max(0, start - 18), start), match: match[0], after: message.text.slice(end, end + 32) };
    });
    hits.push({ projectId: project.id, projectName: project.name, createdAt: message.createdAt, id: message.id,
      role: message.role, ...excerpts[0], ...(excerpts.length > 1 ? { excerpts } : {}) });
  }
  if (!pastCursor) fail(404, '未找到当前检索的消息游标');
  return { hits, nextBefore: null };
}

export const conversationSearch: Extension = {
  id: 'conversation-search', name: '对话历史搜索', capabilities: ['conversation.search'],
  permissions: ['contribute:tools', 'service.provide:conversation-search.saved', 'service.provide:conversation-search.projects', 'store.read', 'store.write'],
  activate(context) {
    context.contribute('tools', 'project_message_search', {
      name: 'project_message_search',
      description: '从新到旧查找项目工作对话。默认按连续原文匹配；mode=keywords 要求同一条消息含全部关键词（空格分隔，最多 8 个，顺序不限）。返回发言角色、消息 ID 和命中前后的摘录。可用 nextBefore 继续查更早的结果。',
      parameters: { type: 'object', required: ['query'], additionalProperties: false, properties: {
        query: { type: 'string' }, mode: { type: 'string', enum: ['phrase', 'keywords'] }, projectId: { type: 'string' }, before: { type: 'string' },
      } },
      async execute(args, signal) {
        signal.throwIfAborted();
        return projectMessages(context.store, args, typeof args.excludeId === 'string' ? args.excludeId : undefined);
      },
    });
    context.contribute('tools', 'project_message_read', {
      name: 'project_message_read',
      description: '按检索命中的项目 ID 和消息 ID 读取一条项目工作消息的正文。续读时传回 nextOffset 和 version。',
      parameters: { type: 'object', required: ['projectId', 'id'], additionalProperties: false, properties: {
        projectId: { type: 'string' }, id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, version: { type: 'string' },
      } },
      async execute({ projectId, id, offset = 0, version, excludeId }, signal) {
        signal.throwIfAborted();
        if (typeof projectId !== 'string' || typeof id !== 'string') fail(400, '缺少项目或消息 ID');
        const project = context.store.get<Project>('projects', projectId);
        const message = context.store.get<Message>('messages', id);
        if (!project || !message || !readableMessage(message, project, excludeId)) fail(404, '未找到当前项目的可读消息');
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && typeof version !== 'string'))
          fail(400, '续读需要有效位置和原版本');
        const current = createHash('sha256').update(message.text).digest('hex');
        if (version !== undefined && version !== current) fail(409, '消息正文已变化，请从头读取');
        if (offset > message.text.length) fail(400, '位置超出消息正文');
        let end = Math.min(offset + 4000, message.text.length);
        if (end < message.text.length && /[\uD800-\uDBFF]/u.test(message.text[end - 1])) end--;
        return { id, projectId, projectName: project.name, role: message.role, createdAt: message.createdAt,
          text: message.text.slice(offset, end), offset, nextOffset: end < message.text.length ? end : null, version: current };
      },
    });
    context.provide('conversation-search.projects', input => projectMessages(context.store, input));
    context.provide('conversation-search.saved', input => savedSearches(context.store, input));
  },
};

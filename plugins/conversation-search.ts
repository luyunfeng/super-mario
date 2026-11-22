import { randomBytes } from 'node:crypto';
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

function projectMessages(store: Store, input: Json) {
  const query = input && typeof input === 'object' && !Array.isArray(input) && input.query;
  if (typeof query !== 'string' || !query.trim() || query.length > 500) fail(400, '检索词须为 1 至 500 个字符');
  const projects = new Map(store.list<Project>('projects').filter(p => !p.archivedAt).map(p => ['project:' + p.id + ':work', p.id]));
  const hits = [];
  const pattern = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  for (const message of store.list<Message>('messages').reverse()) {
    const projectId = projects.get(message.conversationId);
    if (!projectId || (message.projectId && message.projectId !== projectId) ||
      !['user', 'assistant'].includes(message.role) || (message.origin && message.origin !== 'user')) continue;
    const match = pattern.exec(message.text);
    if (!match) continue;
    const start = match.index, end = start + match[0].length;
    hits.push({ projectId, id: message.id, role: message.role, before: message.text.slice(Math.max(0, start - 18), start),
      match: match[0], after: message.text.slice(end, end + 32) });
    if (hits.length === 5) break;
  }
  return { hits };
}

export const conversationSearch: Extension = {
  id: 'conversation-search', name: '对话历史搜索', capabilities: ['conversation.search'],
  permissions: ['service.provide:conversation-search.saved', 'service.provide:conversation-search.projects', 'store.read', 'store.write'],
  activate(context) {
    context.provide('conversation-search.projects', input => projectMessages(context.store, input));
    context.provide('conversation-search.saved', input => savedSearches(context.store, input));
  },
};

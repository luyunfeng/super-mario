import { randomUUID } from 'node:crypto';
import type { Extension, Json, JsonObject, Store } from '../packages/plugin-sdk/src/index.ts';
import type { Message, Project } from '../packages/protocol/src/index.ts';

const format = 'super-mario.message-favorites';
const maxItems = 300;
const maxChars = 4000;
type Snapshot = { title: string; role: 'user' | 'assistant'; text: string; omitted: number; createdAt: string; starredAt: string };
type Favorite = Snapshot & { id: string; messageId?: string; projectId?: string; backupKey?: string };
type Book = { revision: number; items: Favorite[] };

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function object(value: Json | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '收藏参数无效');
  return value;
}

function onlyKeys(value: JsonObject, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(400, '收藏请求包含未知字段');
}

function id(value: Json | undefined): string {
  if (typeof value !== 'string' || !value.trim()) fail(400, '收藏请求缺少有效 ID');
  return value;
}

function read(store: Store): Book {
  return store.get<Book>('message-favorites', 'collection') ?? { revision: 0, items: [] };
}

function list(book: Book) {
  return { revision: book.revision, items: book.items.map(({ backupKey, ...item }) => item) };
}

function save(store: Store, book: Book) {
  book.revision++;
  store.put('message-favorites', 'collection', book);
}

function checkRevision(revision: Json | undefined, book: Book) {
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) fail(400, '收藏版本无效');
  if (revision !== book.revision) fail(409, '收藏已更新，请重新加载');
}

function sourceMessage(store: Store, messageId: string, projectId?: string) {
  const conversationId = projectId === undefined ? 'main' : `project:${projectId}:work`;
  const source = store.get<Message>('messages', messageId);
  if (!source || source.id !== messageId || source.conversationId !== conversationId
    || (projectId && source.projectId !== undefined && source.projectId !== projectId)
    || !['user', 'assistant'].includes(source.role)) fail(404, '当前工作对话中没有这条消息');
  return source;
}

function add(store: Store, book: Book, input: JsonObject) {
  const messageId = id(input.messageId);
  const projectId = input.projectId === undefined ? undefined : id(input.projectId);
  let title = '主对话';
  if (projectId !== undefined) {
    const project = store.get<Project>('projects', projectId);
    if (!project || project.id !== projectId) fail(404, '项目不存在');
    title = Array.from('项目工作对话 · ' + project.name.replace(/[\p{C}\s]+/gu, ' ').trim()).slice(0, 200).join('').trim();
  }
  const source = sourceMessage(store, messageId, projectId);
  if (book.items.some(item => item.messageId === messageId && item.projectId === projectId)) return;
  if (source.status === 'pending') fail(409, '消息仍在生成，请等待完成后收藏');
  if (book.items.length >= maxItems) fail(400, '最多可收藏 300 条消息');
  const text = source.text.replaceAll('\0', '').replace(/\p{Cs}/gu, '�');
  if (!text.trim()) fail(400, '不能收藏空消息');
  const characters = Array.from(text);
  book.items.unshift({
    id: randomUUID(), messageId, ...(projectId && { projectId }), title, role: source.role,
    text: characters.slice(0, maxChars).join(''), omitted: Math.max(0, characters.length - maxChars),
    createdAt: new Date(source.createdAt).toISOString(), starredAt: new Date().toISOString(),
  });
  save(store, book);
}

function backup(book: Book) {
  return { format, version: 1, messages: book.items.map(({ id, messageId, projectId, backupKey, ...snapshot }) =>
    ({ key: backupKey ?? id, ...snapshot })) };
}

function timestamp(stamp: Json | undefined): string {
  if (typeof stamp !== 'string' || stamp.length !== 24 || !Number.isFinite(Date.parse(stamp))
    || new Date(stamp).toISOString() !== stamp) fail(400, '备份消息时间无效');
  return stamp;
}

// Portable keys identify a saved snapshot across backups. Only locally read
// messages acquire a source locator. Archival entries get a fresh local ID.
function parseBackup(raw: Json | undefined) {
  const value = object(raw);
  onlyKeys(value, ['format', 'version', 'messages']);
  if (value.format !== format || value.version !== 1 || !Array.isArray(value.messages) || value.messages.length > maxItems)
    fail(400, '备份格式、版本或数量无效');
  const seen = new Set<string>();
  return value.messages.map(raw => {
    const item = object(raw);
    onlyKeys(item, ['key', 'title', 'role', 'text', 'omitted', 'createdAt', 'starredAt']);
    const { key, title, role, text, omitted, createdAt, starredAt } = item;
    if (typeof key !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(key) || seen.has(key))
      fail(400, '备份记录标识无效或重复');
    if (typeof title !== 'string' || !title.trim() || title.length > 400 || Array.from(title).length > 200 || /[\p{Cc}\p{Cs}]/u.test(title)
      || (role !== 'user' && role !== 'assistant') || typeof text !== 'string' || text.length > maxChars * 2 || /[\0\p{Cs}]/u.test(text)
      || typeof omitted !== 'number' || !Number.isSafeInteger(omitted) || omitted < 0) fail(400, '备份消息内容无效');
    const length = Array.from(text).length;
    if (length > maxChars || (omitted > 0 ? length !== maxChars : !text.trim())) fail(400, '备份消息长度无效');
    seen.add(key);
    return { key, title, role, text, omitted, createdAt: timestamp(createdAt), starredAt: timestamp(starredAt) } satisfies Snapshot & { key: string };
  });
}

const fields = {
  list: [], marks: [], backup: [], source: ['id'], add: ['messageId', 'projectId'], remove: ['id', 'revision'],
  preview: ['backup', 'revision'], restore: ['backup', 'revision'],
} as const;

function manage(store: Store, raw: Json): Json {
  const input = object(raw);
  if (typeof input.action !== 'string' || !Object.hasOwn(fields, input.action)) fail(400, '收藏操作无效');
  const action = input.action as keyof typeof fields;
  onlyKeys(input, ['action', ...fields[action]]);
  if (action === 'list') return list(read(store));
  if (action === 'marks') {
    // Paint per-message controls on startup without loading any saved text.
    const book = read(store);
    return { revision: book.revision, items: book.items.flatMap(({ id, messageId, projectId }) =>
      messageId ? [{ id, messageId, ...(projectId && { projectId }) }] : []) };
  }
  if (action === 'backup') return backup(read(store));
  if (action === 'source') {
    const favoriteId = id(input.id);
    const item = read(store).items.find(item => item.id === favoriteId);
    if (!item?.messageId) fail(404, '此收藏没有可查看的本地原文');
    const source = sourceMessage(store, item.messageId, item.projectId);
    return { messageId: source.id, ...(item.projectId && { projectId: item.projectId }),
      text: source.text, role: source.role, createdAt: source.createdAt };
  }
  return store.transaction(() => {
    const book = read(store);
    if (action === 'add') {
      add(store, book, input);
      return list(book);
    }
    if (action !== 'preview' || input.revision !== undefined) checkRevision(input.revision, book);
    if (action === 'remove') {
      const itemId = id(input.id);
      const index = book.items.findIndex(item => item.id === itemId);
      if (index !== -1) {
        book.items.splice(index, 1);
        save(store, book);
      }
      return list(book);
    }
    const messages = parseBackup(input.backup);
    const saved = new Set(book.items.map(item => item.backupKey ?? item.id));
    const additions = messages.filter(item => !saved.has(item.key));
    const available = maxItems - book.items.length;
    if (action === 'restore' && additions.length) {
      if (additions.length > available) fail(400, '剩余收藏空间不足');
      for (const { key, ...item } of additions) book.items.push({ ...item, id: randomUUID(), backupKey: key });
      book.items.sort((a, b) => b.starredAt.localeCompare(a.starredAt));
      save(store, book);
    }
    return { revision: book.revision, total: messages.length, toAdd: additions.length, alreadySaved: messages.length - additions.length, available };
  });
}

export const messageFavorites: Extension = {
  id: 'message-favorites', name: '消息收藏', capabilities: ['message.favorites'],
  permissions: ['service.provide:message-favorites.manage', 'store.read', 'store.write'],
  activate(context) {
    context.provide('message-favorites.manage', input => manage(context.store, input));
  },
};

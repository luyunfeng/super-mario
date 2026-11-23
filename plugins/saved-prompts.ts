import { randomUUID } from 'node:crypto';
import type { Extension, ExtensionContext, Json, Store } from '../packages/plugin-sdk/src/index.ts';

type Prompt = { id: string; name: string; text: string; createdAt: string; updatedAt: string };
type Book = { revision: number; items: Prompt[] };

const fields = {
  list: [], create: ['revision', 'name', 'text'], update: ['revision', 'id', 'name', 'text'],
  remove: ['revision', 'id'], reorder: ['revision', 'ids'],
} as const;

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function read(store: Store, key: string): Book {
  return store.get<Book>('saved-prompts', key) ?? { revision: 0, items: [] };
}

function normalize(name: Json | undefined, text: Json | undefined) {
  const trim = /^\p{White_Space}+|(?<!\p{White_Space})\p{White_Space}+$/gu;
  const label = typeof name === 'string' ? name.replace(trim, '').replace(/^\//, '') : '';
  if (!/^[\p{L}\p{Nd}\p{Mn}_.-]{1,32}$/u.test(label))
    fail(400, '名称须为 1 至 32 个字符，可含字母、组合标记、数字、连字符、下划线和点');
  const body = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').replace(trim, '') : '';
  if (!body || body.length > 16000 || Array.from(body).length > 8000 || /(?![\n\t])[\p{Cc}\p{Cs}]/u.test(body))
    fail(400, '正文须为 1 至 8000 个字符，控制字符仅支持换行和制表符');
  return { name: label, text: body };
}

function reordered(items: Prompt[], ids: Json | undefined): Prompt[] {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) fail(400, '排序须提供 ID 列表');
  const byId = new Map(items.map(item => [item.id, item]));
  if (ids.length !== items.length || new Set(ids).size !== ids.length) fail(409, '排序须包含全部提示词，且每项仅出现一次');
  return ids.map(id => byId.get(id as string) ?? fail(409, '排序包含未知提示词'));
}

function manage({ store, events }: ExtensionContext, input: Json, requireAssistant?: (id: string) => void): Json {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.action !== 'string' || !Object.hasOwn(fields, input.action)) fail(400, '提示词操作无效');
  const action = input.action as keyof typeof fields;
  const allowed: readonly string[] = fields[action];
  if (Object.keys(input).some(key => key !== 'action' && key !== 'assistantId' && !allowed.includes(key))) fail(400, '提示词操作包含未知字段');
  let assistantId: string | undefined;
  if (input.assistantId !== undefined) {
    if (typeof input.assistantId !== 'string' || !input.assistantId) fail(400, '助理 ID 无效');
    if (!requireAssistant) fail(503, '助理名册不可用');
    assistantId = input.assistantId.toLowerCase();
    requireAssistant(assistantId);
  }
  // The default owner's pre-existing SQLite record is kept in place.
  const key = assistantId ?? 'collection';
  if (action === 'list') return read(store, key);
  const revision = input.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
    fail(400, '提示词版本无效');
  return store.transaction(() => {
    const book = read(store, key);
    if (book.revision !== revision) fail(409, '提示词列表已更新，请重新加载');
    let items = [...book.items];
    if (action === 'reorder') {
      items = reordered(items, input.ids);
      if (items.every((item, index) => item === book.items[index])) return book;
    } else {
      if (action !== 'create' && (typeof input.id !== 'string' || !input.id.trim())) fail(400, '缺少有效的提示词 ID');
      const index = items.findIndex(item => item.id === input.id);
      if (action === 'remove') {
        if (index < 0) return book;
        items.splice(index, 1);
      } else {
        if (action === 'update' && index < 0) fail(404, '提示词不存在');
        const prompt = normalize(input.name, input.text);
        // Unicode case-insensitive matching also folds final sigma and long s.
        // The dot is the only regex metacharacter in the allowed name alphabet.
        const sameName = new RegExp('^' + prompt.name.replaceAll('.', '\\.') + '$', 'iu');
        if (items.some((item, i) => i !== index && sameName.test(item.name))) fail(409, '提示词名称已被使用');
        const now = new Date().toISOString();
        if (action === 'create') {
          if (items.length >= 100) fail(400, '最多可保存 100 条提示词');
          items.push({ id: randomUUID(), ...prompt, createdAt: now, updatedAt: now });
        } else {
          const previous = items[index];
          if (previous.name === prompt.name && previous.text === prompt.text) return book;
          items[index] = { ...previous, ...prompt, updatedAt: now };
        }
      }
    }
    const next = { revision: revision + 1, items };
    store.put('saved-prompts', key, next);
    events.publish('saved-prompts.changed', { revision: next.revision, ...(assistantId && {assistantId}) });
    return next;
  });
}

export function createSavedPrompts(requireAssistant?: (id: string) => void): Extension {
  return {
    id: 'saved-prompts', name: '常用提示词', capabilities: ['prompts.manage'],
    permissions: ['service.provide:saved-prompts.manage', 'store.read', 'store.write', 'events.publish'],
    activate(context) {
      context.provide('saved-prompts.manage', input => manage(context, input, requireAssistant));
    },
  };
}

export const savedPrompts = createSavedPrompts();

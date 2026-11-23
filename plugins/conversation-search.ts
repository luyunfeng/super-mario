import { sensitiveWorkspacePath } from './workspace-code.ts';
import { readConversationStatus } from './conversation-status.ts';
import { localDayFormatter } from './local-day.ts';
import { messageVersion } from '../packages/plugin-sdk/src/index.ts';
import { randomBytes } from 'node:crypto';
import type { Extension, Json, Store } from '../packages/plugin-sdk/src/index.ts';

import type { Message, Project, Todo } from '../packages/protocol/src/index.ts';

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

function messageCitation(projectId: string, id: string, version: string) {
  return '[查看原文](#projects/' + encodeURIComponent(projectId) + '/workspace?' + new URLSearchParams({ at: id, version }) + ')';
}

function projectMessages(store: Store, input: Json, excludeId?: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '检索参数无效');
  const { query, role, sentDay, timeZone, todoId, replyTo, before, limit = 5, mode = 'phrase' } = input;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 25) fail(400, '每页须为 1 至 25 条');
  if (before !== undefined && (typeof before !== 'string' || !before)) fail(400, '消息游标无效');
  if (todoId !== undefined) {
    if (typeof todoId !== 'string' || typeof input.projectId !== 'string' ||
        store.get<Todo>('todos', todoId)?.projectId !== input.projectId) fail(404, '未找到当前项目的待办');
  }
  if (role !== undefined && role !== 'user' && role !== 'assistant') fail(400, '发言角色须为 user 或 assistant');
  let question: Message | undefined;
  if (replyTo !== undefined) {
    if (role === 'user') fail(400, '按原提问查询回复时须选择助手角色');
    const project = typeof input.projectId === 'string' && store.get<Project>('projects', input.projectId);
    question = typeof replyTo === 'string' ? store.get<Message>('messages', replyTo) : undefined;
    if (!project || !question || question.role !== 'user' || !readableMessage(question, project, excludeId) ||
        (todoId !== undefined && question.todoId !== todoId)) fail(404, '未找到当前范围的原提问');
  }
  const dayFormat = localDayFormatter(sentDay, timeZone, '发言日期');
  const listMessages = (todoId !== undefined || question !== undefined || ((role !== undefined || dayFormat !== undefined) && typeof input.projectId === 'string')) && query === undefined;
  if (!listMessages && (typeof query !== 'string' || !query.trim() || query.length > 500)) fail(400, '检索词须为 1 至 500 个字符');
  if (mode !== 'phrase' && mode !== 'keywords') fail(400, '检索方式无效');
  let terms: string[] = [];
  if (typeof query === 'string') terms = mode === 'keywords' ? [...new Set(query.trim().split(/\s+/u))] : [query.trim()];
  if (terms.length > 8) fail(400, '最多可组合 8 个关键词');
  const scope = input.projectId;
  if (scope !== undefined && (typeof scope !== 'string' || !scope.trim())) fail(400, '项目 ID 无效');
  const projects = new Map(store.list<Project>('projects').filter(p => !p.archivedAt && (scope === undefined || p.id === scope)).map(p => ['project:' + p.id + ':work', p]));
  const hits = [];
  const patterns = terms.map(term => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'));
  let pastCursor = before === undefined;
  for (const message of store.list<Message>('messages').reverse()) {
    const project = projects.get(message.conversationId);
    if (!project || (todoId !== undefined && message.todoId !== todoId) || !readableMessage(message, project, excludeId)) continue;
    if (role !== undefined && message.role !== role) continue;
    if (dayFormat) {
      const instant = Date.parse(message.createdAt);
      if (!Number.isFinite(instant) || dayFormat.format(instant).padStart(10, '0') !== sentDay) continue;
    }
    if (question && (message.role !== 'assistant' || message.replyTo !== question.id || message.todoId !== question.todoId)) continue;
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
    const version = messageVersion(message.text);
    hits.push({ projectId: project.id, projectName: project.name, createdAt: message.createdAt, id: message.id,
      role: message.role, version, status: message.status ?? 'unknown', webCitation: messageCitation(project.id, message.id, version), ...(todoId !== undefined && { todoId }),
      ...(listMessages ? { preview: message.text.slice(0, 120) } : excerpts[0]), ...(excerpts.length > 1 ? { excerpts } : {}) });
  }
  if (!pastCursor) fail(404, '未找到当前检索的消息游标');
  return { hits, nextBefore: null };
}

type ReadFiles = (input: { projectId: string; kind: 'search'; query: string }) => Promise<Json>;
export const conversationSearch = (readFiles: ReadFiles, searchPrivate?: (input: Json) => Json): Extension => ({
  id: 'conversation-search', name: '对话历史搜索', capabilities: ['conversation.search'],
  permissions: ['contribute:tools', 'service.provide:conversation-search.saved', 'service.provide:conversation-search.projects', 'service.provide:conversation-search.files', 'service.provide:conversation-search.status', 'store.read', 'store.write'],
  activate(context) {
    let active = true;
    context.defer(() => { active = false; });
    async function searchFiles(input: Json, signal: AbortSignal) {
      signal.throwIfAborted();
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.projectId !== 'string' || !input.projectId.trim()
          || Object.keys(input).some(key => key !== 'query' && key !== 'projectId')) fail(400, '文件检索参数无效');
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 256 || /[\p{Cc}]/u.test(input.query))
        fail(400, '文件检索只接受 1 至 256 字的查询词');
      const result = await readFiles({ projectId: input.projectId, kind: 'search', query: input.query.trim() });
      signal.throwIfAborted();
      if (!active) fail(503, '对话搜索插件已停用');
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.truncated !== 'boolean'
          || !Array.isArray(result.paths) || result.paths.length > 50) fail(502, '文件检索回执无效');
      const paths: string[] = [];
      for (const path of result.paths) {
        if (typeof path !== 'string' || path.length > 4096 || path.split('/').some(part => !part || part === '.' || part === '..')
            || /[\p{Cc}]/u.test(path) || sensitiveWorkspacePath(path)) fail(502, '文件检索回执无效');
        paths.push(path);
      }
      return { paths, truncated: result.truncated };
    }
    context.provide('conversation-search.files', searchFiles);
    const status = (input: Json, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (!active) fail(503, '对话搜索插件已停用');
      return readConversationStatus(context.store, input);
    };
    context.provide('conversation-search.status', status);
    if (searchPrivate) {
      const filters = { botId: { type: 'string' }, archived: { type: 'boolean' }, before: { type: 'string' }, tag: { type: 'string' } };
      const run = (input: Json, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (!active) fail(503, '对话搜索插件已停用');
        return searchPrivate(input);
      };
      context.contribute('tools', 'private_conversation_list', {
        name: 'private_conversation_list', description: '按 Web 显示顺序列出指定全局机器人的主人独立对话，返回名称、标签、发言数量和最近发言时间。Web 主对话提供 botId，飞书主人主会话自动限定当前机器人。可按 archived 和 tag 筛选，before 用上页 nextBefore。',
        parameters: { type: 'object', additionalProperties: false, properties: filters },
        async execute(input, signal) {
          if (!input || typeof input !== 'object' || Array.isArray(input) || 'query' in input) fail(400, '按词查发言请使用独立对话搜索');
          return run(input, signal);
        },
      });
      context.contribute('tools', 'private_conversation_search', {
        name: 'private_conversation_search', description: '在指定全局机器人的主人独立对话中按标题或发言片段查找，返回会话名、命中角色及摘录。Web 主对话提供 botId，飞书主人主会话自动限定当前机器人。archived=true 单查归档，tag 可精确限定一个标签，before 用上页 nextBefore。',
        parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: { ...filters, query: { type: 'string' } } },
        async execute(input, signal) {
          if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.query !== 'string') fail(400, '请提供要检索的词句');
          return run(input, signal);
        },
      });
    }
    context.contribute('tools', 'conversation_status', {
      name: 'conversation_status', description: '查看当前会话已记录的进度、最近发言、明确执行目标和待用户决定的卡片。仅记录事实，无记录或结果未知时如实说明。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute(input, signal) { return status(input, signal); },
    });
    context.contribute('tools', 'project_file_search', {
      name: 'project_file_search', description: '按相对路径模糊检索一个已绑定项目的文件名。返回命中路径和 Web 引用。truncated 表示仅覆盖了部分文件或匹配结果。',
      parameters: { type: 'object', required: ['query'], additionalProperties: false, properties: {
        projectId: { type: 'string' }, query: { type: 'string', minLength: 1, maxLength: 256 },
      } },
      async execute({ projectId, query }, signal) {
        if (typeof projectId !== 'string') fail(400, '请选择要检索的项目');
        const { paths, truncated } = await searchFiles({ projectId, query }, signal);
        return { projectId, truncated, hits: paths.map(path => ({ path, webCitation: '[查看文件](#projects/' +
          encodeURIComponent(projectId) + '/workspace?' + new URLSearchParams({ file: path }) + ')' })) };
      },
    });
    context.contribute('tools', 'project_message_search', {
      name: 'project_message_search',
      description: '从新到旧查找项目工作对话。默认按连续原文匹配；mode=keywords 要求同一条消息含全部关键词（空格分隔，最多 8 个，顺序不限）。按当地发言日期查时同传 sentDay（YYYY-MM-DD）和 timeZone，已限定项目可省略检索词。可传 role=user 或 assistant 限定发言角色；指定项目和角色后省略 query 可浏览该角色的最近发言。返回发言角色、消息状态、ID、正文版本和命中前后的摘录。传 projectId 和 todoId 可限定一项待办，省略 query 则列出该项最近消息。查询某个提问的回答时传 projectId 和 replyTo（原提问 ID），按 status 核对结果。可用 nextBefore 继续查更早的结果。',
      parameters: { type: 'object', additionalProperties: false, properties: {
        sentDay: { type: 'string' }, timeZone: { type: 'string' }, query: { type: 'string' }, role: { type: 'string', enum: ['user', 'assistant'] }, replyTo: { type: 'string' }, todoId: { type: 'string' }, mode: { type: 'string', enum: ['phrase', 'keywords'] }, projectId: { type: 'string' }, before: { type: 'string' },
      } },
      async execute(args, signal) {
        signal.throwIfAborted();
        return projectMessages(context.store, args, typeof args.excludeId === 'string' ? args.excludeId : undefined);
      },
    });
    context.contribute('tools', 'project_message_read', {
      name: 'project_message_read',
      description: '按检索命中的项目 ID 和消息 ID 读取一条项目工作消息的正文。首次读取传检索返回的 version。续读时传回 nextOffset 和 version。',
      parameters: { type: 'object', required: ['projectId', 'id'], additionalProperties: false, properties: {
        projectId: { type: 'string' }, todoId: { type: 'string' }, id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, version: { type: 'string' },
      } },
      async execute({ projectId, todoId, id, offset = 0, version, excludeId }, signal) {
        signal.throwIfAborted();
        if (typeof projectId !== 'string' || typeof id !== 'string') fail(400, '缺少项目或消息 ID');
        const project = context.store.get<Project>('projects', projectId);
        const message = context.store.get<Message>('messages', id);
        if (todoId !== undefined && (typeof todoId !== 'string' || context.store.get<Todo>('todos', todoId)?.projectId !== projectId ||
            message?.todoId !== todoId)) fail(404, '未找到当前待办的可读消息');
        if (!project || !message || !readableMessage(message, project, excludeId)) fail(404, '未找到当前项目的可读消息');
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && typeof version !== 'string'))
          fail(400, '续读需要有效位置和原版本');
        const current = messageVersion(message.text);
        if (version !== undefined && version !== current) fail(409, '消息正文已变化，请从头读取');
        if (offset > message.text.length) fail(400, '位置超出消息正文');
        let end = Math.min(offset + 4000, message.text.length);
        if (end < message.text.length && /[\uD800-\uDBFF]/u.test(message.text[end - 1])) end--;
        return { id, projectId, projectName: project.name, role: message.role, createdAt: message.createdAt,
          status: message.status ?? 'unknown', webCitation: messageCitation(projectId, id, current), text: message.text.slice(offset, end), offset, nextOffset: end < message.text.length ? end : null, version: current };
      },
    });
    context.provide('conversation-search.projects', input => projectMessages(context.store, input));
    context.provide('conversation-search.saved', input => savedSearches(context.store, input));
  },
});

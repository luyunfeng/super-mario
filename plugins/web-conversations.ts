import type { Message } from '../packages/protocol/src/index.ts';
import type { Extension, Json, Store } from '../packages/plugin-sdk/src/index.ts';

type Conversation = { id: string; title: string; projectId?: string; createdAt: string; version?: number; archived?: boolean; creationTitle?: string };
function view(row: Conversation) {
  const { id, title, projectId, createdAt, archived = false, version = 1 } = row;
  return { id, title, ...(projectId && { projectId }), createdAt, archived, version };
}
const fields = {
  list: ['projectId', 'archived', 'query', 'role'], search: ['id', 'projectId', 'archived', 'query', 'role', 'before'], create: ['id', 'projectId', 'title'],
  get: ['id', 'projectId'], update: ['id', 'title', 'version', 'archived'],
} as const;
const collection = 'web-conversations';
const deletedCollection = 'web-conversations.deleted';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function conversationKey(value: unknown) {
  if (typeof value !== 'string' || !uuidV4.test(value)) fail(400, '对话 ID 须为 UUID v4');
  return value.toLowerCase();
}

function requireNotDeleted(store: Pick<Store,'get'>, id: string) {
  if (store.get(deletedCollection, id)) fail(410, '独立对话已删除');
}

/** Called inside the host transaction that checks dependent work and removes private history. */
export function eraseWebConversationRegistration(store: Store, id: string, version: number): void {
  const key = conversationKey(id);
  if (!Number.isSafeInteger(version) || version < 1) fail(400, '请提供有效的对话版本');
  const deleted = store.get<{ version: number }>(deletedCollection, key);
  if (deleted) {
    if (deleted.version !== version) fail(409, '删除时的对话版本不符');
    return;
  }
  const row = store.get<Conversation>(collection, key);
  if (!row) fail(404, '独立对话不存在');
  if ((row.version ?? 1) !== version) fail(409, '对话已更新，请重新读取');
  store.remove(collection, key);
  store.put(deletedCollection, key, { id: key, version, cleanupPending: true });
}

function projectStatus(store: Pick<Store,'get'>, projectId?: string) {
  if (projectId === undefined) return 'available';
  const project = store.get<{ id: string; archivedAt?: string }>('projects', projectId);
  if (!project || project.id !== projectId) return 'missing';
  return project.archivedAt ? 'archived' : 'available';
}

function requireProject(store: Pick<Store,'get'>, projectId?: string) {
  const status = projectStatus(store, projectId);
  if (status === 'missing') fail(404, '项目不存在');
  if (status === 'archived') fail(409, '项目已归档');
}

// Reading archived thread history remains possible while its project is still accessible.
export function requireWebConversationHistory(store: Pick<Store,'get'>, id: string, projectId?: string) {
  if (!uuidV4.test(id) || id !== id.toLowerCase()) fail(404, '未找到当前 Web 对话');
  requireNotDeleted(store, id);
  const row = store.get<Conversation>(collection, id);
  if (row?.id !== id || row.projectId !== projectId) fail(404, '未找到当前 Web 对话');
  requireProject(store, projectId);
  return row;
}

export function webInputFor(store:Store,row:Message,workProject:string|undefined) {
  const source = row.role==='user' ? row : row.role==='assistant' && row.replyTo ? store.get<Message>('messages',row.replyTo) : undefined;
  if (source?.role==='user' && !source.replyTo && (!source.origin || source.origin==='user') &&
      (row.role==='user' || source.id===row.replyTo) && source.conversationId===row.conversationId &&
      (source.projectId ?? workProject)===(row.projectId ?? workProject) && source.todoId===row.todoId &&
      !store.get('message.routes',source.id) && (source.id===row.id || !store.get('message.routes',row.id))) return source;
}

export function independentWebSource(store:Store,row:Message,conversationId:string,projectId?:string) {
  if (row.conversationId!==conversationId || row.projectId!==projectId || row.todoId || row.origin && row.origin!=='user') return;
  const source=webInputFor(store,row,undefined);
  return source?.directWebInput ? source : undefined;
}

export function readWebConversationExport(store:Store,id:string,projectId:string|undefined,attachments:{files:boolean;images:boolean}) {
  const {title}=requireWebConversationHistory(store,id,projectId);
  const messages=store.list<Message>('messages').filter(row=>independentWebSource(store,row,'web:'+id,projectId))
    .map(({files,images,...message})=>({...message,
      ...(message.role==='user' && attachments.files && files && {files}),
      ...(message.role==='user' && attachments.images && images && {images}),
    }));
  return {title,messages};
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
      if (action !== 'list' && action !== 'search' && action !== 'create' && action !== 'get' && action !== 'update') fail(400, '独立对话操作无效');
      const allowed: readonly string[] = ['action', ...fields[action]];
      if (Object.keys(input).some(key => !allowed.includes(key))) fail(400, '独立对话包含未知字段');
      if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim())) fail(400, '项目 ID 无效');
      if (input.archived !== undefined && typeof input.archived !== 'boolean') fail(400, '归档状态无效');
      if (action === 'list' || action === 'search') {
        requireProject(store, projectId);
        const selected = action === 'search' ? requireWebConversationHistory(store, conversationKey(input.id), projectId) : undefined;
        if (selected && (selected.archived ?? false) !== (input.archived ?? false)) fail(409, '对话归档状态已变化，请重新搜索');
        const rows=selected ? [selected] : store.list<Conversation>(collection).filter(row=>row.projectId===projectId && (row.archived ?? false)===(input.archived ?? false)).reverse();
        const threads=new Set(rows.map(row=>'web:'+row.id));
        const query=input.query;
        if(selected && query===undefined)fail(400,'请提供搜索词');
        if(query!==undefined && (typeof query!=='string' || !query.trim() || query.length>200))fail(400,'搜索词须为 1 至 200 个字符');
        const role=input.role;
        if(role!==undefined && (!query || (role!=='user' && role!=='assistant')))fail(400,'正文搜索的发言人须为本人或助手');
        const literal=query && new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'iu');
        type Hit={id:string;text:string;at:string;role:Message['role'];start:number;end:number};
        const hits=new Map<string,{recent:Hit[];count:number}>();
        const before = input.before;
        if (before !== undefined && (typeof before !== 'string' || !before)) fail(400, '分页位置无效');
        const cursor = before ? store.get<Message>('messages', before) : undefined;
        if (before && (!cursor || cursor.conversationId !== 'web:' + selected?.id || typeof cursor.createdAt !== 'string'))
          fail(409, '搜索位置已失效，请重新搜索');
        const order = (a: {at:string;id:string}, b: {at:string;id:string}) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
        let foundCursor = false;
        const latest=new Map<string,Message>();
        if(threads.size)for(const message of store.list<Message>('messages')){
          if(!threads.has(message.conversationId) || (message.role!=='user' && !(query && message.role==='assistant' && message.status==='done')) || (message.role==='user' && !message.directWebInput) || typeof message.id!=='string' || typeof message.text!=='string' || typeof message.createdAt!=='string' || !independentWebSource(store,message,message.conversationId,projectId))continue;
          if(literal && (!role || message.role===role)){
            const found=literal.exec(message.text);
            if(found){
              if (before && message.id === before) foundCursor = true;
              if (cursor && order({at:message.createdAt,id:message.id},{at:cursor.createdAt,id:cursor.id}) <= 0) continue;
              let start=Math.max(0,found.index-32),end=found.index+found[0].length+64;
              if(start && /[\uDC00-\uDFFF]/.test(message.text.charAt(start)))start--;
              if(/[\uDC00-\uDFFF]/.test(message.text.charAt(end)))end++;
              const matchStart=found.index-start+(start ? 1 : 0);
              const group=hits.get(message.conversationId) ?? {recent:[],count:0};
              group.count++;
              group.recent.unshift({id:message.id,role:message.role,at:message.createdAt,start:matchStart,end:matchStart+found[0].length,text:(start?'…':'')+message.text.slice(start,end)+(end<message.text.length?'…':'')});
              group.recent.sort(order);
              if(group.recent.length>(selected ? 21 : 3))group.recent.pop();
              hits.set(message.conversationId,group);
            }
          }
          if(message.role==='user' && message.createdAt >= (latest.get(message.conversationId)?.createdAt ?? ''))latest.set(message.conversationId,message);
        }
        if (selected) {
          if (before && !foundCursor) fail(409, '搜索位置已失效，请重新搜索');
          const recent = hits.get('web:' + selected.id)?.recent ?? [];
          const page = recent.slice(0,20);
          return { hits:page, nextBefore:recent.length > page.length ? page.at(-1)!.id : null };
        }
        const items=rows.filter(row=>!query || hits.has('web:'+row.id)).map(row=>{
          const last=latest.get('web:'+row.id);
          const group=hits.get('web:'+row.id);
          return {...view(row),...(group && {match:group.recent[0],earlierMatches:group.recent.slice(1),matchCount:group.count}),...(last && {lastInputId:last.id,lastInputAt:last.createdAt,lastInputText:[...last.text.trim().replace(/\s+/gu,' ')].slice(0,100).join('')})};
        }).sort((a,b)=>(b.match?.at || b.lastInputAt || b.createdAt).localeCompare(a.match?.at || a.lastInputAt || a.createdAt));
        return {items};
      }
      const id = conversationKey(input.id);
      if (action === 'get') {
        const row = store.get<Conversation>(collection, id);
        requireNotDeleted(store, id);
        if (!row || (projectId !== undefined && row.projectId !== projectId)) fail(404, '独立对话不存在');
        requireProject(store, row.projectId);
        return view(row);
      }
      const titleValue = input.title;
      if (titleValue !== undefined && (typeof titleValue !== 'string' || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(titleValue) || [...titleValue.trim()].length > 80))
        fail(400, '对话标题须为单行文字，最多 80 个字符');
      const title = titleValue?.trim() || '新对话';
      return store.transaction(() => {
        requireNotDeleted(store, id);
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

import { createHash, randomUUID } from 'node:crypto';
import type { Extension, ExtensionContext, Json, JsonObject, Store } from '../packages/plugin-sdk/src/index.ts';
import type { MainAssistantProfile } from '../packages/protocol/src/index.ts';

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

type Assistant = {id:string;name:string;instructions:string};
type StoredAssistant = Assistant & {revision?:number;creationHash?:string};
const assistantView = ({id,name,instructions,revision=0}:StoredAssistant) => ({id,name,instructions,revision});
const creationHash = (name:string,instructions:string) => createHash('sha256').update(JSON.stringify([name,instructions])).digest('hex');
type Thread = {id:string;projectId?:string};
type Binding = {assistantId:string;threadId:string;projectId?:string;title?:string};
const roster='assistant-profile.roster';
const bindings='assistant-profile.thread-bindings', owners='assistant-profile.thread-owners';
const uuid4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bindingKey=(assistantId:string,projectId?:string)=>JSON.stringify([assistantId,projectId??null]);

export function requireRosterAssistant(store: Pick<Store, 'get'>, id: string): void {
  if (!uuid4.test(id)) fail(400, '助理 ID 须为 UUID v4');
  if (store.get<Assistant>(roster,id)?.id !== id) fail(404, '未找到助理');
}

/** The most an avatar may take, decoded. It is kept whole in the workbench's data. */
export const AVATAR_MAX_BYTES = 256 * 1024;
/** The kinds of picture an avatar may be. SVG is not among them: it can hold a script. */
const AVATAR_TYPES: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/**
 * What the request says about the avatar: a new one, none (remove it), or nothing (leave it).
 *
 * A picture is taken only as a data address of one of the allowed kinds, whose bytes decode
 * to no more than the bound. Nothing else is kept, so the page never puts a foreign address
 * or a script where the avatar goes.
 */
export function avatarChange(value: unknown): { set: string | null } | undefined {
  if (value === undefined) return undefined;
  if (value === null) return { set: null };
  if (typeof value !== 'string' || value.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 40) fail(400, '头像无效');
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || !AVATAR_TYPES[match[1]!]) fail(400, '头像须为 PNG、JPEG、WebP 或 GIF 图片');
  const bytes = Buffer.from(match[2]!, 'base64');
  if (!bytes.length || bytes.byteLength > AVATAR_MAX_BYTES) fail(400, '头像须为 1 字节至 256 KB 的图片');
  // The bytes must begin as the address says, so a page is not offered as a picture. The whole
  // of the picture is not decoded here: the page reads a chosen picture before it is sent, and
  // one that is sent past the page and does not decode only shows as nothing to its sender.
  const head = bytes.subarray(0, 12);
  const is = {
    png: head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47,
    jpeg: head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
    webp: head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP',
    gif: ['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('latin1')),
  };
  if (!is[match[1]! as keyof typeof is]) fail(400, '图片内容和它声称的类型不一致');
  return { set: value };
}

export function readWebThreadAssistant(store: Pick<Store,'get'>, threadId:string):ReturnType<typeof assistantView>|undefined {
  const owner=store.get<Binding>(owners,threadId);
  if(!owner || owner.threadId!==threadId || store.get<Binding>(bindings,bindingKey(owner.assistantId,owner.projectId))?.threadId!==threadId) return;
  const thread=store.get<Thread>('web-conversations',threadId);
  if(thread?.id!==threadId || thread.projectId!==owner.projectId || store.get('web-conversations.deleted',threadId)) return;
  const assistant=store.get<StoredAssistant>(roster,owner.assistantId);
  return assistant?.id===owner.assistantId ? assistantView(assistant) : undefined;
}

type UseWebConversations=(input:JsonObject)=>Promise<Json>;
function provideRoster({ store, events, provide, defer, contributions }: ExtensionContext, useWebConversations?: UseWebConversations) {
  let active=true;
  defer(()=>{active=false;});
  provide(roster,async input=>{
    if(!input || typeof input!=='object' || Array.isArray(input)) fail(400,'助理名册参数无效');
    const {action}=input;
    if(action!=='list' && action!=='create' && action!=='update' && action!=='open') fail(400,'助理名册操作无效');
    const allowed=action==='list'?['action']:action==='open'?['action','id','projectId']:
      ['action','id','name','instructions',...(action==='update'?['revision']:[])];
    if(Object.keys(input).some(key=>!allowed.includes(key))) fail(400,'助理名册包含未知字段');
    if(action==='list')return {items:store.list<StoredAssistant>(roster).map(assistantView)};
    if(typeof input.id!=='string'||!uuid4.test(input.id)) fail(400,'助理 ID 须为 UUID v4');
    const id=input.id.toLowerCase();
    if(action==='create'||action==='update'){
      if(typeof input.name!=='string'||/[\p{Cc}\p{Cs}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(input.name)) fail(400,'助理名称须为单行文字');
      const name=input.name.trim();
      if(!name || [...name].length>40) fail(400,'助理名称须为 1 至 40 个字符');
      if(typeof input.instructions!=='string'||/(?![\r\n\t])[\p{Cc}\p{Cs}\p{Bidi_Control}]/u.test(input.instructions)) fail(400,'助理说明须为文字');
      const instructions=input.instructions.replace(/\r\n?/g,'\n').trim();
      if([...instructions].length>2000)fail(400,'助理说明最多 2000 个字符');
      return store.transaction(()=>{
        const prior=store.get<StoredAssistant>(roster,id);
        if(action==='update'){
          const {revision}=input;
          if(typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)
            fail(400,'助理资料版本无效');
          if(!prior)fail(404,'未找到助理');
          if((prior.revision??0)!==revision)fail(409,'助理资料已更新，请重新读取');
          if(prior.name===name && prior.instructions===instructions)return assistantView(prior);
          const next={id,name,instructions,revision:revision+1,creationHash:prior.creationHash??creationHash(prior.name,prior.instructions)};
          store.put(roster,id,next);
          events.publish('assistant-profile.roster-changed',{id});
          return assistantView(next);
        }
        if(prior){
          if((prior.creationHash??creationHash(prior.name,prior.instructions))!==creationHash(name,instructions))fail(409,'同一助理 ID 不能重复用于不同资料');
          return assistantView(prior);
        }
        const assistant={id,name,instructions,revision:0};
        store.put(roster,id,assistant);
        events.publish('assistant-profile.roster-changed',{id});
        return assistant;
      });
    }
    if(!useWebConversations || !contributions.list('services').some(s=>s.value.name==='web-conversations.manage')) fail(503,'独立 Web 对话服务不可用');
    const projectId=input.projectId;
    if(projectId!==undefined && (typeof projectId!=='string'||!projectId.trim())) fail(400,'项目 ID 无效');
    const assistant=store.get<Assistant>(roster,id);
    if(!assistant) fail(404,'未找到助理');
    if(projectId){
      const project=store.get<{id:string;archivedAt?:string}>('projects',projectId);
      if(project?.id!==projectId) fail(404,'项目不存在');
      if(project.archivedAt)fail(409,'项目已归档');
    }
    const scope=projectId===undefined?{}:{projectId};
    const key=bindingKey(id,projectId);
    // Reserve the thread ID first: every concurrent open or retry calls create with the same UUID.
    const binding=store.transaction(()=>{
      const saved=store.get<Binding>(bindings,key);
      if(saved && !store.get('web-conversations.deleted',saved.threadId))return saved;
      if(saved)store.remove(owners,saved.threadId);
      const next={assistantId:id,threadId:randomUUID(),title:assistant.name,...scope};
      store.put(bindings,key,next);
      store.put(owners,next.threadId,next);
      return next;
    });
    const threadId=binding.threadId;
    const registered=readWebThreadAssistant(store,threadId);
    const result=await useWebConversations(registered?{action:'get',id:threadId,...(projectId && {projectId})}:
      {action:'create',id:threadId,title:binding.title??assistant.name,...(projectId && {projectId})});
    if(!active)fail(503,'助理名册已停用');
    if(!result || typeof result!=='object'||Array.isArray(result)||result.id!==threadId||result.projectId!==projectId)
      fail(409,'独立对话登记与助理不符');
    return store.transaction(()=>{
      const thread=store.get<Thread>('web-conversations',threadId);
      if(store.get<Binding>(bindings,key)?.threadId!==threadId || thread?.id!==threadId ||
        thread.projectId!==projectId || store.get('web-conversations.deleted',threadId))fail(409,'助理对话已变更，请重新打开');
      return {threadId};
    });
  });
}

export function createAssistantProfile(useWebConversations?:UseWebConversations): Extension {
  return {
    id: 'assistant-profile', name: '主助手资料', capabilities: ['assistant.profile','assistant.roster'],
    permissions: ['service.provide:assistant-profile.manage', 'service.provide:assistant-profile.roster', 'store.read', 'store.write', 'events.publish'],
    activate(context) {
      provideRoster(context, useWebConversations);
      const { store, events, provide } = context;
      const read = (): MainAssistantProfile => store.get<MainAssistantProfile>('assistant-profile', 'main') ?? { name: '主 Agent', revision: 0 };
      provide('assistant-profile.manage', input => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '主助手资料参数必须为对象');
        const { action, revision } = input;
        if (action !== 'read' && action !== 'save') fail(400, '主助手资料操作无效');
        const allowed = action === 'read' ? ['action'] : ['action', 'name', 'revision', 'avatar'];
        if (Object.keys(input).some(key => !allowed.includes(key))) fail(400, '主助手资料包含未知字段');
        if (action === 'read') return read();
        if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
          fail(400, '主助手资料版本无效');
        // Check the original string before trimming so a leading newline or tab cannot be hidden.
        if (typeof input.name !== 'string' || /[\p{Cc}\p{Cs}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(input.name))
          fail(400, '名称不能包含控制字符或换行');
        const name = input.name.trim();
        if (!name || name.length > 80 || Array.from(name).length > 40) fail(400, '名称须为 1 至 40 个字符');
        // The avatar is checked before anything is written, so a bad one changes nothing.
        const avatar = avatarChange(input.avatar);
        return store.transaction(() => {
          const current = read();
          if (current.revision !== revision) fail(409, '主助手资料已更新，请重新加载');
          const nextAvatar = avatar === undefined ? current.avatar : avatar.set === null ? undefined : avatar.set;
          if (name === current.name && nextAvatar === current.avatar) return current;
          const next: MainAssistantProfile = { name, revision: revision + 1, ...(nextAvatar ? { avatar: nextAvatar } : {}) };
          store.put('assistant-profile', 'main', next);
          events.publish('assistant-profile.changed', { revision: next.revision });
          return next;
        });
      });
    },
  };
}

export const assistantProfile=createAssistantProfile();

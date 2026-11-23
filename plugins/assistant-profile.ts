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
        const allowed = action === 'read' ? ['action'] : ['action', 'name', 'revision'];
        if (Object.keys(input).some(key => !allowed.includes(key))) fail(400, '主助手资料包含未知字段');
        if (action === 'read') return read();
        if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
          fail(400, '主助手资料版本无效');
        // Check the original string before trimming so a leading newline or tab cannot be hidden.
        if (typeof input.name !== 'string' || /[\p{Cc}\p{Cs}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(input.name))
          fail(400, '名称不能包含控制字符或换行');
        const name = input.name.trim();
        if (!name || name.length > 80 || Array.from(name).length > 40) fail(400, '名称须为 1 至 40 个字符');
        return store.transaction(() => {
          const current = read();
          if (current.revision !== revision) fail(409, '主助手资料已更新，请重新加载');
          if (name === current.name) return current;
          const next = { name, revision: revision + 1 };
          store.put('assistant-profile', 'main', next);
          events.publish('assistant-profile.changed', { revision: next.revision });
          return next;
        });
      });
    },
  };
}

export const assistantProfile=createAssistantProfile();

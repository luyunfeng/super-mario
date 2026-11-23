import {checkedResult,phaseLabels,record,traceObject} from './tool-trace-public-fields.ts';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Extension,Json,JsonObject,Store} from '../packages/plugin-sdk/src/index.ts';
import type {Message,Project,Todo} from '../packages/protocol/src/index.ts';
import {publicText} from './agent-progress-card.ts';

const shares='conversation-sharing.shares', snapshots='conversation-sharing.snapshots', tokens='conversation-sharing.tokens';
type ToolRecord={name:string;status:'succeeded'|'failed'|'unknown';args?:string;result?:string};
type Excerpt={role:'user'|'assistant';text:string;tools?:ToolRecord[]};
type Share={showTools?:boolean;revision?:number;id:string;conversationId:string;createdAt:string;expiresAt:string;revokedAt?:string;messageCount:number;tokenHash:string};
type Snapshot={ids:string[];messages:Excerpt[];scopeHash:string};

function fail(status:number,message:string):never {throw Object.assign(Error(message),{status});}
function missing():never {return fail(404,'分享不存在或已失效');}
function hash(value:string) {return createHash('sha256').update(value).digest('hex');}
function args(raw:Json):JsonObject {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) fail(400,'分享请求格式无效');
  return raw;
}
function scope(store:Store,value:Json|undefined,allowArchived=false) {
  if (value==='main') return 'main';
  const match=typeof value==='string' && /^project:([^:]{1,256}):(work|memory)$/.exec(value);
  if (!match) return missing();
  const project=store.get<Project>('projects',match[1]!);
  if (!project || project.id!==match[1] || (!allowArchived && project.archivedAt)) return missing();
  return String(value);
}
function sourceRow(store:Store,conversationId:string,id:string) {
  const row=store.get<Message>('messages',id);
  if (!row || row.id!==id || row.conversationId!==conversationId || row.status!=='done' || row.queueState ||
      (row.origin && row.origin!=='user') || row.runResult || row.stoppedByUser || store.get('message.routes',id)) return missing();
  if (conversationId!=='main' && conversationId!==`project:${row.projectId}:work` && conversationId!==`project:${row.projectId}:memory`) return missing();
  if (row.projectId) {
    const project=store.get<Project>('projects',row.projectId);
    if (project?.id!==row.projectId || project.archivedAt) return missing();
  }
  if (row.todoId) {
    const todo=store.get<Todo>('todos',row.todoId);
    if (todo?.id!==row.todoId || todo.projectId!==row.projectId) return missing();
  }
  return row;
}
function selected(store:Store,conversationId:string,ids:string[]) {
  return ids.map(id=>{
    const row=sourceRow(store,conversationId,id);
    if (row.role!=='user' && row.role!=='assistant') return missing();
    const source=row.role==='user' ? row : row.replyTo && sourceRow(store,conversationId,row.replyTo);
    if (!source || source.role!=='user' || !source.directWebInput || source.replyTo || source.projectId!==row.projectId ||
        source.todoId!==row.todoId || !row.text?.trim()) return missing();
    return row;
  });
}
function visibleText(raw:string,workspaceToken:string) {
  const hidden='[凭证已隐藏]';
  let text=workspaceToken ? raw.replaceAll(workspaceToken,hidden) : raw;
  text=text.replace(/\bdata:[^\s<>"')]+/gi,'[内嵌数据已隐藏]')
    .replace(/\bhttps?:\/\/[^\s\/@]+:[^\s\/@]+@/gi,'https://[凭证已隐藏]@')
    .replace(/\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-)[\w-]{8,}|\bAKIA[A-Z0-9]{16}\b|\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g,hidden)
    .replace(/((?:密码|口令|密钥|令牌|验证码)\s*[：:=]\s*)[^\s，。；;]+/gu,'$1'+hidden)
    .replace(/([#/]share[\/#])[A-Za-z0-9_-]{32,}/gi,'$1'+hidden)
    .replace(/((?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi,'$1'+hidden)
    .replace(/(?:[A-Za-z0-9+/]{256,}={0,2})/g,'[内嵌数据已隐藏]');
  return publicText(text,262144);
}
function searchArgs(args:Record<string,unknown>|undefined,sourceText:string|undefined) {
  if (!args || Object.keys(args).some(k=>!['category','query','before'].includes(k))) return;
  const safe:Record<string,string>={};
  // An assistant may derive a search from private context. Only quote words the
  // owner is sharing in this very turn; a hidden source is never made visible.
  if (typeof args.query==='string' && args.query.trim() && args.query.length<=500 && sourceText?.includes(args.query)) safe.query=args.query;
  if (typeof args.category==='string' && ['text','quoted','file','tool_name','event','tool_input','tool_output'].includes(args.category)) safe.category=args.category;
  return Object.keys(safe).length ? JSON.stringify(safe) : undefined;
}
function toolRecords(store:Store,row:Message,sourceText:string|undefined) {
  const trace=store.get<{id:string;conversationId:string;userMessageId:string;projectId?:string;toolCalls:unknown[]}>('agent.traces',row.id);
  if (!trace || trace.id!==row.id || trace.conversationId!==row.conversationId || trace.userMessageId!==row.replyTo ||
      trace.projectId!==row.projectId || !Array.isArray(trace.toolCalls)) return [];
  const tools:ToolRecord[]=[];
  for (const call of trace.toolCalls) {
    if (!record(call) || typeof call.name!=='string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(call.name)) continue;
    const completed=typeof call.result==='string' && typeof call.isError==='boolean';
    const item:ToolRecord={name:call.name,status:completed ? (call.isError?'failed':'succeeded') : 'unknown'};
    if (call.name==='current_web_message_search') {
      const args=searchArgs(traceObject(call.args,32768),sourceText);
      if (args) item.args=args;
    } else if (call.name==='conversation_status' && item.status==='succeeded') {
      const phase=checkedResult(call)?.phase;
      if (typeof phase==='string' && Object.hasOwn(phaseLabels,phase)) item.result=JSON.stringify({phase});
    }
    tools.push(item);
  }
  return tools;
}
function selectionIds(value:Json|undefined) {
  if (!Array.isArray(value) || !value.length || value.length>100 || new Set(value).size!==value.length ||
      !value.every((id):id is string=>typeof id==='string' && id.length>0 && id.length<=256)) fail(400,'请选择 1 至 100 条不同的消息');
  return value;
}
function scopeFingerprint(rows:Message[]) {
  return hash(JSON.stringify(rows.map(row=>[row.id,row.role,row.replyTo,row.projectId,row.todoId])));
}
function currentSnapshot(store:Store,share:Share) {
  if (share.revokedAt || !(Date.parse(share.expiresAt)>Date.now())) return missing();
  const snapshot=store.get<Snapshot>(snapshots,share.id);
  if (!snapshot || scopeFingerprint(selected(store,scope(store,share.conversationId),snapshot.ids))!==snapshot.scopeHash) return missing();
  return snapshot;
}
function checkRevision(value:Json|undefined,share:Share) {
  if (typeof value!=='number' || !Number.isSafeInteger(value) || value<1) fail(400,'需要有效的分享版本');
  if (value!==(share.revision??1)) fail(409,'分享已经修改，请刷新后重试');
}
export function createConversationSharing(workspaceToken=''):Extension {
  return {id:'conversation-sharing',name:'对话摘录分享',capabilities:['conversation.sharing'],
    permissions:['store.read','store.write','service.provide:conversation-sharing.manage','service.provide:conversation-sharing.read'],
    activate({store,provide}) {
      provide('conversation-sharing.manage',(raw,signal)=>store.transaction(():Json=>{
        signal.throwIfAborted();
        const input=args(raw), action=input.action;
        const conversationId=scope(store,input.conversationId,action==='list' || action==='revoke');
        if (action==='list') {
          return {shares:store.list<Share>(shares).filter(s=>s.conversationId===conversationId).reverse()
            .map(({id,createdAt,expiresAt,revokedAt,messageCount,revision=1,showTools=false})=>({id,revision,showTools,createdAt,expiresAt,...(revokedAt && {revokedAt}),messageCount}))};
        }
        const editing=action==='detail' || action==='update' || (action==='preview' && input.id!==undefined);
        let share:Share|undefined, original:Snapshot|undefined;
        if (editing || action==='revoke') {
          const found=typeof input.id==='string' && store.get<Share>(shares,input.id);
          if (!found || found.id!==input.id || found.conversationId!==conversationId) return missing();
          share=found;
          if (action==='revoke') {
            if (input.revision!==undefined) checkRevision(input.revision,share);
            if (!share.revokedAt) {
              store.put(shares,share.id,{...share,revokedAt:new Date().toISOString()});
              store.remove(tokens,share.tokenHash);store.remove(snapshots,share.id);
            }
            return {revoked:true};
          }
          original=currentSnapshot(store,share);
          if (action==='detail') return {id:share.id,revision:share.revision??1,showTools:share.showTools??false,messageIds:original.ids,expiresAt:share.expiresAt,messages:original.messages};
          checkRevision(input.revision,share);
        } else if (input.id!==undefined || input.revision!==undefined) fail(400,'分享标识与操作不匹配');
        if (action!=='preview' && action!=='create' && action!=='update') fail(400,'分享操作无效');
        // null means retain the exact expiry even when preview and update occur at different times.
        const hours=input.expireHours===undefined ? (editing ? null : 24) : input.expireHours;
        if (hours!==null && (typeof hours!=='number' || !Number.isInteger(hours) || hours<1 || hours>720) || input.expireHours===null)
          fail(400,'分享期限须为 1 至 720 小时');
        const ids=selectionIds(input.messageIds), rows=selected(store,conversationId,ids);
        const retained=new Map(original?.ids.map((id,i)=>[id,original.messages[i]!]));
        const texts=rows.map(row=>retained.get(row.id)?.text??row.text);
        if (texts.reduce((n,text)=>n+Buffer.byteLength(text),0)>262144) fail(400,'选择的正文超过 256 KiB');
        const showTools=input.showTools===undefined ? (share?.showTools??false) : input.showTools;
        if (typeof showTools!=='boolean') fail(400,'请选择是否分享工具记录');
        const excerpts=new Map(rows.map(row=>[row.id,retained.get(row.id)?.text??visibleText(row.text,workspaceToken)]));
        const messages=rows.map((row):Excerpt=>{
          const message:Excerpt={role:row.role,text:excerpts.get(row.id)!};
          if (showTools && row.role==='assistant') {
            const sourceText=row.replyTo && excerpts.get(row.replyTo);
            const previous=retained.get(row.id);
            const tools=previous && share?.showTools ? (previous.tools??[]).map(tool=>{
              if (tool.name!=='current_web_message_search' || !tool.args) return tool;
              // Removing the original question must also remove its echoed private search words.
              const {args,...rest}=tool,allowed=searchArgs(traceObject(args,32768),sourceText);
              return allowed ? {...rest,args:allowed} : rest;
            }) : toolRecords(store,row,sourceText);
            if (tools.length) message.tools=tools;
          }
          return message;
        });
        if (Buffer.byteLength(JSON.stringify(messages))>262144)
          fail(400,'分享摘录超过 256 KiB，请减少所选消息或关闭工具记录');
        const scopeHash=scopeFingerprint(rows);
        const previewHash=hash(JSON.stringify([conversationId,share?.id,share?.revision??1,hours??share?.expiresAt,showTools,scopeHash,texts,messages]));
        if (action==='preview') return {messages,previewHash};
        if (input.previewHash!==previewHash) fail(409,'消息已变化，请重新预览');
        if (share) {
          const expiresAt=hours===null ? share.expiresAt : new Date(Date.now()+hours*3600000).toISOString();
          const revision=(share.revision??1)+1;
          store.put(snapshots,share.id,{ids,messages,scopeHash});
          store.put(shares,share.id,{...share,expiresAt,revision,showTools,messageCount:ids.length});
          return {id:share.id,expiresAt,revision};
        }
        const now=Date.now(), existing=store.list<Share>(shares);
        // Drop expired snapshots before admitting another; keep recent metadata for the owner's list.
        for (const share of existing) if (Date.parse(share.expiresAt)<=now) {
          store.remove(snapshots,share.id);store.remove(tokens,share.tokenHash);
          if (Date.parse(share.expiresAt)<now-30*86400000) store.remove(shares,share.id);
        }
        const inactive=existing.filter(s=>s.revokedAt || Date.parse(s.expiresAt)<=now);
        for (const old of inactive.slice(0,Math.max(0,inactive.length-512))) store.remove(shares,old.id);
        const active=existing.filter(s=>!s.revokedAt && Date.parse(s.expiresAt)>now);
        if (active.length>=256 || active.filter(s=>s.conversationId===conversationId).length>=64) fail(409,'有效分享已达上限，请先撤销旧分享');
        const id=randomUUID(),token=randomBytes(32).toString('base64url'),tokenHash=hash(token);
        const createdAt=new Date(now).toISOString(),expiresAt=new Date(now+(hours??24)*3600000).toISOString();
        store.put(shares,id,{id,revision:1,showTools,conversationId,createdAt,expiresAt,messageCount:ids.length,tokenHash});
        store.put(snapshots,id,{ids,messages,scopeHash});store.put(tokens,tokenHash,id);
        return {id,token,expiresAt};
      }));
      provide('conversation-sharing.read',(raw,signal)=>store.transaction(():Json=>{
        signal.throwIfAborted();
        const {token,knownRevision}=args(raw);
        if (typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return missing();
        const digest=hash(token),id=store.get<string>(tokens,digest),share=id && store.get<Share>(shares,id);
        if (!share || share.id!==id || share.tokenHash!==digest) return missing();
        const snapshot=currentSnapshot(store,share);
        const revision=share.revision??1;
        return knownRevision===revision ? {unchanged:true,expiresAt:share.expiresAt,revision} : {messages:snapshot.messages,expiresAt:share.expiresAt,revision};
      }));
    }};
}

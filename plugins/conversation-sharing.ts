import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Extension,Json,JsonObject,Store} from '../packages/plugin-sdk/src/index.ts';
import type {Message,Project,Todo} from '../packages/protocol/src/index.ts';
import {publicText} from './agent-progress-card.ts';

const shares='conversation-sharing.shares', snapshots='conversation-sharing.snapshots', tokens='conversation-sharing.tokens';
type Excerpt={role:'user'|'assistant';text:string};
type Share={id:string;conversationId:string;createdAt:string;expiresAt:string;revokedAt?:string;messageCount:number;tokenHash:string};
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
function selectionIds(value:Json|undefined) {
  if (!Array.isArray(value) || !value.length || value.length>100 || new Set(value).size!==value.length ||
      !value.every((id):id is string=>typeof id==='string' && id.length>0 && id.length<=256)) fail(400,'请选择 1 至 100 条不同的消息');
  return value;
}
function scopeFingerprint(rows:Message[]) {
  return hash(JSON.stringify(rows.map(row=>[row.id,row.role,row.replyTo,row.projectId,row.todoId])));
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
            .map(({id,createdAt,expiresAt,revokedAt,messageCount})=>({id,createdAt,expiresAt,...(revokedAt && {revokedAt}),messageCount}))};
        }
        if (action==='revoke') {
          const share=typeof input.id==='string' && store.get<Share>(shares,input.id);
          if (!share || share.conversationId!==conversationId) return missing();
          if (!share.revokedAt) {
            store.put(shares,share.id,{...share,revokedAt:new Date().toISOString()});
            store.remove(tokens,share.tokenHash);store.remove(snapshots,share.id);
          }
          return {revoked:true};
        }
        if (action!=='preview' && action!=='create') fail(400,'分享操作无效');
        const hours=input.expireHours===undefined ? 24 : input.expireHours;
        if (typeof hours!=='number' || !Number.isInteger(hours) || hours<1 || hours>720) fail(400,'分享期限须为 1 至 720 小时');
        const ids=selectionIds(input.messageIds), rows=selected(store,conversationId,ids);
        if (rows.reduce((n,row)=>n+Buffer.byteLength(row.text),0)>262144) fail(400,'选择的正文超过 256 KiB');
        const messages=rows.map(row=>({role:row.role,text:visibleText(row.text,workspaceToken)}));
        const scopeHash=scopeFingerprint(rows);
        const previewHash=hash(JSON.stringify([conversationId,hours,scopeHash,rows.map(row=>row.text),messages]));
        if (action==='preview') return {messages,previewHash};
        if (input.previewHash!==previewHash) fail(409,'消息已变化，请重新预览');
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
        const createdAt=new Date(now).toISOString(),expiresAt=new Date(now+hours*3600000).toISOString();
        store.put(shares,id,{id,conversationId,createdAt,expiresAt,messageCount:ids.length,tokenHash});
        store.put(snapshots,id,{ids,messages,scopeHash});store.put(tokens,tokenHash,id);
        return {id,token,expiresAt};
      }));
      provide('conversation-sharing.read',(raw,signal)=>store.transaction(():Json=>{
        signal.throwIfAborted();
        const token=args(raw).token;
        if (typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return missing();
        const digest=hash(token),id=store.get<string>(tokens,digest),share=id && store.get<Share>(shares,id);
        if (!share || share.id!==id || share.tokenHash!==digest || share.revokedAt || !(Date.parse(share.expiresAt)>Date.now())) return missing();
        const snapshot=store.get<Snapshot>(snapshots,share.id);
        if (!snapshot || scopeFingerprint(selected(store,scope(store,share.conversationId),snapshot.ids))!==snapshot.scopeHash) return missing();
        return {messages:snapshot.messages,expiresAt:share.expiresAt};
      }));
    }};
}

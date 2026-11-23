import type {Json,Store} from '../packages/plugin-sdk/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';

export type FutureScope={projectId?:string;todoId?:string};
type Checkpoint={cursor:number;pending:string[];users:string[]};
const checkpoints='conversation-sharing.follow';
function fail(status:number,message:string):never {throw Object.assign(Error(message),{status});}

export function futureScopeFor(value:Json|undefined,original:FutureScope|undefined,enabled:boolean,rows:Message[]) {
  if (value===undefined && !enabled) return original;
  const candidate=value??original;
  if (!candidate || typeof candidate!=='object' || Array.isArray(candidate) ||
      Object.keys(candidate).some(key=>!['projectId','todoId'].includes(key)) ||
      Object.values(candidate).some(v=>typeof v!=='string' || !v.trim() || v.length>256) ||
      (value===null || (!enabled && !original))) fail(400,'请选择后续消息的确切项目和待办范围');
  const scope:FutureScope={...(candidate.projectId && {projectId:candidate.projectId as string}),
    ...(candidate.todoId && {todoId:candidate.todoId as string})};
  if (original && (original.projectId!==scope.projectId || original.todoId!==scope.todoId)) fail(409,'已确认的后续消息范围不能更改');
  if (enabled && rows.some(m=>m.projectId!==scope.projectId || m.todoId!==scope.todoId)) fail(400,'所选消息与后续消息的范围不一致');
  return scope;
}
export function startFollowing(store:Store,id:string) {
  if (!store.lastMessagePosition || !store.messagesAfterPosition) fail(503,'此存储暂不支持核验后续消息的顺序');
  store.put(checkpoints,id,{cursor:store.lastMessagePosition(),pending:[],users:[]});
}
export function stopFollowing(store:Store,id:string) {store.remove(checkpoints,id);}

/** Keep unfinished rows, since updates never change their persistent insertion position.
 * Remember eligible input ids independently from manually selected old messages. */
export function collectFuture(store:Store,id:string,conversationId:string,scope:FutureScope,visibleIds:Set<string>,
  append:(row:Message)=>'added'|'skip'|'full') {
  const before=store.get<Checkpoint>(checkpoints,id);
  if (!before || !store.messagesAfterPosition) {startFollowing(store,id);return;}
  const pending:string[]=[], users=new Set(before.users.filter(key=>visibleIds.has(key)));
  let full=false,cursor=before.cursor;
  function visit(row:Message|undefined,key:string) {
    if (!row || full || row.id!==key || row.conversationId!==conversationId || row.projectId!==scope.projectId ||
        row.todoId!==scope.todoId || (row.origin && row.origin!=='user') || row.runResult || row.stoppedByUser) return;
    if (row.role==='user' ? !row.directWebInput || row.replyTo : row.role!=='assistant' || !row.replyTo ||
        (!users.has(row.replyTo) && !pending.includes(row.replyTo))) return;
    if (store.get('message.routes',row.id)) return;
    if (row.status==='pending' || (row.status==='done' && row.role==='assistant' && pending.includes(row.replyTo!))) {pending.push(key);return;}
    if (row.status!=='done' || visibleIds.has(key)) return;
    const outcome=append(row);
    if (outcome==='full') full=true;
    if (outcome==='added') {visibleIds.add(key);if (row.role==='user') users.add(key);}
  }
  for (const key of before.pending) visit(store.get<Message>('messages',key),key);
  while (!full) {
    const page=store.messagesAfterPosition<Message>(cursor,128);
    for (const {id:key,position,value} of page) {cursor=position;visit(value,key);if(full) break;}
    if (page.length<128) break;
  }
  if (full) stopFollowing(store,id);
  else if (cursor!==before.cursor || users.size!==before.users.length || pending.length!==before.pending.length)
    store.put(checkpoints,id,{cursor,pending,users:[...users]});
}

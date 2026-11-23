import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {InputError,type createWorkbench} from '../../../packages/core/src/workbench.ts';
import type {createPersonalPins} from '../../../plugins/feishu-personal-pins.ts';
import {createInboxMessageAccess,type InboxPersonalActor} from './feishu-inbox-message-access.ts';

export function createInboxPins(app:Awaited<ReturnType<typeof createWorkbench>>, platform:ReturnType<typeof createPersonalPins>,
  account:InboxPersonalActor) {
  const {binding,verify,messagePattern,original,cursorBinding,mutate}=createInboxMessageAccess(app,account,'feishu-chat-pins','置顶');
  const secret=randomBytes(32);
  const originalRef=(stamp:string,messageId:string)=>createHmac('sha256',secret)
    .update(JSON.stringify(['pin-original',stamp,messageId])).digest('base64url');
  async function list(id:string,cursor:string|undefined,signal:AbortSignal) {
    signal.throwIfAborted();
    const target=binding(id);
    const paging=cursorBinding([target.key,target.chatId,target.generation,target.epoch]);
    const token=paging.decode(cursor);
    const page=await platform.list(target.account,target.chatId,signal,token);
    verify(id,target.stamp,signal);
    const pins=page.items.map(({messageId,pinnedAt})=>{
      const row=original(target.source,target.chatId,messageId);
      const characters=row?Array.from(row.text):[];
      return {messageId,originalRef:originalRef(target.stamp,messageId),...(pinnedAt && {pinnedAt}),...(row && {inboxId:row.id,text:characters.slice(0,500).join(''),textTruncated:characters.length>500})};
    });
    return {accountKey:target.key,pins,...(page.nextCursor && {nextCursor:paging.encode(page.nextCursor)})};
  }
  async function write(id:string,input:Record<string,unknown>,signal:AbortSignal) {
    const target=binding(id),{accountKey,action,messageId,requestId}=input;
    if(Object.keys(input).some(k=>!['accountKey','action','messageId','requestId'].includes(k)) ||
      (action!=='pin' && action!=='unpin') || typeof messageId!=='string' || !messagePattern.test(messageId) ||
      typeof requestId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new InputError('置顶操作参数无效');
    if(accountKey!==target.key) throw new InputError('个人账号已变化，请重新打开',409);
    if(action==='pin' && messageId!==target.messageId) throw new InputError('只能置顶当前原始收件',403);
    return mutate(id,target,signal,{
      key:'feishu-pin:'+target.key+':'+requestId,kind:'feishu-chat-pin',summary:'变更飞书会话置顶',
      content:{chatId:target.chatId,messageId,action},send:async beforeWrite=>{
        await platform.write(target.account,target.chatId,messageId,action==='pin',signal,beforeWrite);
        return {confirmed:true,messageId,action};
      }});
  }
  async function locate(id:string,messageId:string,accountKey:string|null,signal:AbortSignal) {
    signal.throwIfAborted();
    const target=binding(id);
    if(accountKey!==target.key) throw new InputError('个人账号已变化，请重新打开',409);
    if(!messagePattern.test(messageId)) throw new InputError('原消息标识无效');
    const remote=await platform.locate(target.account,target.chatId,messageId,signal);
    verify(id,target.stamp,signal);
    if(remote.messageId!==messageId || remote.chatId!==target.chatId) throw new InputError('原消息不属于当前会话',404);
    if(remote.deleted || app.waitingReplies.observedSource(target.source,target.chatId,messageId)?.deleted)
      return {chatId:target.chatId,messageId,deleted:true};
    const row=original(target.source,target.chatId,messageId);
    return {...remote,...(row && {inboxId:row.id})};
  }
  function listedTarget(id:string,messageId:string,ref:string) {
    const target=binding(id);
    const expected=originalRef(target.stamp,messageId);
    if(typeof ref!=='string' || ref.length!==expected.length || !/^[A-Za-z0-9_-]+$/.test(ref) ||
      !timingSafeEqual(Buffer.from(ref),Buffer.from(expected))) throw new InputError('置顶原文引用已失效，请重新读取列表',403);
    return target;
  }
  async function readListedOriginal(id:string,messageId:string,ref:string,signal:AbortSignal) {
    const target=listedTarget(id,messageId,ref);
    const original=await locate(id,messageId,target.key,signal);
    // The model needs the selected original only, never additional local links.
    const {messageId:matched,deleted,text,createdAt,parentId,threadId}=original;
    return {messageId:matched,deleted,text,createdAt,parentId,threadId};
  }
  async function topic(id:string,messageId:string,accountKey:string|null,cursor:string|undefined,signal:AbortSignal) {
    signal.throwIfAborted();
    const target=binding(id);
    if(accountKey!==target.key) throw new InputError('个人账号已变化，请重新打开',409);
    if(!messagePattern.test(messageId)) throw new InputError('原消息标识无效');
    const deleted=(msg:string)=>!!app.waitingReplies.observedSource(target.source,target.chatId,msg)?.deleted;
    if(deleted(messageId)) throw new InputError('原消息已撤回',410);
    const paging=cursorBinding(['pin-topic',target.stamp,messageId]);
    const continuation=paging.decode(cursor);
    // Only our signed token can supply the expected remote thread. The adapter compares
    // it with the live source message before presenting the token to the remote service.
    const [expectedThreadId,remoteCursor]:[string?,string?]=continuation?JSON.parse(continuation):[];
    const page=await platform.topic(target.account,target.chatId,messageId,signal,remoteCursor,expectedThreadId);
    verify(id,target.stamp,signal);
    if(deleted(messageId)) throw new InputError('原消息已撤回',410);
    if(expectedThreadId && page.threadId!==expectedThreadId) throw new InputError('原消息的话题已变化，请重新打开',409);
    const visible=(item:typeof page.messages[number])=>deleted(item.messageId) || item.deleted
      ? {messageId:item.messageId,deleted:true}:item;
    return {threadId:page.threadId,...(page.root && {root:visible(page.root)}),messages:page.messages.map(visible),
      ...(page.nextCursor && {nextCursor:paging.encode(JSON.stringify([page.threadId,page.nextCursor]))})};
  }
  function readListedTopic(id:string,messageId:string,ref:string,cursor:string|undefined,signal:AbortSignal) {
    const target=listedTarget(id,messageId,ref);
    return topic(id,messageId,target.key,cursor,signal);
  }
  return {list,write,locate,readListedOriginal,topic,readListedTopic};
}

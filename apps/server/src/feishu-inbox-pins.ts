import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {EffectError} from '../../../packages/core/src/effects.ts';
import {InputError, type createWorkbench} from '../../../packages/core/src/workbench.ts';
import {inboxItemId} from '../../../packages/core/src/inbox.ts';
import type {InboxItem} from '../../../packages/protocol/src/index.ts';
import type {PersonalAccount} from '../../../plugins/feishu-personal.ts';
import type {createPersonalPins} from '../../../plugins/feishu-personal-pins.ts';

export function createInboxPins(app:Awaited<ReturnType<typeof createWorkbench>>, platform:ReturnType<typeof createPersonalPins>,
  account:()=>{account:PersonalAccount;key:string;generation:number}|undefined) {
  // A restarted service requires reopening the first page. No raw remote cursor is ever accepted.
  const secret=randomBytes(32);
  const messagePattern=/^om_[A-Za-z0-9_-]{1,256}$/;
  function original(source:string,chatId:string,messageId:string) {
    const thread='feishu:message:'+JSON.stringify([chatId,messageId]);
    const id=inboxItemId(source,thread), item=app.store.get<InboxItem>('inbox',id);
    if(item?.id===id && item.source===source && item.thread===thread && item.origin?.chatId===chatId &&
      item.last.split(':')[0]===messageId && !app.waitingReplies.observedSource(source,chatId,messageId)?.deleted) return item;
  }
  function binding(id:string) {
    const plugins=['feishu','feishu-chat-pins'];
    if(!plugins.every(id=>app.plugins.list().some(p=>p.id===id && p.status==='active')))
      throw new InputError('飞书或会话置顶插件已停用',503);
    const actor=account();
    if(!actor) throw new InputError('请先核验个人飞书账号',409);
    const source='feishu:'+actor.account.appId+':'+actor.account.openId;
    const row=app.store.get<InboxItem>('inbox',id),chatId=row?.origin?.chatId,messageId=row?.last.split(':')[0];
    if(!chatId || !/^oc_[A-Za-z0-9_-]{1,256}$/.test(chatId) || !messageId || !messagePattern.test(messageId) ||
      original(source,chatId,messageId)?.id!==id) throw new InputError('当前个人飞书账号没有这条原始收件',404);
    const epoch=plugins.map(id=>app.store.get<{revision:number}>('core.plugin-settings',id)?.revision??1);
    const stamp=JSON.stringify([actor.key,actor.generation,chatId,messageId,epoch]);
    return {...actor,chatId,messageId,source,stamp,epoch};
  }
  function verify(id:string,stamp:string,signal:AbortSignal) {
    signal.throwIfAborted();
    if(binding(id).stamp!==stamp) throw new InputError('账号、原始收件或插件已变化，请重新打开',409);
  }
  const originalRef=(stamp:string,messageId:string)=>createHmac('sha256',secret)
    .update(JSON.stringify(['pin-original',stamp,messageId])).digest('base64url');
  async function list(id:string,cursor:string|undefined,signal:AbortSignal) {
    signal.throwIfAborted();
    const target=binding(id);
    const sign=(token:string)=>createHmac('sha256',secret).update(JSON.stringify([target.key,target.chatId,target.generation,target.epoch,token])).digest('base64url');
    let token:string|undefined;
    if(cursor!==undefined){
      const [signature,value,...extra]=cursor.split('.');
      const expected=sign(value??'');
      if(!value || extra.length || cursor.length>16384 || !signature || !/^[A-Za-z0-9_-]+$/.test(value) ||
        signature.length!==expected.length || !/^[A-Za-z0-9_-]+$/.test(signature) || !timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))
        throw new InputError('置顶列表分页已失效，请重新读取',400);
      token=Buffer.from(value,'base64url').toString('utf8');
    }
    const page=await platform.list(target.account,target.chatId,signal,token);
    verify(id,target.stamp,signal);
    const pins=page.items.map(({messageId,pinnedAt})=>{
      const row=original(target.source,target.chatId,messageId);
      const characters=row?Array.from(row.text):[];
      return {messageId,originalRef:originalRef(target.stamp,messageId),...(pinnedAt && {pinnedAt}),...(row && {inboxId:row.id,text:characters.slice(0,500).join(''),textTruncated:characters.length>500})};
    });
    const next=page.nextCursor && Buffer.from(page.nextCursor).toString('base64url');
    return {accountKey:target.key,pins,...(next && {nextCursor:sign(next)+'.'+next})};
  }
  async function write(id:string,input:Record<string,unknown>,signal:AbortSignal) {
    const target=binding(id),{accountKey,action,messageId,requestId}=input;
    if(Object.keys(input).some(k=>!['accountKey','action','messageId','requestId'].includes(k)) ||
      (action!=='pin' && action!=='unpin') || typeof messageId!=='string' || !messagePattern.test(messageId) ||
      typeof requestId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new InputError('置顶操作参数无效');
    if(accountKey!==target.key) throw new InputError('个人账号已变化，请重新打开',409);
    if(action==='pin' && messageId!==target.messageId) throw new InputError('只能置顶当前原始收件',403);
    const result=await app.effects.perform({
      key:'feishu-pin:'+target.key+':'+requestId,kind:'feishu-chat-pin',target:id,summary:'变更飞书会话置顶',
      content:{chatId:target.chatId,messageId,action},run:async()=>{
        let attempted=false;
        try{
          verify(id,target.stamp,signal);
          await platform.write(target.account,target.chatId,messageId,action==='pin',signal,async()=>{
            verify(id,target.stamp,signal);
            attempted=true;
          });
          return {confirmed:true,messageId,action};
        } catch(error) {
          const unknown=attempted && !(error && typeof error==='object' && 'delivery' in error && error.delivery==='no');
          throw new EffectError(unknown?'飞书置顶操作的回执未知，请刷新置顶列表核实。':'飞书置顶操作未执行，请核实个人授权、原消息和会话。',unknown?'unknown':'no');
        }
      }});
    verify(id,target.stamp,signal);
    return result;
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
  async function readListedOriginal(id:string,messageId:string,ref:string,signal:AbortSignal) {
    const target=binding(id);
    const expected=originalRef(target.stamp,messageId);
    if(typeof ref!=='string' || ref.length!==expected.length || !/^[A-Za-z0-9_-]+$/.test(ref) ||
      !timingSafeEqual(Buffer.from(ref),Buffer.from(expected))) throw new InputError('置顶原文引用已失效，请重新读取列表',403);
    const original=await locate(id,messageId,target.key,signal);
    // The model needs the selected original only, never additional local links.
    const {messageId:matched,deleted,text,createdAt,parentId,threadId}=original;
    return {messageId:matched,deleted,text,createdAt,parentId,threadId};
  }
  return {list,write,locate,readListedOriginal};
}

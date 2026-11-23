import {InputError,type createWorkbench} from '../../../packages/core/src/workbench.ts';
import type {createPersonalReactions} from '../../../plugins/feishu-personal-reactions.ts';
import {createInboxMessageAccess,type InboxPersonalActor} from './feishu-inbox-message-access.ts';

export function createInboxReactions(app:Awaited<ReturnType<typeof createWorkbench>>,platform:ReturnType<typeof createPersonalReactions>,account:InboxPersonalActor) {
  const {binding,cursorBinding,verify,mutate}=createInboxMessageAccess(app,account,'feishu-message-reactions','消息表情');
  async function list(id:string,cursor:string|undefined,signal:AbortSignal) {
    signal.throwIfAborted();
    const target=binding(id),paging=cursorBinding([target.stamp]);
    const page=await platform.list(target.account,target.chatId,target.messageId,signal,paging.decode(cursor));
    verify(id,target.stamp,signal);
    return {accountKey:target.key,items:page.items,...(page.nextCursor && {nextCursor:paging.encode(page.nextCursor)})};
  }
  async function write(id:string,input:Record<string,unknown>,signal:AbortSignal) {
    const target=binding(id),{action,accountKey,emoji,requestId}=input;
    if(Object.keys(input).some(k=>!['accountKey','action','emoji','requestId'].includes(k)) ||
      action!=='add' && action!=='remove' || typeof emoji!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(emoji) ||
      typeof requestId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new InputError('消息表情操作参数无效');
    if(accountKey!==target.key) throw new InputError('个人账号已变化，请重新打开',409);
    return mutate(id,target,signal,{
      key:'feishu-reaction:'+target.key+':'+requestId,kind:'feishu-message-reaction',summary:'变更本人飞书消息表情',
      content:{chatId:target.chatId,messageId:target.messageId,emoji,action},send:async beforeWrite=>{
        await platform.write(target.account,target.chatId,target.messageId,emoji,action==='remove',signal,beforeWrite);
        return {confirmed:true,emoji,action};
      }});
  }
  return {list,write};
}

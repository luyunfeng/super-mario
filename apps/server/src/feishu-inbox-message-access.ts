import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {EffectError} from '../../../packages/core/src/effects.ts';
import {InputError, type createWorkbench} from '../../../packages/core/src/workbench.ts';
import {inboxItemId} from '../../../packages/core/src/inbox.ts';
import type {InboxItem,Json} from '../../../packages/protocol/src/index.ts';
import type {PersonalAccount} from '../../../plugins/feishu-personal.ts';


export type InboxPersonalActor=()=>{account:PersonalAccount;key:string;generation:number}|undefined;

export function createInboxMessageAccess(app:Awaited<ReturnType<typeof createWorkbench>>,account:InboxPersonalActor,
  plugin:'feishu-chat-pins'|'feishu-message-reactions',label:string) {
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
    const plugins=['feishu',plugin];
    if(!plugins.every(id=>app.plugins.list().some(p=>p.id===id && p.status==='active')))
      throw new InputError('飞书或'+label+'插件已停用',503);
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
  function cursorBinding(scope:unknown[]) {
    const sign=(value:string)=>createHmac('sha256',secret).update(JSON.stringify([...scope,value])).digest('base64url');
    return {
      encode(token:string) {
        const value=Buffer.from(token).toString('base64url');
        return sign(value)+'.'+value;
      },
      decode(cursor:string|undefined) {
        if(cursor===undefined) return;
        const match=cursor.length<=16384 && /^([A-Za-z0-9_-]{43})[.]([A-Za-z0-9_-]+)$/.exec(cursor);
        if(!match || !timingSafeEqual(Buffer.from(match[1]!),Buffer.from(sign(match[2]!))))
          throw new InputError('分页位置已失效，请重新读取',400);
        return Buffer.from(match[2]!,'base64url').toString('utf8');
      }
    };
  }
  // Reserve before I/O; an uncertain remote mutation must never be dispatched again.
  async function mutate<T>(id:string,target:ReturnType<typeof binding>,signal:AbortSignal,input:{
    key:string;kind:string;summary:string;content:Json;send:(beforeWrite:()=>Promise<void>)=>Promise<T>;
  }) {
    const {send,...effect}=input;
    const result=await app.effects.perform({...effect,target:id,run:async()=>{
      let attempted=false;
      try {
        verify(id,target.stamp,signal);
        return await send(async()=>{verify(id,target.stamp,signal);attempted=true;});
      }catch(error){
        const unknown=attempted && !(error && typeof error==='object' && 'delivery' in error && error.delivery==='no');
        throw new EffectError(unknown?'飞书'+label+'操作的回执未知，请刷新核实。':'飞书'+label+'操作未执行，请核实个人授权、原消息和会话。',unknown?'unknown':'no');
      }
    }});
    verify(id,target.stamp,signal);
    return result;
  }
  return {binding,verify,messagePattern,original,cursorBinding,mutate};
}

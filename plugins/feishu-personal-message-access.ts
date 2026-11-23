import {createPersonalProvider,runPersonalCLI,type PersonalAccount,type PersonalCLI} from './feishu-personal.ts';
import {renderFeishuPost} from './feishu-post.ts';

const chatID = /^oc_[a-zA-Z0-9_-]{1,200}$/;
export const messageID = /^om_[a-zA-Z0-9_-]{1,200}$/;
const threadID = /^(?:omt|om)_[a-zA-Z0-9_-]{1,200}$/;
export const cursorOK = (v:unknown):v is string => typeof v==='string' && v.length>0 && v.length<=4096 && !/[\s\p{Cc}]/u.test(v);
export const row = (v:unknown):v is Record<string,unknown> => v!==null && typeof v==='object' && !Array.isArray(v);
export function fail(message:string,status=502):never { throw Object.assign(new Error(message),{status}); }
export function senderNameOf(message:Record<string,unknown>) {
  const value=typeof message.sender_name==='string'?message.sender_name:
    row(message.sender) && typeof message.sender.name==='string'?message.sender.name:undefined;
  return value?.trim() || undefined;
}
export function timestamp(value:unknown) {
  if (typeof value!=='string' || !/^\d{13}$/.test(value)) return undefined;
  return new Date(Number(value)).toISOString();
}
// Raw resource/API commands use code=0; some CLI versions return the success envelope.
// Identity is bound by verified profile plus --as user. Reject any contradictory echo.
export function personalMessageData(raw:Record<string,unknown>) {
  if (raw.identity!==undefined && raw.identity!=='user' || raw.ok!==undefined && raw.ok!==true ||
      raw.code!==undefined && raw.code!==0 || raw.ok!==true && raw.code!==0 || raw.error || !row(raw.data))
    fail('飞书回执无法核实');
  return raw.data;
}
export function createPersonalMessageAccess(runCLI:PersonalCLI=runPersonalCLI) {
  const provider=createPersonalProvider({application:()=>undefined,runCLI});
  async function verify(account:PersonalAccount,chatId:string,signal:AbortSignal) {
    if (!chatID.test(chatId)) fail('飞书会话标识无效',400);
    const actor=await provider.verify(account,signal);
    if (actor.openId!==account.openId || actor.appId!==account.appId || actor.profile!==account.profile)
      fail('飞书个人账号已变化，请重新打开',409);
  }
  function run(account:PersonalAccount,args:string[],signal:AbortSignal) {
    signal.throwIfAborted();
    return runCLI(['--profile',account.profile,...args,'--as','user','--format','json'],{signal});
  }
  async function locate(account:PersonalAccount,chatId:string,messageId:string,signal:AbortSignal) {
    if (!messageID.test(messageId)) fail('飞书消息标识无效',400);
    await verify(account,chatId,signal);
    // Raw get avoids shortcut thread expansion: only the specifically requested message is projected.
    const response=personalMessageData(await run(account,['api','GET','/open-apis/im/v1/messages/'+messageId],signal));
    const matches=Array.isArray(response.items) ? response.items.filter(m=>row(m) && m.message_id===messageId) : [];
    if (matches.length!==1 || matches[0].chat_id!==chatId) fail('无法核实原消息所属会话',404);
    await verify(account,chatId,signal);
    const m=matches[0];
    if (m.deleted===true) return {chatId,messageId,deleted:true};
    let text:string|undefined;
    if (typeof m.body?.content==='string' && (m.msg_type==='text' || m.msg_type==='post')) {
      try {
        const content:unknown=JSON.parse(m.body.content);
        if (row(content)) text=m.msg_type==='post'?renderFeishuPost(content,m.mentions):typeof content.text==='string'?content.text:undefined;
      } catch { /* A malformed body is not a readable text receipt. */ }
    }
    const createdAt=timestamp(m.create_time),senderName=senderNameOf(m);
    return {chatId,messageId,deleted:false,...(senderName && {senderName}),...(text && {text}),...(createdAt && {createdAt}),
      ...(typeof m.parent_id==='string' && messageID.test(m.parent_id) && {parentId:m.parent_id as string}),
      ...(typeof m.root_id==='string' && messageID.test(m.root_id) && {rootId:m.root_id as string}),
      ...(typeof m.thread_id==='string' && threadID.test(m.thread_id) && {threadId:m.thread_id as string})};
  }
  return {run,verify,locate};
}

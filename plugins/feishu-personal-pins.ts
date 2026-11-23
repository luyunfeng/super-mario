import {createPersonalProvider,personalProblem,runPersonalCLI,type PersonalAccount,type PersonalCLI} from './feishu-personal.ts';
import {renderFeishuPost} from './feishu-post.ts';

const chatID = /^oc_[a-zA-Z0-9_-]{1,200}$/;
const messageID = /^om_[a-zA-Z0-9_-]{1,200}$/;
const threadID = /^(?:omt|om)_[a-zA-Z0-9_-]{1,200}$/;
type TopicMessage = {messageId:string;text?:string;createdAt?:string;senderName?:string;deleted:boolean};
const cursorOK = (v:unknown):v is string => typeof v==='string' && v.length>0 && v.length<=4096 && !/[\s\p{Cc}]/u.test(v);
const row = (v:unknown):v is Record<string,unknown> => v!==null && typeof v==='object' && !Array.isArray(v);
function fail(message:string,status=502):never { throw Object.assign(new Error(message),{status}); }
function senderNameOf(message:Record<string,unknown>) {
  const value=typeof message.sender_name==='string'?message.sender_name:
    row(message.sender) && typeof message.sender.name==='string'?message.sender.name:undefined;
  return value?.trim() || undefined;
}
function timestamp(value:unknown) {
  if (typeof value!=='string' || !/^\d{13}$/.test(value)) return undefined;
  return new Date(Number(value)).toISOString();
}
// Raw resource/API commands use code=0; some CLI versions return the success envelope.
// Identity is bound by verified profile plus --as user. Reject any contradictory echo.
function data(raw:Record<string,unknown>) {
  if (raw.identity!==undefined && raw.identity!=='user' || raw.ok!==undefined && raw.ok!==true ||
      raw.code!==undefined && raw.code!==0 || raw.ok!==true && raw.code!==0 || raw.error || !row(raw.data))
    fail('飞书回执无法核实');
  return raw.data;
}
export function createPersonalPins(runCLI:PersonalCLI=runPersonalCLI) {
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
  async function list(account:PersonalAccount,chatId:string,signal:AbortSignal,cursor?:string) {
    if (cursor!==undefined && !cursorOK(cursor)) fail('置顶分页游标无效',400);
    await verify(account,chatId,signal);
    const response=data(await run(account,['im','pins','list','--chat-id',chatId,'--page-size','50',
      ...(cursor ? ['--page-token',cursor] : [])],signal));
    if (!Array.isArray(response.items) || response.items.length>50 || typeof response.has_more!=='boolean')
      fail('飞书置顶分页数据不完整');
    const items=response.items.map(pin=>{
      if (!row(pin) || pin.chat_id!==undefined && pin.chat_id!==chatId || typeof pin.message_id!=='string' || !messageID.test(pin.message_id))
        fail('飞书置顶消息的会话归属无法核实');
      const pinnedAt=timestamp(pin.create_time);
      return {messageId:pin.message_id,...(pinnedAt && {pinnedAt})};
    });
    const next=response.page_token;
    if (response.has_more && (!cursorOK(next) || next===cursor)) fail('飞书置顶分页游标无效');
    await verify(account,chatId,signal);
    return {items,...(response.has_more && typeof next==='string' && {nextCursor:next})};
  }
  async function locate(account:PersonalAccount,chatId:string,messageId:string,signal:AbortSignal) {
    if (!messageID.test(messageId)) fail('飞书消息标识无效',400);
    await verify(account,chatId,signal);
    // Raw get avoids shortcut thread expansion: only the specifically requested message is projected.
    const response=data(await run(account,['api','GET','/open-apis/im/v1/messages/'+messageId],signal));
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
  async function topic(account:PersonalAccount,chatId:string,messageId:string,signal:AbortSignal,cursor?:string,expectedThreadId?:string) {
    if (cursor!==undefined && !cursorOK(cursor)) fail('话题分页游标无效',400);
    const original=await locate(account,chatId,messageId,signal);
    if (original.deleted) fail('原消息已撤回',410);
    const threadId=original.threadId;
    if (!threadId) fail('原消息没有可核实的话题',404);
    if (expectedThreadId!==undefined && expectedThreadId!==threadId) fail('原消息所属话题已变化，请重新打开',409);
    const raw=await run(account,['im','+threads-messages-list','--thread',threadId,'--order','asc',
      '--page-size','50','--no-reactions',...(cursor?['--page-token',cursor]:[])],signal);
    const page=data(raw);
    if (raw.identity!=='user' || !Array.isArray(page.messages) || page.messages.length>50 ||
        page.thread_id!==undefined && page.thread_id!==threadId || page.chat_id!==undefined && page.chat_id!==chatId)
      fail('飞书话题页无法核实');
    const complete=raw.meta?.pagination?.complete;
    if (typeof page.has_more!=='boolean' && typeof complete!=='boolean' ||
        typeof page.has_more==='boolean' && page.has_more===complete) fail('飞书话题分页状态无法核实');
    const more=page.has_more===true || complete===false,next=page.page_token;
    if (more && (!cursorOK(next) || next===cursor || !page.messages.length)) fail('飞书话题分页游标无效');
    const rootIds=new Set<string>(original.rootId?[original.rootId]:[]),seen=new Set<string>();
    const messages:TopicMessage[]=[];
    for (const m of page.messages) {
      if (!row(m) || typeof m.message_id!=='string' || !messageID.test(m.message_id) ||
          m.chat_id!==undefined && m.chat_id!==chatId || m.thread_id!==undefined && m.thread_id!==threadId ||
          seen.has(m.message_id)) fail('话题消息范围无法核实');
      seen.add(m.message_id);
      if (typeof m.root_id==='string' && messageID.test(m.root_id)) rootIds.add(m.root_id);
      if (m.deleted===true) { messages.push({messageId:m.message_id,deleted:true}); continue; }
      let createdAt=timestamp(m.create_time);
      if (!createdAt && typeof m.create_time==='string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(m.create_time)) {
        const ms=Date.parse(m.create_time);
        if (Number.isFinite(ms)) createdAt=new Date(ms).toISOString();
      }
      const senderName=senderNameOf(m);
      messages.push({messageId:m.message_id,deleted:false,...(senderName && {senderName}),...(createdAt && {createdAt}),
        ...(typeof m.content==='string' && {text:m.content})});
    }
    if (rootIds.size>1) fail('话题根消息回执不一致');
    // The raw GET supplies root_id for replies. An original post without a parent or
    // root is the head when it carries the confirmed thread ID.
    const rootId=[...rootIds][0] ?? (!original.parentId ? original.messageId : undefined);
    let root:TopicMessage|undefined;
    if (rootId) {
      const found=rootId===messageId ? original : await locate(account,chatId,rootId,signal);
      if (found.threadId && found.threadId!==threadId) fail('话题根消息不属于当前话题');
      root={messageId:found.messageId,deleted:found.deleted,...(found.senderName && {senderName:found.senderName}),...(found.text && {text:found.text}),...(found.createdAt && {createdAt:found.createdAt})};
    }
    await verify(account,chatId,signal);
    return {threadId,...(root && {root}),messages:messages.filter(m=>m.messageId!==rootId),...(more && typeof next==='string' && {nextCursor:next})};
  }
  async function write(account:PersonalAccount,chatId:string,messageId:string,pinned:boolean,signal:AbortSignal,beforeWrite:()=>Promise<void>) {
    if (typeof pinned!=='boolean') fail('置顶操作无效',400);
    if ((await locate(account,chatId,messageId,signal)).deleted) fail('原消息已撤回',410);
    const args=pinned ? ['im','pins','create','--data',JSON.stringify({message_id:messageId})]
      : ['im','pins','delete','--message-id',messageId,'--yes'];
    await beforeWrite();
    try {
      signal.throwIfAborted();
    } catch { throw Object.assign(new Error('操作已取消，未发送置顶请求'),{delivery:'no'}); }
    try {
      const result=data(await run(account,args,signal));
      if (pinned) {
        const pin=result.pin;
        if (!row(pin) || pin.message_id!==messageId || pin.chat_id!==undefined && pin.chat_id!==chatId ||
          pin.operator_id!==undefined && pin.operator_id!==account.openId ||
          pin.operator_id_type!==undefined && pin.operator_id_type!=='open_id') fail('置顶回执与原消息不符');
      } else if (Object.keys(result).length) fail('取消置顶回执无法核实');
      return {confirmed:true as const};
    } catch (err) {
      const problem=personalProblem(err);
      const refused=problem && (problem.kind==='unavailable' || problem.apiCode!==undefined && ['permissions','expired','denied','request','rate_limited'].includes(problem.kind));
      throw Object.assign(new Error(refused?'飞书置顶请求未执行':'飞书置顶操作结果不确定，请重新读取置顶列表核实'),{delivery:refused?'no':'unknown'});
    }
  }
  return {list,locate,topic,write};
}

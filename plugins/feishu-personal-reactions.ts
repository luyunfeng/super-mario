import {personalProblem,runPersonalCLI,type PersonalAccount,type PersonalCLI} from './feishu-personal.ts';
import {createPersonalMessageAccess,personalMessageData,cursorOK,row,fail} from './feishu-personal-message-access.ts';

type Reaction={emoji:string;operatorId:string;operatorType:'user'|'app';reactionId:string;mine:boolean};
const validEmoji=(v:unknown):v is string=>typeof v==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
function parseReaction(value:unknown,openId:string,messageId:string):Reaction {
  if (!row(value) || value.message_id!==undefined && value.message_id!==messageId || !row(value.operator) ||
      !row(value.reaction_type) || !validEmoji(value.reaction_type.emoji_type) ||
      typeof value.reaction_id!=='string' || !/^[a-zA-Z0-9_-]{1,512}={0,2}$/.test(value.reaction_id))
    fail('飞书表情回应回执无法核实');
  const {operator_id:id,operator_type:type}=value.operator;
  if (typeof id!=='string' || type!=='user' && type!=='app' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id) ||
      type==='user' && !id.startsWith('ou_')) fail('飞书表情回应的操作者无法核实');
  return {emoji:value.reaction_type.emoji_type,operatorId:id,operatorType:type,reactionId:value.reaction_id,mine:type==='user' && id===openId};
}
export function createPersonalReactions(runCLI:PersonalCLI=runPersonalCLI) {
  const {locate,run,verify}=createPersonalMessageAccess(runCLI);
  async function original(account:PersonalAccount,chatId:string,messageId:string,signal:AbortSignal) {
    if ((await locate(account,chatId,messageId,signal)).deleted) fail('原消息已撤回',410);
  }
  async function page(account:PersonalAccount,chatId:string,messageId:string,signal:AbortSignal,cursor?:string,emoji?:string) {
    const args=['im','reactions','list','--message-id',messageId,'--user-id-type','open_id','--page-size','50'];
    if (cursor!==undefined) {
      if (!cursorOK(cursor)) fail('表情回应分页游标无效',400);
      args.push('--page-token',cursor);
    }
    if (emoji) args.push('--reaction-type',emoji);
    const value=personalMessageData(await run(account,args,signal));
    if (value.chat_id!==undefined && value.chat_id!==chatId || value.message_id!==undefined && value.message_id!==messageId)
      fail('飞书表情回应回执与原消息不符');
    if (!Array.isArray(value.items) || value.items.length>50 || typeof value.has_more!=='boolean') fail('表情回应分页状态无法核实');
    const items=value.items.map(item=>parseReaction(item,account.openId,messageId));
    if (emoji && items.some(item=>item.emoji!==emoji)) fail('表情回应查询范围不符');
    const next=value.page_token;
    if (value.has_more && (!cursorOK(next) || next===cursor)) fail('表情回应分页缺少有效的下一页游标');
    return {items,...(value.has_more && typeof next==='string' && {nextCursor:next})};
  }
  async function list(account:PersonalAccount,chatId:string,messageId:string,signal:AbortSignal,cursor?:string) {
    await original(account,chatId,messageId,signal);
    const result=await page(account,chatId,messageId,signal,cursor);
    await verify(account,chatId,signal);
    return result;
  }
  async function write(account:PersonalAccount,chatId:string,messageId:string,emoji:string,remove:boolean,signal:AbortSignal,beforeWrite:()=>Promise<void>) {
    if (!validEmoji(emoji) || typeof remove!=='boolean') fail('表情或操作无效',400);
    await original(account,chatId,messageId,signal);
    // Determine the caller's exact reaction ID. No reaction ID is accepted from a Web client.
    const seen=new Set<string>(),operators=new Map<string,string>();
    let cursor:string|undefined,own:string|undefined;
    do {
      if (cursor) {
        if (seen.has(cursor) || seen.size>=100) fail('无法完整核实本人的表情回应');
        seen.add(cursor);
        await verify(account,chatId,signal);
      }
      const result=await page(account,chatId,messageId,signal,cursor,emoji);
      for (const item of result.items) {
        const actor=item.operatorType+':'+item.operatorId;
        if (operators.has(item.reactionId) && operators.get(item.reactionId)!==actor) fail('表情回应归属存在冲突');
        operators.set(item.reactionId,actor);
        if (item.mine) {
          if (own && own!==item.reactionId) fail('本人的表情回应记录存在冲突');
          own=item.reactionId;
        }
      }
      cursor=result.nextCursor;
    } while (cursor);
    await original(account,chatId,messageId,signal);
    if ((remove && !own) || (!remove && own)) return {confirmed:true as const,changed:false};
    const args=['im','reactions',remove?'delete':'create','--message-id',messageId,
      ...(remove?['--reaction-id',own!]:['--data',JSON.stringify({reaction_type:{emoji_type:emoji}})])];
    await beforeWrite();
    if (signal.aborted) throw Object.assign(new Error('表情回应请求已取消'),{delivery:'no'});
    try {
      const raw=await run(account,args,signal);
      const receipt=parseReaction(personalMessageData(raw),account.openId,messageId);
      if (!receipt.mine || receipt.emoji!==emoji || remove && receipt.reactionId!==own) fail('表情回应回执与操作不符');
      return {confirmed:true as const,changed:true};
    } catch (error) {
      const problem=personalProblem(error);
      const refused=problem && (problem.kind==='unavailable' || problem.apiCode!==undefined &&
        ['permissions','expired','denied','request','rate_limited'].includes(problem.kind));
      throw Object.assign(new Error(refused?'飞书拒绝了表情回应操作':'飞书表情回应结果不确定，请刷新原消息核实'),{delivery:refused?'no':'unknown'});
    }
  }
  return {list,write};
}

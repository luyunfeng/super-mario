import type {Extension} from '../packages/plugin-sdk/src/index.ts';

type Pin = {originalRef?:string;messageId:string;text?:string;textTruncated?:boolean;inboxId?:string;pinnedAt?:string};
export type FeishuPinReader = (id:string,cursor:string|undefined,signal:AbortSignal)=>Promise<{pins:Pin[];nextCursor?:string|null}>;

type PinOriginal = {messageId:string;deleted:boolean;text?:string;createdAt?:string;parentId?:string;threadId?:string};
export type FeishuPinOriginalReader = (id:string,messageId:string,originalRef:string,signal:AbortSignal)=>Promise<PinOriginal>;

export function feishuChatPinsExtension(read:FeishuPinReader,locate:FeishuPinOriginalReader):Extension {
  return {
    id:'feishu-chat-pins',name:'飞书会话置顶消息',capabilities:['feishu.chat-pins'],
    dependencies:['feishu','inbox-triage'],permissions:['contribute:tools'],
    activate({contribute}) {
      contribute('tools','inbox_chat_pins',{
        name:'inbox_chat_pins',description:'按主人指定的原始收件编号，读取该飞书会话一页置顶消息。读取列表可能在飞书侧标为已读。',
        parameters:{type:'object',required:['id'],additionalProperties:false,properties:{
          id:{type:'string',maxLength:256},cursor:{type:'string',maxLength:8192}}},
        async execute(input,signal) {
          const {id,cursor}=input;
          if(Object.keys(input).some(k=>k!=='id' && k!=='cursor') || typeof id!=='string' || !id || id.length>256 ||
            (cursor!==undefined && (typeof cursor!=='string' || !cursor || cursor.length>8192))) throw Error('请提供原始收件编号和有效的分页位置');
          signal.throwIfAborted();
          const page=await read(id,cursor,signal);
          signal.throwIfAborted();
          // Project only reference and preview fields. The gateway also returns the account binding to the Web client.
          const pins=page.pins.map(({messageId,text,textTruncated,inboxId,pinnedAt,originalRef})=>{
            const content=text===undefined ? undefined : Array.from(text);
            return {messageId,...(originalRef && {originalRef}),...(inboxId && {inboxId}),...(pinnedAt && {pinnedAt}),
              ...(content && {text:content.slice(0,500).join(''),textTruncated:!!textTruncated || content.length>500})};
          });
          return {pins,nextCursor:page.nextCursor??null};
        },
      });
      contribute('tools','inbox_pin_original',{
        name:'inbox_pin_original',description:'按本次置顶列表返回的引用核对指定消息原文。',
        parameters:{type:'object',required:['id','messageId','originalRef'],additionalProperties:false,properties:{
          id:{type:'string',maxLength:256},messageId:{type:'string',maxLength:256},originalRef:{type:'string',maxLength:128}}},
        async execute(input,signal) {
          const {id,messageId,originalRef}=input;
          if(typeof id!=='string' || !id || id.length>256 || typeof messageId!=='string' || !/^om_[a-zA-Z0-9_-]{1,200}$/.test(messageId)
            || typeof originalRef!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(originalRef)) throw Error('请使用置顶列表中同一条消息的引用');
          signal.throwIfAborted();
          const result=await locate(id,messageId,originalRef,signal);
          signal.throwIfAborted();
          if(result.deleted) return {messageId,deleted:true};
          const chars=result.text===undefined ? undefined : Array.from(result.text);
          return {messageId,deleted:false,...(chars && {text:chars.slice(0,6000).join(''),textTruncated:chars.length>6000}),
            ...(result.createdAt && {createdAt:result.createdAt}),...(result.parentId && {parentId:result.parentId}),...(result.threadId && {threadId:result.threadId})};
        },
      });
    },
  };
}

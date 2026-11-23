import type {Extension} from '../packages/plugin-sdk/src/index.ts';

type Pin = {originalRef?:string;messageId:string;text?:string;textTruncated?:boolean;inboxId?:string;pinnedAt?:string};
export type FeishuPinReader = (id:string,cursor:string|undefined,signal:AbortSignal)=>Promise<{pins:Pin[];nextCursor?:string|null}>;

type PinOriginal = {messageId:string;deleted:boolean;text?:string;createdAt?:string;parentId?:string;threadId?:string};
export type FeishuPinOriginalReader = (id:string,messageId:string,originalRef:string,signal:AbortSignal)=>Promise<PinOriginal>;

type TopicMessage = Pick<PinOriginal,'messageId'|'deleted'|'text'|'createdAt'> & {senderName?:string};
type TopicPage = {threadId:string;root?:TopicMessage;messages:TopicMessage[];nextCursor?:string|null};
export type FeishuPinTopicReader = (id:string,messageId:string,originalRef:string,cursor:string|undefined,signal:AbortSignal)=>Promise<TopicPage>;

const referenceFields={id:{type:'string',maxLength:256},messageId:{type:'string',maxLength:256},originalRef:{type:'string',maxLength:128}};
const cursorField={type:'string',maxLength:16384};
function readReference(input:Record<string,unknown>) {
  const {id,messageId,originalRef}=input;
  if(typeof id!=='string' || !id || id.length>256 || typeof messageId!=='string' || !/^om_[a-zA-Z0-9_-]{1,200}$/.test(messageId)
    || typeof originalRef!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(originalRef)) throw Error('请使用置顶列表中同一条消息的引用');
  return {id,messageId,originalRef};
}
function readCursor(value:unknown) {
  if(value!==undefined && (typeof value!=='string' || !value || value.length>16384)) throw Error('请提供有效的分页位置');
  return value;
}
function topicMessage({messageId,deleted,text,createdAt,senderName}:TopicMessage) {
  if(deleted) return {messageId,deleted};
  const chars=text===undefined ? undefined : Array.from(text);
  return {messageId,deleted,...(senderName && {senderName}),...(createdAt && {createdAt}),...(chars && {text:chars.slice(0,1000).join(''),textTruncated:chars.length>1000})};
}

export function feishuChatPinsExtension(read:FeishuPinReader,locate:FeishuPinOriginalReader,topic:FeishuPinTopicReader):Extension {
  return {
    id:'feishu-chat-pins',name:'飞书会话置顶消息',capabilities:['feishu.chat-pins'],
    dependencies:['feishu','inbox-triage'],permissions:['contribute:tools'],
    activate({contribute}) {
      contribute('tools','inbox_chat_pins',{
        name:'inbox_chat_pins',description:'按主人指定的原始收件编号，读取该飞书会话一页置顶消息。读取列表可能在飞书侧标为已读。',
        parameters:{type:'object',required:['id'],additionalProperties:false,properties:{
          id:{type:'string',maxLength:256},cursor:cursorField}},
        async execute(input,signal) {
          const id=input.id,cursor=readCursor(input.cursor);
          if(Object.keys(input).some(k=>k!=='id' && k!=='cursor') || typeof id!=='string' || !id || id.length>256) throw Error('请提供原始收件编号和有效的分页位置');
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
        parameters:{type:'object',required:['id','messageId','originalRef'],additionalProperties:false,properties:referenceFields},
        async execute(input,signal) {
          const {id,messageId,originalRef}=readReference(input);
          signal.throwIfAborted();
          const result=await locate(id,messageId,originalRef,signal);
          signal.throwIfAborted();
          if(result.deleted) return {messageId,deleted:true};
          const chars=result.text===undefined ? undefined : Array.from(result.text);
          return {messageId,deleted:false,...(chars && {text:chars.slice(0,6000).join(''),textTruncated:chars.length>6000}),
            ...(result.createdAt && {createdAt:result.createdAt}),...(result.parentId && {parentId:result.parentId}),...(result.threadId && {threadId:result.threadId})};
        },
      });
      contribute('tools','inbox_pin_topic',{
        name:'inbox_pin_topic',description:'按置顶消息引用读取所属话题的开头和一页消息。',
        parameters:{type:'object',required:['id','messageId','originalRef'],additionalProperties:false,properties:{...referenceFields,cursor:cursorField}},
        async execute(input,signal) {
          const {id,messageId,originalRef}=readReference(input);
          signal.throwIfAborted();
          const page=await topic(id,messageId,originalRef,readCursor(input.cursor),signal);
          signal.throwIfAborted();
          return {threadId:page.threadId,...(page.root && {root:topicMessage(page.root)}),
            messages:page.messages.map(topicMessage),nextCursor:page.nextCursor??null};
        },
      });
    },
  };
}

import type {Extension} from '../packages/plugin-sdk/src/index.ts';

type Reaction = {emoji:string;operatorType:string;operatorId:string;reactionId:string;mine:boolean};
export type FeishuReactionReader = (id:string,cursor:string|undefined,signal:AbortSignal)=>Promise<{
  items:Reaction[];nextCursor?:string|null;
}>;

export function feishuMessageReactionsExtension(read:FeishuReactionReader):Extension {
  return {
    id:'feishu-message-reactions',name:'飞书消息表情回应',capabilities:['feishu.message-reactions'],
    dependencies:['feishu','inbox-triage'],permissions:['contribute:tools'],
    activate({contribute}) {
      contribute('tools','inbox_message_reactions',{
        name:'inbox_message_reactions',description:'按原始收件编号查看该条飞书消息的一页表情回应，可用 nextCursor 续读。',
        parameters:{type:'object',required:['id'],additionalProperties:false,properties:{
          id:{type:'string',maxLength:256},cursor:{type:'string',maxLength:16384}}},
        async execute(input,signal) {
          const {id,cursor}=input;
          if(typeof id!=='string' || !id || id.length>256 || (cursor!==undefined &&
            (typeof cursor!=='string' || !cursor || cursor.length>16384))) throw Error('请提供原始收件编号和有效的分页位置');
          signal.throwIfAborted();
          const page=await read(id,cursor,signal);
          signal.throwIfAborted();
          return {items:page.items.map(({emoji,operatorType,operatorId,reactionId,mine})=>({emoji,operatorType,operatorId,reactionId,mine})),
            nextCursor:page.nextCursor??null};
        },
      });
    },
  };
}

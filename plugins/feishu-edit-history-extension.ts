import type {Extension} from '../packages/plugin-sdk/src/index.ts';

type Versions = {versions:{text:string;replacedAt:string}[];truncated:boolean};
export type FeishuHistoryReader = (id:string)=>Versions|Promise<Versions>;

export function feishuEditHistoryExtension(read:FeishuHistoryReader):Extension {
  return {
    id:'feishu-edit-history',name:'飞书消息编辑历史',capabilities:['feishu.edit-history'],
    dependencies:['feishu','inbox-triage'],permissions:['contribute:tools'],
    activate({contribute}) {
      contribute('tools','inbox_edit_history',{
        name:'inbox_edit_history',description:'读取个人采集实际保存的飞书消息旧正文。id 是收件编号。版本按被替换时间从早到晚排列，按 nextOffset 续查。只需最近一版时传 latest=true，省略 offset。',
        parameters:{type:'object',required:['id'],additionalProperties:false,properties:{
          id:{type:'string',maxLength:256},offset:{type:'integer',minimum:0},latest:{type:'boolean'}}},
        async execute(input,signal) {
          const {id,offset=0,latest=false}=input;
          if(Object.keys(input).some(key=>key!=='id' && key!=='offset' && key!=='latest') || typeof id!=='string' || !id || id.length>256 ||
            typeof latest!=='boolean' || (latest && input.offset!==undefined) || typeof offset!=='number' || !Number.isSafeInteger(offset) || offset<0) throw new Error('请提供收件编号和有效的读取位置');
          signal.throwIfAborted();
          const result=await read(id);
          signal.throwIfAborted();
          const start=latest ? Math.max(0,result.versions.length-1) : offset;
          const end=start+5;
          const versions=result.versions.slice(start,end).map(({text,replacedAt})=>{
            const chars=Array.from(text);
            return {text:chars.slice(0,2000).join(''),replacedAt,textTruncated:chars.length>2000};
          });
          return {versions,truncated:result.truncated,nextOffset:end<result.versions.length?end:null};
        },
      });
    },
  };
}

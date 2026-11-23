import {createHash} from 'node:crypto';
import type {NativeExportSource} from '../packages/protocol/src/index.ts';

export type NativeToolRecord={name:string;status:'succeeded'|'failed'|'unknown'|'returned'};
type Item={id:string;index:number;role:'user'|'assistant';text:string;tools?:NativeToolRecord[]};
type Selection={offset:number}|{ids:string[];showTools?:boolean};
export type ReadNative=(source:NativeExportSource,selection:Selection,signal:AbortSignal)=>Promise<{items:Item[];total:number}>;
export function nativeShareKey(source:NativeExportSource) {
  return 'native:'+createHash('sha256').update(JSON.stringify([source.machineId,source.executorId,source.nativeSessionId,source.cwd])).digest('hex');
}
export async function readShareItems(reader:ReadNative|undefined,source:NativeExportSource,selection:Selection,signal:AbortSignal) {
  if (!reader) throw Object.assign(Error('原生会话读取服务未连接'),{status:503});
  signal.throwIfAborted();
  const result=await reader(source,selection,signal);
  signal.throwIfAborted();
  const invalid=()=>Object.assign(Error('原生会话内容已变化或读取结果无效，请重新选择'),{status:409});
  if (!Number.isSafeInteger(result?.total) || result.total<0 || !Array.isArray(result.items)) throw invalid();
  const expected='ids' in selection?new Set(selection.ids):undefined;
  const length=expected?.size??Math.max(0,Math.min(25,result.total-('offset' in selection?selection.offset:0)));
  if (result.items.length!==length) throw invalid();
  const ids=new Set<string>(),indices=new Set<number>();
  const items=result.items.map((item,i)=>{
    if (!item || typeof item.id!=='string' || !/^[a-f0-9]{64}$/.test(item.id) || ids.has(item.id) || indices.has(item.index) ||
        !Number.isSafeInteger(item.index) || item.index<0 || item.index>=result.total ||
        (expected && !expected.has(item.id)) || ('offset' in selection && item.index!==selection.offset+i) ||
        (item.role!=='user' && item.role!=='assistant') || typeof item.text!=='string') throw invalid();
    ids.add(item.id);indices.add(item.index);
    const selected:Item={id:item.id,index:item.index,role:item.role,text:item.text};
    if ('ids' in selection && selection.showTools && item.role==='assistant' && item.tools!==undefined) {
      if (!Array.isArray(item.tools)) throw invalid();
      // Even an adapter returning full tool objects grants access only to these two fields.
      const tools=item.tools.map(tool=>{
        if (!tool || typeof tool.name!=='string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(tool.name) ||
            !['succeeded','failed','unknown','returned'].includes(tool.status)) throw invalid();
        return {name:tool.name,status:tool.status};
      });
      if (tools.length) selected.tools=tools;
    }
    return selected;
  });
  return {items,total:result.total};
}

export type NativeAnchor={index:number;id:string};
export async function nativeTail(reader:ReadNative|undefined,source:NativeExportSource,signal:AbortSignal) {
  let page=await readShareItems(reader,source,{offset:0},signal);
  if (page.total>page.items.length) page=await readShareItems(reader,source,{offset:page.total-1},signal);
  const last=page.items.at(-1);
  if (!last || last.index!==page.total-1) throw Object.assign(Error('原生会话尾部已变化，请重新预览'),{status:409});
  return {index:last.index,id:last.id};
}

// An offset page includes the last confirmed row. Fetching the contiguous
// fingerprints again also binds tool summaries to the same transcript snapshot.
export async function nextNativeRows(reader:ReadNative|undefined,source:NativeExportSource,anchor:NativeAnchor,showTools:boolean,signal:AbortSignal) {
  const page=await readShareItems(reader,source,{offset:anchor.index},signal);
  if (page.items[0]?.id!==anchor.id) return {pause:'原生会话历史已变化，请重新确认追加起点',items:[]};
  const next=page.items.slice(1);
  if (!next.length) return {items:[]};
  if (!showTools) return {items:next};
  const listed:Item[]=[];
  let bytes=0;
  for (const item of next) {
    const size=Buffer.byteLength(item.text);
    if (bytes+size>262144) {
      if (!listed.length) return {items:[item]}; // The caller pauses before admitting an oversized row.
      break;
    }
    bytes+=size;listed.push(item);
  }
  const loaded=await readShareItems(reader,source,{ids:listed.map(row=>row.id),showTools:true},signal);
  const check=await readShareItems(reader,source,{offset:anchor.index},signal);
  if (check.items[0]?.id!==anchor.id || listed.some((row,i)=>row.id!==check.items[i+1]?.id))
    return {pause:'原生会话历史已变化，请重新确认追加起点',items:[]};
  const byId=new Map(loaded.items.map(item=>[item.id,item]));
  return {items:listed.map(row=>{
    const item=byId.get(row.id);
    if (!item || item.index!==row.index || item.role!==row.role || item.text!==row.text)
      throw Object.assign(Error('原生会话内容已变化'),{status:409});
    return item;
  })};
}

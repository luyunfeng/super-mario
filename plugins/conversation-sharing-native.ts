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

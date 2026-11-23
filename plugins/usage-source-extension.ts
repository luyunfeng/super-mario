import type {GatewayAccount} from './usage-source-reader.ts';
import type {Tool} from '../packages/plugin-sdk/src/index.ts';

type Window = {label:string;windowMinutes:number;usedPercent:number;resetsAt?:string;model?:string};
type Account = {id:string;name:string;provider:string;plan?:string;sampledAt?:string;stale?:boolean;sourceId:string;sourceName:string;windows:Window[]};
export type UsageSourceCoverage = {sourceName:string;checkedAt?:string;state:'unread'|'failed'|'partial'|'quota_hidden'|'sampled'};
export type UsageWindowCache = {enabled:boolean;accounts:Account[];hiddenProviders:string[];coverage:UsageSourceCoverage[]};

export function createUsageWindowTool(read:()=>UsageWindowCache):Tool {
  return {
    name:'usage_source_windows',description:'读取已配置用量来源的本地缓存。按提供商筛选订阅窗口与已用比例。',
    parameters:{type:'object',additionalProperties:false,properties:{
      provider:{type:'string',maxLength:100},offset:{type:'integer',minimum:0}}},
    async execute(input,signal) {
      const {provider,offset=0}=input;
      if((provider!==undefined && (typeof provider!=='string' || !provider.trim() || provider.length>100)) ||
        typeof offset!=='number' || !Number.isSafeInteger(offset) || offset<0) throw Error('用量查询条件无效');
      signal.throwIfAborted();
      const cache=read();
      const filter=provider?.trim().toLowerCase();
      const visible=cache.enabled ? cache.accounts.filter(a=>!cache.hiddenProviders.includes(a.provider) &&
        (!filter || a.provider.toLowerCase()===filter)) : [];
      const end=offset+5;
      const accounts=visible.slice(offset,end).map(a=>({
        name:a.name,provider:a.provider,sourceName:a.sourceName,stale:!!a.stale,...(a.plan && {plan:a.plan}),
        ...(a.sampledAt && {sampledAt:a.sampledAt}),windows:a.windows.map(({label,windowMinutes,usedPercent,resetsAt,model})=>
          ({label,windowMinutes,usedPercent,...(resetsAt && {resetsAt}),...(model && {model})})),
      }));
      return {enabled:cache.enabled,coverage:cache.coverage,accounts,total:visible.length,nextOffset:end<visible.length?end:null};
    },
  };
}

type InventoryQuery={sourceId?:string;offset:number;limit:number};
type InventoryAccount=GatewayAccount & {sourceId:string};
type InventorySource={id:string;name:string;checkedAt?:string|null;error?:string;listed:number;complete:boolean};
export type UsageInventoryPage={sources:InventorySource[];accounts:InventoryAccount[];total:number;nextOffset?:number|null};
export type UsageInventoryReader=(query:InventoryQuery)=>UsageInventoryPage;

export function createUsageInventoryTool(read:UsageInventoryReader):Tool {
  return {
    name:'usage_gateway_accounts',description:'读取管理接口上一次采集的账户清单，包含停用、不可调度及没有额度读数的账户。',
    parameters:{type:'object',additionalProperties:false,properties:{sourceId:{type:'string',maxLength:128},offset:{type:'integer',minimum:0}}},
    async execute(input,signal) {
      const {sourceId,offset=0}=input;
      if((sourceId!==undefined && (typeof sourceId!=='string'|| !sourceId.trim() || sourceId.length>128)) ||
        typeof offset!=='number' || !Number.isSafeInteger(offset) || offset<0) throw Error('请提供有效的来源编号和分页位置');
      signal.throwIfAborted();
      const page=read({sourceId,offset,limit:5});
      const accounts=page.accounts.map(a=>({
        sourceId:a.sourceId,accountId:a.accountId,name:a.name??'',provider:a.provider??'',status:a.status??'',
        schedulable:a.schedulable,reason:a.reason??'',cooldownUntil:a.cooldownUntil??null,cached:a.cached,stale:a.stale,checkedAt:a.checkedAt??null,
        plan:a.planDisplayName||a.plan||'',windows:a.windows.map(w=>({kind:w.kind,scope:w.scope??'',model:w.scopedModel??'',
          usedRatio:w.usedRatio??null,limit:w.limit??null,remaining:w.remaining??null,resetsAt:w.resetsAt??null})),
      }));
      return {sources:page.sources.map(s=>({id:s.id,name:s.name,listed:s.listed,complete:s.complete,checkedAt:s.checkedAt??null,error:s.error??''})),
        accounts,total:page.total,nextOffset:page.nextOffset??null};
    },
  };
}

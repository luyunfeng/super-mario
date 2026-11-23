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

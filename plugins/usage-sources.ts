import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Extension,ExtensionContext,Store} from '../packages/plugin-sdk/src/index.ts';
import {createUsageWindowTool,type UsageSourceCoverage} from './usage-source-extension.ts';
import {normalizeUsageSourceURL,readUsageSource,UsageSourceReaderError,type UsageSourceConfig,type UsageSourceReadResult} from './usage-source-reader.ts';

type Input=Record<string,unknown>;
type Source={id:string;type:UsageSourceConfig['type'];name:string;url:string;enabled:boolean;revision:number;keyRef?:string};
type Settings={enabled:boolean;revision:number;pollMinutes:number;hiddenProviders:string[]};
type Sample={at:string;okAt?:string;error?:string;result?:UsageSourceReadResult};
const sources='usage.sources',samples='usage.samples',settingsCollection='usage.settings',limit=8;
function fail(message:string,status=400):never{throw Object.assign(new Error(message),{status});}
function fields(input:Input,allowed:string[]){if(Object.keys(input).some(k=>!allowed.includes(k)))fail('用量配置包含未知字段');}
function version(expected:unknown,actual:number){if(expected!==actual)fail('用量设置已变化，请重新加载后再保存',409);}
function reason(e:unknown){return e instanceof UsageSourceReaderError?e.message:'无法读取用量来源';}
export function createUsageSources(store:Store,modelWindows?:Parameters<typeof createUsageWindowTool>[0],reader=readUsageSource) {
  let ctx:ExtensionContext|undefined,timer:NodeJS.Timeout|undefined,session=new AbortController();
  const jobs=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  function active(){return ctx??fail('用量来源插件已停用',503);}
  const prefs=():Settings=>store.get<Settings>(settingsCollection,'current')??{enabled:true,revision:1,pollMinutes:5,hiddenProviders:[]};
  const get=(id:string)=>store.get<Source>(sources,id)??fail('用量来源不存在',404);
  const all=()=>store.list<Source>(sources);
  const sample=(id:string)=>store.get<Sample>(samples,id);
  function changed(){ctx?.events.publish('usage.sources.changed',{});}
  const keyPath=(id:string)=>join(active().dataDir,'keys',id);
  function secret(ref?:string) {
    if(!ref)return;
    try{return readFileSync(keyPath(ref),'utf8');}catch{fail('无法读取本地用量密钥，请重新设置',503);}
  }
  function config(input:Input,old?:Source,testing=false) {
    const type=input.type===undefined?old?.type:input.type;
    if(type!=='generic' && type!=='relay' && type!=='relay_key')fail('用量来源类型无效');
    const raw=input.url===undefined?old?.url:input.url;
    if(typeof raw!=='string')fail('请填写用量来源地址');
    let url:string;try{url=normalizeUsageSourceURL(raw.trim());}catch{fail('用量地址仅支持无用户名、密码、查询或片段的 HTTP(S) 地址');}
    const name=input.name===undefined?old?.name??(type==='generic'?(testing?'试读':''):'Relay'):input.name;
    if(typeof name!=='string'||!name.trim()||Array.from(name.trim()).length>40||/\p{Cc}/u.test(name))fail('名称需为 1 至 40 个字符');
    if(input.enabled!==undefined && typeof input.enabled!=='boolean'||input.clearKey!==undefined && typeof input.clearKey!=='boolean')fail('开关值无效');
    if(input.key!==undefined && (typeof input.key!=='string'||input.key.length>512||/[^!-~]/.test(input.key)))fail('密钥须为一行可打印字符，最多 512 字节');
    if(input.key && input.clearKey)fail('请只选择填写或清除密钥');
    const moved=old && (old.url!==url||old.type!==type);
    if(moved && old.keyRef && !input.key && !input.clearKey)fail('地址或类型已更换，请重新填写密钥或明确清除');
    const keyRef=input.clearKey||moved||input.key?undefined:old?.keyRef;
    if(type!=='generic' && !input.key && !keyRef)fail('该来源需要密钥');
    return {name:name.trim(),type,url,keyRef,enabled:typeof input.enabled==='boolean'?input.enabled:old?.enabled??true,
      newKey:typeof input.key==='string'&&input.key?input.key:undefined} as const;
  }
  function view(){
    active();const rows=all(),config=prefs();
    const providers=[...new Set([...config.hiddenProviders,...rows.flatMap(s=>Object.keys(sample(s.id)?.result?.seen.providers??{}))])].sort();
    return {...config,limit,providers,sources:rows.map(({keyRef,...s})=>{
      const latest=sample(s.id);
      return {...s,hasKey:!!keyRef,status:{checkedAt:latest?.at,okAt:latest?.okAt,error:latest?.error,
        seen:latest?.result?.seen,accounts:latest?.result?.seen.accounts??0,windows:latest?.result?.seen.windows??0}};
    })};
  }
  function stop(id:string){jobs.get(id)?.controller.abort();jobs.delete(id);}
  function save(input:Input,id?:string){
    active();fields(input,['type','url','name','enabled','key','clearKey',...(id?['revision']:[])]);
    const old=id?get(id):undefined;
    if(old)version(input.revision,old.revision);else if(all().length>=limit)fail('最多配置 8 个用量来源',409);
    const {newKey,...value}=config(input,old);
    let keyRef=value.keyRef;
    if(newKey){
      keyRef=randomUUID();
      try{mkdirSync(join(active().dataDir,'keys'),{recursive:true,mode:0o700});writeFileSync(keyPath(keyRef),newKey,{flag:'wx',mode:0o600});}
      catch{fail('无法保存本地用量密钥',503);}
    }
    const row={...value,keyRef,id:old?.id??randomUUID(),revision:(old?.revision??0)+1};
    try{store.transaction(()=>{
      store.put(sources,row.id,row);
      if(old && (keyRef!==old.keyRef||row.url!==old.url||row.type!==old.type))store.remove(samples,row.id);
    });}catch(error){if(newKey&&keyRef)rmSync(keyPath(keyRef),{force:true});throw error;}
    if(old?.keyRef && old.keyRef!==keyRef)rmSync(keyPath(old.keyRef),{force:true});
    stop(row.id);changed();return view();
  }
  function settings(input:Input){
    active();fields(input,['revision','enabled','pollMinutes','hiddenProviders']);
    const old=prefs();version(input.revision,old.revision);
    if(input.enabled!==undefined && typeof input.enabled!=='boolean')fail('主开关值无效');
    if(input.pollMinutes!==undefined && (typeof input.pollMinutes!=='number'||!Number.isInteger(input.pollMinutes)||input.pollMinutes<1||input.pollMinutes>1440))fail('轮询间隔须为 1 至 1440 分钟');
    const hidden=input.hiddenProviders??old.hiddenProviders;
    if(!Array.isArray(hidden)||hidden.length>100||hidden.some(x=>typeof x!=='string'||!x.trim()||x.length>32||/\p{Cc}/u.test(x)))fail('隐藏的供应商列表无效');
    const next:Settings={enabled:typeof input.enabled==='boolean'?input.enabled:old.enabled,pollMinutes:typeof input.pollMinutes==='number'?input.pollMinutes:old.pollMinutes,
      hiddenProviders:[...new Set((hidden as string[]).map(x=>x.trim().toLowerCase()))],revision:old.revision+1};
    store.put(settingsCollection,'current',next);
    if(!next.enabled)for(const id of jobs.keys())stop(id);
    changed();return view();
  }
  function remove(id:string,input:Input) {
    active();fields(input,['revision']);const row=get(id);version(input.revision,row.revision);
    store.transaction(()=>{store.remove(sources,id);store.remove(samples,id);});
    stop(id);if(row.keyRef)rmSync(keyPath(row.keyRef),{force:true});
    changed();return view();
  }
  async function read(input:UsageSourceConfig,signal:AbortSignal) {
    const result=await reader(input,AbortSignal.any([signal,AbortSignal.timeout(45000)]));
    signal.throwIfAborted();
    return result;
  }
  function pull(id:string):Promise<void> {
    active();const row=get(id);
    if(!prefs().enabled || !row.enabled)fail('请先启用用量来源及主开关',409);
    const pending=jobs.get(id);if(pending)return pending.promise;
    const controller=new AbortController(),signal=AbortSignal.any([session.signal,controller.signal]);
    const valid=()=>!signal.aborted && !!ctx && store.get<Source>(sources,id)?.revision===row.revision && prefs().enabled;
    const promise=Promise.resolve().then(async()=>{
      let result:UsageSourceReadResult;
      try{result=await read({type:row.type,url:row.url,key:secret(row.keyRef)},signal);}
      catch(error){
        if(!valid())fail('用量配置已变化，请重新读取',409);
        const message=reason(error);store.put(samples,id,{...sample(id),at:new Date().toISOString(),error:message});changed();fail(message,502);
      }
      if(!valid())fail('用量配置已变化，请重新读取',409);
      const at=new Date().toISOString();store.put(samples,id,{at,okAt:at,result});changed();
    }).finally(()=>{if(jobs.get(id)?.controller===controller)jobs.delete(id);});
    jobs.set(id,{controller,promise});return promise;
  }
  function poll() {
    if(!ctx || !prefs().enabled)return;
    const cutoff=Date.now()-prefs().pollMinutes*60000;
    for(const row of all())if(row.enabled && !jobs.has(row.id) && Date.parse(sample(row.id)?.at??'1970-01-01')<=cutoff)void pull(row.id).catch(()=>{});
  }
  function windows(){
    active();const {enabled,hiddenProviders}=prefs(),now=Date.now();
    const coverage:UsageSourceCoverage[]=[];
    const accounts=all().flatMap(row=>{
      const s=sample(row.id);
      if(!enabled || !row.enabled)return [];
      coverage.push({sourceName:row.name,...(s && {checkedAt:s.at}),state:s?.error?'failed':!s?.result?'unread':
        s.result.seen.partial?'partial':s.result.seen.quotaHidden?'quota_hidden':'sampled'});
      if(!s?.okAt||now-Date.parse(s.okAt)>3*86400000)return [];
      return (s.result?.accounts??[]).flatMap((account,index)=>{
        const sampled=Date.parse(account.sampledAt??s.okAt!);
        if(hiddenProviders.includes(account.provider.toLowerCase()) || now-sampled>=3*86400000)return [];
        const windows=account.windows.filter(w=>!w.resetsAt||Date.parse(w.resetsAt)>now);
        if(!windows.length)return [];
        const id=createHash('sha256').update(JSON.stringify([row.id,account.id||null,account.id?null:index])).digest('hex');
        return [{...account,windows,id,sourceId:row.id,sourceName:row.name,stale:!!(account.stale||s.error||now-sampled>=6*3600000)}];
      });
    });
    const peak=(a:typeof accounts[number])=>Math.max(0,...a.windows.filter(w=>!w.model).map(w=>w.usedPercent));
    accounts.sort((a,b)=>Number(a.stale)-Number(b.stale)||peak(b)-peak(a));
    return {accounts,enabled,hiddenProviders,coverage};
  }
  let testing=false;
  async function test(input:Input,signal?:AbortSignal){
    active();fields(input,['id','type','url','key','clearKey','name']);
    if(input.id!==undefined && typeof input.id!=='string')fail('来源编号无效');
    const row=typeof input.id==='string'?get(input.id):undefined;
    const c=config(input,row,true);
    if(testing)fail('已有试读正在进行',409);
    testing=true;const current=session;
    try{
      const readSignal=signal?AbortSignal.any([current.signal,signal]):current.signal;
      const result=await read({type:c.type,url:c.url,key:c.newKey??secret(c.keyRef)},readSignal);
      if(row && store.get<Source>(sources,row.id)?.revision!==row.revision)fail('配置已变化，请重新试读',409);
      return {...result.seen};
    }catch(error){if(error && typeof error==='object' && 'status' in error && error.status===409)throw error;fail(reason(error),502);}
    finally{testing=false;}
  }
  const extension:Extension={id:'usage-sources',name:'用量来源',capabilities:['usage.sources'],permissions:['contribute:tools','events.publish'],
    navigation:[{id:'sources',label:'用量来源',route:'#agent?usageSources=1'}],activate(context){
      ctx=context;session=new AbortController();
      if(modelWindows)context.contribute('tools','usage_source_windows',createUsageWindowTool(modelWindows));
      timer=setInterval(poll,15000);timer.unref();queueMicrotask(poll);
      context.defer(()=>{ctx=undefined;session.abort();clearInterval(timer);for(const id of jobs.keys())stop(id);});
    }};
  return {extension,view,windows,test,settings,add:(input:Input)=>save(input),update:(id:string,input:Input)=>save(input,id),remove,
    async refresh(id:string){await pull(id);return view();},poll};
}

export interface UsageSourceConfig {type:'relay'|'relay_key'|'generic';url:string;key?:string}
type UsageWindow={label:string;windowMinutes:number;usedPercent:number;resetsAt?:string;model?:string};
type Account={id:string;name:string;provider:string;plan?:string;sampledAt?:string;stale?:boolean;windows:UsageWindow[]};
export interface GatewayWindow {
  kind:string; scope?:string; scopedModel?:string; usedRatio?:number; limit?:number; remaining?:number; resetsAt?:string;
}
export interface GatewayAccount {
  accountId:string; name:string; provider:string; status:string; schedulable:boolean; reason?:string; cooldownUntil?:string;
  plan?:string; planRaw?:string; planDisplayName?:string; checkedAt?:string; cached:boolean; stale:boolean; windows:GatewayWindow[];
}
export type UsageSourceReadResult={accounts:Account[];inventory?:GatewayAccount[];seen:{accounts:number;windows:number;listed:number;providers:Record<string,number>;quotaHidden?:boolean;partial?:true}};
const errors={bad_config:'用量源地址、类型或密钥无效',unauthorized:'用量源密钥未获认证',forbidden:'用量源拒绝访问',not_found:'用量源接口不存在',
  redirect:'用量源返回重定向，已停止读取',server_error:'用量源服务端出错',bad_response:'用量源返回的数据无效',too_large:'用量源响应超过读取上限',
  unreachable:'无法连接用量源',timeout:'读取用量源超时',aborted:'用量读取已取消'};
export class UsageSourceReaderError extends Error {
  readonly code:keyof typeof errors;
  constructor(code:keyof typeof errors){super(errors[code]);this.code=code;}
}
function fail(code:keyof typeof errors):never {throw new UsageSourceReaderError(code);}
type Row=Record<string,unknown>;
function row(v:unknown):Row {if(!v || typeof v!=='object' || Array.isArray(v)) fail('bad_response');return v as Row;}
function rows(v:unknown):Row[]{if(!Array.isArray(v))fail('bad_response');return v.map(row);}
function str(v:unknown,max:number){return typeof v==='string'?Array.from(v.trim()).slice(0,max).join(''):'';}
function number(v:unknown):v is number{return typeof v==='number' && Number.isFinite(v);}
function instant(v:unknown){if(typeof v!=='string'|| !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(v))return undefined;
  const n=Date.parse(v);return Number.isFinite(n)?new Date(n).toISOString():undefined;}
function lengthOf(label:string) {
  const k=label.toLowerCase(),numeric=/^(\d+)([mhdw])$/.exec(k);
  if(numeric){const n=Number(numeric[1])*({m:1,h:60,d:1440,w:10080}[numeric[2]!]??0);return {minutes:n>0&&n<=366*1440?n:0,model:''};}
  const words=k.split(/[_\s.:-]+/).filter(Boolean);
  for(let i=0;i<words.length;i++){
    const w=words[i]!,next=words[i+1],five=w==='five'&&(next==='hour'||next==='hours'),seven=w==='seven'&&next==='day';
    const minutes=five?300:seven?10080:({hour:60,hourly:60,'5h':300,fivehour:300,'5hour':300,daily:1440,day:1440,weekly:10080,week:10080,'7d':10080,monthly:43200,month:43200,'30d':43200} as Record<string,number>)[w];
    if(number(minutes)){words.splice(i,five||seven?2:1);return {minutes,model:words.join(' ')};}
  }
  return {minutes:0,model:''};
}
function account(info:Row,entry:Row,mode:UsageSourceConfig['type'],now:string):Account|undefined{
  const provider=str(info.provider,32).toLowerCase(),generic=mode==='generic';
  if (!provider||entry.unsupported===true) return;
  const windows=new Map<string,{value:UsageWindow;at:string}>();
  let sampled=instant(generic?entry.sampled_at??entry.sampledAt:entry.checked_at)??'';
  const source=rows(entry.windows??[]);
  for(const w of generic?source.slice(0,32):source){
    const kind=lengthOf(str(generic?w.label:w.kind,128)),explicitMinutes=w.window_minutes??w.windowMinutes;
    const minutes=kind.minutes||(generic&&number(explicitMinutes)?explicitMinutes:0);
    if(!Number.isSafeInteger(minutes)||minutes<=0||minutes>366*1440)continue;
    const used=generic?w.used_percent??w.usedPercent:number(w.used_ratio)?w.used_ratio*100:number(w.limit)&&w.limit>0&&number(w.remaining)?(1-w.remaining/w.limit)*100:undefined;
    if(!number(used))continue;
    const model=str(generic?w.model:w.scoped_model,40)||(!generic&&w.scope==='model'?str(kind.model,40):'');
    const key=JSON.stringify([minutes,model]),at=(!generic&&instant(w.checked_at))||'';
    const prev=windows.get(key);
    if(prev && prev.at>=at || !prev && windows.size>=32)continue;
    const percent=Math.max(0,Math.min(100,used)),resetsAt=instant(w.resets_at??(generic?w.resetsAt:undefined));
    windows.set(key,{at,value:{windowMinutes:minutes,label:minutes%1440===0?minutes/1440+'d':minutes%60===0?minutes/60+'h':minutes+'m',
      usedPercent:generic?percent:Math.round(percent*1e9)/1e9,...(model&&{model}),...(resetsAt&&{resetsAt})}});
    if(at>sampled)sampled=at;
  }
  if(!windows.size)return;
  const plan=str(entry.plan_display_name,40)||str(entry.plan,40)||str(entry.plan_raw,40);
  const capital=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1);
  const name=mode==='relay_key'?[capital(provider),capital(str(entry.plan,40))].filter(Boolean).join(' '):str(info.name,80)||provider;
  return {id:str(info.id??info.account_id,128),provider,name,...(plan&&{plan}),sampledAt:!sampled||sampled>now?now:sampled,
    ...(entry.stale===true||!!str(entry.error,1)?{stale:true}:{}),windows:[...windows.values()].map(w=>w.value).sort((a,b)=>a.windowMinutes-b.windowMinutes||(a.model??'').localeCompare(b.model??''))};
}
// Inventory preserves the gateway's own vocabulary, including non-time windows such as credits.
// Compact summaries have fewer fields than full reads and never supply a fresh observation.
function inventoryAccount(info:Row, entry:Row|undefined, key?:string):GatewayAccount {
  function field(value:unknown,max:number) {
    if (key && typeof value==='string' && value.includes(key)) fail('bad_response');
    return str(value,max);
  }
  const head=typeof info.last_error==='string' ? info.last_error.split(':',1)[0]!.trim() : '';
  const reason=/^[a-z_]{1,32}$/.test(head) ? field(head,32) : undefined;
  const full=rows(entry?.windows??[]);
  const summary=!entry || !full.length;
  const windows:GatewayWindow[]=[];
  let checkedAt=instant(entry?.checked_at);
  for(const w of summary ? rows(info.quota_summary??[]) : full){
    const kind=field(w.kind,64);
    if(!kind) continue;
    const scopedModel=field(w.scoped_model,80);
    const scope=summary ? (scopedModel?'model':'account') : field(w.scope,16);
    const resetsAt=instant(w.resets_at);
    windows.push({kind,...(scope&&{scope}),...(scopedModel&&{scopedModel}),...(resetsAt&&{resetsAt}),
      ...(number(w.used_ratio)&&{usedRatio:w.used_ratio}),...(!summary && number(w.limit)&&{limit:w.limit}),
      ...(!summary && number(w.remaining)&&{remaining:w.remaining})});
    const observed=!summary && instant(w.checked_at);
    if(observed && (!checkedAt || observed>checkedAt)) checkedAt=observed;
    if(windows.length===32) break;
  }
  const plan=field(entry?.plan,40),planRaw=field(entry?.plan_raw,40),planDisplayName=field(entry?.plan_display_name,40);
  const cooldownUntil=instant(info.cooldown_until);
  return {accountId:field(info.id,128),name:field(info.name,80),provider:field(info.provider,32).toLowerCase(),
    status:field(info.status,32).toLowerCase(),schedulable:info.schedulable!==false,...(reason&&{reason}),
    ...(cooldownUntil&&{cooldownUntil}),...(plan&&{plan}),...(planRaw&&{planRaw}),...(planDisplayName&&{planDisplayName}),
    ...(checkedAt&&{checkedAt}),cached:entry?.cached===true,stale:!entry || entry.stale===true ||
      !!str(entry.error,1) || summary && windows.length>0,windows};
}
export function normalizeUsageSourceURL(raw:string):string {
  if(typeof raw!=='string'||raw.length>512||/[?#\\\p{Cc}]/u.test(raw)) fail('bad_config');
  let url:URL;try{url=new URL(raw);}catch{fail('bad_config');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||!url.hostname)fail('bad_config');
  return url.href.replace(/\/+$/,'');
}
export async function readUsageSource(config:UsageSourceConfig,signal:AbortSignal):Promise<UsageSourceReadResult>{
  if(!config||!['relay','relay_key','generic'].includes(config.type)||config.key!==undefined&&
    (typeof config.key!=='string'||config.key.length>8192||/[^\x20-\x7e]/.test(config.key)))fail('bad_config');
  const normalized=normalizeUsageSourceURL(config.url);
  const base=config.type==='relay_key'?normalized.replace(/\/v1$/,''):normalized;
  const now=new Date().toISOString();
  async function request(path:string,ids?:string[]):Promise<unknown>{
    const timeout=AbortSignal.timeout(15_000),bound=AbortSignal.any([signal,timeout]);
    try {
      const response=await fetch(base+path,{signal:bound,redirect:'manual',method:ids?'POST':'GET',headers:{Accept:'application/json',
        ...(config.key&&{Authorization:'Bearer '+config.key}),...(ids&&{'Content-Type':'application/json'})},...(ids&&{body:JSON.stringify({ids,refresh:false})})});
      if(response.status!==200){
        await response.body?.cancel();
        const status=response.status;
        fail(status===401?'unauthorized':status===403?'forbidden':status===404?'not_found':status>=300&&status<400?'redirect':status>=500?'server_error':'bad_response');
      }
      const reader=response.body?.getReader();if(!reader)fail('bad_response');
      const chunks:Buffer[]=[];let bytes=0;
      for(;;){const {done,value}=await reader.read();if(done)break;
        bytes+=value.byteLength;if(bytes>8*1024*1024){await reader.cancel();fail('too_large');}chunks.push(Buffer.from(value));}
      try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('bad_response');}
    }catch(error){if(error instanceof UsageSourceReaderError)throw error;fail(signal.aborted?'aborted':timeout.aborted?'timeout':'unreachable');}
  }
  const result:UsageSourceReadResult={accounts:[],seen:{accounts:0,windows:0,listed:0,providers:{}}};
  const add=(a:Account|undefined)=>{
    if(!a)return;
    // Only allowlisted fields leave this reader. A gateway echoing the bearer into one
    // of those fields must not transfer the credential into storage or a model prompt.
    if(config.key && [a.id,a.name,a.provider,a.plan,...a.windows.map(w=>w.model)].some(v=>v?.includes(config.key!))) fail('bad_response');
    result.accounts.push(a);
    result.seen.accounts++;
    result.seen.windows+=a.windows.length;
  };
  const distinct=new Set<string>();
  if(config.type==='relay'){
    const inventory=new Map<string,Row>(),samples=new Map<string,Row>(),seenCursors=new Set<string>();
    let next='',scanned=0;
    do{
      let entries:Row[], following='';
      try {
        const page=await request('/api/admin/accounts?view=compact&limit=500'+(next?'&'+next:''));
        const wrapped=Array.isArray(page)?{accounts:page}:row(page);
        entries=rows(wrapped.accounts);
        const cursor=(v:unknown)=>v===undefined||v===null?'':typeof v==='string'&&v.length<=256?v:number(v)?String(v):fail('bad_response');
        const id=cursor(wrapped.next_after_id),priority=cursor(wrapped.next_after_priority);
        if(id){
          const q=new URLSearchParams({after_id:id});
          if(priority)q.set('after_priority',priority);
          following=q.toString();
        }
      } catch(error) {
        if(signal.aborted)fail('aborted');
        if(!seenCursors.size)throw error;
        result.seen.partial=true;
        break;
      }
      const remaining=2000-scanned;
      for(const info of entries.slice(0,remaining)){
        const id=str(info.id,512);
        if(id && !inventory.has(id))inventory.set(id,info);
      }
      scanned+=entries.length;
      next=following;
      if(scanned>2000 || next && (!entries.length||seenCursors.has(next)||seenCursors.size>=100||scanned>=2000)){
        result.seen.partial=true;
        break;
      }
      if(!next)break;
      seenCursors.add(next);
    }while(next);
    const ids=[...inventory].filter(([,info])=>info.status!=='disabled').slice(0,500).map(([id])=>id);
    for(let i=0;i<ids.length;i+=100){
      const batch=ids.slice(i,i+100),requested=new Set(batch);
      for(const entry of rows(row(await request('/api/admin/accounts/usage',batch)).accounts)){
        const id=str(entry.account_id,512);
        if(!requested.delete(id))continue;
        samples.set(id,entry);
        add(account(inventory.get(id)!,entry,'relay',now));
      }
    }
    result.inventory=[...inventory].map(([id,info])=>inventoryAccount(info,samples.get(id),config.key));
    result.seen.listed=inventory.size;
  } else {
    const doc=row(await request(config.type==='relay_key'?'/me/usage':''));
    if(config.type==='relay_key'&&doc.account_quota_shared===false){result.seen.quotaHidden=true;return result;}
    for(const [i,entry] of rows(doc.accounts).entries()){
      const id=str(config.type==='generic'?entry.id:entry.account_id,512);
      if(id&&distinct.has(id)||!id&&config.type==='relay_key')continue;
      if(id)distinct.add(id);result.seen.listed++;
      if(config.type==='generic'?i<500:result.accounts.length<500)add(account(entry,entry,config.type,now));
    }
  }
  if(signal.aborted)fail('aborted');
  if(config.type!=='generic')result.accounts.sort((a,b)=>a.id.localeCompare(b.id));
  const providers=new Map<string,number>();
  for(const a of result.accounts)providers.set(a.provider,(providers.get(a.provider)??0)+1);
  result.seen.providers=Object.fromEntries(providers);
  return result;
}

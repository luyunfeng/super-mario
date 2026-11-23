import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../../plugin-sdk/src/index.ts';

type Destination = 'inbox' | 'knowledge';
export type SourceItem = {id:string; title:string; text:string; url?:string};
type SubscriptionInput = {sourceId:string; resource:string; name:string; destinations:Destination[]; intervalMinutes:number};
export interface SourceSubscription extends SubscriptionInput {
  id:string; version:number; enabled:boolean; nextRunAt:string; lastRunAt?:string; error?:string;
}
type Options = {
  store:Store;
  onChange?:(id:string)=>void;
  sources:()=>{id:string;name:string;resourceLabel:string}[];
  read:(sourceId:string,resource:string,signal:AbortSignal)=>Promise<SourceItem[]>;
  deliver:(destination:Destination,key:string,item:SourceItem,subscription:{id:string;name:string})=>Promise<void>|void;
};
const rows = 'source.subscriptions';
const pending = 'source.subscription-pending';
const receipts = 'source.subscription-receipts';

function failure(message:string,status:number):never {
  throw Object.assign(new Error(message),{status});
}
function tooLong(text:string, limit:number) {
  return text.length>limit && (text.length>2*limit || Array.from(text).length>limit);
}
function readerFailure(error:unknown):never {
  const code=error && typeof error==='object' && 'sourceReadCode' in error ? error.sourceReadCode : undefined;
  switch(code) {
    case 'invalid_resource': return failure('来源资源格式无效，请检查填写的资源标识。',400);
    case 'not_found': return failure('找不到来源资源，或资源未向当前连接开放。',404);
    case 'rate_limited': return failure('来源服务已限流，请稍后再拉取。',429);
    case 'forbidden': return failure('当前连接没有读取来源资源的权限。',403);
    case 'unavailable': return failure('来源服务暂不可用。',503);
    default: return failure('读取订阅来源失败，请检查来源连接与权限。',502);
  }
}
function required(value:unknown,name:string) {
  if (typeof value!=='string' || !value.trim()) failure(name+'不能为空。',400);
  return value.trim();
}
function nextRun(minutes:number) {
  return new Date(Date.now()+minutes*60000).toISOString();
}
function deliveryKey(id:string,item:string,destination:Destination) {
  return 'source-subscription:'+createHash('sha256').update(JSON.stringify([id,item,destination])).digest('hex');
}

export function createSourceSubscriptions({store,sources,read,deliver,onChange}:Options) {
  let closed=false;
  const deliveries=new Set<Promise<void>>();
  const previews=new Set<AbortController>();
  const running=new Map<string,AbortController>();

  function open() { if(closed) failure('来源订阅服务已关闭。',503); }
  function available(sourceId:string) { return sources().some(s=>s.id===sourceId); }
  function requireSource(sourceId:string) {
    if(!available(sourceId)) failure('来源插件已停用或不可用。',503);
  }
  function get(id:string) {
    const row=store.get<SourceSubscription>(rows,id);
    if(!row || row.id!==id) failure('来源订阅不存在。',404);
    return row;
  }
  function current(id:string,version:unknown) {
    open();
    if(typeof version!=='number' || !Number.isSafeInteger(version) || version<1) failure('订阅版本无效。',400);
    const row=get(id);
    if(row.version!==version) failure('来源订阅已更新，请刷新。',409);
    return row;
  }
  async function load(sourceId:string,resource:string,controller:AbortController) {
    requireSource(sourceId);
    let result:SourceItem[];
    try { result=await read(sourceId,resource,controller.signal); }
    catch(error) { readerFailure(error); }
    open();
    controller.signal.throwIfAborted();
    requireSource(sourceId);
    if(!Array.isArray(result)) failure('来源插件未返回有效的条目列表。',502);
    if(result.length>100) failure('来源单次读取超过 100 个条目。',502);
    const items=new Map<string,SourceItem>();
    for(const entry of result) {
      if(!entry || typeof entry.id!=='string' || !entry.id.trim() || typeof entry.title!=='string' || !entry.title.trim() ||
        typeof entry.text!=='string' || (entry.url!==undefined && typeof entry.url!=='string')) failure('来源条目缺少稳定编号或有效内容。',502);
      if(tooLong(entry.id,512) || tooLong(entry.title,512) || tooLong(entry.text,16000) || (entry.url && tooLong(entry.url,4096)))
        failure('来源条目超出支持的长度。',502);
      if(!items.has(entry.id)) items.set(entry.id,{id:entry.id,title:entry.title,text:entry.text,...(entry.url && {url:entry.url})});
    }
    return [...items.values()];
  }
  function list() {
    open();
    return store.list<SourceSubscription>(rows).map(row=>row.enabled && !available(row.sourceId)
      ? {...row,error:'来源插件已停用或不可用。'} : row);
  }
  async function preview(input:Record<string,unknown>, signal?:AbortSignal) {
    open();
    const sourceId=required(input?.sourceId,'来源'),resource=required(input?.resource,'资源');
    signal?.throwIfAborted();
    const controller=new AbortController();previews.add(controller);
    const cancel=()=>controller.abort(signal?.reason);
    signal?.addEventListener('abort',cancel,{once:true});
    try { return {items:await load(sourceId,resource,controller)}; }
    finally { signal?.removeEventListener('abort',cancel); previews.delete(controller); }
  }
  function settings(input:Record<string,unknown>) {
    const name=required(input.name,'订阅名称');
    const {destinations,intervalMinutes}=input;
    if(!Array.isArray(destinations) || !destinations.length || destinations.some(d=>d!=='inbox' && d!=='knowledge'))
      failure('请选择有效的投递位置。',400);
    if(typeof intervalMinutes!=='number' || !Number.isSafeInteger(intervalMinutes) || intervalMinutes<1 || intervalMinutes>10080)
      failure('拉取间隔必须为 1–10080 的整数分钟。',400);
    return {name,intervalMinutes,destinations:[...new Set<Destination>(destinations)]};
  }
  function configuration(input:Record<string,unknown>) {
    open();
    const sourceId=required(input?.sourceId,'来源'),resource=required(input?.resource,'资源');
    requireSource(sourceId);
    return {sourceId,resource,...settings(input)};
  }
  function create(input:Record<string,unknown>) {
    const config=configuration(input);
    const requestId=input.requestId;
    if(requestId!==undefined && (typeof requestId!=='string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestId)))
      failure('创建请求编号无效。',400);
    const id=requestId ?? randomUUID();
    // Keep the request fingerprint after deletion so a delayed retry cannot recreate the subscription.
    const fingerprint=createHash('sha256').update(JSON.stringify(config)).digest('hex');
    return store.transaction(()=>{
      const prior=requestId && store.get<string>('source.subscription-requests',id);
      if(prior) {
        if(prior!==fingerprint) failure('创建请求已用于其他订阅设置。',409);
        const existing=store.get<SourceSubscription>(rows,id);
        if(!existing) failure('此请求创建的订阅已被删除。',410);
        return existing;
      }
      if(store.get(rows,id)) failure('创建请求编号已使用。',409);
      const row:SourceSubscription={id,...config,enabled:true,version:1,nextRunAt:nextRun(config.intervalMinutes)};
      store.put(rows,id,row);
      if(requestId) store.put('source.subscription-requests',id,fingerprint);
      onChange?.(id);
      return row;
    });
  }
  function update(id:string,input:Record<string,unknown>) {
    const fields=Object.keys(input).filter(key=>key!=='version');
    if(!fields.length || fields.some(key=>!['enabled','name','intervalMinutes','destinations'].includes(key)))
      failure('只支持修改名称、拉取间隔、投递位置和开关。',400);
    const row=store.transaction(()=>{
      const previous=current(id,input.version);
      if(running.has(id) && !(fields.length===1 && input.enabled===false)) failure('订阅正在拉取，请稍后再修改。',409);
      const enabled=Object.hasOwn(input,'enabled') ? input.enabled : previous.enabled;
      if(typeof enabled!=='boolean') failure('订阅开关无效。',400);
      const config=settings({...previous,...input});
      const reschedule=enabled!==previous.enabled || config.intervalMinutes!==previous.intervalMinutes;
      if(!reschedule && previous.name===config.name && previous.destinations.length===config.destinations.length &&
        config.destinations.every(d=>previous.destinations.includes(d))) return previous;
      const next={...previous,...config,enabled,version:previous.version+1};
      // A newly enabled destination can use the next scheduler tick. Interval changes
      // count from the last pull, so editing the schedule does not postpone overdue work.
      const addedDestination=config.destinations.some(value=>!previous.destinations.includes(value));
      if(enabled && (!previous.enabled || addedDestination)) next.nextRunAt=new Date().toISOString();
      else if(reschedule) {
        const last=Date.parse(previous.lastRunAt ?? '');
        next.nextRunAt=Number.isFinite(last) ? new Date(last+next.intervalMinutes*60_000).toISOString() : nextRun(next.intervalMinutes);
      }
      if(enabled!==previous.enabled) delete next.error;
      store.put(rows,id,next);return next;
    });
    if(!row.enabled) running.get(id)?.abort();
    if(row.version!==input.version) onChange?.(id);
    return row;
  }
  function remove(id:string,version:unknown) {
    store.transaction(()=>{
      current(id,version);
      if(running.has(id)) failure('订阅正在拉取，请稍后再删除。',409);
      for(const key of store.list<string>(receipts+'.'+id)) store.remove(receipts+'.'+id,key);
      store.remove(pending,id);
      store.remove(rows,id);
    });
    onChange?.(id);
    return {deleted:true};
  }
  async function pull(id:string,version:unknown) {
    const row=current(id,version);
    if(!row.enabled) failure('订阅已暂停。',409);
    if(running.has(id)) failure('订阅正在拉取。',409);
    const controller=new AbortController();running.set(id,controller);
    const ownedReceipts=receipts+'.'+id;
    function delivered(key:string) {
      return Boolean(store.get(ownedReceipts,key));
    }
    function guard() {
      if(closed || controller.signal.aborted) failure('订阅拉取已停止。',409);
      const active=current(id,version);
      if(!active.enabled) failure('订阅已暂停。',409);
      requireSource(row.sourceId);
    }
    function finish(error?:string) {
      const next={...row,lastRunAt:new Date().toISOString(),nextRunAt:nextRun(row.intervalMinutes)};
      if(error) next.error=error;else delete next.error;
      store.put(rows,id,next);
      return next;
    }
    async function deliverQueue(queue:SourceItem[]) {
      for(let index=0;index<queue.length;index++) {
        const item=queue[index]!;
        for(const destination of row.destinations) {
          guard();
          const key=deliveryKey(id,item.id,destination);
          if(delivered(key)) continue;
          // The host's destination writer must commit this key with its content for crash-safe replay.
          const delivery = Promise.resolve().then(() => {
            guard();
            return deliver(destination,key,{...item},{id,name:row.name});
          });
          deliveries.add(delivery);
          try { await delivery; }
          catch (error) {
            if(error instanceof Error && 'code' in error && error.code==='CREATE_ONLY_UNAVAILABLE')
              failure('当前知识后端不支持按编号仅创建。请启用支持该能力的知识后端，然后重新拉取。',503);
            failure('订阅条目投递失败，已保留未完成的投递。',502);
          }
          finally { deliveries.delete(delivery); }
          if(closed) failure('订阅服务关闭，投递回执待核对。',503);
          store.put(ownedReceipts,key,key);
        }
      }
    }
    try {
      // An upstream outage must not block a retry of content already stored locally.
      guard();
      const backlog=store.get<SourceItem[]>(pending,id) ?? [];
      if (backlog.length) {
        await deliverQueue(backlog);
        guard();
        store.remove(pending,id);
      }
      const items=await load(row.sourceId,row.resource,controller);
      guard();
      const queue=items.filter(item=>row.destinations.some(d=>!delivered(deliveryKey(id,item.id,d))));
      if(queue.length) {
        store.put(pending,id,queue);
        await deliverQueue(queue);
      }
      guard();
      const updated=store.transaction(()=>{store.remove(pending,id);return finish();});
      onChange?.(id);
      return updated;
    } catch(error) {
      if(!closed && !controller.signal.aborted && get(id).version===version) {
        finish(error instanceof Error && 'status' in error ? error.message : '来源订阅拉取失败。');
        onChange?.(id);
      }
      if(controller.signal.aborted) failure('订阅拉取已停止。',409);
      throw error;
    } finally { running.delete(id); }
  }
  async function tick() {
    if(closed) return;
    const now=Date.now();
    await Promise.allSettled(store.list<SourceSubscription>(rows).filter(row=>
      row.enabled && !running.has(row.id) && Date.parse(row.nextRunAt)<=now).map(row=>pull(row.id,row.version)));
  }
  async function close() {
    closed=true;
    for(const controller of [...previews,...running.values()]) controller.abort();
    await Promise.allSettled([...deliveries]);
  }
  return {list,preview,configuration,create,update,remove,pull,tick,close};
}

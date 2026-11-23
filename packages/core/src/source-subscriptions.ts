import { createHash, randomUUID } from 'node:crypto';
import { nextOccurrence } from './schedules.ts';
import type { Store } from '../../plugin-sdk/src/index.ts';

type Destination = 'inbox' | 'knowledge';
export type SourceItem = {id:string; title:string; text:string; url?:string};
type SubscriptionInput = {sourceId:string; resource:string; name:string; destinations:Destination[]; intervalMinutes:number};
export interface SourceSubscription extends SubscriptionInput {
  mode?:'snapshot'; dailyAt?:string; id:string; version:number; enabled:boolean; nextRunAt:string; lastRunAt?:string; nextPageNumber?:number; retryAt?:string; error?:string;
}
type Options = {
  store:Store;
  timezone?:()=>string;
  onChange?:(id:string)=>void;
  sources:()=>{id:string;name:string;resourceLabel:string;mode?:'snapshot'}[];
  read:(sourceId:string,resource:string,signal:AbortSignal,cursor?:string,checkpoint?:string)=>Promise<SourceItem[]|{items:SourceItem[];nextCursor?:string;checkpoint?:string}|{snapshot:Omit<SourceItem,'id'>}>;
  deliver:(destination:Destination,key:string,item:SourceItem,subscription:{id:string;name:string;mode?:'snapshot'})=>Promise<void>|void;
};
const rows = 'source.subscriptions';
const pending = 'source.subscription-pending';
const receipts = 'source.subscription-receipts';

const snapshots = 'source.subscription-snapshots';
const snapshotChanges='source.snapshot-changes';
const snapshotCatchups='source.snapshot-catchups';
const snapshotTargets='source.snapshot-targets';
type Change={sequence:number; changedAt:string; item:SourceItem};
type Catchup={item:SourceItem; destination:Destination};
type SnapshotState = {sequence:number; digest:string; changedAt:string; item:SourceItem};
const positions = 'source.subscription-positions';
const stagedPages = 'source.subscription-staged-pages';
const checkpoints = 'source.subscription-checkpoints';
type Position = {cursor:string; page:number; seen:string[]; candidate?:string; failures?:number};
type Advance = {position?:Position; checkpoint?:string};
class PaginationError extends Error { status=502; }

function token(value:unknown) {
  if(value==null || (typeof value==='string' && !value.trim())) return undefined;
  if(typeof value!=='string' || Buffer.byteLength(value,'utf8')>2048 || /[\x00-\x1F\x7F]/u.test(value))
    throw new PaginationError('来源返回的分页标识无效。');
  return value;
}

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

export function createSourceSubscriptions({store,sources,read,deliver,onChange,timezone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone}:Options) {
  let closed=false;
  const deliveries=new Set<Promise<void>>();
  const previews=new Set<AbortController>();
  const running=new Map<string,AbortController>();

  function open() { if(closed) failure('来源订阅服务已关闭。',503); }
  function available(sourceId:string) { return sources().some(s=>s.id===sourceId); }
  function requireSource(sourceId:string) {
    if(!available(sourceId)) failure('来源插件已停用或不可用。',503);
  }
  function scheduled(row:{intervalMinutes:number; dailyAt?:string}, after=Date.now()) {
    if(!row.dailyAt) return new Date(after+row.intervalMinutes*60_000).toISOString();
    const [hour,minute]=row.dailyAt.split(':').map(Number);
    return nextOccurrence({kind:'cron',name:'订阅每日快照',cron:minute+' '+hour+' * * *',tz:timezone()},after);
  }
  function syncTimezone() {
    const zone=timezone();
    if(store.get<string>('source.subscription-clock','timezone')===zone) return;
    const now=Date.now();
    const changed=store.transaction(()=>{
      const ids:string[]=[];
      for(const row of store.list<SourceSubscription>(rows)) {
        // Keep immediate catch-up and recovery attempts. Their next successful run sets the new daily deadline.
        if(!row.dailyAt || !row.enabled || !row.lastRunAt || row.error || Date.parse(row.nextRunAt)<=now) continue;
        const nextRunAt=scheduled(row,now);
        if(nextRunAt===row.nextRunAt) continue;
        store.put(rows,row.id,{...row,nextRunAt}); ids.push(row.id);
      }
      store.put('source.subscription-clock','timezone',zone);
      return ids;
    });
    for(const id of changed) onChange?.(id);
  }
  function get(id:string) {
    const row=store.get<SourceSubscription>(rows,id);
    if(!row || row.id!==id) failure('来源订阅不存在。',404);
    return row;
  }
  function recentChanges(id:string) {
    const since=Date.now()-86400000;
    return (store.get<Change[]>(snapshotChanges,id) ?? []).filter(change=>Date.parse(change.changedAt)>=since);
  }
  function snapshotHistory(id:string) {
    open();
    if(get(id).mode!=='snapshot') failure('此订阅不是快照来源。',400);
    return {items:recentChanges(id).reverse()};
  }
  function current(id:string,version:unknown) {
    open();
    if(typeof version!=='number' || !Number.isSafeInteger(version) || version<1) failure('订阅版本无效。',400);
    const row=get(id);
    if(row.version!==version) failure('来源订阅已更新，请刷新。',409);
    return row;
  }
  // All anonymous reads from the same connector use the same upstream quota.
  const reads=new Map<string,Promise<void>>();
  function connector(sourceId:string) {
    const separator=sourceId.lastIndexOf('.');
    return separator<0 ? sourceId : sourceId.slice(0,separator);
  }
  function retryTime(sourceId:string) {
    const until=store.get<number>('source.connector-retry',connector(sourceId)) ?? 0;
    return until>Date.now() ? until : 0;
  }
  function limited(until:number):never {
    throw Object.assign(new Error('来源服务已限流，请稍后再拉取。'),{status:429,retryAt:new Date(until).toISOString()});
  }
  async function readConnector(sourceId:string,resource:string,controller:AbortController,cursor?:string,checkpoint?:string) {
    const key=connector(sourceId);
    // Recheck after every preceding read. Its response may have paused the whole connector.
    if(reads.has(key)) {
      const {signal}=controller;
      signal.throwIfAborted();
      let cancel!:()=>void;
      const stopped=new Promise<never>((_,reject)=>{cancel=()=>reject(signal.reason);});
      signal.addEventListener('abort',cancel,{once:true});
      try {
        while(reads.has(key)) await Promise.race([reads.get(key),stopped]);
      } finally { signal.removeEventListener('abort',cancel); }
    }
    open(); controller.signal.throwIfAborted(); requireSource(sourceId);
    const until=retryTime(sourceId);
    if(until) limited(until);
    let release!:()=>void;
    reads.set(key,new Promise<void>(resolve=>{release=resolve;}));
    try { return await read(sourceId,resource,controller.signal,cursor,checkpoint); }
    catch(error) {
      open(); controller.signal.throwIfAborted();
      if(error && typeof error==='object' && 'sourceReadCode' in error && error.sourceReadCode==='rate_limited') {
        const seconds='retryAfterSeconds' in error ? error.retryAfterSeconds : undefined;
        const delay=typeof seconds==='number' && Number.isFinite(seconds) && seconds>0 ? Math.ceil(seconds*1000) : 60000;
        const until=Date.now()+delay;
        const deadline=Number.isFinite(new Date(until).valueOf()) ? until : Date.now()+60000;
        store.put('source.connector-retry',key,deadline);
        // A preview can encounter the limit before any subscription is polled.
        onChange?.(sourceId);
        limited(deadline);
      }
      readerFailure(error);
    } finally { reads.delete(key);release(); }
  }
  async function load(sourceId:string,resource:string,controller:AbortController,cursor?:string,checkpoint?:string,mode?:'snapshot') {
    requireSource(sourceId);
    const raw=await readConnector(sourceId,resource,controller,cursor,checkpoint);
    open();
    controller.signal.throwIfAborted();
    requireSource(sourceId);
    const isSnapshot=raw && !Array.isArray(raw) && 'snapshot' in raw;
    if((mode==='snapshot')!==Boolean(isSnapshot)) failure('来源返回的内容模式与订阅不一致。',502);
    if(isSnapshot && ('items' in raw || 'nextCursor' in raw || 'checkpoint' in raw)) failure('快照来源不能同时返回分页或条目。',502);
    const paged=!isSnapshot && !Array.isArray(raw);
    const result=isSnapshot ? [{...raw.snapshot,id:'snapshot:preview'}] : paged ? raw?.items : raw;
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
    const first=items.values().next().value;
    const digest=isSnapshot && first ? createHash('sha256').update(JSON.stringify([first.title,first.text,first.url ?? ''])).digest('hex') : undefined;
    return {items:[...items.values()],digest,paged,nextCursor:paged ? token(raw.nextCursor) : undefined,checkpoint:paged ? token(raw.checkpoint) : undefined};
  }
  function list() {
    open();
    return store.list<SourceSubscription>(rows).map(row=>{
      if(row.enabled && !available(row.sourceId)) return {...row,error:'来源插件已停用或不可用。'};
      const until=retryTime(row.sourceId);
      if(!until) return row;
      const retryAt=new Date(until).toISOString();
      return {...row,retryAt,nextRunAt:Date.parse(row.nextRunAt)<until ? retryAt : row.nextRunAt};
    });
  }
  async function preview(input:Record<string,unknown>, signal?:AbortSignal) {
    open();
    const sourceId=required(input?.sourceId,'来源'),resource=required(input?.resource,'资源');
    const mode=sources().find(source=>source.id===sourceId)?.mode;
    const row=input.subscriptionId!==undefined ? get(required(input.subscriptionId,'订阅编号')) : undefined;
    if(row && (row.sourceId!==sourceId || row.resource!==resource || row.mode!==mode)) failure('预览资源与订阅不符。',409);
    signal?.throwIfAborted();
    const controller=new AbortController();previews.add(controller);
    const cancel=()=>controller.abort(signal?.reason);
    signal?.addEventListener('abort',cancel,{once:true});
    try {
      const page=await load(sourceId,resource,controller,undefined,undefined,mode);
      if(row) get(row.id);
      const prior=row && page.digest ? store.get<SnapshotState>(snapshots,row.id) : undefined;
      return {items:page.items,...(page.nextCursor && {hasMore:true as const}),
        ...(row && page.digest && {changed:prior?.digest!==page.digest,...(!prior && {firstObservation:true})})};
    }
    finally { signal?.removeEventListener('abort',cancel); previews.delete(controller); }
  }
  function settings(input:Record<string,unknown>,mode?:'snapshot') {
    const name=required(input.name,'订阅名称');
    const {destinations}=input;
    const dailyAt=mode==='snapshot' ? input.dailyAt ?? (input.intervalMinutes===undefined ? '08:00' : '') : undefined;
    if(input.dailyAt!==undefined && mode!=='snapshot') failure('只有快照订阅支持每日时间。',400);
    if(dailyAt!==undefined && (typeof dailyAt!=='string' || (dailyAt!=='' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyAt)))) failure('每日快照时间须为 HH:mm。',400);
    const intervalMinutes=input.intervalMinutes ?? (mode==='snapshot' ? 1440 : undefined);
    if(!Array.isArray(destinations) || !destinations.length || destinations.some(d=>d!=='inbox' && d!=='knowledge'))
      failure('请选择有效的投递位置。',400);
    if(typeof intervalMinutes!=='number' || !Number.isSafeInteger(intervalMinutes) || intervalMinutes<1 || intervalMinutes>10080)
      failure('拉取间隔必须为 1–10080 的整数分钟。',400);
    if(mode==='snapshot' && !dailyAt && intervalMinutes<60) failure('快照固定间隔至少为 60 分钟。',400);
    return {name,intervalMinutes,...(typeof dailyAt==='string' && {dailyAt}),destinations:[...new Set<Destination>(destinations)]};
  }
  function configuration(input:Record<string,unknown>) {
    open();
    const sourceId=required(input?.sourceId,'来源'),resource=required(input?.resource,'资源');
    requireSource(sourceId);
    const mode=sources().find(source=>source.id===sourceId)?.mode;
    return {sourceId,resource,...(mode && {mode}),...settings(input,mode)};
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
      const row:SourceSubscription={id,...config,enabled:true,version:1,nextRunAt:config.mode ? new Date().toISOString() : nextRun(config.intervalMinutes)};
      store.put(rows,id,row);
      if(requestId) store.put('source.subscription-requests',id,fingerprint);
      onChange?.(id);
      return row;
    });
  }
  function update(id:string,input:Record<string,unknown>) {
    const fields=Object.keys(input).filter(key=>key!=='version');
    if(!fields.length || fields.some(key=>!['enabled','name','intervalMinutes','destinations','dailyAt'].includes(key)))
      failure('只支持修改名称、拉取间隔、投递位置和开关。',400);
    const row=store.transaction(()=>{
      const previous=current(id,input.version);
      if(running.has(id) && !(fields.length===1 && input.enabled===false)) failure('订阅正在拉取，请稍后再修改。',409);
      const enabled=Object.hasOwn(input,'enabled') ? input.enabled : previous.enabled;
      if(typeof enabled!=='boolean') failure('订阅开关无效。',400);
      const config=settings({...previous,...input},previous.mode);
      const reschedule=enabled!==previous.enabled || config.intervalMinutes!==previous.intervalMinutes || config.dailyAt!==previous.dailyAt;
      if(!reschedule && previous.name===config.name && previous.destinations.length===config.destinations.length &&
        config.destinations.every(d=>previous.destinations.includes(d))) return previous;
      const next={...previous,...config,enabled,version:previous.version+1};
      // A newly enabled destination can use the next scheduler tick. Interval changes
      // count from the last pull, so editing the schedule does not postpone overdue work.
      const addedDestination=config.destinations.some(value=>!previous.destinations.includes(value));
      if(enabled && (!previous.enabled || addedDestination)) next.nextRunAt=new Date().toISOString();
      else if(reschedule) {
        const last=Date.parse(previous.lastRunAt ?? '');
        next.nextRunAt=scheduled(next,next.dailyAt || !Number.isFinite(last) ? Date.now() : last);
      }
      if(enabled!==previous.enabled) delete next.error;
      if(!enabled || addedDestination) {
        store.remove(positions,id);
        store.remove(stagedPages,id);
        delete next.nextPageNumber;
      }
      if(addedDestination) {
        store.remove(checkpoints,id);
        if(previous.mode==='snapshot') {
          const history=recentChanges(id);
          const jobs=store.get<Catchup[]>(snapshotCatchups,id) ?? [];
          for(const destination of config.destinations.filter(d=>!previous.destinations.includes(d))) {
            const changes=destination==='inbox' ? history.slice(-1) : history;
            for(const change of changes) {
              if(!jobs.some(job=>job.item.id===change.item.id && job.destination===destination))
                jobs.push({item:change.item,destination});
            }
          }
          if(jobs.length) store.put(snapshotCatchups,id,jobs);
        }
      }
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
      store.remove(positions,id);store.remove(stagedPages,id);store.remove(checkpoints,id);
      for(const kind of [snapshots,snapshotChanges,snapshotCatchups,snapshotTargets]) store.remove(kind,id);
      store.remove(rows,id);
    });
    onChange?.(id);
    return {deleted:true};
  }
  async function pull(id:string,version:unknown) {
    const row=current(id,version);
    if(!row.enabled) failure('订阅已暂停。',409);
    if(running.has(id)) failure('订阅正在拉取。',409);
    requireSource(row.sourceId);
    const until=retryTime(row.sourceId);
    if(until && !store.get(pending,id) && !store.get(snapshotCatchups,id)) limited(until);
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
    function finish(error?:string,retryAt?:string) {
      const next={...row,lastRunAt:new Date().toISOString(),nextRunAt:retryAt ?? scheduled(row)};
      const nextPosition=store.get<Position>(positions,id);
      if(nextPosition) {
        next.nextPageNumber=nextPosition.page;
        if(!error) next.nextRunAt=new Date().toISOString();
      } else delete next.nextPageNumber;
      if(error) next.error=error;else delete next.error;
      store.put(rows,id,next);
      return next;
    }
    async function deliverQueue(queue:SourceItem[],targets=row.destinations) {
      for(let index=0;index<queue.length;index++) {
        const item=queue[index]!;
        for(const destination of targets) {
          if(!row.destinations.includes(destination)) continue;
          guard();
          const key=deliveryKey(id,item.id,destination);
          if(delivered(key)) continue;
          // The host's destination writer must commit this key with its content for crash-safe replay.
          const delivery = Promise.resolve().then(() => {
            guard();
            return deliver(destination,key,{...item},{id,name:row.name,...(row.mode && {mode:row.mode})});
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
    function commitPage(advance:Advance) {
      return store.transaction(()=>{
        store.remove(pending,id);store.remove(stagedPages,id);store.remove(snapshotTargets,id);
        if(advance.position) store.put(positions,id,advance.position);
        else {
          store.remove(positions,id);
          if(advance.checkpoint!==undefined) store.put(checkpoints,id,advance.checkpoint);
        }
        return finish();
      });
    }
    let reading=false;
    try {
      guard();
      if(row.mode==='snapshot') {
        const jobs=store.get<Catchup[]>(snapshotCatchups,id) ?? [];
        for(const job of jobs) await deliverQueue([job.item],[job.destination]);
        guard();
        if(jobs.length) store.remove(snapshotCatchups,id);
      }
      const backlog=store.get<SourceItem[]>(pending,id) ?? [];
      const staged=store.get<Advance>(stagedPages,id);
      if(backlog.length || staged) {
        await deliverQueue(backlog,row.mode ? store.get<Destination[]>(snapshotTargets,id) : undefined);
        guard();
        if(staged) {
          const updated=commitPage(staged);onChange?.(id);return updated;
        }
        store.remove(pending,id);
      }
      const position=store.get<Position>(positions,id);
      const checkpoint=store.get<string>(checkpoints,id);
      reading=true;
      const page=await load(row.sourceId,row.resource,controller,position?.cursor,checkpoint,row.mode);
      reading=false;
      guard();
      if(row.mode==='snapshot') {
        const prior=store.get<SnapshotState>(snapshots,id);
        const digest=page.digest;
        if(digest && digest!==prior?.digest) {
          const sequence=(prior?.sequence ?? 0)+1;
          const item={...page.items[0]!,id:'snapshot:'+sequence};
          store.transaction(()=>{
            const change={sequence,changedAt:new Date().toISOString(),item};
            store.put(snapshots,id,{...change,digest} satisfies SnapshotState);
            store.put(snapshotChanges,id,[...recentChanges(id),change]);
            store.put(pending,id,[item]);
            store.put(snapshotTargets,id,row.destinations);
          });
          await deliverQueue([item]);
        }
        guard();
        const updated=commitPage({});onChange?.(id);return updated;
      }
      let advance:Advance={};
      if(page.paged || position) {
        const candidate=position ? position.candidate : page.checkpoint;
        if(page.nextCursor) {
          const seen=position?.seen ?? [];
          const pageNumber=position?.page ?? 1;
          const fingerprint=createHash('sha256').update(page.nextCursor).digest('hex');
          if(seen.includes(fingerprint)) throw new PaginationError('来源重复返回分页标识，订阅已暂停。');
          if(pageNumber>=100) throw new PaginationError('来源超过 100 页，订阅已暂停。');
          advance={position:{page:pageNumber+1,cursor:page.nextCursor,seen:[...seen,fingerprint],candidate}};
        } else advance={checkpoint:candidate};
      }
      const queue=page.items.filter(item=>row.destinations.some(d=>!delivered(deliveryKey(id,item.id,d))));
      if(queue.length) {
        store.transaction(()=>{
          store.put(pending,id,queue);
          if(page.paged || position) store.put(stagedPages,id,advance);
        });
        await deliverQueue(queue);
      }
      guard();
      const updated=commitPage(advance);
      onChange?.(id);
      return updated;
    } catch(error) {
      if(!closed && !controller.signal.aborted && get(id).version===version) {
        store.transaction(()=>{
          const position=store.get<Position>(positions,id);
          const status=error && typeof error==='object' && 'status' in error ? error.status : undefined;
          if(reading && position && !(error instanceof PaginationError) && status!==429 && status!==503) {
            if(position.failures) store.remove(positions,id);
            else store.put(positions,id,{...position,failures:1});
          }
          if(error instanceof PaginationError) store.remove(positions,id);
          const updated=finish(error instanceof Error && 'status' in error ? error.message : '来源订阅拉取失败。',
            error instanceof Error && 'retryAt' in error && typeof error.retryAt==='string' ? error.retryAt : undefined);
          if(error instanceof PaginationError) store.put(rows,id,{...updated,enabled:false,version:updated.version+1});
        });
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
      row.enabled && !running.has(row.id) && Date.parse(row.nextRunAt)<=now &&
      (!retryTime(row.sourceId) || Boolean(store.get(pending,row.id) || store.get(snapshotCatchups,row.id)))).map(row=>pull(row.id,row.version)));
  }
  async function close() {
    closed=true;
    for(const controller of [...previews,...running.values()]) controller.abort();
    await Promise.allSettled([...deliveries]);
  }
  return {list,preview,syncTimezone,snapshotHistory,configuration,create,update,remove,pull,tick,close};
}

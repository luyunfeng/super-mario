import { randomUUID } from 'node:crypto';
import type { Store } from '../../plugin-sdk/src/index.ts';

type Destination='inbox'|'knowledge';
type Entry={title:string;delivered:Destination[];pending:Destination[]};
export interface SubscriptionRun {
  id:string; startedAt:string; finishedAt?:string; interruptionObservedAt?:string; durationMs?:number; trigger:'manual'|'schedule'; status:'running'|'completed'|'failed'|'interrupted';
  readCount:number|null; newCount:number; delivered:Record<Destination,number>; pending:Record<Destination,number>;
  page:number; error?:string; entries:Entry[]; totalEntries:number;
}
const rows='source.subscription-runs', indexes='source.subscription-run-ids', active='source.subscription-active-runs';

export function runTitle(title:string) {
  return Array.from(title.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi,'[链接]').replace(/\s+/g,' ').trim()).slice(0,80).join('');
}

export function subscriptionRuns(store:Store) {
  function interrupt(subId:string,runId:string) {
    const row=store.get<SubscriptionRun>(rows,runId);
    if(row?.status==='running') store.put(rows,runId,{...row,status:'interrupted',interruptionObservedAt:new Date().toISOString(),
      error:'拉取已中断，尚未取得回执的投递结果待核对。'});
    store.remove(active,subId);
  }
  function interruptAll(){
    store.transaction(()=>{
      for(const {subId,runId} of store.list<{subId:string;runId:string}>(active)) interrupt(subId,runId);
    });
  }
  interruptAll();
  function list(subId:string) {
    return (store.get<string[]>(indexes,subId) ?? []).map(id=>store.get<SubscriptionRun>(rows,id)).filter(row=>row!==undefined);
  }
  function remove(subId:string){
    for(const id of store.get<string[]>(indexes,subId) ?? []) store.remove(rows,id);
    store.remove(active,subId);store.remove(indexes,subId);
  }
  function begin(subId:string,trigger:SubscriptionRun['trigger'],page:number) {
    const started=performance.now();
    const item:SubscriptionRun={id:randomUUID(),startedAt:new Date().toISOString(),trigger,page,status:'running',readCount:null,
      delivered:{inbox:0,knowledge:0},pending:{inbox:0,knowledge:0},entries:[],totalEntries:0,newCount:0};
    const planned=new Map<string,{entry:Entry;queued:Set<Destination>}>();
    function save(){store.put(rows,item.id,item);}
    store.transaction(()=>{
      const ids=[item.id,...(store.get<string[]>(indexes,subId) ?? [])];
      for(const old of ids.slice(20)) store.remove(rows,old);
      store.put(indexes,subId,ids.slice(0,20));store.put(active,subId,{subId,runId:item.id});save();
    });
    function queue(id:string,title:string,dest:Destination) {
      let found=planned.get(id);
      if(!found) {
        const entry:Entry={title:runTitle(title),delivered:[],pending:[]};
        found={entry,queued:new Set()};planned.set(id,found);item.totalEntries++;
        if(item.entries.length<10)item.entries.push(entry);
      }
      if(!found.queued.has(dest)){
        found.queued.add(dest);found.entry.pending.push(dest);item.pending[dest]++;
      }
    }
    function confirm(id:string,dest:Destination) {
      const found=planned.get(id);
      if(!found?.entry.pending.includes(dest)) return;
      found.entry.pending=found.entry.pending.filter(d=>d!==dest);
      found.entry.delivered.push(dest);item.pending[dest]--;item.delivered[dest]++;save();
    }
    function finish(status:'completed'|'failed'|'interrupted',error?:string) {
      store.transaction(()=>{
        if(store.get<{runId:string}>(active,subId)?.runId!==item.id) return;
        // A receipt write may have rolled back. Only finalize counters already committed with their evidence.
        const committed=store.get<SubscriptionRun>(rows,item.id)!;
        store.put(rows,item.id,{...committed,status,finishedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-started),...(error && {error})});
        store.remove(active,subId);
      });
    }
    return {item,queue,confirm,save,finish};
  }
  return {begin,remove,list,interruptAll};
}

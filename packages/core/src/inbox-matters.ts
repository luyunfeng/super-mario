import {randomUUID} from 'node:crypto';
import type {InboxItem,InboxMatter} from '../../protocol/src/index.ts';

export interface MatterBatch {
  newMessageIds:string[];
  existing:InboxMatter[];
}
export interface MatterGrouping {
  assign:{message:string;event:string}[];
  events:{event:string;title:string;summary:string;tier:InboxMatter['tier'];reason?:string;urgent?:boolean;continues?:string;reopen?:boolean;settled?:'replied'|'over'}[];
}

export function visibleMatters(matters:InboxMatter[],items:InboxItem[]) {
  const ids=new Set(items.map(item=>item.id));
  // A summary may quote any member. Moving a single message out of scope hides that whole summary.
  const visible=matters.filter(m=>m.messageIds.length && m.messageIds.every(id=>ids.has(id)));
  const retained=new Set(visible.map(m=>m.id));
  return visible.map(m=>m.continues && !retained.has(m.continues) ? {...m,continues:undefined} : m);
}

export function nextMatterBatch(items:InboxItem[],matters:InboxMatter[],allMatters:InboxMatter[],now:number,kind:'direct'|'group') {
  const assigned=new Set(allMatters.flatMap(m=>m.messageIds));
  const fresh=items.filter(i=>!i.archivedAt && !i.todoId && !assigned.has(i.id));
  if(!fresh.length)return;
  const recency=new Map(items.map((item,i)=>[item.id,i]));
  const latest=[...matters].sort((a,b)=>(recency.get(b.messageIds.at(-1)!) ?? -1)-(recency.get(a.messageIds.at(-1)!) ?? -1));
  const done=latest.filter(m=>m.tier!=='noise' && m.doneAt && Date.parse(m.doneAt)>=now-3*86400000 && (kind==='direct' || m.messageIds.length<50));
  const existing=[...latest.filter(m=>!m.doneAt).slice(0,10),...done.slice(0,6)];
  const take=20;
  return {batch:{newMessageIds:fresh.slice(0,take).map(i=>i.id),existing:existing.map(m=>({...m,messageIds:m.messageIds.slice(-1)}))},more:fresh.length>take};
}

export function applyMatterGrouping(matters:InboxMatter[],batch:MatterBatch|undefined,grouping:MatterGrouping,now:string):InboxMatter[] {
  const invalid=()=>{throw Error('事项归组未覆盖本批消息或引用了不可见事项');};
  if(!grouping || !Array.isArray(grouping.assign) || !Array.isArray(grouping.events))return invalid();
  if(!batch)return grouping.assign.length || grouping.events.length ? invalid() : matters;
  const existing=new Map(batch.existing.map(m=>[m.id,m]));
  const pending=new Set(batch.newMessageIds);
  const byEvent=new Map<string,string[]>();
  for(const a of grouping.assign) {
    if(!a || typeof a.event!=='string' || !pending.delete(a.message) || (!existing.has(a.event) && !/^new:\d{1,10}$/.test(a.event)))return invalid();
    const ids=byEvent.get(a.event);
    if(ids)ids.push(a.message);else byEvent.set(a.event,[a.message]);
  }
  if(pending.size || grouping.events.length!==byEvent.size)return invalid();
  const next=new Map(matters.map(m=>[m.id,m]));
  for(const e of grouping.events) {
    const added=e && byEvent.get(e.event);
    if(!added || typeof e.title!=='string' || !e.title.trim() || e.title.length>500 ||
      typeof e.summary!=='string' || !e.summary.trim() || e.summary.length>2000 ||
      !['action','fyi','noise'].includes(e.tier) ||
      (e.reason!==undefined && (typeof e.reason!=='string' || e.reason.length>500)) ||
      (e.urgent!==undefined && typeof e.urgent!=='boolean') ||
      (e.reopen!=null && typeof e.reopen!=='boolean') ||
      (e.settled!=null && !['replied','over'].includes(e.settled)))return invalid();
    byEvent.delete(e.event);
    const prev=next.get(e.event);
    if(e.continues && (prev || !existing.get(e.continues)?.doneAt))return invalid();
    const keepDone=prev?.doneAt && e.reopen===false;
    const id=prev?.id ?? randomUUID();
    const matter:InboxMatter={id,title:keepDone ? prev!.title : e.title.trim(),summary:keepDone ? prev!.summary : e.summary.trim(),tier:keepDone ? prev!.tier : e.tier,
      messageIds:[...(prev?.messageIds ?? []),...batch.newMessageIds.filter(id=>added.includes(id))]};
    const reason=keepDone ? prev!.reason : e.reason?.trim();
    if(reason)matter.reason=reason;
    if(!keepDone && e.tier==='action' && e.urgent)matter.urgent=true;
    const doneAt=keepDone ? prev!.doneAt : prev && !prev.doneAt && e.tier!=='action' && e.settled ? now : undefined;
    if(doneAt)matter.doneAt=doneAt;
    const continues=prev?.continues ?? e.continues;
    if(continues)matter.continues=continues;
    next.set(id,matter);
  }
  return [...next.values()];
}

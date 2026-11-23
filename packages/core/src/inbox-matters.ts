import {randomUUID} from 'node:crypto';
import type {InboxItem,InboxMatter,InboxFallbackInput,InboxFallbackPlan} from '../../protocol/src/index.ts';

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
  const recency=new Map(items.map(item=>[item.id,Date.parse(item.receivedAt ?? item.updatedAt)]));
  // A late-arriving older reply is appended to membership, but cannot move an event's activity backward.
  const latestMember=(m:InboxMatter)=>m.messageIds.reduce((a,b)=>(recency.get(a) ?? -Infinity)>=(recency.get(b) ?? -Infinity)?a:b);
  const latest=matters.map(m=>{const id=latestMember(m);return {...m,messageIds:[id],activity:recency.get(id) ?? 0,count:m.messageIds.length};})
    .sort((a,b)=>b.activity-a.activity);
  const done=latest.filter(m=>m.tier!=='noise' && m.doneAt && Date.parse(m.doneAt)>=now-3*86400000 && (kind==='direct' || m.count<50));
  const existing=[...latest.filter(m=>!m.doneAt).slice(0,10),...done.slice(0,6)];
  const take=20;
  return {batch:{newMessageIds:fresh.slice(0,take).map(i=>i.id),existing:existing.map(({activity:_at,count:_count,...matter})=>matter)},more:fresh.length>take};
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
    const matter:InboxMatter={id,groupedBy:keepDone ? prev!.groupedBy ?? 'model' : 'model',lastGroupedBy:'model',title:keepDone ? prev!.title : e.title.trim(),summary:keepDone ? prev!.summary : e.summary.trim(),tier:keepDone ? prev!.tier : e.tier,
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


function fallbackTitle(item:InboxItem) {
  const title=item.title.trim();
  if(title && title!==item.origin?.chatName && title!==item.origin?.chatId && !title.startsWith('oc_'))
    return Array.from(title).slice(0,160).join('');
  const line=item.text.split(/\r?\n/).map(s=>s.trim().replace(/^\[om_[^\]\s]+\]\s*/,'')).find(Boolean);
  const person=item.origin?.senderName || item.sender;
  const fallback=person && !/^(?:o[uc]_|unknown$)/i.test(person) ? person+'的收件' : '新收件';
  return Array.from(line || fallback).slice(0,80).join('');
}

export function fallbackMatterInput(batch:MatterBatch,items:InboxItem[],matters:InboxMatter[],topics:Map<string,string>,kind:'direct'|'group',now:string):InboxFallbackInput {
  const candidateIds=new Set(batch.existing.map(m=>m.id));
  const byId=new Map(items.map(i=>[i.id,i])), byMessage=new Map<string,string>();
  const fresh=new Set(batch.newMessageIds);
  const existing=matters.filter(m=>candidateIds.has(m.id)).map(m=>{
    const refs=new Set<string>();
    let at='',timestamp=-Infinity;
    for(const id of m.messageIds){
      byMessage.set(id,m.id);
      const item=byId.get(id)!;
      const observed=item.receivedAt ?? item.updatedAt,time=Date.parse(observed);
      if(time>timestamp){timestamp=time;at=observed;}
      const topic=topics.get(id);if(topic)refs.add(topic);
    }
    return {id:m.id,at,...(refs.size && {topicIds:[...refs]})};
  });
  const messages=batch.newMessageIds.map(id=>{
    const item=byId.get(id)!;
    const parent=item.parentInboxBy==='connector' ? item.parentInboxId : undefined;
    const prior=parent && byMessage.get(parent);
    const topicId=topics.get(id);
    return {id,title:fallbackTitle(item),at:item.receivedAt ?? item.updatedAt,
      tier:item.tier==='pending' ? 'fyi' as const : item.tier,...(topicId && {topicId}),
      ...(parent && fresh.has(parent) ? {replyToMessageId:parent} : prior ? {replyToMatterId:prior} : {})};
  });
  return {kind,now,messages,existing};
}

export function applyFallbackPlan(input:InboxFallbackInput,plan:InboxFallbackPlan,matters:InboxMatter[],handling:Set<string>):InboxMatter[] {
  const invalid=()=>{throw Error('规则分组未覆盖本批消息或引用了不可见事项');};
  const listed=new Set(input.existing.map(m=>m.id));
  const assignments=new Map<string,string>();
  if(!Array.isArray(plan?.assign) || plan.assign.length!==input.messages.length)return invalid();
  for(const a of plan.assign){
    if(!a || typeof a.message!=='string' || typeof a.event!=='string' || assignments.has(a.message) ||
      (!listed.has(a.event) && !/^new:\d{1,10}$/.test(a.event)))return invalid();
    assignments.set(a.message,a.event);
  }
  const batches=new Map<string,InboxFallbackInput['messages']>();
  for(const m of input.messages){
    const event=assignments.get(m.id);if(!event)return invalid();
    const members=batches.get(event);if(members)members.push(m);else batches.set(event,[m]);
  }
  const next=new Map(matters.map(m=>[m.id,m]));
  const rank={noise:0,fyi:1,action:2};
  for(const [key,messages] of batches){
    const old=next.get(key),ids=messages.map(m=>m.id);
    const floor=messages.reduce((tier,m)=>rank[m.tier]>rank[tier]?m.tier:tier,'noise' as InboxMatter['tier']);
    if(old){
      const raise=old.tier!=='noise' && rank[floor]>rank[old.tier] && !old.messageIds.some(id=>handling.has(id));
      next.set(key,{...old,doneAt:undefined,groupedBy:old.groupedBy ?? 'model',lastGroupedBy:'rules',messageIds:[...old.messageIds,...ids],
        ...(raise && {tier:floor,reason:'按新增收件分级提升'})});
    }else{
      const id=randomUUID();next.set(id,{id,title:messages[0]!.title,summary:'',tier:floor,messageIds:ids,groupedBy:'rules',lastGroupedBy:'rules'});
    }
  }
  return [...next.values()];
}

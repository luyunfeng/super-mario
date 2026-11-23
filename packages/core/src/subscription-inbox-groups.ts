import {createHash} from 'node:crypto';
import type {SubscriptionMove} from '../../protocol/src/index.ts';
import type {SourceItem} from './source-subscriptions.ts';

export type HeldInboxItem={item:SourceItem;storedAt:string;sequence:number};
export type SubscriptionInboxGroup={kind:SubscriptionMove['kind']|'item';thread:string;last:string;title:string;text:string;due:boolean;receivedAt:string;itemIds:string[]};

function heldTime(row:HeldInboxItem) {
  const stored=Date.parse(row.storedAt);
  return row.item.occurredAt ? Math.min(stored,Date.parse(row.item.occurredAt)) : stored;
}

function chronological(a:HeldInboxItem,b:HeldInboxItem) {
  return heldTime(a)-heldTime(b) || a.sequence-b.sequence;
}

function displayTime(timezone:string) {
  if(timezone==='UTC') return (time:number)=>new Date(time).toISOString();
  const format=new Intl.DateTimeFormat('sv-SE',{
    timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',
    second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset',
  });
  return (time:number)=>format.format(time);
}

function summaryLine(row:HeldInboxItem,when:(time:number)=>string) {
  const {title,url}=row.item;
  const time=when(heldTime(row));
  return time+' · '+title.replace(/\s+/g,' ').trim()+(url?' '+url:'');
}

function membersDigest(ids:string[]) {
  return createHash('sha256').update(JSON.stringify(ids)).digest('hex');
}

function block(row:HeldInboxItem,when:(time:number)=>string) {
  const {title,text,dueAt,url}=row.item;
  const lines=[title,when(heldTime(row))];
  if(dueAt) lines.push('截止时间：'+dueAt);
  const body=text.trim();
  if(body && body!==title.trim()) lines.push('',Array.from(body).slice(0,3000).join(''));
  if(url) lines.push('',url);
  return lines.join('\n');
}

export function subscriptionInboxGroups(input:{
  name:string;inboxGroup?:'thread'|'source';held:HeldInboxItem[];pendingIds:string[];catchupAt?:string;groupFrom?:string;timezone?:string;
}):SubscriptionInboxGroup[] {
  const pending=new Set(input.pendingIds);
  if(!pending.size) return [];
  const when=displayTime(input.timezone ?? 'UTC');
  const catchup=input.catchupAt ? Date.parse(input.catchupAt) : -Infinity;
  const from=input.groupFrom ? Date.parse(input.groupFrom) : -Infinity;
  const candidates:HeldInboxItem[]=[];
  const rows:HeldInboxItem[]=[];
  for(const row of input.held) {
    if(Date.parse(row.storedAt)<=catchup && !(row.item.dueAt && Date.parse(row.item.dueAt)>catchup)) candidates.push(row);
    else rows.push(row);
  }
  const groups:SubscriptionInboxGroup[]=[];
  const pendingMembers=(items:HeldInboxItem[])=>items.map(row=>row.item.id).filter(id=>pending.has(id));
  if(candidates.length>3) {
    candidates.sort((a,b)=>chronological(b,a));
    const itemIds=pendingMembers(candidates);
    if(itemIds.length) {
      const lines=candidates.slice(0,50).map(row=>summaryLine(row,when));
      if(candidates.length>50) lines.push('另有 '+(candidates.length-50)+' 条');
      // Hash all member identities, including those omitted from the displayed fifty lines.
      const ids=candidates.map(row=>row.item.id).sort();
      const digest=membersDigest(ids);
      groups.push({kind:'digest',thread:'digest:'+input.catchupAt,last:'digest:'+digest,title:input.name+' · 首次收录 '+ids.length+' 条',
        text:lines.join('\n'),due:false,receivedAt:new Date(heldTime(candidates[0]!)).toISOString(),itemIds});
    }
  } else rows.push(...candidates);

  const threads=new Map<string,HeldInboxItem[]>();
  for(const row of rows.sort((a,b)=>a.sequence-b.sequence)) {
    if(Date.parse(row.storedAt)<from) continue;
    let key='source';
    if(input.inboxGroup!=='source') key=row.item.thread?'thread:'+row.item.thread:'item:'+row.item.id;
    const members=threads.get(key);
    if(members) members.push(row);
    else threads.set(key,[row]);
  }
  for(const [thread,members] of threads) {
    members.sort(chronological);
    const itemIds=pendingMembers(members);
    if(!itemIds.length) continue;
    const newest=members[members.length-1]!;
    const earlier=members.slice(-11,-1).map(row=>summaryLine(row,when));
    const content=earlier.length ? earlier.join('\n')+'\n\n'+block(newest,when) : block(newest,when);
    // A later page can add an older item while leaving the newest item unchanged.
    const kind=input.inboxGroup==='source' ? 'source' : newest.item.thread ? 'thread' : 'item';
    const last=kind==='item' ? newest.item.id : 'group:'+membersDigest(members.map(row=>row.item.id));
    groups.push({kind,thread,last,title:kind==='source'?input.name:newest.item.title,
      text:content,receivedAt:new Date(heldTime(newest)).toISOString(),due:members.some(row=>Boolean(row.item.dueAt)),itemIds});
  }
  return groups;
}

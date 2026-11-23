import type {Json, JsonObject, Store} from '../packages/plugin-sdk/src/index.ts';

type Column={id:string;title:string};
type Card={id:string;title:string;columnId:string;pinned:boolean;archived:boolean};
type View={revision:number;columns:Column[];cards:Card[]};
type Value={title:string;columnId?:string;columnTitle?:string;pinned?:boolean;archived?:boolean};
type Change={kind:string;id?:string;title?:string;fields?:string[];before?:Value;after?:Value;cardIds?:string[]};
type Summary={revision:number;at:string;changeCount:number;cardCount:number;kinds:string[]};
type Entry=Summary & {cardIds:string[]};
type IndexRow={revision:number;bytes:number};
const collection='workspace-board.activity';
const retentionLimit=500, retentionBytes=16*1024*1024;
const readIndex=(store:Store)=>store.get<IndexRow[]>(collection,'index') ?? [];
const cost=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
function fail(status:number,message:string):never {throw Object.assign(new Error(message),{status});}

function changesBetween(before:View,after:View) {
  const oldColumns=new Map(before.columns.map(c=>[c.id,c])), newColumns=new Map(after.columns.map(c=>[c.id,c]));
  const oldCards=new Map(before.cards.map(c=>[c.id,c])), newCards=new Map(after.cards.map(c=>[c.id,c]));
  const value=(c:Card,columns:Map<string,Column>):Value=>({title:c.title,columnId:c.columnId,columnTitle:columns.get(c.columnId)!.title,pinned:c.pinned,archived:c.archived});
  const changes:Change[]=[];
  for (const c of before.cards) if (!newCards.has(c.id)) changes.push({kind:'card_removed',id:c.id,title:c.title,before:value(c,oldColumns)});
  for (const c of after.cards) {
    const old=oldCards.get(c.id);
    if (!old) {changes.push({kind:'card_added',id:c.id,title:c.title,after:value(c,newColumns)});continue;}
    const fields:string[]=[];
    if (old.title!==c.title) fields.push('title');
    if (old.columnId!==c.columnId) fields.push('column');
    if (old.pinned!==c.pinned) fields.push('pinned');
    if (old.archived!==c.archived) fields.push('archived');
    if (fields.length) changes.push({kind:'card_updated',id:c.id,title:c.title,fields,before:value(old,oldColumns),after:value(c,newColumns)});
  }
  for (const c of before.columns) if (!newColumns.has(c.id)) changes.push({kind:'column_removed',id:c.id,title:c.title,before:{title:c.title}});
  for (const c of after.columns) {
    const old=oldColumns.get(c.id);
    if (!old) changes.push({kind:'column_added',id:c.id,title:c.title,after:{title:c.title}});
    else if (old.title!==c.title) changes.push({kind:'column_renamed',id:c.id,title:c.title,before:{title:old.title},after:{title:c.title}});
  }
  const oldOrder=before.columns.filter(c=>newColumns.has(c.id)).map(c=>c.id);
  const newOrder=after.columns.filter(c=>oldColumns.has(c.id)).map(c=>c.id);
  if (oldOrder.some((id,i)=>id!==newOrder[i])) changes.push({kind:'columns_reordered'});
  for (const col of after.columns) {
    // Compare survivors in the same column. Adding, pinning or moving a card to another column does not reorder its neighbours.
    const stayed=(c:Card)=>c.columnId===col.id && oldCards.get(c.id)?.columnId===col.id && newCards.get(c.id)?.columnId===col.id;
    const old=before.cards.filter(stayed), next=after.cards.filter(stayed);
    const first=old.findIndex((c,i)=>c.id!==next[i].id);
    if (first<0) continue;
    const last=old.findLastIndex((c,i)=>c.id!==next[i].id);
    changes.push({kind:'cards_reordered',id:col.id,title:col.title,cardIds:next.slice(first,last+1).map(c=>c.id)});
  }
  return changes;
}

// Called inside the same SQLite transaction as the board mutation.
export function recordBoardActivity(store:Store,before:View,after:View) {
  const changes=changesBetween(before,after);
  if (!changes.length) return;
  const cardIds=[...new Set(changes.flatMap(c=>c.cardIds ?? (c.kind.startsWith('card_') && c.id ? [c.id] : [])))];
  const revision=after.revision;
  const entry:Entry={revision,at:new Date().toISOString(),changeCount:changes.length,cardCount:cardIds.length,
    kinds:[...new Set(changes.map(c=>c.kind))],cardIds};
  const row={revision,bytes:cost(entry)+cost(changes)};
  store.put(collection,'meta:'+revision,entry);
  store.put(collection,'changes:'+revision,changes);
  const index=readIndex(store);
  index.push(row);
  // The index is small even when a revision changes every card. Never load the old detail payloads to prune them.
  let bytes=index.reduce((sum,r)=>sum+r.bytes,0)+cost(index);
  // Keep the newest commit intact even when its changes alone exceed the byte budget.
  while (index.length > 1 && (index.length>retentionLimit || bytes>retentionBytes)) {
    const removed=index.shift()!;
    bytes-=removed.bytes+cost(removed)+(index.length?1:0);
    store.remove(collection,'meta:'+removed.revision);
    store.remove(collection,'changes:'+removed.revision);
  }
  store.put(collection,'index',index);
}

function number(raw:Json|undefined,min:number,max:number,fallback?:number) {
  if (raw===undefined && fallback!==undefined) return fallback;
  if (typeof raw!=='number' || !Number.isSafeInteger(raw) || raw<min || raw>max) fail(400,'看板活动版本或分页参数无效');
  return raw;
}
export function readBoardActivity(store:Store,input:JsonObject,detail:boolean) {
  const fields=detail?['revision','offset','limit','cardId']:['before','limit','cardId'];
  if (Object.keys(input).some(k=>!fields.includes(k))) fail(400,'看板活动查询包含未知字段');
  const cardId=input.cardId;
  if (cardId!==undefined && (typeof cardId!=='string' || !cardId || cardId.trim()!==cardId || cardId.length>256 || /[\p{Cc}\p{Cs}]/u.test(cardId))) fail(400,'看板卡片 ID 无效');
  return store.transaction(():JsonObject=>{
    if (detail) {
      const revision=number(input.revision,1,Number.MAX_SAFE_INTEGER),offset=number(input.offset,0,1_000_000,0),limit=number(input.limit,1,100,30);
      const entry=store.get<Entry>(collection,'meta:'+revision), changes=store.get<Change[]>(collection,'changes:'+revision);
      if (!entry || !changes) fail(404,'看板活动记录不存在或已超出保留范围');
      const selected=!cardId ? changes : changes.filter(c=>c.cardIds ? c.cardIds.includes(cardId) : c.kind.startsWith('card_') && c.id===cardId)
        .map(c=>c.cardIds ? {...c,cardIds:[cardId]} : c);
      return {revision,at:entry.at,changes:selected.slice(offset,offset+limit),total:selected.length,nextOffset:offset+limit<selected.length ? offset+limit : null};
    }
    const before=number(input.before,1,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER),limit=number(input.limit,1,50,20);
    const index=readIndex(store);
    const latestRevision=store.get<{revision:number}>('workspace-board','board')?.revision ?? 0;
    const entries:Summary[]=[];
    let nextBefore:number|null=null;
    for (let i=index.length-1;i>=0;i--) {
      if (index[i].revision>=before) continue;
      const entry=store.get<Entry>(collection,'meta:'+index[i].revision);
      if (!entry || (cardId && !entry.cardIds.includes(cardId))) continue;
      if (entries.length===limit) {nextBefore=entries[limit-1].revision;break;}
      const {cardIds:_ids,...summary}=entry;
      entries.push(summary);
    }
    return {entries,nextBefore,latestRevision,oldestRevision:index[0]?.revision ?? null,retentionLimit};
  });
}

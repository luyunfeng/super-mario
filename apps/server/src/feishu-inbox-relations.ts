import {inboxItemId} from '../../../packages/core/src/inbox.ts';
import type {Store} from '../../../packages/plugin-sdk/src/index.ts';
import type {InboxItem,InboxThing} from '../../../packages/protocol/src/index.ts';
import type {CollectedReplyEvidence} from '../../../packages/protocol/src/waiting-replies.ts';

const pending='feishu.inbox-pending-parent';
const children=(parent:string)=>'feishu.inbox-pending-children.'+parent;
const prefix='feishu:message:';
type Offer=(id:string,parentId:string)=>'applied'|'missing'|'ignored';
function identifier(value:unknown):value is string {
  return typeof value==='string' && value.trim()!=='' && value.length<=512 && !/[\p{Cc}]/u.test(value);
}

function messageIdentity(thing:InboxThing):[string,string]|undefined {
  if(!thing.thread.startsWith(prefix)) return;
  let pair:unknown;
  try {pair=JSON.parse(thing.thread.slice(prefix.length));} catch {return;}
  if(Array.isArray(pair) && pair.length===2 && identifier(pair[0]) && identifier(pair[1]) &&
      pair[0]===thing.origin?.chatId && thing.thread===prefix+JSON.stringify(pair)) return [pair[0],pair[1]];
}

type Observe=(source:string,chatId:string,messageId:string)=>{senderId:string;deleted:boolean}|undefined;
export function collectInboxRelations(store:Store,offer:Offer,observe:Observe,source:string,ownerId:string,things:InboxThing[],
  evidence:CollectedReplyEvidence[],assertCurrent:()=>void) {
  const key=(chat:string,message:string)=>inboxItemId(source,prefix+JSON.stringify([chat,message]));
  function unavailable(chat:string,message:string) {
    const observed=observe(source,chat,message);
    return observed?.deleted || observed?.senderId===ownerId;
  }
  const arrivals=new Set<string>();
  for(const thing of things) {
    const pair=messageIdentity(thing);
    if(pair && !unavailable(...pair)) arrivals.add(key(...pair));
  }
  const latest=new Map<string,CollectedReplyEvidence>();
  for(const item of evidence) {
    if(item.source!==source || !identifier(item.chatId) || !identifier(item.messageId)) continue;
    const id=key(item.chatId,item.messageId);
    if(!latest.has(id) || item.deleted || item.senderId===ownerId || identifier(item.parentId)) latest.set(id,item);
  }

  // An unresolved edge belongs to one existing child. Its reverse index is consulted only when that parent arrives.
  function setPending(child:string,parent?:string) {
    store.transaction(()=>{
      const old=store.get<string>(pending,child);
      if(old===parent) return;
      if(old) store.remove(children(old),child);
      if(parent) {
        store.put(pending,child,parent);
        store.put(children(parent),child,child);
      } else store.remove(pending,child);
    });
  }

  function attempt(child:string,parent:string) {
    assertCurrent();
    const item=store.get<InboxItem>('inbox',child);
    const pair=item && messageIdentity(item);
    if(!item || !pair || item.source!==source || key(...pair)!==child || unavailable(...pair) ||
        (item.parentInboxId && item.parentInboxBy!=='connector')) {
      setPending(child);return;
    }
    setPending(child,offer(child,parent)==='missing' ? parent : undefined);
  }

  const excluded=new Set<string>();
  for(const [id,metadata] of latest) {
    if(!metadata.deleted && metadata.senderId!==ownerId && !unavailable(metadata.chatId,metadata.messageId)) continue;
    assertCurrent();
    excluded.add(id);
    const waiting=store.list<string>(children(id));
    setPending(id);
    for(const child of waiting) setPending(child);
  }
  for(const [child,metadata] of latest) {
    if(excluded.has(child)) continue;
    // A narrower CLI projection can omit parent_id. Only positive evidence can replace a pending parent.
    if(!identifier(metadata.parentId) || metadata.messageId===metadata.parentId) continue;
    const parent=key(metadata.chatId,metadata.parentId);
    if(excluded.has(parent) || unavailable(metadata.chatId,metadata.parentId)) {setPending(child);continue;}
    if(arrivals.has(child) || store.get('inbox',child)) attempt(child,parent);
  }
  for(const parent of arrivals) {
    if(excluded.has(parent)) continue;
    for(const child of store.list<string>(children(parent))) attempt(child,parent);
  }
}

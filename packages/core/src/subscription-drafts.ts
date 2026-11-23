import { createHash } from 'node:crypto';
import type { Store } from '../../plugin-sdk/src/index.ts';
import type { createSourceSubscriptions } from './source-subscriptions.ts';

type Service = ReturnType<typeof createSourceSubscriptions>;
type Draft = ReturnType<Service['configuration']> & {id:string;createdAt:string};
type StoredDraft=Draft & {used?:true};
const collection='source.subscription-drafts';
const lifetime=7*86400000;
const gone=()=>Object.assign(new Error('订阅草案已使用或过期，请重新生成。'),{status:410});

export function subscriptionDrafts(store:Store,service:()=>Service,changed:(id:string)=>void) {
  function list() {
    service();
    const result:Draft[]=[];
    for(const row of store.list<StoredDraft>(collection)) {
      if (Date.now()-Date.parse(row.createdAt)>=lifetime) store.remove(collection,row.id);
      else if(!row.used) result.push(row);
    }
    return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  function get(id:string) {
    service();
    const row=store.get<StoredDraft>(collection,id);
    if(!row || row.used || Date.now()-Date.parse(row.createdAt)>=lifetime) throw gone();
    return row;
  }
  async function propose(input:Record<string,unknown>,ownerMessage:()=>{id:string;createdAt:string},signal:AbortSignal) {
    const actor=ownerMessage();
    if(Date.now()-Date.parse(actor.createdAt)>=lifetime) throw gone();
    const current=service();
    const cfg=current.configuration(input);
    cfg.destinations.sort();
    const id=createHash('sha256').update(JSON.stringify([actor.id,cfg])).digest('hex').slice(0,16);
    const existing=store.get<StoredDraft>(collection,id);
    if(existing) return get(id);
    // No source contents are stored in a draft. Keep the proof of validation within this call.
    await current.preview({sourceId:cfg.sourceId,resource:cfg.resource},signal);
    signal.throwIfAborted();
    const verified=ownerMessage();
    if(verified.id!==actor.id || service()!==current) throw gone();
    const row={id,...cfg,createdAt:actor.createdAt};
    store.transaction(()=>{
      if(Date.now()-Date.parse(actor.createdAt)>=lifetime || store.get<StoredDraft>(collection,id)?.used) throw gone();
      store.put(collection,id,row);
    });
    changed(id);
    return row;
  }
  function create(input:Record<string,unknown>) {
    const current=service();
    if(input.draftId===undefined) return current.create(input);
    if(typeof input.draftId!=='string') throw gone();
    const id=input.draftId;
    return store.transaction(()=>{
      const draft=get(id);
      store.put(collection,id,{...draft,used:true});
      return current.create(input);
    });
  }
  return {list,get,propose,create};
}

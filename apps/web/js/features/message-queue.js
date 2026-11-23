import { h, keyedList } from '../lib/dom.js';
import { turnQueueActive } from './stop-turn.js';

export function createMessageQueue(api, store, messages, messageHref) {
  const summary=h('summary',null,'排队消息');
  const list=h('ol');
  const notice=h('p',{role:'status',hidden:true});
  const el=h('details',{class:'message-queue small',hidden:true},summary,list,notice);
  let scope, owner, timer, job, generation=0, pending=false, snapshot, event, fingerprint;

  function reset() {
    generation++;
    clearTimeout(timer); timer=undefined;
    job?.abort(); job=undefined; pending=false;
    el.hidden=true; el.open=false; notice.hidden=true;
    keyedList(list,[],row=>row.id,()=>null);
    snapshot=undefined; fingerprint=undefined;
  }
  function render(items) {
    notice.hidden=true;
    const rows=items.filter(item=>typeof item?.id==='string' && typeof item.text==='string');
    el.hidden=!rows.length;
    if(!rows.length) el.open=false;
    summary.textContent='排队消息（'+rows.length+'）';
    keyedList(list,rows,item=>item.id,item=>{
      const text=item.text.replace(/\s+/g,' ').trim();
      const attachments=[item.images>0 && item.images+' 张图片',item.files>0 && item.files+' 个文件'].filter(Boolean);
      const label=[text && (text.length>100?text.slice(0,100)+'…':text),...attachments].filter(Boolean).join(' · ') || '查看原消息';
      const link=h('a',{href:messageHref(item.id)},label);
      link.addEventListener('click',e=>{
        if(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        const original=messages.querySelector('[data-id="'+CSS.escape(item.id)+'"]');
        if(original) {
          e.preventDefault(); original.tabIndex=-1;
          original.focus({preventScroll:true});original.scrollIntoView({block:'center'});
        }
      });
      return h('li',null,link);
    });
  }
  function schedule() {
    if(job) {pending=true;return;}
    if(timer===undefined) timer=setTimeout(read,80);
  }
  async function read() {
    timer=undefined;
    const stamp=generation;
    const controller=job=new AbortController();
    try {
      const result=await api(scope,{signal:controller.signal});
      if(stamp===generation && owner===api.draftOwner()) render(result.items);
    } catch (error) {
      if(stamp===generation) {
        render([]);
        if (![401,403,404].includes(error.status)) {
          el.hidden=false;
          summary.textContent='排队消息暂不可读';
          notice.textContent=error.message || '队列读取失败';
          notice.hidden=false;
        }
      }
    } finally {
      if(job===controller) {
        job=undefined;
        if(pending) {pending=false;schedule();}
      }
    }
  }
  function update(path,conversationId) {
    const view=store.view, identity=api.draftOwner();
    const next=path && view.snapshotOwner===identity && view.connection==='online' && turnQueueActive(store) ? path : '';
    const changed=next!==scope || owner!==identity;
    if(changed) {reset();scope=next;owner=identity;}
    if(!scope) return;
    // Snapshots also cover reconnects and manually refreshed state. Most
    // snapshot changes concern other features and need no queue request.
    let changedInputs=false;
    if(snapshot!==view.snapshot) {
      snapshot=view.snapshot;
      const inputs=conversationId==='main'?snapshot.messages:snapshot.agentTurns;
      const nextFingerprint=JSON.stringify((inputs || []).filter(m=>m.conversationId===conversationId && m.role==='user' && m.status==='pending').map(m=>[m.id,m.queueState]));
      changedInputs=nextFingerprint!==fingerprint;
      fingerprint=nextFingerprint;
    }
    const messageChanged=event!==view.messageQueueChanges && view.messageQueueChanges?.includes(conversationId);
    event=view.messageQueueChanges;
    if(changed || changedInputs || messageChanged) schedule();
  }
  return {el,update};
}

import { h, keyedList } from '../lib/dom.js';
import { toast } from '../ui/overlay.js';
import { turnQueueActive } from './stop-turn.js';

export function createMessageQueue(api, store, messages, messageHref, editAction) {
  const summary=h('summary',null,'排队消息');
  const list=h('ol');
  const notice=h('p',{role:'status',hidden:true});
  const el=h('details',{class:'message-queue small',hidden:true},summary,list,notice);
  let scope, owner, timer, job, generation=0, pending=false, snapshot, event, fingerprint;

  let rows=[], writing, dragging;
  function reset() {
    generation++;
    clearTimeout(timer); timer=undefined;
    job?.abort(); job=undefined; pending=false;
    writing?.abort(); writing=undefined; dragging=undefined; rows=[];
    el.hidden=true; el.open=false; notice.hidden=true;
    keyedList(list,[],row=>row.id,()=>null);
    snapshot=undefined; fingerprint=undefined;
  }
  function updateControls() {
    list.setAttribute('aria-busy',String(!!writing));
    Array.from(list.children).forEach((row,index)=>{
      row.draggable=!writing && rows.length>1;
      for (const button of row.querySelectorAll('button[data-step]')) {
        const target=index+Number(button.dataset.step);
        button.setAttribute('aria-disabled',String(!!writing || target<0 || target>=rows.length));
      }
    });
  }
  function render(items) {
    const focus=document.activeElement;
    const focusedRow=list.contains(focus) && focus.closest('li');
    const focusedIndex=focusedRow ? rows.findIndex(item=>item.id===focusedRow.dataset.queueId) : -1;
    rows=items.filter(item=>typeof item?.id==='string' && typeof item.text==='string');
    el.hidden=!rows.length;
    if(!rows.length) el.open=false;
    summary.textContent='排队消息（'+rows.length+'）';
    keyedList(list,rows,item=>item.id,item=>{
      const text=item.text.replace(/\s+/g,' ').trim();
      const attachments=[item.images>0 && item.images+' 张图片',item.files>0 && item.files+' 个文件'].filter(Boolean);
      const label=[text && (text.length>100?text.slice(0,100)+'…':text),...attachments].filter(Boolean).join(' · ') || '查看原消息';
      const link=h('a',{href:messageHref(item.id),draggable:false},label);
      link.addEventListener('click',e=>{
        if(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        const original=messages.querySelector('[data-id="'+CSS.escape(item.id)+'"]');
        if(original) {
          e.preventDefault(); original.tabIndex=-1;
          original.focus({preventScroll:true});original.scrollIntoView({block:'center'});
        }
      });
      const moveButton=(label,step)=>h('button',{type:'button',class:'btn btn--ghost btn--sm',dataset:{step},onClick:()=>{
        const ids=rows.map(row=>row.id);
        void move(ids,item.id,ids.indexOf(item.id)+step);
      }},label);
      return h('li',{dataset:{queueId:item.id},'aria-keyshortcuts':'ArrowUp ArrowDown Home End',title:'可拖动调序，也可在本行按上下方向键、Home 或 End'},
        h('div',{class:'message-queue-row'},link,h('div',{class:'message-queue-actions'},moveButton('上移',-1),moveButton('下移',1),editAction?.(item))));
    });
    updateControls();
    // keyedList moves DOM nodes. Preserve keyboard focus on the same item,
    // or the nearest surviving row if the original has already started.
    if (focusedRow && !list.contains(document.activeElement) && rows.length) {
      const row=list.querySelector('[data-queue-id="'+CSS.escape(focusedRow.dataset.queueId)+'"]') || list.children[Math.min(Math.max(0,focusedIndex),rows.length-1)];
      const target=focus.dataset.step ? row.querySelector('[data-step="'+focus.dataset.step+'"]') : row.querySelector('a');
      target?.focus({preventScroll:true});
    }
  }
  async function move(expected,id,target) {
    const index=expected.indexOf(id);
    if(writing || !scope || !turnQueueActive(store) || owner!==api.draftOwner() || index<0 || target<0 || target>=expected.length || index===target) return;
    const ordered=[...expected]; ordered.splice(index,1); ordered.splice(target,0,id);
    // This GET may have been answered before the reorder took effect.
    clearTimeout(timer); timer=undefined; job?.abort(); job=undefined;
    const stamp=generation, controller=writing=new AbortController();
    const current=()=>generation===stamp && writing===controller && owner===api.draftOwner();
    notice.hidden=true;updateControls();
    try {
      const result=await api(scope,{method:'POST',body:{expected,ordered},signal:controller.signal});
      if(current()) render(result.items);
    } catch(error) {
      if(!current()) return;
      // A lost acknowledgement or stale list requires a fresh read. A write
      // is never repeated automatically.
      await read();
      if(!current()) return;
      const message=error.status===409
        ? (rows.length?'队列已变化，已重新读取，请核对顺序。':'队列已变化，请核对最新状态。')
        : '调序未确认：'+error.message+'。请核对队列顺序。';
      if(el.hidden) toast(message);
      else {notice.textContent=message;notice.hidden=false;}
    } finally {
      if(writing===controller) {
        writing=undefined;updateControls();
        if(pending) {pending=false;schedule();}
      }
    }
  }
  list.addEventListener('keydown',e=>{
    if(e.ctrlKey || e.metaKey || e.shiftKey) return;
    const id=e.target.closest('li')?.dataset.queueId;
    if(!id) return;
    const expected=rows.map(row=>row.id), index=expected.indexOf(id);
    const target={ArrowUp:index-1,ArrowDown:index+1,Home:0,End:expected.length-1}[e.key];
    if(typeof target!=='number') return;
    e.preventDefault(); void move(expected,id,target);
  });
  list.addEventListener('dragstart',e=>{
    const row=e.target.closest('li');
    if(!row || writing || !row.draggable) {e.preventDefault();return;}
    dragging={id:row.dataset.queueId,expected:rows.map(item=>item.id)};
    e.dataTransfer.effectAllowed='move';
    e.dataTransfer.setData('text/plain',row.dataset.queueId);
  });
  list.addEventListener('dragover',e=>{
    if(!dragging || !e.target.closest('li')) return;
    e.preventDefault(); e.dataTransfer.dropEffect='move';
  });
  list.addEventListener('drop',e=>{
    if(!dragging) return;
    e.preventDefault();
    const {id,expected}=dragging;dragging=undefined;
    void move(expected,id,expected.indexOf(e.target.closest('li')?.dataset.queueId));
  });
  list.addEventListener('dragend',()=>{dragging=undefined;});
  function schedule() {
    if(job || writing) {pending=true;return;}
    if(timer===undefined) timer=setTimeout(read,80);
  }
  async function read() {
    timer=undefined;
    const stamp=generation;
    const controller=job=new AbortController();
    try {
      const result=await api(scope,{signal:controller.signal});
      if(stamp===generation && job===controller && owner===api.draftOwner()) {
        if(notice.dataset.readError) {notice.hidden=true;delete notice.dataset.readError;}
        render(result.items);
      }
    } catch (error) {
      if(stamp===generation && job===controller) {
        render([]);
        if (![401,403,404].includes(error.status)) {
          el.hidden=false;
          summary.textContent='排队消息暂不可读';
          notice.textContent=error.message || '队列读取失败';
          notice.hidden=false;notice.dataset.readError='true';
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

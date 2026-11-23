import { h } from './dom.js';
import { Button } from '../ui/kit.js';
import { confirmDialog } from '../ui/overlay.js';
import { clearSubmissionPayloads, readSubmissionPayload, removeSubmissionPayload, saveSubmissionPayload } from './submission-payloads.js';

const rowLabel={rejected:'发送被拒绝',unknown:'发送结果未知',missing:'未找到发送回执'};
export function createMessageOutbox({enabled,persist,act,render}) {
  const payloads=new Map(),loads=new Map(),persistPolicy=new Map();
  let owner;
  const panel=h('section',{class:'stack message-outbox',role:'region','aria-label':'待确认发件',hidden:true});
  const title=h('strong',null,'待确认发件');
  const ignored=()=>{};
  const key=(ctx,id)=>JSON.stringify([ctx.owner,ctx.key,id]);
  function sync(ctx) {
    if(owner!==ctx.owner) {owner=ctx.owner;payloads.clear();loads.clear();}
    if(!owner) return;
    const durable=!!persist();
    if(!durable && persistPolicy.get(owner)!==false) void clearSubmissionPayloads(owner).catch(ignored);
    persistPolicy.set(owner,durable);
  }
  function remember(ctx,id) {
    if(!enabled() || !ctx.owner || !ctx.key) return;
    const payload={text:ctx.body,projectId:ctx.projectId,todoId:ctx.todoId,
      images:(ctx.images||[]).map(({name,mime,data,bytes,sha256})=>({name,mime,data,bytes,sha256})),
      files:(ctx.files||[]).map(({name,mime,bytes,sha256,uploadId})=>({name,mime,bytes,sha256,uploadId}))};
    const k=key(ctx,id);
    if (!payloads.get(k)) payloads.set(k,payload);
    if(persist()) return saveSubmissionPayload(ctx.owner,ctx.key,id,payload).catch(()=>false);
  }
  function forget(ctx,id) {
    const k=key(ctx,id);
    payloads.delete(k);loads.delete(k);
    if(ctx.owner && ctx.key) void removeSubmissionPayload(ctx.owner,ctx.key,id).catch(ignored);
  }
  function load(ctx,id) {
    const k=key(ctx,id);
    if(payloads.has(k) || loads.has(k) || !persist()) return;
    const pending=readSubmissionPayload(ctx.owner,ctx.key,id).catch(ignored);
    loads.set(k,pending);
    void pending.then(payload=>{
      if(loads.get(k)!==pending) return;
      loads.delete(k);
      if(ctx.owner!==owner || !enabled() || !persist()) return;
      if (!payloads.get(k)) payloads.set(k,payload || null);
      render();
    });
  }
  let signature;
  function paint(ctx,rows,locked) {
    sync(ctx);
    const visible=!!ctx.owner && !!ctx.key && enabled() && rows.length>0;
    panel.hidden=!visible;
    if(!visible) {panel.replaceChildren();signature=undefined;return;}
    for(const record of rows) load(ctx,record.id);
    const next=JSON.stringify([ctx.owner,ctx.key,ctx.epoch,rows.map(r=>[r.id,r.state,r.reason,locked(r.id),payloads.has(key(ctx,r.id)),!!payloads.get(key(ctx,r.id))])]);
    if(next===signature) return;
    signature=next;
    panel.replaceChildren(title,...rows.map(record=>{
      const payload=payloads.get(key(ctx,record.id)), state=record.state || 'unknown', busy=locked(record.id);
      const names=[...(payload?.images||[]).map(r=>r.name || '图片'),...(payload?.files||[]).map(r=>r.name)];
      const run=operation=>act(operation,ctx,record,payload);
      return h('article',{class:'stack',dataset:{requestId:record.id}},
        h('span',null,payload?.text ? payload.text.slice(0,240)+(payload.text.length>240?'…':'') :
          payload ? '仅附件' : loads.has(key(ctx,record.id))?'正在读取原发件…':'未保存原文，可核对回执。'),
        names.length>0 && h('span',{class:'muted small'},names.join('、')),
        h('span',{class:'small',role:'status'},rowLabel[state]+(record.reason?' · '+record.reason:'')),
        h('div',{class:'row row--wrap'},
          Button({label:'核对回执',size:'sm',disabled:busy,onClick:()=>run('check')}),
          Button({label:'重新发送',size:'sm',disabled:busy || !payload,onClick:()=>run('send')}),
          Button({label:'移除记录',kind:'ghost',size:'sm',disabled:busy,onClick:async()=>{
            if(await confirmDialog({title:'移除发件记录',message:'移除本地发件记录。服务端已受理的消息会保留。',confirmLabel:'移除记录'}))
              return run('remove');
          }})));
    }));
  }
  return {panel,remember,forget,paint};
}

import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';
import { conversationSearchActive } from './search.js';

export function conversationMessageSearch({api,store,router}) {
  let scope, owner, drawer;
  const button=Button({label:'搜索本对话',size:'sm',onClick:open});
  button.hidden=true;
  function close() {
    if(drawer) { drawer.cancel(); drawer.close(); drawer=undefined; }
  }
  function update(next) {
    const who=api.draftOwner();
    if(!next || !who || who!==store.view.snapshotOwner || store.view.unauthorized || !conversationSearchActive(store.view.snapshot))
      next=undefined;
    if(owner!==who || scope?.conversationId!==next?.conversationId || scope?.projectId!==next?.projectId || scope?.todoId!==next?.todoId) close();
    owner=who;scope=next;button.hidden=!next;
  }
  function open() {
    if(!scope || drawer) return;
    const input=h('input',{type:'search',class:'input','aria-label':'搜索关键词',placeholder:'输入要查找的原文'});
    const status=h('p',{class:'muted small',role:'status'});
    const list=h('ul',{class:'stack','aria-label':'命中消息'});
    const more=Button({label:'加载更多',size:'sm',onClick:()=>void read(cursor)});
    const submit=Button({label:'搜索',type:'submit',size:'sm'});
    const form=h('form',{class:'row'},input,submit);
    const body=h('div',{class:'stack'},form,status,list,more);
    let job,timer,cursor,total=0;
    const seen=new Set();
    const view=openDrawer({title:'搜索本对话',body,onClose:()=>{
      cancel();if(drawer===view) drawer=undefined;
    }});
    function cancel() {clearTimeout(timer);job?.abort();job=undefined;}
    view.cancel=cancel;drawer=view;
    function reset() {
      cancel();cursor=undefined;total=0;seen.clear();replace(list);more.hidden=true;
      status.textContent=input.value.trim()?'正在搜索…':'';
    }
    async function read(before) {
      cancel();
      const query=input.value.trim();
      if(!query || !scope || drawer!==view) return;
      const task=job=new AbortController(),range=scope;
      const valid=()=>view.el.open && drawer===view && job===task && !task.signal.aborted && owner===api.draftOwner() && !store.view.unauthorized;
      more.disabled=true;status.textContent='正在搜索…';
      try {
        const result=await api('/conversation-message-search',{method:'POST',body:{...range,query,before},signal:task.signal});
        if(!valid()) return;
        const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
        for(const hit of result.hits) {
          if(seen.has(hit.id)) continue;
          seen.add(hit.id);
          const at=new URLSearchParams({at:hit.id});
          if(range.todoId) at.set('todo',range.todoId);
          const base=range.conversationId==='main'?router.href('chat'):router.href('projects',range.projectId,'workspace');
          const href=base+'?'+at;
          const match=pattern.exec(hit.text);
          const excerpt=match ? [hit.text.slice(0,match.index),h('mark',null,match[0]),hit.text.slice(match.index+match[0].length)] : [hit.text];
          const link=h('a',{href,onClick:e=>{
            if(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();close();router.go(href);
          }},...excerpt);
          list.append(h('li',null,h('div',{class:'small muted'},(hit.role==='user'?'我':'助手')+' · '+new Date(hit.createdAt).toLocaleString()),link));
          total++;
        }
        cursor=result.nextBefore;more.hidden=!cursor;
        status.textContent=total?'已显示 '+total+' 条命中消息。':'没有找到匹配的消息。';
      } catch(error) {
        if(valid()) status.textContent='搜索失败：'+error.message;
      } finally {
        if(valid()) {more.disabled=false;job=undefined;}
      }
    }
    input.addEventListener('input',()=>{reset();if(input.value.trim())timer=setTimeout(()=>void read(),200);});
    form.addEventListener('submit',event=>{event.preventDefault();reset();void read();});
    reset();input.focus();
  }
  return {button,update};
}

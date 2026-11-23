import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';
import { conversationSearchActive } from './search.js';

const categories={text:'正文',quoted:'引用',file:'附件名',tool_name:'工具名',tool_input:'工具入参',tool_output:'工具返回',event:'工作事件'};

export function conversationMessageSearch({api,store,router,hitLink,allowedCategories}) {
  let scope, owner, drawer, filesEnabled, officeEnabled;
  const button=Button({label:'搜索本对话',size:'sm',onClick:open});
  button.hidden=true;
  function close() {
    if(drawer) { drawer.cancel(); drawer.close(); drawer=undefined; }
  }
  function update(next) {
    const who=api.draftOwner();
    if(!next || !who || who!==store.view.snapshotOwner || store.view.unauthorized || !conversationSearchActive(store.view.snapshot))
      next=undefined;
    const files=!!store.view.snapshot?.plugins?.some(plugin=>plugin.id==='conversation-files' && plugin.status==='active');
    const office=!!store.view.snapshot?.plugins?.some(plugin=>plugin.id==='office-documents' && plugin.status==='active');
    if(officeEnabled!==office || filesEnabled!==files || owner!==who || scope?.conversationId!==next?.conversationId || scope?.projectId!==next?.projectId || scope?.todoId!==next?.todoId) close();
    officeEnabled=office;filesEnabled=files;owner=who;scope=next;button.hidden=!next;
  }
  function open() {
    if(!scope || drawer) return;
    const input=h('input',{type:'search',class:'input','aria-label':'搜索关键词',placeholder:'输入要查找的原文'});
    const category=h('select',{'aria-label':'搜索内容'},
      h('option',{value:''},'全部'),Object.entries(categories)
        .filter(([value])=>(!allowedCategories || allowedCategories.includes(value)) && (value!=='file' || filesEnabled)).map(([value,label])=>h('option',{value},label)));
    const status=h('p',{class:'muted small',role:'status'});
    const list=h('ul',{class:'stack','aria-label':'命中消息'});
    const more=Button({label:'加载更多',size:'sm',onClick:()=>void read(cursor)});
    const submit=Button({label:'搜索',type:'submit',size:'sm'});
    const form=h('form',{class:'row'},input,category,submit);
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
        const result=await api('/conversation-message-search',{method:'POST',body:{...range,query,before,...(category.value && {category:category.value})},signal:task.signal});
        if(!valid()) return;
        const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
        for(const hit of result.hits) {
          const matches=(hit.matches?.length?hit.matches:[{text:hit.text}]).filter(part=>part.category!=='file' || filesEnabled);
          if(!matches.length || seen.has(hit.id)) continue;
          seen.add(hit.id);
          const at=new URLSearchParams({at:hit.id});
          if(range.todoId) at.set('todo',range.todoId);
          const href=hitLink?hitLink(range,hit.id):
            (range.conversationId==='main'?router.href('chat'):router.href('projects',range.projectId,'workspace'))+'?'+at;
          const excerpts=matches.map(part=>{
            const match=pattern.exec(part.text);
            const excerpt=match ? [part.text.slice(0,match.index),h('mark',null,match[0]),part.text.slice(match.index+match[0].length)] : [part.text];
            const label=categories[part.category];
            const tool=(part.category==='tool_input' || part.category==='tool_output') && part.toolName;
            return h('div',null,label && h('span',{class:'small muted'},label+' · '+(tool?tool+' · ':'')),h('a',{href,onClick:e=>{
              if(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();close();router.go(href);
            }},...excerpt));
          });
          list.append(h('li',null,h('div',{class:'small muted'},(hit.role==='user'?'我':'助手')+' · '+new Date(hit.createdAt).toLocaleString()),...excerpts));
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
    category.addEventListener('change',()=>{reset();void read();});
    form.addEventListener('submit',event=>{event.preventDefault();reset();void read();});
    reset();input.focus();
  }
  return {button,update};
}

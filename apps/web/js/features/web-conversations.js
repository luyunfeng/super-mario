import {h,replace} from '../lib/dom.js';
import {uuid} from '../lib/format.js';
import {renderFormattedText} from '../lib/markdown.js';
import {createConversationDrafts} from '../lib/conversation-drafts.js';
import {createMessageSubmissions} from '../lib/message-submissions.js';
import {openDrawer} from '../ui/overlay.js';

const uuid4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const path='/web-conversations';
const button=(label,onClick)=>h('button',{type:'button',class:'btn btn--sm',onclick:onClick},label);
const href=id=>'#chat?'+new URLSearchParams({thread:id});

export function createWebConversations({api,store,scope,router}){
  const drafts=createConversationDrafts({api,store});
  const active=()=>store.view.snapshotOwner===drafts.owner() && !store.view.unauthorized &&
    store.view.snapshot?.plugins?.some(p=>p.id==='web-conversations' && p.status==='active');
  const listProject=()=>meta?.projectId || (current && meta?'':scope.get() || '');
  const routeId=()=>router.current.page==='chat'?router.current.query.get('thread'):null;
  const entry=button('独立对话',openList);
  const heading=h('h1',{},'独立对话'),notice=h('p',{role:'status',class:'small'});
  const messages=h('div',{class:'msgs','aria-live':'polite'}),more=button('加载更早消息',()=>loadMessages(true));
  const scroller=h('div',{class:'chat__scroll'},h('div',{class:'chat__inner'},more,messages));
  const input=h('textarea',{class:'composer__input',rows:2,maxLength:20000,'aria-label':'给独立对话发消息',placeholder:'输入消息，Enter 发送'});
  const send=h('button',{class:'btn btn--sm btn--primary',type:'submit'},'发送');
  const retry=button('重新读取对话',()=>{reset();update();});
  const form=h('form',{class:'composer',onsubmit:event=>{event.preventDefault();void post();}},
    h('div',{class:'composer__box'},input,h('div',{class:'composer__bar'},h('span',{class:'grow'}),send)));
  const el=h('div',{class:'chat-code-main',hidden:true,'aria-label':'独立对话内容'},
    h('div',{class:'chat__top'},h('header',{class:'page__head'},heading,h('div',{class:'page__actions'},button('独立对话',openList),
      h('a',{class:'btn btn--sm',href:'#chat'},'返回主对话'))),notice,retry),scroller,form);
  let selector,selectorScope,selectorOwner,current,meta,nextBefore,readVersion=0,rows=[],lastChanges,lastConnection;
  let pending=false,epoch=0,draftKey=null;
  const valid=stamp=>current===stamp && stamp && stamp.owner===drafts.owner() && routeId()===stamp.id && active();
  function context(){
    return {key:meta && valid(current)?draftKey:null,owner:current?.owner,epoch,draft:input.value,body:input.value.trim(),
      captured:'',conversation:'web:'+current?.id,projectId:meta?.projectId || undefined,url:path+'/'+current?.id+'/messages'};
  }
  function confirmed(ctx){
    drafts.clearIf(ctx.key,ctx.draft);
    if(context().key===ctx.key && input.value===ctx.draft)input.value=drafts.read(ctx.key);
  }
  const submissions=createMessageSubmissions({api,context,onConfirmed:confirmed,onStatus:text=>{notice.textContent=text;},captureEdit:()=>()=>{},
    isRecoveryEnabled:()=>!!active() && store.view.snapshot.plugins.some(p=>p.id==='conversation-outbox' && p.status==='active'),
    canPersistDraft:()=>store.view.snapshot?.plugins.some(p=>p.id==='conversation-drafts' && p.status==='active')});
  form.prepend(submissions.panel,submissions.button);
  input.oninput=()=>{const key=context().key;if(key)drafts.write(key,input.value);};
  input.onkeydown=e=>{if(e.key==='Enter' && !e.shiftKey && !e.isComposing){e.preventDefault();form.requestSubmit();}};

  function reset(){
    current=null;meta=null;draftKey=null;rows=[];epoch++;readVersion++;pending=false;nextBefore=null;
    input.value='';heading.textContent='独立对话';replace(messages);form.hidden=true;more.hidden=true;retry.hidden=true;notice.textContent='';
    submissions.update();
  }
  function openList(){
    if(!active() || selector)return;
    const owner=drafts.owner(),projectId=listProject(),name=h('input',{class:'input',placeholder:'新对话',maxLength:160,'aria-label':'对话标题'});
    selectorScope=projectId;selectorOwner=owner;
    const list=h('div',{class:'stack'}),status=h('p',{role:'status',class:'small'}),submit=h('button',{class:'btn btn--primary',type:'submit'},'创建对话');
    let candidate;
    const createKey='sm.web-conversation-create.'+JSON.stringify([owner,projectId]);
    // Store only the pending request ID and a fingerprint, so reopening after a lost receipt reuses the ID.
    function identify(title){
      const hash=Array.from(globalThis.sha256(new TextEncoder().encode(title)),b=>b.toString(16).padStart(2,'0')).join('');
      let cached;
      try{cached=JSON.parse(sessionStorage.getItem(createKey));}catch{/* Storage may be unavailable. */}
      const id=cached?.hash===hash && uuid4.test(cached.id)?cached.id:uuid();
      try{sessionStorage.setItem(createKey,JSON.stringify({id,hash}));}catch{/* This drawer retains its request. */}
      return {id,title,...(projectId && {projectId})};
    }
    const draft=h('form',{class:'stack',onsubmit:async e=>{
      e.preventDefault();if(!ok() || submit.disabled)return;
      const title=name.value.trim() || '新对话';if([...title].length>80){status.textContent='对话标题最多 80 个字符。';return;}
      submit.disabled=true;name.readOnly=true;
      try{
        if(candidate?.title!==title)candidate=identify(title);
        const result=await api.post(path,candidate);
        if(!ok())return;
        if(result.id!==candidate.id)throw Error('创建回执与原请求不符。');
        try{if(JSON.parse(sessionStorage.getItem(createKey))?.id===result.id)sessionStorage.removeItem(createKey);}catch{/* No cached request. */}
        drawer.close();router.go(href(result.id));
      }catch(error){if(ok())status.textContent=error.message;}
      finally{if(ok()){submit.disabled=false;name.readOnly=false;}}
    }},h('label',{class:'field'},'对话标题',name),submit);
    const drawer=openDrawer({title:'独立对话',body:[draft,status,list],onClose:()=>{if(selector===drawer)selector=null;}});
    selector=drawer;
    const ok=()=>selector===drawer && drawer.el.open && active() && drafts.owner()===owner && listProject()===projectId;
    status.textContent='正在读取对话…';
    api.get(path+'?'+new URLSearchParams({projectId})).then(result=>{
      if(!ok())return;
      status.textContent=result.items.length?'':'当前范围还没有独立对话。';
      replace(list,result.items.map(row=>h('a',{class:'btn btn--ghost',href:href(row.id),onclick:()=>drawer.close()},row.title)));
    }).catch(error=>{if(ok())status.textContent=error.message;});
  }
  function display(){
    replace(messages,rows.map(row=>h('article',{class:'msg msg--'+(row.role==='user'?'user':'assistant'),dataset:{id:row.id}},
      h('div',{class:'msg__bubble'},renderFormattedText(row.text,undefined,{reply:row.role==='assistant'})),
      row.status==='pending' && h('small',{},'处理中…'),row.status==='failed' && h('small',{},'处理失败'))));
    more.hidden=!nextBefore;
  }
  async function loadMessages(earlier=false){
    const stamp=current,version=++readVersion;
    if(!valid(stamp) || !meta)return;
    const cursor=earlier?nextBefore:null;if(earlier && !cursor)return;
    more.disabled=true;
    try{
      const page=await api.get(path+'/'+stamp.id+'/messages'+(cursor?'?before='+encodeURIComponent(cursor):''));
      if(!valid(stamp) || version!==readVersion)return;
      if(page.messages.some(m=>m.conversationId!=='web:'+stamp.id || (m.projectId || '')!==(meta.projectId || '')))throw Error('消息与当前对话不匹配。');
      const previousHeight=scroller.scrollHeight,nearEnd=previousHeight-scroller.scrollTop-scroller.clientHeight<100;
      const overlap=earlier?-1:rows.findIndex(row=>row.id===page.messages[0]?.id);
      if(earlier){rows=[...page.messages,...rows];nextBefore=page.nextBefore;}
      else if(overlap>0){rows=[...rows.slice(0,overlap),...page.messages];}
      else{rows=page.messages;nextBefore=page.nextBefore;}
      display();retry.hidden=true;
      if(earlier)scroller.scrollTop+=scroller.scrollHeight-previousHeight;else if(nearEnd)scroller.scrollTop=scroller.scrollHeight;
    }catch(error){
      if(!valid(stamp) || version!==readVersion)return;
      if([401,403,404,410,503].includes(error.status)){meta=null;replace(messages);rows=[];input.value='';form.hidden=true;more.hidden=true;}
      notice.textContent=error.message;retry.hidden=false;
    }finally{if(valid(stamp) && version===readVersion)more.disabled=false;}
  }
  async function open(stamp){
    notice.textContent='正在读取对话…';
    try{
      const result=await api.get(path+'/'+stamp.id);
      if(!valid(stamp))return;
      if(result.id!==stamp.id)throw Error('对话记录与链接不匹配。');
      meta=result;draftKey=JSON.stringify(['web',stamp.id]);heading.textContent=result.title;
      notice.textContent='';input.value=drafts.read(draftKey);form.hidden=false;submissions.update();
      await loadMessages();
    }catch(error){if(valid(stamp)){notice.textContent=error.message;retry.hidden=false;}}
  }
  async function post(){
    const stamp=current,ctx=context();
    if(!valid(stamp) || !ctx.key || !ctx.body || pending)return;
    const ticket=submissions.begin(ctx);if(!ticket)return;
    if(ticket.record.blocked){notice.textContent='请先核对发送回执。';return;}
    pending=true;send.disabled=true;notice.textContent='';
    try{
      const receipt=await submissions.preflight(ticket,ctx);
      if(!valid(stamp))return;
      const reply=receipt ?? await api.post(ctx.url,{text:ctx.body},{'Idempotency-Key':ticket.record.id});
      if(!valid(stamp))return;
      if(!submissions.accepted(ticket,reply,ctx)){submissions.block(ticket);throw Error('回执与原消息不匹配。');}
      confirmed(ctx);await loadMessages();
    }catch(error){submissions.failed(ticket,error);if(valid(stamp))notice.textContent='发送未确认：'+error.message;}
    finally{submissions.finish(ticket);if(valid(stamp)){pending=false;send.disabled=false;}}
  }
  function update(){
    const id=routeId(),owner=drafts.owner();
    entry.hidden=!active();el.hidden=id===null;
    if(selector && (!active() || selectorOwner!==owner || selectorScope!==listProject()))selector.close();
    if(id===null || !active() || !uuid4.test(id)){
      if(current || !form.hidden)reset();
      if(id!==null)notice.textContent=!uuid4.test(id)?'独立对话链接无效。':store.view.snapshot?'独立对话插件不可用。':'正在连接工作台…';
      return;
    }
    if(meta?.projectId && !store.view.snapshot.projects?.some(p=>p.id===meta.projectId && !p.archivedAt)){
      reset();notice.textContent='原项目已归档或不可用。';return;
    }
    if(current?.id!==id || current.owner!==owner){reset();current={id,owner};send.disabled=false;void open(current);}
    else if(meta && ((lastChanges!==store.view.messageQueueChanges && store.view.messageQueueChanges?.includes('web:'+id)) ||
      (lastConnection!=='online' && store.view.connection==='online')))void loadMessages();
    lastChanges=store.view.messageQueueChanges;lastConnection=store.view.connection;
  }
  reset();store.subscribe(update);router.subscribe(update);scope.subscribe(update);
  return {el,entry,update,focus:()=>{if(!form.hidden)input.focus();}};
}

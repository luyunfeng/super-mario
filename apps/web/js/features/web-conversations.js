import {attachSentHistory} from './sent-history.js';
import {createMessageQueue} from './message-queue.js';
import {createQueuedDraftEditor} from './edit-queued.js';
import {turnQueueActive,queueLabel} from './stop-turn.js';
import {createWebImageExport} from './web-conversation-image-export.js';
import {createReplyTranslation} from './reply-translation.js';
import {webThreadStopButton} from './stop-turn.js';
import {createTurnRetry,turnRetryActive} from './retry-turn.js';
import {conversationImagesActive,createMessageImages,messageImages} from './message-images.js';
import {createMessageFiles,messageFiles} from './message-files.js';
import {createMessageCopyActions,conversationExportActive,openConversationExport} from './conversation-export.js';
import {attachSavedPrompts} from './saved-prompts.js';
import {createMessageFavorites} from './message-favorites.js';
import {createAssistantSwitcher} from './assistant-roster.js';
import {conversationMessageSearch} from './conversation-message-search.js';
import {copyText} from '../lib/clipboard.js';
import {icon} from '../ui/icons.js';
import {h,replace} from '../lib/dom.js';
import {uuid, timeAgo} from '../lib/format.js';
import {createConversationDrafts} from '../lib/conversation-drafts.js';
import {createMessageEdit} from '../lib/message-edit.js';
import {createMessageQuote,quoteDraftKey} from '../lib/message-quote.js';
import {createMessageSubmissions,messagePayload} from '../lib/message-submissions.js';
import {openDrawer} from '../ui/overlay.js';

const uuid4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const path='/web-conversations';
const button=(label,onClick)=>h('button',{type:'button',class:'btn btn--sm',onclick:onClick},label);
const href=(id,at)=>'#chat?'+new URLSearchParams({thread:id,...(at && {at})});

export function createWebConversations({api,store,scope,router}){
  const retryTurn=createTurnRetry(api,store);
  let retryEnabled=false,canStop=false;
  const drafts=createConversationDrafts({api,store});
  const search=conversationMessageSearch({api,store,router,allowedCategories:['text','quoted','file'],hitLink:(range,id)=>href(range.conversationId.slice(4),id)});
  const active=()=>store.view.snapshotOwner===drafts.owner() && !store.view.unauthorized &&
    store.view.snapshot?.plugins?.some(p=>p.id==='web-conversations' && p.status==='active');
  const listProject=()=>meta?.projectId || (current && meta?'':scope.get() || '');
  const routeId=()=>router.current.page==='chat'?router.current.query.get('thread'):null;
  let selector,selectorScope,selectorOwner,current,meta,nextBefore,nextAfter,targetMessage,readVersion=0,rows=[],lastChanges,lastConnection;
  const translation=createReplyTranslation({api,store,getScope:()=>meta?.projectId,getConversationId:()=>meta && 'web:'+meta.id});
  let translationEpoch=0;
  const switcher=createAssistantSwitcher({api,store,router,scope,target:()=>{
    if(router.current.page!=='chat')return;
    const threadId=routeId();
    if(threadId===null)return {projectId:scope.get() || undefined};
    if(active() && meta && current?.owner===drafts.owner() && meta.id===threadId)return {threadId,projectId:meta.projectId};
  }});
  const favorites=createMessageFavorites({api,store,router,readable:()=>!!meta && valid(current)});
  let favoriteEpoch=favorites.epoch,exportDrawer;
  const exportButton=button('导出对话',()=>{
    const stamp=current,row=meta;
    const isCurrent=()=>valid(stamp) && meta?.id===row?.id && meta?.projectId===row?.projectId;
    if(!row || !isCurrent() || exportDrawer?.el.open)return;
    exportDrawer=openConversationExport({api,store,subtitle:row.title,source:{webThreadId:row.id,...(row.projectId && {projectId:row.projectId})},
      isCurrent,onSourceError:error=>{
        if(error.status!==410)return false;
        deleted(stamp.id,stamp.owner);return true;
      }});
  });
  const imageExport=createWebImageExport({api,redraw:display,source:()=>meta && valid(current) && conversationExportActive(store)
    ? {id:meta.id,projectId:meta.projectId,title:meta.title,owner:current.owner,imagesEnabled:conversationImagesActive(store),
      filesEnabled:store.view.snapshot.plugins.some(p=>p.id==='conversation-files' && p.status==='active')} : null});
  const entry=button('独立对话',openList);
  const heading=h('h1',{},'独立对话'),notice=h('p',{role:'status',class:'small'});
  const messages=h('div',{class:'msgs','aria-live':'polite'});
  const more=button('加载更早消息',()=>loadMessages('before')),later=button('加载后续消息',()=>loadMessages('after'));
  const latest=h('a',{class:'btn btn--sm',hidden:true},'返回最新消息');
  const scroller=h('div',{class:'chat__scroll'},h('div',{class:'chat__inner'},more,messages,later));
  const input=h('textarea',{class:'composer__input',rows:2,maxLength:20000,'aria-label':'给独立对话发消息',placeholder:'输入消息，Enter 发送'});
  const pictures=createMessageImages(input);
  const files=createMessageFiles(api,store,input);
  const quote=createMessageQuote({drafts,input,store,router,scope});
  const prompts=attachSavedPrompts({api,store,input,getAssistantId:()=>meta?.assistantId,getScope:()=>meta && valid(current) ? meta.id : null});
  let promptEpoch=prompts.epoch,quoteKey=null,editEnabled=false;
  const edit=createMessageEdit({input,quote,context:()=>({
    key:meta && !meta.archived && valid(current) ? draftKey : null,
    owner:drafts.owner(),enabled:editEnabled,quotesEnabled:!!quoteKey,
  })});
  const send=h('button',{class:'btn btn--sm btn--primary',type:'submit'},'发送');
  const cleanupRetry=button('按原版本重试删除',retryDeletion);
  cleanupRetry.hidden=true;
  let unconfirmedDeletion;
  let failedPage;
  const retry=button('重新读取对话',()=>{
    if(failedPage && meta)return loadMessages(failedPage);
    reset();update();
  });
  const form=h('form',{class:'composer',onsubmit:event=>{event.preventDefault();void post();}},
    h('div',{class:'composer__box'},edit.notice,quote.bar,prompts.menu,pictures.el,files.el,input,h('div',{class:'composer__bar'},prompts.manage,pictures.button,files.button,h('span',{class:'grow'}),send)));
  const rename=button('修改对话标题',openRename),archive=button('归档对话',()=>changeArchive());
  const stateLabel=h('span',{class:'small muted'});
  const controls=h('div',{class:'row row--wrap'},stateLabel,rename,archive,button('删除对话',openDelete));
  const el=h('div',{class:'chat-code-main',hidden:true,'aria-label':'独立对话内容'},
    h('div',{class:'chat__top'},h('header',{class:'page__head'},heading,h('div',{class:'page__actions'},button('独立对话',openList),switcher.threadButton,search.button,favorites.button,exportButton,imageExport.enter,
      h('a',{class:'btn btn--sm',href:'#chat'},'返回主对话'))),controls,imageExport.controls,notice,latest,retry,cleanupRetry),scroller,form);
  let pending=false,epoch=0,draftKey=null,renameDrawer,deleteDrawer,listRefresh,lastMetaEvent,changing=false;
  const valid=stamp=>current===stamp && stamp && stamp.owner===drafts.owner() && routeId()===stamp.id && active();
  const copies=createMessageCopyActions({api,store,matches:row=>valid(current) && meta &&
    row.conversationId==='web:'+current.id && row.projectId===meta.projectId});
  function context(){
    const captured=quoteKey ? quote.capture() : '';
    return {key:meta && !meta.archived && valid(current)?draftKey:null,owner:current?.owner,epoch,draft:input.value,body:quote.compose(captured,input.value.trim()).trim(),
      captured,images:pictures.capture(),files:files.capture(),conversation:'web:'+current?.id,projectId:meta?.projectId || undefined,url:path+'/'+current?.id+'/messages'};
  }
  let queueEnabled=false;
  const queuedEdit=createQueuedDraftEditor({api,store,input,pictures,files,context,isEditing:()=>!edit.notice.hidden,
    isSending:()=>pending,persist:()=>store.view.snapshot?.plugins.some(p=>p.id==='conversation-drafts' && p.status==='active')});
  const queue=createMessageQueue(api,store,messages,id=>href(current.id,id),item=>queuedEdit.action(rows.find(row=>row.id===item.id) || item,true));
  form.prepend(queue.el);
  const history=attachSentHistory({input,store,currentConversationOnly:true,context:()=>({
    key:meta && !meta.archived && valid(current) ? draftKey : null,owner:drafts.owner(),
    draftsEnabled:store.view.snapshot?.plugins.some(p=>p.id==='conversation-drafts' && p.status==='active')
  })});
  function confirmed(ctx){
    if(context().key===ctx.key)history.record(ctx);
    pictures.accepted(ctx);files.accepted(ctx);drafts.clearIf(ctx.key,ctx.draft);
    if(ctx.captured)quote.accepted(ctx.key,ctx.captured);
    if(context().key===ctx.key && input.value===ctx.draft)input.value=drafts.read(ctx.key);
  }
  const submissions=createMessageSubmissions({api,context,onConfirmed:confirmed,onStatus:text=>{notice.textContent=text;},captureEdit:edit.onAccepted,
    isRecoveryEnabled:()=>!!active() && store.view.snapshot.plugins.some(p=>p.id==='conversation-outbox' && p.status==='active'),
    canPersistDraft:()=>store.view.snapshot?.plugins.some(p=>p.id==='conversation-drafts' && p.status==='active')});
  form.prepend(submissions.panel,submissions.button);
  input.oninput=()=>{const key=context().key;if(key)drafts.write(key,input.value);};
  input.onkeydown=e=>{if(!e.defaultPrevented && e.key==='Enter' && !e.shiftKey && !e.isComposing){e.preventDefault();form.requestSubmit();}};

  function syncSearch(){
    prompts.update();
    const readable=meta && valid(current);
    const writableKey=readable && !meta.archived ? draftKey : null;
    const persist=!!store.view.snapshot?.plugins.some(p=>p.id==='conversation-drafts' && p.status==='active');
    pictures.update(writableKey,drafts.owner(),persist,conversationImagesActive(store));
    files.update(writableKey,drafts.owner(),persist,
      readable ? {conversationId:'web:'+meta.id,...(meta.projectId && {projectId:meta.projectId})} : undefined);
    favorites.update();imageExport.update();
    search.update(readable && {conversationId:'web:'+meta.id,projectId:meta.projectId});
    const hidden=!readable || !conversationExportActive(store);
    if(hidden)exportDrawer?.close();
    const nextQuoteKey=readable && !meta.archived && store.view.snapshot.plugins.some(p=>p.id==='conversation-quotes' && p.status==='active') ? draftKey : null;
    queue.update(writableKey && path+'/'+meta.id+'/messages/queue',meta && 'web:'+meta.id);
    queuedEdit.observe(writableKey,drafts.owner(),!!writableKey);
    const nextQueue=!!writableKey && turnQueueActive(store);
    const nextRetry=!!writableKey && turnRetryActive(store);
    const nextEdit=!!readable && !meta.archived && store.view.snapshot.plugins.some(p=>p.id==='conversation-edit' && p.status==='active');
    const editChanged=editEnabled!==nextEdit;
    const quoteChanged=quoteKey!==nextQuoteKey;
    if(editChanged || quoteChanged){editEnabled=nextEdit;edit.reset();}
    if(quoteChanged){quoteKey=nextQuoteKey;quote.restore(quoteKey);epoch++;}
    const nextTranslation=translation.update(readable ? rows : []);
    if(queueEnabled!==nextQueue || translationEpoch!==nextTranslation || canStop!==!!writableKey || retryEnabled!==nextRetry || exportButton.hidden!==hidden || editChanged || quoteChanged || favoriteEpoch!==favorites.epoch || promptEpoch!==prompts.epoch){
      queueEnabled=nextQueue;translationEpoch=nextTranslation;canStop=!!writableKey;retryEnabled=nextRetry;promptEpoch=prompts.epoch;favoriteEpoch=favorites.epoch;
      exportButton.hidden=hidden;
      if(readable && rows.length)display();
    }
  }
  function reset(){
    failedPage=null;history.reset();queue.update(null);queuedEdit.observe(null,drafts.owner(),false);queueEnabled=false;imageExport.reset();pictures.update(null,drafts.owner(),false,false);files.update(null,drafts.owner(),false);
    canStop=false;retryEnabled=false;editEnabled=false;edit.reset();prompts.changeScope();quoteKey=null;quote.restore(null);
    exportButton.hidden=true;exportDrawer?.close();exportDrawer=null;search.update(null);cleanupRetry.hidden=true;deleteDrawer?.close();renameDrawer?.close();changing=false;controls.hidden=true;current=null;meta=null;draftKey=null;rows=[];epoch++;readVersion++;pending=false;nextBefore=null;nextAfter=null;targetMessage=null;latest.hidden=true;later.hidden=true;
    translation.update([]);favorites.update();input.value='';heading.textContent='独立对话';replace(messages);form.hidden=true;more.hidden=true;retry.hidden=true;notice.textContent='';
    submissions.update();switcher.update();
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
    const filter=h('select',{class:'input','aria-label':'对话状态'},h('option',{value:'active'},'进行中'),h('option',{value:'archived'},'已归档'));
    const searchTitle=h('input',{type:'search',class:'input','aria-label':'按标题查找',placeholder:'输入标题中的文字'});
    const lookup=h('button',{type:'button',class:'btn btn--sm'},'按正文查找');
    const speaker=h('select',{class:'input','aria-label':'筛选发言人',hidden:true},
      h('option',{value:''},'全部发言人'),h('option',{value:'user'},'我'),h('option',{value:'assistant'},'助手'));
    speaker.onchange=()=>listRefresh?.();
    const canSearch=()=>store.view.snapshot?.plugins.some(p=>p.id==='conversation-search' && p.status==='active');
    lookup.hidden=!canSearch();
    let bodyQuery='',unwatch;
    const drawer=openDrawer({title:'独立对话',body:[draft,h('label',{class:'field'},'对话状态',filter),searchTitle,lookup,speaker,status,list],onClose:()=>{unwatch?.();if(selector===drawer){selector=null;listRefresh=null;}}});
    selector=drawer;
    const ok=()=>selector===drawer && drawer.el.open && active() && drafts.owner()===owner && listProject()===projectId;
    let request=0,items;
    const expanded = new Map();
    function searchParams() {
      const query = new URLSearchParams({projectId});
      if (bodyQuery) {
        query.set('query', bodyQuery);
        if (speaker.value) query.set('role', speaker.value);
      }
      if (filter.value === 'archived') query.set('archived', 'true');
      return query;
    }
    async function loadHits(row) {
      if (!ok() || !canSearch() || !bodyQuery) return;
      const page = expanded.get(row.id) ?? { hits: null, nextBefore: null };
      if (page.loading || (page.hits && !page.nextBefore)) return;
      expanded.set(row.id, page);
      page.loading = true;
      page.error = '';
      const params = searchParams();
      if (page.nextBefore) params.set('before', page.nextBefore);
      drawList();
      try {
        const result = await api.get(path + '/' + encodeURIComponent(row.id) + '/search?' + params);
        page.hits = (page.hits ?? []).concat(result.hits);
        page.nextBefore = result.nextBefore;
      } catch (error) {
        if (error.status === 409 || error.status === 404) {
          page.hits = null;
          page.nextBefore = null;
        }
        page.error = error.message;
      } finally {
        page.loading = false;
        if (ok() && canSearch() && expanded.get(row.id) === page) drawList();
      }
    }
    function hitLinks(row) {
      const page = expanded.get(row.id);
      const hits = page?.hits ?? [row.match, ...(row.earlierMatches || [])];
      return [
        ...hits.map(hit => h('div', {class:'stack'},
          h('small', {class:'muted'}, hit.role === 'user' ? '我' : '助手', ' · ',
            h('time', {datetime:hit.at, title:new Date(hit.at).toLocaleString('zh-CN')}, timeAgo(hit.at))),
          h('a', {'aria-label':hit.text, href:href(row.id,hit.id), onclick:()=>drawer.close()}, hit.text.slice(0,hit.start),
            h('mark', {}, hit.text.slice(hit.start,hit.end)), hit.text.slice(hit.end)))),
        row.matchCount > 3 && h('small', {class:'muted'}, '共 ' + row.matchCount + ' 条匹配，已显示 ' + hits.length + ' 条。'),
        page && button('收起匹配发言', () => {
          expanded.delete(row.id);
          drawList();
        }),
        page?.error && h('p', {role:'alert'}, page.error),
        page?.loading ? h('small', {role:'status'}, '正在读取匹配发言…')
          : (page?.nextBefore || (!page?.hits && row.matchCount > 3)) && button(
            page?.error ? '重试读取匹配发言' : page?.hits ? '加载更多匹配发言' : '查看全部匹配发言', () => loadHits(row)),
      ];
    }
    function drawList(){
      if(!items || !ok())return;
      const term=searchTitle.value.trim().toLowerCase();
      const matches=bodyQuery ? items : items.filter(row=>row.title.toLowerCase().includes(term));
      status.textContent=matches.length?'':bodyQuery?'没有匹配的对话正文。':items.length?'没有匹配的对话标题。':filter.value==='archived'?'当前范围没有已归档对话。':'当前范围还没有独立对话。';
      replace(list,matches.map(row=>h('div',{class:'stack'},
        h('a',{class:'btn btn--ghost',href:href(row.id),onclick:()=>drawer.close()},row.title),
        row.match ? hitLinks(row)
        : h('small',{class:'muted'},timeAgo(row.lastInputAt || row.createdAt),row.lastInputId && [' · ',
          h('a',{href:href(row.id,row.lastInputId),onclick:()=>drawer.close()},row.lastInputText || '查看最近发言')]))));
    }
    lookup.onclick=()=>{if(canSearch() && searchTitle.value.trim()){bodyQuery=searchTitle.value.trim();void listRefresh();}};
    searchTitle.maxLength=200;
    searchTitle.placeholder='输入标题或正文中的文字';
    searchTitle.oninput=()=>{if(bodyQuery){bodyQuery='';void listRefresh();}else drawList();};
    listRefresh=async(quiet=false, changedThreads)=>{
      const seq=++request,query=searchParams();
      // An unrelated conversation can enter the search without invalidating pages already read here.
      if (quiet && changedThreads) {
        for (const id of expanded.keys()) if (changedThreads.includes('web:' + id)) expanded.delete(id);
      } else expanded.clear();
      speaker.hidden=!bodyQuery;
      if(quiet)drawList();
      if(!quiet){items=undefined;replace(list);status.textContent='正在读取对话…';}
      try{
        const result=await api.get(path+'?'+query);
        if(!ok() || seq!==request)return;
        items=result.items;drawList();
      }catch(error){
        if(ok() && seq===request)replace(status,error.message,' ',button('重试读取对话',()=>listRefresh?.()));
      }
    };
    let previousChanges=store.view.messageQueueChanges,previousConnection=store.view.connection;
    unwatch=store.subscribe(view=>{
      lookup.hidden=!canSearch();
      if(lookup.hidden && bodyQuery){bodyQuery='';void listRefresh?.();}
      // A thread outside the current results can acquire its first matching message.
      const changed=view.messageQueueChanges!==previousChanges && (bodyQuery
        ? view.messageQueueChanges?.some(id=>id.startsWith('web:'))
        : items?.some(row=>view.messageQueueChanges?.includes('web:'+row.id)));
      const reconnected=view.connection==='online' && previousConnection!=='online';
      previousChanges=view.messageQueueChanges;previousConnection=view.connection;
      if(ok() && (changed || reconnected))void listRefresh?.(true, reconnected ? undefined : view.messageQueueChanges);
    });
    filter.onchange=()=>listRefresh?.();void listRefresh();
  }
  function applyMeta(stamp,row){
    if(row.id!==stamp.id)throw Error('对话记录与链接不匹配。');
    if(meta && row.version<meta.version)return;
    if(!meta){draftKey=JSON.stringify(['web',stamp.id]);input.value=drafts.read(draftKey);}
    if(meta && row.version>meta.version)notice.textContent='';
    if(row.archived && !meta?.archived){prompts.reset();history.reset();}
    meta=row;heading.textContent=row.title;
    form.hidden=!!row.archived;controls.hidden=false;
    stateLabel.textContent=row.archived?'已归档 · 只读':'';
    archive.textContent=row.archived?'恢复对话':'归档对话';
    archive.disabled=changing;submissions.update();syncSearch();switcher.update();
  }
  async function refreshMeta(stamp){
    try{
      const row=await api.get(path+'/'+stamp.id);
      if(valid(stamp))applyMeta(stamp,row);
    }catch(error){if(valid(stamp)){
      if(error.status===410){deleted(stamp.id,stamp.owner);return;}
      reset();current=stamp;notice.textContent=error.message;retry.hidden=false;
    }}
  }
  async function modify(stamp,version,fields){
    if(!meta || !valid(stamp))return;
    try{
      const row=await api.patch(path+'/'+stamp.id,{version,...fields});
      if(!valid(stamp))return;
      // The mutation receipt describes the conversation. Its roster binding comes from the detail read.
      applyMeta(stamp,{...row,assistantId:meta?.assistantId});return true;
    }catch(error){
      if(!valid(stamp))return;
      if(error.status===409)await refreshMeta(stamp);
      throw error;
    }
  }
  function deleted(id,owner){
    if(owner!==drafts.owner())return;
    const key=JSON.stringify(['web',id]);
    history.forget(owner,key);pictures.forget(owner,key);files.forget(owner,key);drafts.forget(key);drafts.forget(quoteDraftKey(key));submissions.forgetScope(owner,key);
    if(routeId()!==id)return;
    reset();current={id,owner,deleted:true};notice.textContent='该独立对话已删除，原链接已失效。';
    if(unconfirmedDeletion?.id===id && unconfirmedDeletion.owner===owner){
      cleanupRetry.hidden=false;notice.textContent+=' '+unconfirmedDeletion.reason;
    }
  }
  async function retryDeletion(){
    const job=unconfirmedDeletion;
    if(!job || !valid(current) || current.id!==job.id || current.owner!==job.owner || cleanupRetry.disabled)return;
    cleanupRetry.disabled=true;
    try{
      const result=await api.del(path+'/'+job.id,{version:job.version});
      if(result?.deleted!==true)throw Error('未取得删除回执。');
      if(unconfirmedDeletion===job)unconfirmedDeletion=undefined;
      deleted(job.id,job.owner);
    }catch(error){
      if(current?.id===job.id && current.owner===job.owner)notice.textContent='原链接已失效。'+error.message;
    }finally{cleanupRetry.disabled=false;}
  }
  function openDelete(){
    const stamp=current;
    if(!valid(stamp) || !meta || deleteDrawer)return;
    const {title,version}=meta,status=h('p',{role:'status'}),cancel=button('取消',()=>drawer.close());
    const confirm=button('确认永久删除',async()=>{
      if(confirm.disabled || !valid(stamp))return;
      confirm.disabled=true;
      try{
        const result=await api.del(path+'/'+stamp.id,{version});
        if(result?.deleted!==true)throw Error('未取得删除回执。');
        unconfirmedDeletion=undefined;deleted(stamp.id,stamp.owner);
      }catch(error){
        if(drafts.owner()!==stamp.owner || routeId()!==stamp.id)return;
        const uncertain={id:stamp.id,owner:stamp.owner,version,reason:'删除清理回执未确认。'+error.message};
        if(current?.deleted && (error.status>=500 || !error.status)){unconfirmedDeletion=uncertain;deleted(stamp.id,stamp.owner);return;}
        if(!valid(stamp))return;
        if(error.status===410){deleted(stamp.id,stamp.owner);return;}
        if(error.status>=400 && error.status<500){
          if(error.status===409)await refreshMeta(stamp);
          if(valid(stamp))status.textContent=error.message+'。请关闭后重新核对。';
          return;
        }
        status.textContent='删除结果未知，正在核对原对话。';
        try{
          const row=await api.get(path+'/'+stamp.id);
          if(!valid(stamp) || !drawer.el.open)return;
          applyMeta(stamp,row);
          if(row.version!==version){status.textContent='对话版本已变化，请关闭后重新核对。';return;}
          status.textContent='原对话仍在，可以按同一版本重试删除。';confirm.disabled=false;
        }catch(check){
          if(drafts.owner()===stamp.owner && routeId()===stamp.id && (check.status===410 || current?.deleted)){
            unconfirmedDeletion=uncertain;deleted(stamp.id,stamp.owner);return;
          }
          if(!valid(stamp))return;
          status.textContent='尚未核实删除结果，可按同一版本重试。';confirm.disabled=false;
        }
      }
    });
    const drawer=openDrawer({title:'永久删除独立对话',
      body:[h('p',{},'永久删除「'+title+'」？'),h('p',{},'这会清除该对话的消息、草稿和待确认发件，原链接也会失效。删除后无法恢复。已收藏的消息快照会保留，可在收藏列表单独移除。'),status],
      footer:[cancel,confirm],onClose:()=>{if(deleteDrawer===drawer)deleteDrawer=null;}});
    deleteDrawer=drawer;
  }
  function openRename(){
    const stamp=current;
    if(!valid(stamp) || !meta || renameDrawer)return;
    let version=meta.version;
    const name=h('input',{class:'input',maxLength:160,value:meta.title,'aria-label':'新的对话标题'}),status=h('p',{role:'status'});
    const save=h('button',{type:'submit',class:'btn btn--primary'},'保存标题');
    const editor=h('form',{class:'stack',onsubmit:async e=>{
      e.preventDefault();
      if(save.disabled || !valid(stamp))return;
      const title=name.value.trim();if(!title || [...title].length>80){status.textContent='请输入 1 至 80 个字符的标题。';return;}
      save.disabled=true;
      try{if(await modify(stamp,version,{title}))drawer.close();}
      catch(error){if(valid(stamp)){
        version=meta.version;
        status.textContent=error.status===409?'对话已变化。当前标题为「'+meta.title+'」，请核对后再保存。':error.message;
      }}finally{save.disabled=false;}
    }},h('label',{class:'field'},'新的对话标题',name),save,status);
    const drawer=openDrawer({title:'修改对话标题',body:editor,onClose:()=>{if(renameDrawer===drawer)renameDrawer=null;}});
    renameDrawer=drawer;
  }
  async function changeArchive(){
    const stamp=current;
    if(!valid(stamp) || !meta || changing)return;
    const archived=!meta.archived;changing=true;archive.disabled=true;
    try{if(await modify(stamp,meta.version,{archived}))notice.textContent=archived?'已归档对话。':'已恢复对话。';}
    catch(error){if(valid(stamp))notice.textContent=error.status===409?'对话已变化，请核对当前状态后重试。':error.message;}
    finally{if(valid(stamp)){changing=false;archive.disabled=false;}}
  }
  function setTarget(id,at){
    targetMessage=at;readVersion++;nextBefore=null;nextAfter=null;rows=[];
    more.hidden=true;later.hidden=true;latest.hidden=at===null;latest.href=href(id);
    replace(messages);notice.textContent='';
  }
  async function copyLink(stamp,id){
    if(!valid(stamp))return;
    const url=new URL(location.pathname,location.origin);
    url.hash=href(stamp.id,id);
    try{await copyText(url.href);if(valid(stamp))notice.textContent='已复制消息链接。';}
    catch(error){if(valid(stamp))notice.textContent='复制失败：'+error.message;}
  }
  function display(){
    const stamp=current;
    translation.update(rows);
    replace(messages,rows.map(row=>{
      const text=h('div',{},copies.renderMessage(row,row.text));
      const selected=targetMessage===row.id;
      const source = row.origin === 'notification' ? '系统通知' : row.origin === 'result' ? '执行结果' : row.role === 'user' ? '我' : '助手';
      return h('article',{class:'msg msg--'+(row.role==='user'?'user':'assistant')+(selected?' is-search-hit':''),
        dataset:{id:row.id},tabIndex:selected?-1:undefined,'aria-current':selected?'true':undefined},
        h('div',{class:'msg__col'},
          h('div',{class:'msg__bubble'},text,
            messageImages(api,store,row,meta.archived ? undefined : pictures.editCopy.bind(null,draftKey),messages),messageFiles(api,store,row,rows,messages)),
          h('div',{class:'msg__meta row row--wrap'},
            h('span',{},source),
            h('time',{datetime:row.createdAt,title:new Date(row.createdAt).toLocaleString('zh-CN')},timeAgo(row.createdAt)),
            copies.copyMessage(row,translation.displayedText),translation.action(row,text,copies.renderMessage),
            canStop && webThreadStopButton(api,row,meta,()=>valid(stamp) && meta?.id===stamp.id && !meta.archived && rows.includes(row),queueEnabled),
            queueEnabled && queuedEdit.action(row),imageExport.checkbox(row),
            row.origin!=='notification' && favorites.mark(row,meta.projectId,stamp.id,()=>valid(stamp) && meta?.id===stamp.id && rows.includes(row)),
            retryEnabled && retryTurn(row,rows,'web:'+stamp.id,id=>href(stamp.id,id),
              ()=>valid(stamp) && meta?.id===stamp.id && !meta.archived && rows.includes(row)),
            row.directWebInput && prompts.fromMessage(row),
            row.directWebInput && edit.action(row),
            quoteKey && row.origin!=='notification' && quote.action(row,source),
            row.status==='pending' && h('small',{},queueLabel(row,queueEnabled) || '处理中…'),row.status==='failed' && h('small',{},row.queueState==='cancelled'?'已取消排队':row.queueState==='withdrawn'?'已取回编辑':row.stoppedByUser?'已停止本轮':'处理失败'),
            h('button',{type:'button',class:'btn btn--ghost btn--icon btn--sm','aria-label':'复制消息链接',title:'复制消息链接',
              onclick:()=>copyLink(stamp,row.id)},icon('copy')))));
    }));
    more.hidden=!nextBefore;later.hidden=!nextAfter;
  }
  async function loadMessages(direction='latest'){
    const stamp=current,at=targetMessage;
    if(!valid(stamp) || !meta || direction==='latest' && at!==null)return;
    const refresh=direction==='refresh-pending';
    const cursor=refresh?rows.find(row=>row.status==='pending')?.id:direction==='before'?nextBefore:direction==='after'?nextAfter:at;
    if(direction!=='latest' && !cursor){if(direction==='at')notice.textContent='消息链接缺少定位标识。';return;}
    const version=++readVersion;
    more.disabled=true;later.disabled=true;
    try{
      const query=direction==='latest'?'':'?'+new URLSearchParams({[refresh?'at':direction]:cursor});
      const page=await api.get(path+'/'+stamp.id+'/messages'+query);
      if(!valid(stamp) || version!==readVersion || at!==router.current.query.get('at'))return;
      if(page.messages.some(m=>m.conversationId!=='web:'+stamp.id || (m.projectId || '')!==(meta.projectId || '')))throw Error('消息与当前对话不匹配。');
      if(direction==='at' && !page.messages.some(m=>m.id===at))throw Error('此对话中找不到链接中的消息。');
      const previousHeight=scroller.scrollHeight,nearEnd=previousHeight-scroller.scrollTop-scroller.clientHeight<100;
      if(refresh){
        // Keep the located page and any manually loaded neighbors. Replace only rows already in view.
        const latest=new Map(page.messages.map(row=>[row.id,row]));
        rows=rows.map(row=>latest.get(row.id) || row);
      }else if(direction==='before'){rows=[...page.messages,...rows];nextBefore=page.nextBefore;}
      else if(direction==='after'){rows=[...rows,...page.messages];nextAfter=page.nextAfter;}
      else{
        const overlap=direction==='latest'?rows.findIndex(row=>row.id===page.messages[0]?.id):-1;
        if(overlap>0)rows=[...rows.slice(0,overlap),...page.messages];
        else{rows=page.messages;nextBefore=page.nextBefore;}
        nextAfter=page.nextAfter;
      }
      display();
      if(failedPage)notice.textContent='';
      failedPage=null;retry.hidden=true;
      if(direction==='before')scroller.scrollTop+=scroller.scrollHeight-previousHeight;
      else if(direction==='at'){
        const hit=messages.querySelector('[aria-current="true"]');
        hit.focus({preventScroll:true});hit.scrollIntoView({block:'center'});
      }else if(direction==='latest' && nearEnd)scroller.scrollTop=scroller.scrollHeight;
    }catch(error){
      if(!valid(stamp) || version!==readVersion)return;
      if(error.status===410){deleted(stamp.id,stamp.owner);return;}
      if([401,403,409,503].includes(error.status) || error.status===404 && direction==='latest'){
        controls.hidden=true;meta=null;syncSearch();heading.textContent='独立对话';replace(messages);rows=[];input.value='';form.hidden=true;more.hidden=true;later.hidden=true;
      }
      failedPage=meta && (direction==='before' || direction==='after') ? direction : null;
      notice.textContent=error.message;retry.hidden=false;
    }finally{if(valid(stamp) && version===readVersion){more.disabled=false;later.disabled=false;}}
  }
  async function open(stamp){
    notice.textContent='正在读取对话…';
    try{
      const event=lastMetaEvent,result=await api.get(path+'/'+stamp.id);
      if(!valid(stamp))return;
      if(lastMetaEvent!==event && lastMetaEvent?.id===stamp.id){void open(stamp);return;}
      notice.textContent='';applyMeta(stamp,result);
      await loadMessages(targetMessage!==null?'at':'latest');
    }catch(error){if(valid(stamp)){if(error.status===410){deleted(stamp.id,stamp.owner);return;}notice.textContent=error.message;retry.hidden=false;}}
  }
  async function post(){
    const stamp=current,ctx=context();
    if(!valid(stamp) || !ctx.key || pending || !pictures.ready() || !files.ready() || (!ctx.body && !ctx.files.length && !ctx.images.length))return;
    let payload;
    try{payload=messagePayload(ctx,{text:ctx.body});}
    catch(error){notice.textContent=error.message;return;}
    const ticket=submissions.begin(ctx);if(!ticket)return;
    if(ticket.record.blocked){notice.textContent='请先核对发送回执。';return;}
    const finishEdit=edit.onAccepted();
    pending=true;send.disabled=true;notice.textContent='';
    try{
      const receipt=await submissions.preflight(ticket,ctx);
      if(!valid(stamp) || !context().key || (!receipt && ctx.epoch!==epoch))return;
      const reply=receipt ?? await api.post(ctx.url,payload,{'Idempotency-Key':ticket.record.id});
      if(!valid(stamp))return;
      if(!submissions.accepted(ticket,reply,ctx)){submissions.block(ticket);throw Error('回执与原消息不匹配。');}
      finishEdit();confirmed(ctx);
      if(targetMessage!==null)notice.textContent='消息已受理。可返回最新消息查看本轮回复。';
      else await loadMessages();
    }catch(error){submissions.failed(ticket,error);if(error.status===410 && !error.receiptCheck)files.expired(ctx);if(valid(stamp))notice.textContent='发送未确认：'+error.message;}
    finally{submissions.finish(ticket);if(valid(stamp)){pending=false;send.disabled=false;}}
  }
  function update(){
    const id=routeId(),owner=drafts.owner();
    if(unconfirmedDeletion && unconfirmedDeletion.owner!==owner)unconfirmedDeletion=undefined;
    entry.hidden=!active();el.hidden=id===null;switcher.update();
    const event=store.view.webConversationChange,changed=event && lastMetaEvent!==event;
    lastMetaEvent=event;
    if(changed && event.deleted && active() && uuid4.test(event.id))deleted(event.id,owner);
    if(changed && selector && (event.projectId || '')===selectorScope)void listRefresh?.();
    if(selector && (!active() || selectorOwner!==owner || selectorScope!==listProject()))selector.close();
    if(id===null || !active() || !uuid4.test(id)){
      if(current || !form.hidden)reset();
      if(id!==null)notice.textContent=!uuid4.test(id)?'独立对话链接无效。':store.view.snapshot?'独立对话插件不可用。':'正在连接工作台…';
      return;
    }
    if(meta?.projectId && !store.view.snapshot.projects?.some(p=>p.id===meta.projectId && !p.archivedAt)){
      reset();notice.textContent='原项目已归档或不可用。';return;
    }
    const at=router.current.query.get('at');
    if(current?.id!==id || current.owner!==owner){reset();setTarget(id,at);current={id,owner};send.disabled=false;void open(current);}
    else if(!current.deleted && targetMessage!==at){
      setTarget(id,at);
      if(meta)void loadMessages(at!==null?'at':'latest');
    }
    else if(meta && (changed && event.id===id || lastConnection!=='online' && store.view.connection==='online')){
      void refreshMeta(current);void loadMessages();
    }else if(meta && lastChanges!==store.view.messageQueueChanges && store.view.messageQueueChanges?.includes('web:'+id)){
      if(targetMessage!==null && rows.length){
        if(!nextAfter){nextAfter=rows.at(-1).id;later.hidden=false;}
        if(rows.some(row=>row.status==='pending') && !more.disabled)void loadMessages('refresh-pending');
      }else void loadMessages();
    }
    syncSearch();lastChanges=store.view.messageQueueChanges;lastConnection=store.view.connection;
  }
  reset();store.subscribe(update);router.subscribe(update);scope.subscribe(update);
  return {el,entry,switcher:switcher.mainButton,update,focus:()=>{if(!form.hidden)input.focus();}};
}

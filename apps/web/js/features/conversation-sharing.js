import {h, replace} from '../lib/dom.js';
import {Button, Field, Select, copyText} from '../ui/kit.js';
import {renderSharedTools} from '../lib/shared-excerpt-tools.js';
import {openDrawer} from '../ui/overlay.js';

const roleLabel = role => role === 'user' ? '我' : '助手';
const dateLabel = value => new Date(value).toLocaleString();
const excerpt = text => Array.from(text.slice(0,96)).slice(0,48).join('');

function eligible(rows,range,snapshot) {
  const projects=new Set(snapshot.projects?.filter(p=>!p.archivedAt).map(p=>p.id));
  const todos=new Map(snapshot.todos?.map(t=>[t.id,t]));
  const completed=rows.filter(m=>m.conversationId===range.conversationId &&
    (!range.projectId || m.projectId===range.projectId) && (!range.todoId || m.todoId===range.todoId) &&
    (!m.projectId || projects.has(m.projectId)) && (!m.todoId || (todos.has(m.todoId) && todos.get(m.todoId).projectId===m.projectId)) &&
    m.status==='done' && !m.runResult && !m.stoppedByUser && (!m.origin || m.origin==='user') && !['cancelled','withdrawn'].includes(m.queueState));
  const sources=new Map(completed.filter(m=>m.role==='user' && m.directWebInput===true && !m.replyTo).map(m=>[m.id,m]));
  return completed.filter(m=>{
    if (typeof m.text!=='string' || !m.text.trim()) return false;
    if (m.role==='user') return sources.has(m.id);
    const source=sources.get(m.replyTo);
    return m.role==='assistant' && source && source.projectId===m.projectId && source.todoId===m.todoId;
  });
}

export function createConversationSharing({api,store,getRows}) {
  let range,scopeKey,session;
  const button=Button({label:'分享对话摘录',size:'sm',onClick:open});
  button.hidden=true;
  function enabled() {
    return !store.view.unauthorized && !!api.draftOwner() && store.view.snapshotOwner===api.draftOwner() &&
      store.view.snapshot?.plugins?.some(p=>p.id==='conversation-sharing' && p.status==='active');
  }
  function update(next) {
    const key=next && enabled() ? JSON.stringify([api.draftOwner(), next.conversationId,next.projectId,next.todoId,next.native]) : '';
    if (scopeKey!==key) session?.close();
    range=key ? next : undefined; scopeKey=key; button.hidden=!key;
    session?.refreshRows();
  }
  function open() {
    if (session?.drawer.el.open || !range || !enabled()) return;
    const key=scopeKey, owner=api.draftOwner(), conversationId=range.conversationId;
    const native=range.native, source=native?{native}:{conversationId};
    const selected=new Set();
    const lifetime=new AbortController();
    const manage=body=>api('/conversation-shares',{method:'POST',body,signal:lifetime.signal});
    let catalogRows=[],offset=0,catalogLoading=false;
    const catalogStatus=h('p',{class:'small muted',role:'status'});
    const more=Button({label:'加载更多消息',size:'sm',onClick:loadCatalog});
    const catalogControls=native && h('div',{class:'stack'},catalogStatus,more);
    let rows=[], rendered=false, preview, generation=0, writing=false, reading=false, issued, listStamp=0, editStamp=0, editing, loadingEdit=false;
    const candidates=h('div',{class:'stack','aria-label':'选择要公开的消息'});
    const status=h('p',{class:'small muted',role:'status'});
    const feedback=h('p',{role:'status'});
    const previewBox=h('section',{class:'card',hidden:true,'aria-label':'公开内容预览'});
    const result=h('section',{class:'stack',hidden:true});
    const history=h('div',{class:'stack'});
    const historyStatus=h('p',{class:'small muted',role:'status'});
    const expiry=Select({options:[['1','1 小时'],['24','1 天'],['72','3 天'],['168','7 天'],['720','30 天']],value:'24',onchange:invalidate});
    const showTools=h('input',{type:'checkbox',onchange:invalidate});
    const includeFuture=h('input',{type:'checkbox',onchange:invalidate});
    const futureHint=h('p',{class:'small',hidden:true});
    const inspect=Button({label:'预览公开内容',size:'sm',onClick:showPreview});
    const editLabel=h('strong',{});
    const editBar=h('div',{class:'row row--between',hidden:true},editLabel,Button({label:'取消编辑',size:'sm',onClick:()=>{if (!writing) resetMode();}}));
    const inputs=h('fieldset',{class:'stack',style:{border:'0',padding:'0',margin:'0',minWidth:'0'}},
      h('div',{class:'row row--wrap'},Button({label:'全选当前消息',size:'sm',onClick:()=>chooseFrom(0)}),
        Button({label:'全不选',size:'sm',onClick:()=>chooseFrom(rows.length)})),candidates,catalogControls,status,!native && h('label',{class:'check'},showTools,'包含工具记录'),!native && h('label',{class:'check'},includeFuture,'自动追加后续消息'),futureHint,Field({label:'分享有效期',control:expiry}),inspect);
    const drawer=openDrawer({title:'分享对话摘录',subtitle:native && (native.executorId+' · '+native.nativeSessionId),wide:true,body:[
      editBar,inputs,previewBox,feedback,result,h('section',{class:'stack','aria-label':'已有分享'},
        h('div',{class:'row row--between'},h('h3',{},'本对话已有分享'),Button({label:'刷新分享列表',size:'sm',onClick:loadList})),historyStatus,history)
    ],onClose:()=>{if(session?.drawer===drawer) session=undefined; erase();}});
    const current=()=>drawer.el.open && scopeKey===key && owner===api.draftOwner() && enabled();
    function erase() {
      lifetime.abort();
      generation++; listStamp++; editStamp++; editing=undefined; selected.clear(); rows=[]; issued=undefined; preview=undefined;
      drawer.body.replaceChildren();
    }
    function close() { erase(); drawer.close(); }
    function counts() {
      status.textContent=rows.length ? '已选 '+selected.size+' 条，最多 100 条。' : '当前消息范围内没有可分享的已完成对话正文。';
      if (selected.size>100) status.textContent='已选 '+selected.size+' 条，超过 100 条上限，请减少选取后预览。';
      inspect.disabled=writing || reading || !selected.size || selected.size>100;
    }
    function futureScope() {
      return editing?.futureScope ?? { ...(range.projectId && {projectId:range.projectId}), ...(range.todoId && {todoId:range.todoId}) };
    }
    function scopeLabel(scope) {
      const snapshot=store.view.snapshot;
      const project=snapshot.projects?.find(p=>p.id===scope.projectId);
      const todo=snapshot.todos?.find(t=>t.id===scope.todoId);
      return [conversationId==='main'?'主对话':'项目工作对话',scope.projectId?'项目「'+(project?.name || scope.projectId)+'」':'无项目归属',
        scope.todoId?'待办「'+(todo?.title || scope.todoId)+'」':'无待办归属'].join(' · ');
    }
    function describeFuture(scope,tools) {
      return '自动追加范围：'+scopeLabel(scope)+'。勾选的摘录须属于此范围。此范围内后续从 Web 直接发送的正文和对应的助手答复完成后，持有链接的人无需登录即可查看。'+
        (tools?'答复中的工具名称、状态、参数和结果也会公开。':'');
    }
    function futureState(item) {
      if(item.pauseReason) return '自动追加已暂停：'+item.pauseReason;
      return item.includeFuture?'自动追加后续消息':'';
    }
    function updateHint() {
      futureHint.hidden=!includeFuture.checked && !editing?.includeFuture;
      futureHint.textContent=includeFuture.checked?describeFuture(futureScope(),showTools.checked):
        editing?.includeFuture?'关闭后，原链接保留本次预览中的摘录。':'';
    }
    function invalidate() {
      updateHint();
      generation++; preview=undefined; reading=false; previewBox.hidden=true; previewBox.replaceChildren(); feedback.textContent=''; counts();
    }
    function refreshRows() {
      if (!current()) return;
      const loaded=native ? catalogRows : eligible(getRows() ?? [],range,store.view.snapshot);
      const originals=new Set(editing?.rows.map(m=>m.id));
      const next=editing ? [...editing.rows,...loaded.filter(m=>!originals.has(m.id))] : loaded;
      if (rendered && rows.length===next.length && rows.every((m,i)=>m.id===next[i].id && m.text===next[i].text)) return;
      rendered=true;
      const byId=new Map(next.map(m=>[m.id,m]));
      const changed=rows.some(old=>selected.has(old.id) && byId.get(old.id)?.text!==old.text);
      rows=next;
      const ids=new Set(rows.map(m=>m.id));
      for (const id of selected) if (!ids.has(id)) selected.delete(id);
      if (changed) invalidate();
      paintRows();
    }
    async function loadCatalog() {
      if (!current() || !native || catalogLoading) return;
      catalogLoading=true;more.disabled=true;catalogStatus.textContent='正在读取原生会话消息…';
      try {
        const page=await manage({action:'catalog',native,offset});
        if (!current()) return;
        const seen=new Set(catalogRows.map(row=>row.id));
        catalogRows=[...catalogRows,...page.items.filter(row=>!seen.has(row.id))];
        offset+=25;
        more.hidden=offset>=page.total;
        more.textContent='加载更多消息';
        catalogStatus.textContent='已加载 '+catalogRows.length+' 条，共 '+page.total+' 条。';
        refreshRows();
      } catch(error) {
        if(current()){more.hidden=false;more.textContent='重新读取本页';catalogStatus.textContent=error.message+'。已有分享仍可在下方管理。';}
      } finally {if(current()){catalogLoading=false;more.disabled=false;}}
    }
    function chooseFrom(index) {
      if (!current() || writing) return;
      selected.clear();
      for (const row of rows.slice(index)) selected.add(row.id);
      invalidate();paintRows();
    }
    function paintRows() {
      replace(candidates,rows.map((m,index)=>{
        const short=excerpt(m.text);
        const check=h('input',{type:'checkbox',checked:selected.has(m.id),'aria-label':'选择消息 '+(index+1)+'：'+short,
          onchange(){if(check.checked) selected.add(m.id);else selected.delete(m.id);invalidate();}});
        return h('div',{class:'row row--between'},h('label',{class:'check'},check,h('span',{},h('strong',{},roleLabel(m.role)+'　'),short+(short.length<m.text.length?'…':''))),
          Button({label:'从此条选到末条',ariaLabel:'从第 '+(index+1)+' 条选到末条',size:'sm',onClick:()=>chooseFrom(index)}));
      }));
      counts();
    }
    function resetMode() {
      editStamp++; editing=undefined;loadingEdit=false; selected.clear(); rendered=false;
      editBar.hidden=true; inputs.disabled=writing; expiry.querySelector('option[value="keep"]')?.remove();expiry.value='24';showTools.checked=false;includeFuture.checked=false;
      invalidate();refreshRows();
    }
    async function edit(item) {
      if (!current() || writing) return;
      resetMode();removeIssued(issued);
      const stamp=editStamp;
      loadingEdit=true;inputs.disabled=true;editBar.hidden=false;editLabel.textContent='正在读取分享…';
      try {
        const detail=await manage({action:'detail',...source,id:item.id});
        if (!current() || stamp!==editStamp) return;
        if (detail.id!==item.id || !detail.revision || detail.messageIds.length!==detail.messages.length) throw new Error('分享详情不完整，请刷新后再试。');
        if (detail.includeFuture && (!detail.futureScope || typeof detail.futureScope!=='object' || Array.isArray(detail.futureScope))) {
          throw new Error('无法核对原分享的自动追加范围。');
        }
        editing={id:detail.id,revision:detail.revision,expiresAt:detail.expiresAt,futureScope:detail.futureScope,includeFuture:detail.includeFuture===true,rows:detail.messages.map((m,i)=>({...m,id:detail.messageIds[i]}))};
        showTools.checked=detail.showTools===true;includeFuture.checked=editing.includeFuture;updateHint();
        for (const m of editing.rows) selected.add(m.id);
        expiry.prepend(h('option',{value:'keep'},'保留原到期时间'));expiry.value='keep';
        editLabel.textContent='修改分享 · 原到期时间 '+dateLabel(detail.expiresAt)+(futureState(detail)?' · '+futureState(detail):'');
        rendered=false;refreshRows();editBar.scrollIntoView({block:'nearest'});
      } catch(error) {
        if(current() && stamp===editStamp){resetMode();feedback.textContent=error.message+'。请刷新分享列表核对。';}
      } finally {if(current() && stamp===editStamp){loadingEdit=false;inputs.disabled=false;counts();}}
    }
    function parameters() {
      return {...source,...(!native && {showTools:showTools.checked,includeFuture:includeFuture.checked,...(includeFuture.checked && {futureScope:futureScope()})}),messageIds:rows.filter(m=>selected.has(m.id)).map(m=>m.id),...(editing?{id:editing.id,revision:editing.revision}:{}),...(expiry.value==='keep'?{}:{expireHours:Number(expiry.value)})};
    }
    async function showPreview() {
      if (!current() || !selected.size || selected.size>100 || writing || loadingEdit) return;
      invalidate(); const stamp=generation, args=parameters();
      reading=true;counts();feedback.textContent='正在核对可公开的正文…';
      try {
        const value=await manage({action:'preview',...args});
        if (!current() || stamp!==generation) return;
        preview={...args,previewHash:value.previewHash};
        previewBox.hidden=false;
        replace(previewBox,h('header',{class:'card__head'},h('h3',{},'公开内容预览')),
          h('div',{class:'card__body stack'},value.messages.map(m=>h('div',{},h('strong',{},roleLabel(m.role)),h('pre',{class:'mailbox-content'},m.text),args.showTools && renderSharedTools(m.tools))),
            args.includeFuture && h('p',{},h('strong',{},describeFuture(args.futureScope,args.showTools))),
            !args.includeFuture && editing?.includeFuture && h('p',{},'确认后停止自动追加，原链接将保留以上摘录。'),
            args.showTools && h('p',{class:'small'},'持有链接的人也能查看预览中的工具名称、状态、参数和结果。请展开工具记录，核对后再确认。'),
            h('p',{class:'small'},args.expireHours ? '持有链接的人可在 '+args.expireHours+' 小时内查看以上正文。' : '原链接到期时间为 '+dateLabel(editing.expiresAt)+'。'),
            Button({label:editing?'确认更新分享':'确认创建分享',kind:'primary',onClick:create})));
        feedback.textContent='';
      } catch(error) {if(current() && stamp===generation) feedback.textContent=error.message+(editing && error.status===409?'。请重新打开「修改分享」核对最新消息。':'');}
      finally {if(current() && stamp===generation) {reading=false;counts();}}
    }
    async function create() {
      if (!current() || !preview || writing) return;
      const args=preview;
      if (issued) removeIssued(issued);
      invalidate(); writing=true;inputs.disabled=true;counts(); feedback.textContent=args.id?'正在更新分享…':'正在创建分享…';
      try {
        const reply=await manage({action:args.id?'update':'create',...args});
        if (!current()) return;
        if (args.id) {
          if (reply.id!==args.id || !reply.revision) throw new Error('未取得更新回执');
          resetMode();feedback.textContent='分享已更新，持有原链接的人可以查看更新后的摘录。';return;
        }
        const url=new URL('/share',location.origin);url.hash=encodeURIComponent(reply.token);
        issued=reply.id; result.hidden=false;
        const link=h('input',{class:'input',readOnly:true,value:url.href,'aria-label':'分享链接'});
        replace(result,h('strong',{},'分享链接已创建'),h('p',{class:'small'},'链接仅在这里显示一次，到期时间为 '+dateLabel(reply.expiresAt)+'。'),link,
          Button({label:'复制分享链接',size:'sm',onClick:async()=>{
            if (!current() || issued!==reply.id) return;
            try { await copyText(link.value); if(current()) feedback.textContent='分享链接已复制。'; }
            catch { if(current()){ link.select();feedback.textContent='请复制选中的分享链接。'; } }
          }}));
        feedback.textContent='';
      } catch(error) {if(current()) feedback.textContent=error.message+(args.id?'。请重新打开「修改分享」核对最新版本。':'。请先核对已有分享，再决定是否重新创建。');}
      finally {if(current()){writing=false;inputs.disabled=false;counts();void loadList();}}
    }
    function removeIssued(id) {
      if (issued!==id) return;
      issued=undefined; result.replaceChildren();result.hidden=true;
    }
    async function loadList() {
      if (!current()) return;
      const stamp=++listStamp;
      historyStatus.textContent='正在读取分享列表…';
      try {
        const {shares}=await manage({action:'list',...source});
        if (!current() || stamp!==listStamp) return;
        const edited=editing && shares.find(s=>s.id===editing.id);
        if (edited && (edited.revision>editing.revision || edited.revokedAt || Date.parse(edited.expiresAt)<=Date.now()) && !writing) {
          resetMode();feedback.textContent='这份分享已变化，请从列表重新核对。';
        }
        historyStatus.textContent=shares.length?'':'还没有分享。';
        replace(history,shares.map(item=>{
          const expired=Date.parse(item.expiresAt)<=Date.now();
          if (expired || item.revokedAt) removeIssued(item.id);
          const actions=h('div',{class:'row'});
          const revert=()=>replace(actions,Button({label:'修改分享',size:'sm',onClick:()=>edit(item)}),Button({label:'撤销分享',size:'sm',onClick:()=>replace(actions,
            Button({label:'确认撤销',size:'sm',kind:'danger',onClick:async()=>{
              if (!current() || writing || stamp!==listStamp) return;
              const revokeStamp=++editStamp;
              if(loadingEdit) resetMode();
              replace(actions,h('span',{class:'small muted'},'正在撤销…'));
              try {
                await manage({action:'revoke',...source,id:item.id,revision:item.revision});
                if(current()){removeIssued(item.id);if(editing?.id===item.id && revokeStamp===editStamp) resetMode();void loadList();}
              } catch(error) {if(current() && stamp===listStamp){actions.replaceChildren();historyStatus.textContent=error.message+'。请刷新分享列表核对。';}}
            }}),Button({label:'取消',size:'sm',onClick:revert}))}));
          if (!item.revokedAt && !expired) revert();
          return h('div',{class:'item'},h('div',{class:'item__main'},h('strong',{},item.messageCount+' 条消息 · '+(item.revokedAt?'已撤销':expired?'已到期':'分享中')),
            h('span',{class:'item__meta'},(futureState(item)?futureState(item)+' · ':'')+(item.showTools?'包含工具记录 · ':'')+'创建于 '+dateLabel(item.createdAt)+'，到期于 '+dateLabel(item.expiresAt))),actions);
        }));
      } catch(error){if(current() && stamp===listStamp){history.replaceChildren();historyStatus.textContent=error.message;}}
    }
    session={drawer,close,refreshRows};
    refreshRows();void loadList();if(native) void loadCatalog();
  }
  return {button,update,open,refreshRows:()=>session?.refreshRows()};
}

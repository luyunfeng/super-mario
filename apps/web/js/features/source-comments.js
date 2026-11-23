import {h,replace} from '../lib/dom.js';
import {uuid} from '../lib/format.js';
import {confirmDialog} from '../ui/overlay.js';
import {Button,Field,Select,TextArea} from '../ui/kit.js';

const pending=new Map();

export function sourceComments(api,path,canRead,title,selectedText) {
  const status=h('p',{class:'small',role:'status'});
  const threads=h('div',{class:'stack'});
  const refresh=Button({label:'刷新评论',size:'sm',onClick:load});
  const filter=Select({options:[['all','全部'],['open','未解决'],['resolved','已解决']],value:'all',onchange:render});
  const editor=h('div',{class:'stack'});
  const receipt=h('p',{class:'small',role:'status',hidden:true});
  function report(text) {receipt.hidden=!text;receipt.textContent=text;}
  const create=Button({label:'评论全文',size:'sm',onClick:()=>compose('create')});
  const quote=Button({label:'评论选段',size:'sm',onClick:()=>{
    const passage=selectedText();
    if(!passage.trim()){report('请先在上方原文中选中要评论的文字。');return;}
    if(Array.from(passage).length>1000){report('选段最多 1000 个字符，请重新选择。');return;}
    compose('create',undefined,passage);
  }});
  quote.addEventListener('mousedown',e=>e.preventDefault());
  const readOnly=h('p',{class:'small',hidden:true},'请先核验飞书账号，再发布或更改评论。');
  const actions=h('div',{class:'row row--wrap',hidden:true},create,quote);
  const panel=h('details',{},h('summary',{},'查看飞书文档评论'),Field({label:'评论状态',control:filter}),status,readOnly,actions,editor,threads,refresh,receipt);
  let active,result,writing=false,editToken;
  const canWrite=()=>panel.isConnected && panel.open && canRead() && !!result?.documentId && !!result?.binding;
  function closeEditor(){editToken=undefined;editor.replaceChildren();}
  function compose(kind,thread,quote) {
    if (!canWrite() || writing) return;
    const token=editToken={};
    const input=TextArea({rows:3});
    const label=kind==='reply'?'回复内容':'评论内容';
    replace(editor,quote && h('blockquote',{},quote),quote && h('p',{class:'small'},'按所选文字定位到原文段落。若多处匹配或原文已更改，请重新选择。'),Field({label,control:input}),
      h('div',{class:'row'},Button({label:'核对并发送',size:'sm',onClick:()=>{
        const text=input.value.trim();
        if(!text){report('请填写'+label+'。');input.focus();return;}
        if(Array.from(text).length>4000){report('评论正文最多 4000 个字符。');input.focus();return;}
        return submit({kind,text,...(thread && {threadId:thread.id}),...(quote && {quote})},thread,token);
      }}),Button({label:'取消编辑',size:'sm',onClick:closeEditor})));
    report('');input.focus();
  }
  async function submit(action,thread,token) {
    if (!canWrite() || writing) return;
    const snapshot=result;
    const labels={create:action.quote?'发布选段评论':'发布全文评论',reply:'发送回复',resolve:'解决评论',reopen:'重新打开评论'};
    const label=labels[action.kind];
    const target=thread && (thread.quote || thread.replies[0]?.text || thread.id);
    let key;
    function clearRequest(){
      if(!key) return;
      pending.delete(key);
      try {sessionStorage.removeItem(key);} catch { /* The in-memory receipt is already cleared. */ }
    }
    writing=true;
    try {
      const approved=await confirmDialog({title:'确认'+label,confirmLabel:label,message:h('div',{class:'stack'},
        h('p',{},'飞书文档：'+title),h('p',{},'飞书账号：'+(snapshot.actorName || '当前已核验账号')),target && h('p',{},'目标评论：'+target),
        action.quote && h('div',{},h('p',{},'按所选文字定位到原文段落'),h('blockquote',{},action.quote)),action.text && h('p',{style:{whiteSpace:'pre-wrap'}},action.text))});
      if(!approved || !canWrite() || result!==snapshot || (token && editToken!==token)) return;
      key='sm.document-comment.'+Array.from(globalThis.sha256(new TextEncoder().encode(
        JSON.stringify([api.draftOwner(),path,snapshot.documentId,snapshot.binding,action]))),n=>n.toString(16).padStart(2,'0')).join('');
      let requestId=pending.get(key);
      try {requestId ||= sessionStorage.getItem(key);} catch { /* Page memory still covers retries. */ }
      requestId ||= uuid();
      pending.set(key,requestId);
      try {sessionStorage.setItem(key,requestId);} catch { /* Keep in page memory. */ }
      const response=await api.post(path,{documentId:snapshot.documentId,binding:snapshot.binding,requestId,action});
      if(response?.confirmed!==true) throw new Error('未取得飞书回执');
      clearRequest();
      if(!canWrite() || result!==snapshot) return;
      closeEditor();report('飞书已确认：'+label+'。');await load();
    } catch(error) {
      if(error.code==='COMMENT_NOT_SENT') clearRequest();
      if(canWrite() && result===snapshot) report((error.code==='COMMENT_NOT_SENT'?'未发送：':'未确认操作结果：')+error.message+'。可刷新评论核对。');
    } finally {writing=false;}
  }
  function current(request) {
    return request===active && panel.isConnected && panel.open && canRead();
  }
  function render() {
    if (!result || !canRead()) return;
    const shown=result.threads.filter(thread=>filter.value==='all' || thread.resolved===(filter.value==='resolved'));
    replace(threads,shown.map(thread=>h('article',{class:'item stack'},
        h('strong',{},thread.resolved?'已解决':'未解决'),
        thread.quote && h('blockquote',{},thread.quote),
        thread.replies.map(reply=>h('p',{style:{whiteSpace:'pre-wrap'}},
          h('strong',{},reply.author || '未知作者'),'：',reply.text)),
        canWrite() && h('div',{class:'row row--wrap'},
          thread.canReply && !thread.resolved && Button({label:'回复评论',size:'sm',onClick:()=>compose('reply',thread)}),
          Button({label:thread.resolved?'重新打开评论':'解决评论',size:'sm',onClick:()=>
            submit({kind:thread.resolved?'reopen':'resolve',threadId:thread.id},thread)})))));
    status.textContent=(shown.length?'显示 '+shown.length+' 条评论。':result.threads.length?'没有符合筛选条件的评论。':'暂无评论。')+
        (result.truncated?'仅显示部分评论或回复。':'');
  }
  async function load() {
    if (!panel.open || !canRead()) return;
    active?.abort();
    const request=new AbortController();
    active=request;result=undefined;filter.disabled=true;actions.hidden=true;readOnly.hidden=true;closeEditor();
    refresh.disabled=true;status.textContent='正在读取评论…';threads.replaceChildren();
    try {
      const response=await api(path,{signal:request.signal});
      if (!current(request)) return;
      result=response;filter.disabled=false;actions.hidden=!canWrite();readOnly.hidden=!actions.hidden;render();
    } catch(error) {
      if (current(request)) status.textContent='读取评论失败：'+error.message;
    } finally {
      if (active===request) refresh.disabled=false;
    }
  }
  panel.addEventListener('toggle',()=>{
    if (panel.open) {void load();return;}
    active?.abort();active=undefined;result=undefined;closeEditor();report('');actions.hidden=true;threads.replaceChildren();status.textContent='';
  });
  return panel;
}

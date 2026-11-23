import {h,replace} from '../lib/dom.js';
import {uuid} from '../lib/format.js';
import {Button} from '../ui/kit.js';
import {confirmDialog} from '../ui/overlay.js';
import {personalInboxPluginActive,personalInboxMessageId} from './feishu-edit-history.js';

export const chatPinsActive=(store,api)=>personalInboxPluginActive(store,api,'feishu-chat-pins');

export function inboxChatPins(api,store,row,openSource){
  const original=personalInboxMessageId(row);
  if(!original || !chatPinsActive(store,api)) return;
  const path='/inbox/'+encodeURIComponent(row.id)+'/pins',life=new AbortController();
  const body=h('div',{class:'stack'}),status=h('p',{role:'status'}),buttons=h('div',{class:'row row--wrap'});
  const full=h('section',{class:'stack',hidden:true,'aria-label':'置顶消息原文'});
  const panel=h('details',{hidden:true},h('summary',{},'查看会话置顶'),status,body,buttons,full);
  let accountKey,rows=[],cursor,read,locating,writing=false,unknown,verified=false;
  const current=()=>!life.signal.aborted && panel.isConnected && chatPinsActive(store,api);
  function clearOriginal(){locating?.abort();full.hidden=true;replace(full);}
  async function locate(pin){
    if(!current() || !panel.open || !verified) return;
    clearOriginal();locating=new AbortController();
    const signal=locating.signal;
    full.hidden=false;replace(full,h('p',{role:'status'},'正在核对置顶原文…'));
    try{
      const result=await api(path+'/'+encodeURIComponent(pin.messageId)+'/original?accountKey='+encodeURIComponent(accountKey),{signal});
      if(!current() || signal.aborted || !panel.open) return;
      if(result.messageId!==pin.messageId || result.chatId!==row.origin.chatId) throw Error('原消息与本会话不符');
      if(result.deleted){replace(full,h('p',{role:'status'},'原消息已撤回。'));return;}
      if(result.threadId){await openTopic(result,signal);return;}
      if(result.inboxId){openSource(result.inboxId);return;}
      replace(full,h('strong',{},'置顶消息原文'),result.text && h('p',{class:'mailbox-content'},result.text),
        result.parentId && h('p',{class:'small muted'},'引用消息：'+result.parentId),
        !result.text && h('p',{role:'status'},'没有可显示的原文。'));
    }catch(error){if(current() && !signal.aborted)replace(full,h('p',{role:'alert'},'无法定位原文：'+error.message));}
  }
  async function openTopic(target,signal){
    const replies=new Map(), controls=h('div',{class:'row row--wrap'}),list=h('div',{class:'stack'});
    const section=h('section',{class:'stack','aria-label':'置顶消息话题'},h('h3',{},'置顶消息所在话题'),list,controls);
    let root,nextCursor;
    function message(entry){
      const hit=entry.messageId===target.messageId;
      return h('div',{class:'stack'},hit && h('mark',{tabIndex:-1},'当前置顶消息'),
        h('p',{class:'mailbox-content'},entry.deleted?'原消息已撤回。':entry.text || '没有可显示的原文。'),
        !entry.deleted && entry.senderName && h('span',{class:'small muted'},entry.senderName),
        entry.createdAt && h('time',{dateTime:entry.createdAt,class:'small muted'},new Date(entry.createdAt).toLocaleString('zh-CN')));
    }
    async function loadPage(more){
      replace(controls,h('p',{role:'status'},'正在读取话题…'));
      try{
        const query=new URLSearchParams({accountKey});
        if(more) query.set('cursor',nextCursor);
        const page=await api(path+'/'+encodeURIComponent(target.messageId)+'/topic?'+query,{signal});
        if(signal.aborted || !current() || !panel.open) return;
        if(page.threadId!==target.threadId){replace(full,h('p',{role:'alert'},'原消息与话题不符。'));return;}
        root=page.root ?? root;
        for(const entry of page.messages) replies.set(entry.messageId,entry);
        if(root) replies.delete(root.messageId);
        nextCursor=page.nextCursor;
        replace(list,root && h('div',{class:'stack'},h('strong',{},'话题首条消息'),message(root)),
          root?.messageId!==target.messageId && !replies.has(target.messageId) && message(target),
          h('strong',{},'话题回复'),[...replies.values()].map(message));
        replace(controls,nextCursor && Button({label:'加载更多回复',size:'sm',onClick:()=>loadPage(true)}));
        if(!more) list.querySelector('mark')?.focus();
      }catch(error){
        if(signal.aborted || !current() || !panel.open) return;
        if([401,403,404,409,410,503].includes(error.status)){replace(full,h('p',{role:'alert'},'无法读取话题：'+error.message));return;}
        replace(controls,h('p',{role:'alert'},'无法读取话题：'+error.message),
          Button({label:'重试读取话题',size:'sm',onClick:()=>loadPage(more)}));
      }
    }
    replace(full,section);
    await loadPage(false);
  }
  function render(){
    replace(body,rows.map(pin=>h('article',{class:'stack card__body'},
      h('p',{class:'mailbox-content'},pin.text || '消息 '+pin.messageId),
      pin.pinnedAt && h('time',{dateTime:pin.pinnedAt},new Date(pin.pinnedAt).toLocaleString('zh-CN')),
      h('div',{class:'row row--wrap'},
        Button({label:'查看原文',size:'sm',disabled:writing || !verified,onClick:()=>locate(pin)}),
        Button({label:'取消置顶',size:'sm',disabled:!verified || writing || !!unknown,onClick:()=>change('unpin',pin)})))));
    replace(buttons,Button({label:'刷新置顶列表',disabled:writing,size:'sm',onClick:()=>load(false)}),
      cursor && Button({label:'加载更多置顶',disabled:writing,size:'sm',onClick:()=>load(true)}),
      verified && !cursor && !rows.some(p=>p.messageId===original) && Button({label:'置顶这条消息',disabled:writing || !!unknown,size:'sm',
        onClick:()=>change('pin',{messageId:original,text:row.text})}));
  }
  async function load(more){
    if(!current() || !panel.open || writing) return;
    read?.abort();read=new AbortController();const signal=read.signal;
    if(!more){clearOriginal();rows=[];cursor=undefined;verified=false;}
    status.textContent='正在读取置顶消息…';render();
    try{
      const page=await api(path+(more?'?cursor='+encodeURIComponent(cursor):''),{signal});
      if(!current() || signal.aborted || !panel.open) return;
      if(!page.accountKey || page.accountKey!==accountKey){clearOriginal();panel.hidden=true;rows=[];replace(body);replace(buttons);return;}
      const seen=new Set(rows.map(p=>p.messageId));
      rows.push(...page.pins.filter(p=>!seen.has(p.messageId)));cursor=page.nextCursor;
      verified=true;
      if(unknown && (rows.some(p=>p.messageId===unknown.messageId) || !cursor)) unknown=undefined;
      status.textContent=unknown?'请继续加载置顶消息，核对上次操作。':rows.length?'已读取 '+rows.length+' 条置顶消息。':'当前会话没有置顶消息。';
    }catch(error){
      if(!current() || signal.aborted) return;
      if([401,403,404,409,503].includes(error.status)){clearOriginal();rows=[];cursor=undefined;verified=false;}
      status.textContent='无法读取置顶列表：'+error.message;
    }
    render();
  }
  async function change(action,pin){
    if(!current() || !verified || writing || unknown) return;
    writing=true;render();
    const label=action==='pin'?'置顶这条消息':'取消置顶';
    try{
      const approved=await confirmDialog({title:'确认'+label,confirmLabel:label,signal:life.signal,message:h('div',{class:'stack'},
        h('p',{},'将修改飞书会话「'+(row.origin.chatName || row.origin.chatId)+'」的置顶列表。'),h('p',{class:'mailbox-content'},pin.text || pin.messageId))});
      if(!approved || !panel.open || !current()) return;
      const response=await api.post(path,{action,accountKey,messageId:pin.messageId,requestId:uuid()});
      if(response?.confirmed!==true || response.messageId!==pin.messageId || response.action!==action) throw Error('没有可确认的回执');
      writing=false;await load(false);
    }catch(error){
      if(!current() || !panel.open) return;
      if(error.code==='PIN_DELIVERY_UNKNOWN' || !error.status || error.status>=500) {
        unknown={messageId:pin.messageId};verified=false;
        status.textContent='置顶操作结果未知。请刷新置顶列表核对。';
      } else {
        verified=false;status.textContent='未确认置顶操作：'+error.message+'。请刷新列表核对。';
      }
    }finally{writing=false;if(current())render();}
  }
  panel.addEventListener('toggle',()=>{
    if(panel.open) void load(false);
    else {read?.abort();clearOriginal();rows=[];cursor=undefined;verified=false;replace(body);replace(buttons);status.textContent='';}
  });
  void api('/feishu/personal',{signal:life.signal}).then(state=>{
    if(current() && state.source===row.source && state.accountKey){accountKey=state.accountKey;panel.hidden=false;}
  }).catch(()=>{});
  return {el:panel,close(){life.abort();read?.abort();clearOriginal();rows=[];panel.hidden=true;replace(body);replace(buttons);}};
}

import {h,replace} from '../lib/dom.js';
import {Button} from '../ui/kit.js';
import {personalInboxMessageId,personalInboxPluginActive} from './feishu-edit-history.js';

export const inboxFileActive=(store,api)=>personalInboxPluginActive(store,api,'inbox-triage');

export function inboxFilePreview(api,store,row){
  if(!inboxFileActive(store,api) || row.origin?.feishuFile!==true || !personalInboxMessageId(row)) return;
  const content=h('div',{class:'stack'});
  const panel=h('details',{},h('summary',{},'读取附件正文'),content);
  let read;
  function clear(){
    read?.abort();
    read=undefined;
    replace(content);
  }
  async function load(){
    clear();
    if(!panel.open || !panel.isConnected || !inboxFileActive(store,api)) return;
    read=new AbortController();
    const {signal}=read;
    replace(content,h('p',{role:'status'},'正在读取附件正文…'));
    try{
      const file=await api('/inbox/'+encodeURIComponent(row.id)+'/file-text',{signal});
      if(signal.aborted || !panel.open || !panel.isConnected || !inboxFileActive(store,api)) return;
      replace(content,h('strong',{},file.name),
        file.text ? h('pre',{class:'mailbox-content'},file.text) : h('p',{role:'status'},'附件中没有可显示的文字。'),
        file.truncated && h('p',{class:'small muted'},'仅显示部分附件正文。'));
    }catch(error){
      if(!signal.aborted && panel.open && panel.isConnected && inboxFileActive(store,api))
        replace(content,h('p',{role:'alert'},'无法读取附件正文：'+error.message),Button({label:'重新读取附件',onClick:load}));
    }
  }
  panel.addEventListener('toggle',()=>{if(panel.open) void load();else clear();});
  return {el:panel,close:clear};
}

import {h,replace} from '../lib/dom.js';
import {Button} from '../ui/kit.js';
import {openDrawer} from '../ui/overlay.js';

const settingsPath='/feishu/personal/edit-history';
export function editHistoryActive(store,api){
  const v=store.view;
  return !v.unauthorized && v.connection!=='offline' && v.connection!=='connecting' && v.snapshotOwner===api.draftOwner?.() &&
    ['feishu','feishu-edit-history'].every(id=>v.snapshot?.plugins?.some(p=>p.id===id && p.status==='active'));
}

export function showEditHistorySettings(api,store,currentAccount){
  const label=currentAccount()?.account?.name,owner=api.draftOwner();
  const status=h('p',{role:'status'}),body=h('div',{class:'stack'});
  let request=0,unsubscribe;
  const drawer=openDrawer({title:'个人消息编辑历史',body:[status,body],onClose:()=>{request++;unsubscribe?.();}});
  const current=()=>drawer.el.open && currentAccount()?.account?.name===label && !!currentAccount() && owner===api.draftOwner() && editHistoryActive(store,api);
  let changed=store.view.feishuEditHistoryChange;
  unsubscribe=store.subscribe(view=>{
    if(!current()){replace(body);drawer.close();return;}
    if(view.feishuEditHistoryChange!==changed){changed=view.feishuEditHistoryChange;if(changed?.accountChanged){replace(body);drawer.close();}else void load();}
  });
  async function load(){
    const stamp=++request;
    replace(body);status.textContent='正在读取编辑历史设置…';
    try{
      const value=await api.get(settingsPath);
      if(!current() || stamp!==request) return;
      if(!value.accountKey) throw Error('请先核验个人飞书账号。');
      const check=h('input',{type:'checkbox',checked:value.enabled});
      status.textContent='';
      replace(body,h('p',{},'飞书账号：'+label),h('label',{class:'check'},check,'保留消息编辑历史'),
        h('p',{class:'small muted'},'开启后会保留个人采集消息被替换前的正文。关闭并保存会删除该账号已保存的旧版本，重新开启也无法恢复。'),
        Button({label:'保存设置',onClick:async()=>{
          if(!current() || stamp!==request) return;
          try{
            await api.put(settingsPath,{accountKey:value.accountKey,revision:value.revision,enabled:check.checked});
            if(current() && stamp===request) await load();
          }catch(error){if(current() && stamp===request){await load();if(current())status.textContent='设置未保存：'+error.message;}}
        }}));
    }catch(error){
      if(current() && stamp===request){status.textContent=error.message;replace(body,Button({label:'重新读取设置',onClick:load}));}
    }
  }
  void load();
}

// Read the account-level permission first. Previous message text is requested only after the owner expands it.
export function inboxEditHistory(api,store,row){
  if(!editHistoryActive(store,api) || !/^feishu:cli_[\w-]+:ou_[\w-]+$/.test(row.source) ||
      !row.thread?.startsWith('feishu:message:') || !['direct','group'].includes(row.origin?.kind)) return;
  try {
    const [chat,message]=JSON.parse(row.thread.slice('feishu:message:'.length));
    if(!/^oc_[\w-]+$/.test(chat) || !/^om_[\w-]+$/.test(message) || chat!==row.origin.chatId || row.last?.split(':')[0]!==message) return;
  }catch{return;}
  const content=h('div',{class:'stack'}),panel=h('details',{hidden:true},h('summary',{},'查看消息编辑历史'),content);
  const controller=new AbortController();
  let grant,read;
  const current=()=>!controller.signal.aborted && panel.isConnected && editHistoryActive(store,api);
  async function authorize(){
    const value=await api(settingsPath,{signal:controller.signal});
    return value.enabled && value.source===row.source && !!value.accountKey ? value : undefined;
  }
  async function load(){
    read?.abort();read=new AbortController();
    const signal=read.signal;
    if(!current() || !panel.open || !grant) return;
    replace(content,h('p',{role:'status'},'正在读取旧版本…'));
    try{
      const result=await api('/inbox/'+encodeURIComponent(row.id)+'/edit-history',{signal});
      if(!current() || !panel.open || signal.aborted) return;
      replace(content,result.versions.length ? result.versions.map(version=>h('article',{},
        h('time',{dateTime:version.replacedAt},new Date(version.replacedAt).toLocaleString('zh-CN')+' 被替换'),
        h('p',{class:'mailbox-content'},version.text))) : h('p',{role:'status'},'没有保存的旧版本。'),
        result.truncated && h('p',{class:'small muted'},'仅显示部分旧版本。'));
    }catch(error){
      if(current() && panel.open && !signal.aborted) replace(content,h('p',{role:'alert'},'无法读取编辑历史：'+error.message));
    }
  }
  panel.addEventListener('toggle',()=>{if(panel.open)void load();else{read?.abort();replace(content);}});
  void authorize().then(value=>{if(current()){grant=value;panel.hidden=!grant;}}).catch(()=>{});
  return {el:panel,close(){controller.abort();read?.abort();grant=undefined;replace(content);panel.hidden=true;}};
}

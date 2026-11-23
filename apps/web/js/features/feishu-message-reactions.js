import {h,replace} from '../lib/dom.js';
import {uuid} from '../lib/format.js';
import {Button} from '../ui/kit.js';
import {reactionCatalog,reactionLabels} from './feishu-reaction-catalog.js';
import {personalInboxMessageId,personalInboxPluginActive} from './feishu-edit-history.js';

export const reactionsActive=(store,api)=>personalInboxPluginActive(store,api,'feishu-message-reactions');
const common=['THUMBSUP','OK','HEART','CLAP','SMILE'];

function reactionDirectory(choose){
  const search=h('input',{type:'search',class:'input','aria-label':'搜索表情',placeholder:'搜索中文名或飞书表情名称'});
  const results=h('div',{class:'stack'});
  const directory=h('details',{},h('summary',{},'全部表情'),search,results);
  function filter(){
    const query=search.value.trim().toLowerCase();
    const sections=[];
    for(const {title,items} of reactionCatalog){
      const matches=items.filter(({key,name})=>(title+' '+name+' '+key).toLowerCase().includes(query));
      if(matches.length)sections.push(h('section',{'aria-label':title},h('strong',{},title),
        h('div',{class:'row row--wrap'},matches.map(({key,name,icon})=>Button({label:icon+' '+name,size:'sm',
          title:key,onClick:()=>{directory.open=false;choose(key);}})))));
    }
    replace(results,sections.length?sections:h('p',{role:'status'},'没有匹配的表情。'));
  }
  directory.ontoggle=()=>{if(directory.open){filter();search.focus();}else replace(results);};
  search.oninput=filter;
  return directory;
}

export function inboxReactions(api,store,row){
  if(!personalInboxMessageId(row) || !reactionsActive(store,api))return;
  const path='/inbox/'+encodeURIComponent(row.id)+'/reactions',life=new AbortController();
  const status=h('p',{role:'status'}),body=h('div',{class:'stack'}),actions=h('div',{class:'row row--wrap'});
  const panel=h('details',{hidden:true},h('summary',{},'表情回应'),status,body,actions);
  const entries=new Map(),owner=api.draftOwner();
  const recentKey=()=>JSON.stringify(['sm.reactions.recent',owner,accountKey]);
  function recent(){
    try{return JSON.parse(localStorage.getItem(recentKey()) || '[]').filter(key=>typeof key==='string' && key).slice(0,6);}
    catch{return [];}
  }
  function remember(emoji){
    try{localStorage.setItem(recentKey(),JSON.stringify([...new Set([emoji,...recent()])].slice(0,6)));}
    catch{/* Storage limits do not change the confirmed reaction. */}
  }
  let accountKey,cursor,read,loading=false,writing=false,verified=false,uncertain=false;
  const active=()=>!life.signal.aborted && panel.isConnected && owner===api.draftOwner() && reactionsActive(store,api);
  function render(){
    const groups=new Map();
    for(const entry of entries.values()){
      if(!groups.has(entry.emoji))groups.set(entry.emoji,[]);
      groups.get(entry.emoji).push(entry);
    }
    const busy=loading || writing,canWrite=verified && !busy && !uncertain;
    // Adding is an idempotent set; removing needs an observed reaction belonging to this account.
    const mayAdd=canWrite;
    replace(body,[...groups].map(([emoji,group])=>{
      const mine=group.some(item=>item.mine);
      return h('section',{class:'stack','aria-label':'回应 '+emoji},
        h('strong',{},(reactionLabels.get(emoji) || emoji)+' · '+group.length+(mine?' · 我已回应':'')),
        h('details',{},h('summary',{},'参与者'),h('ul',{},group.map(item=>h('li',{},item.mine?'我':
          (item.operatorType==='app'?'应用 ':'')+item.operatorId)))),
        Button({label:mine?'撤回我的 '+emoji:'回应 '+emoji,size:'sm',disabled:mine?!canWrite:!mayAdd,onClick:()=>change(emoji,mine?'remove':'add')}));
    }));
    const keys=[...new Set([...recent(),...common])].slice(0,6);
    const picker=h('select',{'aria-label':'选择表情'},keys.map(key=>h('option',{value:key},reactionLabels.get(key) || key)),h('option',{value:''},'其他表情'));
    const custom=h('input',{hidden:true,placeholder:'例如 THUMBSUP','aria-label':'飞书表情名称'});
    picker.onchange=()=>{custom.hidden=!!picker.value;if(!custom.hidden)custom.focus();};
    const directory=mayAdd && reactionDirectory(key=>{
      if(![...picker.options].some(option=>option.value===key))picker.add(new Option(reactionLabels.get(key),key),picker.options.length-1);
      picker.value=key;custom.hidden=true;picker.focus();
    });
    replace(actions,Button({label:'刷新回应',size:'sm',disabled:busy,onClick:()=>load(false)}),
      cursor && Button({label:'加载更多回应',size:'sm',disabled:busy,onClick:()=>load(true)}),
      mayAdd && [h('span',{class:'small muted'},'本机常用表情'),picker,custom,Button({label:'添加回应',size:'sm',onClick:()=>{
        const emoji=picker.value || custom.value.trim();
        if(!emoji){status.textContent='请选择或输入飞书表情名称。';return;}
        if(groups.get(emoji)?.some(item=>item.mine)){status.textContent='你已添加这个回应。';return;}
        void change(emoji,'add');
      }}),directory]);
  }
  async function load(more){
    if(!active() || !panel.open || writing)return;
    read?.abort();read=new AbortController();const signal=read.signal;
    if(!more){entries.clear();cursor=undefined;verified=false;}
    loading=true;status.textContent='正在读取表情回应…';render();
    try{
      const page=await api(path+(more?'?cursor='+encodeURIComponent(cursor):''),{signal});
      if(!active() || signal.aborted || !panel.open)return;
      if(page.accountKey!==accountKey){entries.clear();verified=false;panel.hidden=true;return;}
      for(const item of page.items)entries.set(item.reactionId,item);
      cursor=page.nextCursor;verified=true;
      if(uncertain && (!cursor || [...entries.values()].some(item=>item.emoji===uncertain && item.mine)))uncertain=false;
      status.textContent=uncertain?'请继续核对全部回应。':cursor?'已显示部分回应，可继续加载。':entries.size?'已读取全部回应。':'这条消息还没有表情回应。';
    }catch(error){
      if(!active() || signal.aborted)return;
      verified=false;
      if([401,403,404,409,410,503].includes(error.status)){entries.clear();cursor=undefined;}
      status.textContent='无法读取表情回应：'+error.message;
    }finally{if(active() && !signal.aborted){loading=false;render();}}
  }
  async function change(emoji,action){
    if(!active() || !panel.open || !verified || loading || writing || uncertain)return;
    writing=true;render();
    try{
      const result=await api.post(path,{accountKey,emoji,action,requestId:uuid()});
      if(!active() || !panel.open)return;
      if(result?.confirmed!==true || result.action!==action || result.emoji!==emoji)throw Error('缺少确认回执');
      if(action==='add')remember(emoji);
      writing=false;await load(false);
    }catch(error){
      if(!active() || !panel.open)return;
      verified=false;
      if([401,403,404,409,410,503].includes(error.status)){entries.clear();cursor=undefined;}
      uncertain=(error.code==='REACTION_DELIVERY_UNKNOWN' || !error.status || error.status>=500)?emoji:false;
      status.textContent=uncertain?'表情回应结果未知，请刷新核对。':'回应未确认：'+error.message+'。请刷新核对。';
    }finally{writing=false;if(active())render();}
  }
  panel.ontoggle=()=>{
    if(panel.open)void load(false);
    else {read?.abort();entries.clear();verified=false;cursor=undefined;replace(body);replace(actions);status.textContent='';}
  };
  void api('/feishu/personal',{signal:life.signal}).then(state=>{
    if(active() && state.source===row.source && state.accountKey){accountKey=state.accountKey;panel.hidden=false;}
  }).catch(()=>{});
  return {el:panel,close(){life.abort();read?.abort();entries.clear();panel.hidden=true;replace(body);replace(actions);}};
}

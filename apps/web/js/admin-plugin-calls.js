import {h,replace} from './lib/dom.js';

const button=(label,onclick)=>h('button',{type:'button',class:'btn btn--sm',onclick},label);

// Each expanded viewer owns its reader, timer and visibility handlers. A closed row holds no call history.
export function attachPluginCalls(detail,id,{request,active,checkSession}){
  const show=button('查看最近调用',open);
  detail.append(show);
  let close=()=>{};
  function open(){
    if(!active() || !detail.open || show.hidden)return;
    show.hidden=true;
    const events=new AbortController(),search=h('input',{type:'search',class:'input','aria-label':'筛选操作名'});
    const failed=h('input',{type:'checkbox'}),follow=h('input',{type:'checkbox'});
    const refresh=button('刷新调用',load),status=h('p',{role:'status',class:'small muted'}),report=h('div');
    const box=h('section',{class:'stack','aria-label':'最近调用'},h('h4',{},'最近调用'),
      h('small',{},'当前服务进程保留最近 200 条调用。'),h('label',{class:'field'},'筛选操作名',search),
      h('div',{class:'row row--wrap'},h('label',{class:'check'},failed,'仅失败'),h('label',{class:'check'},follow,'跟随刷新'),
        refresh,button('收起最近调用',()=>{close();show.focus();})),status,report);
    detail.append(box);
    let calls=[],ready=false,timer,reader,focused=document.hasFocus();
    const visible=()=>active() && detail.open && box.isConnected && !events.signal.aborted;
    const foreground=()=>visible() && focused && !document.hidden;
    function schedule(){
      clearTimeout(timer);
      if(follow.checked && foreground() && !reader)timer=setTimeout(()=>{if(follow.checked && foreground())void load();},5000);
    }
    function cancel(){
      clearTimeout(timer);reader?.abort();reader=undefined;refresh.disabled=false;
    }
    close=()=>{
      cancel();events.abort();box.remove();calls=[];show.hidden=false;close=()=>{};
    };
    function paint(){
      if(!ready)return;
      const query=search.value.trim().toLowerCase();
      const rows=calls.filter(call=>(!failed.checked || call.status==='error') && call.name.toLowerCase().includes(query));
      status.textContent=rows.length?'显示 '+rows.length+' / '+calls.length+' 条调用。':calls.length?'没有符合条件的调用。':'当前进程没有调用记录。';
      replace(report,rows.length>0 && h('table',{class:'table','aria-label':'调用记录'},
        h('thead',{},h('tr',{},['时间','操作','耗时','状态'].map(value=>h('th',{scope:'col'},value)))),
        h('tbody',{},rows.map(call=>h('tr',{},h('td',{},h('time',{dateTime:call.at},new Date(call.at).toLocaleString('zh-CN'))),
          h('td',{},call.name),h('td',{},call.elapsedMs+' 毫秒'),h('td',{},call.status==='error'?'失败':'成功'))))));
    }
    async function load(){
      if(!visible() || reader)return;
      const pending=new AbortController();reader=pending;
      refresh.disabled=true;if(!ready)status.textContent='正在读取最近调用…';
      try{
        const result=await request('plugins/'+encodeURIComponent(id)+'/calls',undefined,{},pending.signal);
        if(!visible() || pending.signal.aborted)return;
        calls=result.items;ready=true;paint();
      }catch(error){
        if(!visible() || pending.signal.aborted)return;
        calls=[];ready=false;follow.checked=false;replace(report);status.textContent='无法读取最近调用：'+error.message;
        if(error.status===401 || error.status===403)await checkSession();
      }finally{
        if(reader===pending){reader=undefined;refresh.disabled=false;schedule();}
      }
    }
    function onVisibility(){
      if(!foreground()){cancel();return;}
      if(follow.checked || !ready)void load();
    }
    document.addEventListener('visibilitychange',onVisibility,{signal:events.signal});
    window.addEventListener('blur',()=>{focused=false;onVisibility();},{signal:events.signal});
    window.addEventListener('focus',()=>{focused=true;onVisibility();},{signal:events.signal});
    search.oninput=paint;failed.onchange=paint;follow.onchange=schedule;
    void load();
  }
  return ()=>close();
}

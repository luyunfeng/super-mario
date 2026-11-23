import {attachPluginCalls} from './admin-plugin-calls.js';
import {h,replace} from './lib/dom.js';

const statuses={active:'运行中',disabled:'已停用',waiting:'等待依赖',failed:'加载失败',missing:'未安装'};
const button=(label,onclick)=>h('button',{type:'button',class:'btn btn--sm',onclick},label);
const listText=items=>items.length?items.join('、'):'无';

export function createAdminPlugins({request,current,checkSession}){
  const life=new AbortController();
  const filters=h('div',{class:'stack',hidden:true}),message=h('p',{class:'small muted'}),list=h('div',{class:'stack'});
  const search=h('input',{type:'search',class:'input',placeholder:'名称、ID 或能力'});
  const status=h('select',{class:'select'},h('option',{value:''},'全部状态'),
    ['active','disabled','waiting','failed'].map(value=>h('option',{value},statuses[value])));
  const read=button('查看插件',load);
  const panel=h('section',{'aria-label':'插件诊断',class:'stack'},h('h2',{},'插件诊断'),read,filters,message,list);
  filters.append(h('label',{class:'field'},'搜索插件',search),h('label',{class:'field'},'插件状态',status));
  const expanded=new Set(),metricReads=new Map(),callViews=new Set();
  let rows=[],ready=false,loading=false;
  const active=()=>current() && panel.isConnected && !life.signal.aborted;
  function stopReports(){
    for(const close of callViews)close();
    callViews.clear();
    for(const reader of metricReads.values())reader.abort();
    metricReads.clear();
  }
  function attachMetrics(detail,id){
    const box=h('section',{class:'stack','aria-label':'调用指标',hidden:true});
    const windowPicker=h('select',{class:'select','aria-label':'指标时间范围'},
      [['1h','近 1 小时'],['24h','近 24 小时'],['7d','近 7 天']].map(([value,label])=>h('option',{value},label)));
    windowPicker.value='24h';
    const report=h('div',{class:'stack'}),refresh=button('刷新指标',loadMetrics);
    const show=button('查看调用指标',()=>{show.hidden=true;box.hidden=false;void loadMetrics();});
    box.append(windowPicker,refresh,report);detail.append(show,box);
    windowPicker.onchange=loadMetrics;
    const latency=value=>Number.isFinite(value)?value+' 毫秒':'暂无数据';
    async function loadMetrics(){
      if(!active() || !detail.open || !detail.isConnected)return;
      metricReads.get(id)?.abort();
      const reader=new AbortController();metricReads.set(id,reader);
      const valid=()=>active() && detail.open && detail.isConnected && !reader.signal.aborted;
      replace(report,h('p',{role:'status'},'正在读取指标…'));refresh.disabled=true;
      try{
        const data=await request('plugins/'+encodeURIComponent(id)+'/metrics?window='+windowPicker.value,undefined,{},reader.signal);
        if(!valid())return;
        if(!data.calls){replace(report,h('p',{role:'status'},'此时间范围没有调用记录。'));return;}
        replace(report,h('dl',{class:'kv'},[['调用次数',data.calls],['错误次数',data.errors],['P95 耗时',latency(data.p95Ms)]]
          .map(([label,value])=>[h('dt',{},label),h('dd',{},String(value))])),
          data.operations.length>0 && h('table',{class:'table','aria-label':'按操作统计'},
            h('thead',{},h('tr',{},['操作','调用次数','错误次数','P95 耗时'].map(text=>h('th',{scope:'col'},text)))),
            h('tbody',{},data.operations.map(op=>h('tr',{},h('th',{scope:'row'},op.name),
              h('td',{},op.calls),h('td',{},op.errors),h('td',{},latency(op.p95Ms)))))));
      }catch(error){
        if(!valid())return;
        replace(report,h('p',{role:'alert'},'无法读取调用指标：'+error.message));
        if(error.status===401 || error.status===403)await checkSession();
      }finally{
        if(metricReads.get(id)===reader){metricReads.delete(id);refresh.disabled=false;}
      }
    }
    return ()=>{
      metricReads.get(id)?.abort();metricReads.delete(id);
      show.hidden=false;box.hidden=true;refresh.disabled=false;replace(report);
    };
  }
  function paint(){
    if(!ready)return;
    stopReports();
    const query=search.value.trim().toLowerCase();
    const results=rows.filter(p=>(!status.value || p.status===status.value) &&
      [p.id,p.name,...p.capabilities].some(value=>value.toLowerCase().includes(query)));
    message.textContent=results.length?'显示 '+results.length+' / '+rows.length+' 个插件。':
      rows.length?'没有符合条件的插件。':'尚未登记插件。';
    replace(list,results.map(p=>{
      const detail=h('details',{class:'fold',open:expanded.has(p.id)},h('summary',{},p.name+' · '+(statuses[p.status] ?? p.status)),
        h('dl',{class:'kv fold__body'},[
          ['插件 ID',p.id],['来源',p.source==='local'?'本地插件':'内置插件'],['版本',p.version ?? '未提供'],
          ['配置开关',p.enabled?'已启用':'已停用'],['能力',listText(p.capabilities)],
          ['权限',p.permissions===null?'宿主默认':p.permissions.length?listText(p.permissions):'无显式授权'],
          ['依赖',listText(p.dependencies.map(dep=>dep.id+'（'+(statuses[dep.status] ?? dep.status)+'）'))],
          ...(p.reason?[['原因',p.reason]]:[]),
        ].map(([label,text])=>[h('dt',{},label),h('dd',{},text)])));
      const resetMetrics=attachMetrics(detail,p.id);
      const closeCalls=attachPluginCalls(detail,p.id,{request,active,checkSession});
      callViews.add(closeCalls);
      detail.ontoggle=()=>{if(detail.isConnected){
        if(detail.open)expanded.add(p.id);else{expanded.delete(p.id);resetMetrics();closeCalls();}
      }};
      return detail;
    }));
  }
  async function load(){
    if(!active() || loading)return;
    stopReports();loading=true;read.disabled=true;ready=false;replace(list);message.textContent='正在读取插件清单…';
    try{
      const result=await request('plugins',undefined,{},life.signal);
      if(!active())return;
      rows=result.plugins;ready=true;filters.hidden=false;paint();
    }catch(error){
      if(!active())return;
      rows=[];expanded.clear();filters.hidden=true;message.textContent='无法读取插件清单：'+error.message;
      if(error.status===401 || error.status===403)await checkSession();
    }finally{if(active()){loading=false;read.disabled=false;read.textContent='刷新插件';}}
  }
  search.oninput=paint;status.onchange=paint;
  return {el:panel,close(){life.abort();stopReports();rows=[];expanded.clear();replace(list);search.value='';}};
}

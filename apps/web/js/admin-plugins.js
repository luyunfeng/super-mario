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
  const expanded=new Set();
  let rows=[],ready=false,loading=false;
  const active=()=>current() && panel.isConnected && !life.signal.aborted;
  function paint(){
    if(!ready)return;
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
      detail.ontoggle=()=>{if(detail.isConnected){if(detail.open)expanded.add(p.id);else expanded.delete(p.id);}};
      return detail;
    }));
  }
  async function load(){
    if(!active() || loading)return;
    loading=true;read.disabled=true;ready=false;replace(list);message.textContent='正在读取插件清单…';
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
  return {el:panel,close(){life.abort();rows=[];expanded.clear();replace(list);search.value='';}};
}

import {h,replace} from './lib/dom.js';

const button=(text,action)=>h('button',{type:'button',class:'btn btn--sm',onclick:action},text);
export function createAdminMachines({request,submit,csrf,current}){
  const life=new AbortController(),drafts=new Map();
  const status=h('p',{class:'small muted'}),list=h('div',{class:'stack'}),loadButton=button('查看执行机',load);
  const section=h('section',{class:'stack','aria-label':'执行机管理'},h('h2',{},'执行机管理'),loadButton,status,list);
  const active=()=>current() && section.isConnected && !life.signal.aborted;
  let loaded=false;
  function paint(rows){
    loaded=true;loadButton.textContent='刷新执行机';
    status.textContent=rows.length?'已登记 '+rows.length+' 台执行机，'+rows.filter(row=>row.online).length+' 台在线。':'尚未连接过执行机。';
    const ids=new Set(rows.map(row=>row.id));
    for(const id of drafts.keys())if(!ids.has(id))drafts.delete(id);
    replace(list,rows.map(row=>{
      const name=h('input',{type:'text',class:'input',value:drafts.get(row.id) ?? (row.name===row.reportedName?'':row.name),
        placeholder:row.reportedName || row.id,'aria-label':'执行机显示名',oninput:event=>drafts.set(row.id,event.target.value)});
      return h('article',{class:'card card__body','aria-label':row.name || row.id},h('h3',{},row.name || row.id),
        h('dl',{class:'kv'},[
          ['执行机 ID',row.id],['上报名',row.reportedName || '未提供'],['在线状态',row.online?'在线':'离线'],
          ['平台',row.platform || '未提供'],['最近连接',row.connectedAt?new Date(row.connectedAt).toLocaleString('zh-CN'):'暂无记录'],
          ['能力',row.capabilities.length?row.capabilities.join('、'):'未上报能力'],
        ].map(([label,value])=>[h('dt',{},label),h('dd',{},value)])),
        h('form',{class:'stack',onsubmit:event=>{event.preventDefault();void save(row.id,name.value.trim());}},
          h('label',{class:'field'},'执行机显示名',name),
          h('div',{class:'row row--wrap'},h('button',{class:'btn btn--sm',type:'submit'},'保存显示名'),
            button('恢复上报名',()=>save(row.id,'')))));
    }));
  }
  async function load(){
    await submit(async()=>{
      if(!active())return;
      status.textContent='正在读取执行机…';
      try{
        const result=await request('machines',undefined,{},life.signal);
        if(active())paint(result.machines);
      }catch(error){
        if(!active())return;
        loaded=false;replace(list);status.textContent='执行机清单未能读取。';loadButton.textContent='刷新执行机';throw error;
      }
    });
  }
  async function save(id,name){
    await submit(async()=>{
      if(!loaded || !active())return;
      try{
        const result=await request('machines/name',{id,name},csrf,life.signal);
        if(!active())return;
        drafts.delete(id);paint(result.machines);status.textContent=name?'已保存执行机显示名。':'已恢复执行机上报名。';
      }catch(error){if(active())throw error;}
    });
  }
  return {el:section,close(){life.abort();drafts.clear();replace(list);}};
}

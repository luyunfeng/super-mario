import {h,replace} from './lib/dom.js';

const button=(text,action)=>h('button',{type:'button',class:'btn btn--sm',onclick:action},text);
// A build as a person reads it. A node outside a build, and one made with uncommitted
// changes, are both said plainly: neither matches a commit exactly.
const buildText=build=>!build?.commit||build.commit==='unknown'?'未构建':build.commit.slice(0,10)+(build.dirty?'（含未提交改动）':'');
function machineCredentials({request,submit,csrf,signal,active}){
  const issued=h('div',{class:'stack'}),rows=h('div',{class:'stack'}),actions=h('div',{class:'stack'});
  const machineId=h('input',{class:'input',type:'text',required:true,autocomplete:'off','aria-label':'签发凭据的执行机 ID'});
  const reload=button('查看专用凭据',()=>submit(async()=>{clearSecret();await read();}));
  let opened=false,issuedId;
  const clearSecret=()=>{
    issuedId=undefined;
    const input=issued.querySelector('input');
    if(input)input.value='';
    replace(issued);
  };
  function confirmRevoke(id){
    clearSecret();
    replace(actions,h('p',{},'确认撤销 '+id+' 的专用凭据？'),
      h('div',{class:'row'},button('取消撤销',()=>replace(actions,form)),button('确认撤销',()=>submit(async()=>{
        await request('machine-credentials/revoke',{id},csrf,signal);
        if(!active())return;
        await read();
      }))));
  }
  async function read(){
    opened=true;replace(actions);replace(rows);
    const result=await request('machine-credentials',undefined,{},signal);
    if(!active())return;
    reload.textContent='刷新专用凭据';
    replace(rows,result.machines.length?result.machines.map(({id})=>h('div',{class:'row'},h('code',{},id),
      button('撤销 '+id,()=>confirmRevoke(id)))):h('p',{class:'small muted'},'还没有专用执行机凭据。'));
    replace(actions,form);
  }
  const form=h('form',{class:'stack',onsubmit:event=>{event.preventDefault();void submit(async()=>{
    const id=machineId.value.trim();
    if(!id)throw Error('请输入执行机 ID。');
    clearSecret();
    const result=await request('machine-credentials/issue',{id},csrf,signal);
    if(!active())return;
    const token=h('input',{class:'input',type:'text',readOnly:true,autocomplete:'off','aria-label':'新签发的执行机凭据'});
    token.value=result.token;issuedId=result.id;
    replace(issued,h('p',{},'请将凭据保存至 '+result.id+' 的执行机配置。此处仅展示一次。'),token,button('清除已显示凭据',clearSecret));
    machineId.value='';
    await read();
  });}},h('label',{class:'field'},'签发凭据的执行机 ID',machineId),h('button',{type:'submit',class:'btn btn--sm'},'签发专用凭据'));
  const el=h('section',{class:'stack','aria-label':'专用执行机凭据'},h('h3',{},'专用执行机凭据'),
    h('p',{class:'small muted'},'可在执行机首次连接前签发针对该 ID 的凭据。撤销专用凭据后，使用主令牌的连接仍然有效。'),reload,issued,rows,actions);
  return {el,clearSecret,async afterRemoval(id){
    if(issuedId===id)clearSecret();
    if(opened)await read();
  }};
}

export function createAdminMachines({request,submit,csrf,current}){
  const life=new AbortController(),drafts=new Map();
  const status=h('p',{class:'small muted'}),list=h('div',{class:'stack'}),loadButton=button('查看执行机',load);
  const section=h('section',{class:'stack','aria-label':'执行机管理'},h('h2',{},'执行机管理'),loadButton,status,list);
  const active=()=>current() && section.isConnected && !life.signal.aborted;
  const credentials=machineCredentials({request,submit,csrf,signal:life.signal,active});
  section.append(credentials.el);
  let loaded=false;
  function paint(result){
    const rows=result.machines,server=result.build;
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
          ['构建',buildText(row.build)+(row.build?.commit&&server?.commit&&row.build.commit!==server.commit
            ?'（与本服务端的构建 '+buildText(server)+' 不同，请把执行机和服务端更新到同一版本）':'')],
        ].map(([label,value])=>[h('dt',{},label),h('dd',{},value)])),
        h('form',{class:'stack',onsubmit:event=>{event.preventDefault();void save(row.id,name.value.trim());}},
          h('label',{class:'field'},'执行机显示名',name),
          h('div',{class:'row row--wrap'},h('button',{class:'btn btn--sm',type:'submit'},'保存显示名'),
            button('恢复上报名',()=>save(row.id,'')))),row.online?null:removal(row));
    }));
  }
  function removal(row){
    const box=h('div',{class:'stack'});
    const open=button('移除执行机',()=>replace(box,
      h('p',{},'移除 '+(row.name || row.id)+'（'+row.id+'）将删除执行机记录和显示名，并撤销其专用凭据。任务历史会保留。使用主令牌的执行机仍可重新登记。'),
      h('div',{class:'row'},button('取消移除',()=>replace(box,open)),button('确认移除',()=>submit(async()=>{
        if(!active())return;
        const result=await request('machines/remove',{id:row.id},csrf,life.signal);
        if(!active())return;
        paint(result);
        status.textContent='已移除执行机 '+(row.name || row.id)+'。';
        await credentials.afterRemoval(row.id);
      })))));
    box.append(open);return box;
  }
  async function load(){
    await submit(async()=>{
      if(!active())return;
      status.textContent='正在读取执行机…';
      try{
        const result=await request('machines',undefined,{},life.signal);
        if(active())paint(result);
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
        drafts.delete(id);paint(result);status.textContent=name?'已保存执行机显示名。':'已恢复执行机上报名。';
      }catch(error){if(active())throw error;}
    });
  }
  return {el:section,close(){life.abort();credentials.clearSecret();drafts.clear();replace(list);}};
}

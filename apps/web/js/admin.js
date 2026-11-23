import {createAdminDevices} from './admin-devices.js';
import {h,replace} from './lib/dom.js';

const view=document.getElementById('admin-view'),errorBox=document.getElementById('admin-error');
const base='/api/v1/admin/';
let devices,state,timer,busy=false,generation=0;
const button=(text,action)=>h('button',{class:'btn',type:'button',onclick:action},text);
const secret=(label,autocomplete)=>h('label',{class:'field'},label,h('input',{class:'input',type:'password',autocomplete,required:true}));
const value=field=>field.querySelector('input').value;
function lock(locked){
  busy=locked;
  for(const control of view.querySelectorAll('button,input'))control.disabled=locked;
}
// Only loopback bootstrap can use a locally saved workspace root credential.
function workspaceRoot(){
  if(!['localhost','[::1]'].includes(location.hostname) && !/^127(?:\.\d{1,3}){3}$/.test(location.hostname))return;
  try{
    const record=JSON.parse(localStorage.getItem('super-mario-token'));
    if(record?.expiresAt>Date.now() && typeof record.value==='string' && record.value && !record.value.startsWith('smbd_'))return record.value;
  }catch{/* Manual code entry works without workspace storage. */}
}
async function request(endpoint,body,headers={},signal){
  const res=await fetch(base+endpoint,{method:body===undefined?'GET':'POST',credentials:'same-origin',signal,referrerPolicy:'no-referrer',
    cache:'no-store',redirect:'error',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const reply=await res.json();
  if(!res.ok)throw Object.assign(Error(reply.error || '管理员请求失败'),{status:res.status});
  return reply;
}
function clear(){
  clearTimeout(timer);devices?.close();devices=undefined;state=undefined;generation++;
  for(const input of view.querySelectorAll('input'))input.value='';
  replace(view);
}
async function refresh(){
  const stamp=++generation;
  try{
    const next=await request('state');
    if(stamp!==generation)return;
    if(next.authenticated){
      if(state?.authenticated && state.csrf===next.csrf && state.expiresAt===next.expiresAt){await devices?.recheck();return;}
      const overview=await request('overview');
      if(stamp!==generation)return;
      clear();state=next;showSession(overview);
      const expiry=new Date(next.expiresAt).getTime();
      if(Number.isFinite(expiry))timer=setTimeout(()=>{clear();void refresh();},Math.max(0,expiry-Date.now()));
    }else{
      if(state && !state.authenticated && state.configured===next.configured)return;
      clear();state=next;showLogin(next.configured);
    }
  }catch(error){
    if(stamp!==generation)return;
    clear();errorBox.textContent=error.message;replace(view,button('重新读取状态',refresh));
  }
}
async function submit(action){
  if(busy)return;
  lock(true);errorBox.textContent='';
  try{await action();}
  catch(error){
    errorBox.textContent=error.message;
    if(error.status===401 || error.status===403)await refresh();
  }finally{lock(false);}
}
function form(title,fields,label,action){
  return h('form',{class:'stack',onsubmit:event=>{event.preventDefault();void submit(action);}},
    h('h2',{},title),fields,h('button',{class:'btn btn--primary',type:'submit'},label));
}
function showLogin(configured){
  const password=secret('管理员密码',configured?'current-password':'new-password');
  if(configured){
    replace(view,form('管理员登录',[password],'登录',async()=>{
      await request('login',{password:value(password)});clear();await refresh();
    }));return;
  }
  const code=secret('首次设置码','off'),confirm=secret('确认管理员密码','new-password');
  const issue=button('在本机获取设置码',()=>submit(async()=>{
    const token=workspaceRoot();
    if(!token)throw Error('请在本机工作台以主访问令牌连接，或手动填写首次设置码。');
    const data=await request('setup-code',{}, {Authorization:'Bearer '+token});
    if(!code.isConnected)return;
    code.querySelector('input').value=data.code;
    message.textContent='已填入本次设置码。';
  }));
  issue.hidden=!workspaceRoot();
  const message=h('p',{class:'small muted',role:'status'},'可手动填写设置码，也可在服务端本机通过工作台主令牌获取。');
  replace(view,form('首次设置管理员密码',[code,issue,message,password,confirm],'设置管理员密码',async()=>{
    if(value(confirm)!==value(password))throw Error('两次输入的密码不一致。');
    await request('setup',{code:value(code),password:value(password)});clear();await refresh();
  }));
}
function uptime(startedAt){
  const minutes=Math.floor((Date.now()-Date.parse(startedAt))/60000);
  if(!Number.isFinite(minutes) || minutes<0)return;
  if(minutes<1)return '不足 1 分钟';
  if(minutes<60)return minutes+' 分钟';
  const hours=Math.floor(minutes/60);
  return hours<24?hours+' 小时 '+minutes%60+' 分钟':Math.floor(hours/24)+' 天 '+hours%24+' 小时';
}
function showSession(overview){
  const old=secret('当前密码','current-password'),next=secret('新密码','new-password'),confirm=secret('确认新密码','new-password');
  const csrf={'x-csrf-token':state.csrf};
  const session=state,info=h('dl',{class:'kv'}),name=h('input',{class:'input',type:'text'}),feedback=h('p',{role:'status'}),
    report=h('div',{class:'stack','aria-label':'诊断结果'});
  const endpoints=h('div',{class:'stack'});
  let dirty=false;
  name.oninput=()=>{dirty=true;feedback.textContent='';};
  function paint(data){
    const display=data.name || data.defaultName;
    if(!dirty)name.value=data.name===data.defaultName?'':(data.name ?? '');
    name.placeholder=data.defaultName || '';
    const details=[
      ['实例名称',display],['服务版本',data.version],['实例 ID',data.instanceId],
      ['运行模式',data.mode==='demo'?'演示':data.mode==='live'?'正式':undefined],
      ['操作系统',[data.platform,data.arch].filter(Boolean).join(' / ')],['监听地址',data.listen],
      ['运行时长',uptime(data.startedAt)],['启动时间',data.startedAt && new Date(data.startedAt).toLocaleString('zh-CN')],
      ['执行机',data.machines && (data.machines.online+' 台在线，共 '+data.machines.total+' 台')],
      ['已配对浏览器',data.devices==null?'不可用':data.devices+' 台'],
      ['会话到期',session.expiresAt && new Date(session.expiresAt).toLocaleString('zh-CN')],
    ];
    replace(endpoints,data.endpoints?.length?[h('h4',{},'服务直连 HTTP 地址'),
      ...data.endpoints.map(endpoint=>h('label',{class:'field'},endpoint.kind==='local'?'本机访问地址':'网络访问地址',
        h('input',{class:'input',readOnly:true,value:endpoint.url,onclick:event=>event.target.select()}))),
      h('small',{class:'muted'},'来自服务监听和本机网络接口，外网连通性未经测试。')]:[]);
    replace(info,details.map(([label,text])=>[h('dt',{},label),h('dd',{},text ?? '未提供')]));
  }
  const saveName=form('修改实例名称',[h('label',{class:'field'},'实例名称',name),
    h('small',{class:'muted'},'留空保存可恢复默认名称。')],'保存名称',async()=>{
    const updated=await request('name',{name:name.value.trim()},csrf);
    if(state!==session)return;
    dirty=false;paint(updated);feedback.textContent='实例名称已更新。';
  });
  const reload=button('刷新概览',()=>submit(async()=>{
    const updated=await request('overview');
    if(state===session){paint(updated);feedback.textContent='概览已刷新。';}
  }));
  const statusLabels={ok:'正常',warning:'警告',error:'错误'};
  const diagnose=button('运行诊断',()=>submit(async()=>{
    replace(report);
    const result=await request('doctor');
    if(state!==session)return;
    replace(report,h('p',{},'检查时间 '+new Date(result.checkedAt).toLocaleString('zh-CN')),
      h('ul',{},result.checks.map(check=>h('li',{},h('strong',{},check.label+' · '+statusLabels[check.status]),
        h('p',{},check.detail)))));
  }));
  devices=createAdminDevices({request,submit,csrf,current:()=>state===session});
  paint(overview);
  replace(view,h('h2',{},'管理员会话'),h('section',{class:'stack','aria-label':'服务概览'},h('h3',{},'服务概览'),info,endpoints,reload),
    saveName,feedback,h('section',{class:'stack','aria-label':'运行诊断'},h('h3',{},'运行诊断'),diagnose,report),
    devices.el,form('修改密码',[old,next,confirm],'保存新密码',async()=>{
      if(value(confirm)!==value(next))throw Error('两次输入的新密码不一致。');
      await request('password',{currentPassword:value(old),newPassword:value(next)},csrf);
      clear();await refresh();
    }),button('退出管理员',()=>submit(async()=>{await request('logout',{},csrf);clear();await refresh();})));
}
window.addEventListener('pagehide',clear);
window.addEventListener('pageshow',event=>{if(event.persisted)void refresh();});
window.addEventListener('focus',()=>{if(!busy && state)void refresh();});
void refresh();

import {h,replace} from './lib/dom.js';

const view=document.getElementById('admin-view'),errorBox=document.getElementById('admin-error');
const base='/api/v1/admin/';
let state,timer,busy=false,generation=0;
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
async function request(endpoint,body,headers={}){
  const res=await fetch(base+endpoint,{method:body===undefined?'GET':'POST',credentials:'same-origin',referrerPolicy:'no-referrer',
    cache:'no-store',redirect:'error',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const reply=await res.json();
  if(!res.ok)throw Object.assign(Error(reply.error || '管理员请求失败'),{status:res.status});
  return reply;
}
function clear(){
  clearTimeout(timer);state=undefined;generation++;
  for(const input of view.querySelectorAll('input'))input.value='';
  replace(view);
}
async function refresh(){
  const stamp=++generation;
  try{
    const next=await request('state');
    if(stamp!==generation)return;
    if(next.authenticated){
      const overview=await request('overview');
      if(stamp!==generation)return;
      if(state?.authenticated && state.csrf===next.csrf && state.expiresAt===next.expiresAt)return;
      clear();state=next;showSession(overview);
      if(next.expiresAt)timer=setTimeout(()=>{clear();void refresh();},Math.max(0,next.expiresAt-Date.now()));
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
function showSession(overview){
  const old=secret('当前密码','current-password'),next=secret('新密码','new-password'),confirm=secret('确认新密码','new-password');
  const csrf={'x-csrf-token':state.csrf};
  replace(view,h('h2',{},'管理员会话'),h('dl',{class:'kv'},h('dt',{},'服务版本'),h('dd',{},overview.version),
    h('dt',{},'会话到期'),h('dd',{},state.expiresAt?new Date(state.expiresAt).toLocaleString('zh-CN'):'未提供')),
    form('修改密码',[old,next,confirm],'保存新密码',async()=>{
      if(value(confirm)!==value(next))throw Error('两次输入的新密码不一致。');
      await request('password',{currentPassword:value(old),newPassword:value(next)},csrf);
      clear();await refresh();
    }),button('退出管理员',()=>submit(async()=>{await request('logout',{},csrf);clear();await refresh();})));
}
window.addEventListener('pagehide',clear);
window.addEventListener('pageshow',event=>{if(event.persisted)void refresh();});
window.addEventListener('focus',()=>{if(!busy && state)void refresh();});
void refresh();

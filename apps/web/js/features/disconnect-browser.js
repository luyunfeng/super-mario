import {h,replace} from '../lib/dom.js';
import {Button} from '../ui/kit.js';
import {closeOverlays,openDrawer,toast} from '../ui/overlay.js';

const replacementKey='sm.browser-devices.replaces';
const deviceKey=api=>'sm.browser-devices.current.'+api.draftOwner();
const deviceToken=api=>/^smbd_[A-Za-z0-9_-]{43}$/.test(api.token());
export function rememberDevice(api,id,proof){
  if(!deviceToken(api) || typeof id!=='string' || !id)return;
  try{
    const key=deviceKey(api),previous=JSON.parse(localStorage.getItem(key));
    const valid=/^[a-f0-9]{64}$/.test(proof)?proof:previous?.id===id?previous.proof:undefined;
    localStorage.setItem(key,JSON.stringify({id,proof:valid}));
  }catch{/* In-memory login still works. */}
}
export function pendingReplacement(){
  try{
    const item=JSON.parse(localStorage.getItem(replacementKey));
    if(item && typeof item.id==='string' && /^[a-f0-9]{64}$/.test(item.proof))return {id:item.id,proof:item.proof};
  }catch{/* No previous device proof. */}
}
export function clearReplacement(replaces){
  if(!replaces)return;
  try{if(pendingReplacement()?.proof===replaces.proof)localStorage.removeItem(replacementKey);}catch{}
}
async function replacement(api,id){
  if(!id || !deviceToken(api))return;
  const encode=new TextEncoder();
  async function digest(text){
    const bytes=encode.encode(text);
    const hash=typeof globalThis.sha256==='function'?globalThis.sha256(bytes):new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    return Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');
  }
  try{return {id,proof:await digest('super-mario.browser-replace.v1:'+await digest(api.token()))};}
  catch{/* The local sign-out still works if hashing is unavailable. */}
}

let openFlow;
export function disconnectBrowser(api,store){
  if(openFlow || !api.token())return;
  const currentLogin=api.loginGuard(),life=new AbortController();
  if(!currentLogin()){toast('浏览器已保存另一登录身份，请刷新后核对。');return;}
  const body=h('div',{class:'stack'}),buttons=h('div',{class:'row row--wrap'});
  const drawer=openDrawer({title:'断开此浏览器',body,footer:buttons,onClose:()=>{
    life.abort();off();openFlow=undefined;
  }});
  openFlow=drawer;
  window.addEventListener('storage',()=>{if(!currentLogin())drawer.close();},{signal:life.signal});
  const current=()=>drawer.el.open && currentLogin();
  const off=store.subscribe(()=>{if(!currentLogin())drawer.close();});
  let id,issuedProof,busy=false;
  const closeButton=drawer.el.querySelector('.drawer__head button');
  drawer.el.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  drawer.el.addEventListener('click',event=>{if(busy && event.target===drawer.el)event.stopImmediatePropagation();},true);
  try{const record=JSON.parse(localStorage.getItem(deviceKey(api)));id=record?.id;issuedProof=record?.proof;}catch{}
  // A pasted device token has no local id yet. A failed lookup must not prevent local sign-out.
  const lookup=!id && deviceToken(api)?api('/browser/devices',{signal:AbortSignal.any([life.signal,AbortSignal.timeout(2500)])})
    .then(result=>{if(current() && result.currentDeviceId){id=result.currentDeviceId;issuedProof=result.replacementProof;rememberDevice(api,id,issuedProof);}}).catch(()=>{}):undefined;
  async function signOut(localOnly=false){
    if(!current())return;
    if(localOnly && deviceToken(api)){
      await lookup;
      if(!current())return;
      const proof=id && /^[a-f0-9]{64}$/.test(issuedProof)?{id,proof:issuedProof}:await replacement(api,id);
      if(!current())return;
      if(proof)try{localStorage.setItem(replacementKey,JSON.stringify(proof));}catch{}
    }
    try{localStorage.removeItem(deviceKey(api));}catch{}
    if(!current())return;
    closeOverlays();api.setToken('');store.reset();
    // Drop rendered private data, URL parameters, pending callbacks and socket state together.
    history.replaceState(null,'',location.pathname);location.reload();
  }
  const cancel=()=>Button({label:'取消',onClick:()=>drawer.close()});
  async function revoke(){
    if(!current() || busy)return;
    busy=true;closeButton.disabled=true;
    replace(body,h('p',{role:'status'},'正在撤销本设备凭据…'));replace(buttons);
    try{
      const result=await api('/browser/devices/current',{method:'DELETE',
        signal:AbortSignal.any([life.signal,AbortSignal.timeout(15000)])});
      if(!current())return;
      if(result?.revoked!==true)throw Error('未收到撤销回执。');
      signOut();
    }catch(error){
      if(!current() || life.signal.aborted)return;
      busy=false;closeButton.disabled=false;
      const master=error.status===409 && !deviceToken(api);
      replace(body,h('p',{role:'status'},master?'服务器未确认撤销。主访问令牌不能由浏览器撤销。':'服务器未确认本设备凭据已撤销。'),
        h('p',{class:'small'},'仅退出本机将清除此浏览器保存的登录。服务器上的凭据仍可能有效。'),
        !master && h('p',{class:'small muted'},error.message));
      replace(buttons,cancel(),!master && Button({label:'重试撤销',onClick:revoke}),Button({label:'仅退出本机',kind:'danger',onClick:()=>signOut(true)}));
    }
  }
  replace(body,h('p',{},'将撤销此浏览器的设备凭据并退出工作台。再次连接需要新的配对链接或访问令牌。'));
  replace(buttons,cancel(),Button({label:'确认断开',kind:'danger',onClick:revoke}));
}

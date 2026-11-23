import {h,replace} from '../lib/dom.js';
import {openDrawer} from '../ui/overlay.js';
import {rememberDevice} from './disconnect-browser.js';
import {passwordExchange,validBrowserPassword} from './browser-password-protocol.js';

async function publicRequest(path,body,signal){
  const res=await fetch('/api/v1/public/password/'+path,{method:body?'POST':'GET',credentials:'omit',cache:'no-store',
    referrerPolicy:'no-referrer',redirect:'error',signal,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const data=await res.json();
  if(!res.ok)throw Error(data.error || '浏览器密码登录失败。');
  return data;
}

export function openPasswordLogin(api,store){
  const owner=api.draftOwner(),life=new AbortController(),status=h('p',{role:'status'}),box=h('div',{class:'stack'});
  const name=h('input',{class:'input',required:true,placeholder:'例如：家中电脑'}),password=h('input',{class:'input',type:'password',autocomplete:'current-password',required:true});
  let busy=false;
  const drawer=openDrawer({title:'浏览器密码登录',body:[status,box],onClose:()=>{life.abort();password.value='';off();}});
  const current=()=>drawer.el.open && owner===api.draftOwner() && !life.signal.aborted;
  const off=store.subscribe(()=>{if(owner!==api.draftOwner())drawer.close();});
  window.addEventListener('pagehide',()=>drawer.close(),{once:true,signal:life.signal});
  window.addEventListener('storage',event=>{if(event.key==='super-mario-token')drawer.close();},{signal:life.signal});
  async function load(){
    status.textContent='正在核对登录方式…';replace(box);
    try{
      const state=await publicRequest('state',undefined,life.signal);
      if(!current())return;
      if(!state.enabled){status.textContent='浏览器密码登录未启用。';return;}
      status.textContent=api.token()?'登录后将更换本机保存的工作台凭据。':'';
      const send=h('button',{class:'btn btn--primary',type:'submit'},'登录工作台');
      replace(box,h('form',{class:'stack',onsubmit:async event=>{
        event.preventDefault();
        if(busy || !current())return;
        if(!name.value.trim() || !validBrowserPassword(password.value)){status.textContent='请填写设备名称及 8 个字符以上、最多 256 字节的浏览器登录密码。';return;}
        busy=true;const deviceName=name.value.trim();
        send.disabled=true;name.disabled=true;password.disabled=true;status.textContent='正在验证浏览器密码…';
        try{
          const signal=AbortSignal.any([life.signal,AbortSignal.timeout(60000)]);
          const exchange=passwordExchange({mode:'login',password:password.value,signal,current,
            start:message=>publicRequest('start',{name:deviceName,message},signal),
            finish:(session,message)=>publicRequest('finish',{session,message},signal)});
          password.value='';
          const result=await exchange;
          if(!current())return;
          if(!result.token || !result.device?.id)throw Error('未收到设备登录回执。');
          api.setToken(result.token);rememberDevice(api,result.device.id,result.replacementProof);drawer.close();store.reset();
        }catch(error){if(current())status.textContent=error.message;}
        finally{password.value='';busy=false;send.disabled=false;name.disabled=false;password.disabled=false;}
      }},h('label',{class:'field'},'设备名称',name),h('label',{class:'field'},'浏览器登录密码',password),send));
    }catch(error){if(current()){status.textContent=error.message;replace(box,h('button',{type:'button',class:'btn',onclick:load},'重新读取'));}}
  }
  void load();
}

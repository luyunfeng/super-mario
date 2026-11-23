import {h,replace} from '../lib/dom.js';
import {confirmDialog} from '../ui/overlay.js';
import {passwordExchange,validBrowserPassword} from './browser-password-protocol.js';

const button=(label,onclick)=>h('button',{class:'btn',type:'button',onclick},label);
export function adminBrowserPassword({request,submit,csrf,current}){
  const life=new AbortController(),status=h('p',{class:'small muted'}),body=h('div',{class:'stack'});
  const section=h('section',{'aria-label':'浏览器密码登录',class:'stack'},h('h2',{},'浏览器密码登录'),status,body);
  const passwd=h('input',{type:'password',required:true,class:'input',autocomplete:'new-password'});
  const confirm=h('input',{type:'password',required:true,class:'input',autocomplete:'new-password'});
  const revoke=h('input',{type:'checkbox'});
  const clear=()=>{passwd.value='';confirm.value='';};
  const active=()=>section.isConnected && current() && !life.signal.aborted;
  const read=()=>request('password-login',undefined,{},life.signal);
  const write=(path,data,signal=life.signal)=>request('password-login/'+path,data,csrf,signal);
  let revision;
  function draw(result){
    if(!active())return;
    revision=result.revision;clear();revoke.checked=false;
    status.textContent=result.enabled?'密码登录已启用。':result.configured?'密码登录已停用，已保留原密码。':'尚未设置浏览器登录密码。';
    const set=h('form',{class:'stack',onsubmit:event=>{
      event.preventDefault();
      if(!validBrowserPassword(passwd.value)){status.textContent='密码至少需要 8 个字符，最多 256 字节。';return;}
      if(passwd.value!==confirm.value){status.textContent='两次输入的浏览器密码不一致。';return;}
      const expected=revision,remove=revoke.checked;
      void mutate(async()=>{
        status.textContent='正在设置浏览器登录密码…';
        const signal=AbortSignal.any([life.signal,AbortSignal.timeout(60000)]);
        const exchange=passwordExchange({mode:'register',password:passwd.value,current:active,signal,
          start:message=>write('register/start',{revision:expected,message},signal),
          finish:(session,message)=>write('register/finish',{session,message,revokeDevices:remove},signal)});
        clear();await exchange;
      });
    }},h('label',{class:'field'},'浏览器登录密码',passwd),h('label',{class:'field'},'确认浏览器登录密码',confirm),
      h('label',{class:'check'},revoke,'同时撤销通过密码登录的设备'),
      h('button',{class:'btn btn--primary',type:'submit'},'保存浏览器登录密码'));
    replace(body,set,result.enabled?button('停用浏览器密码登录',()=>mutate(async()=>{
      const expected=revision,remove=revoke.checked;
      if(!await confirmDialog({title:'停用浏览器密码登录',confirmLabel:'确认停用',danger:true,signal:life.signal,
        message:remove?'停用密码登录，并撤销已通过密码登录的设备。':'停用后无法使用密码登录，已登录设备仍可使用。'}))return false;
      if(active())await write('disable',{revision:expected,revokeDevices:remove});
    })):result.configured && button('重新启用浏览器密码登录',()=>mutate(()=>write('enable',{revision,revokeDevices:revoke.checked}))));
  }
  function mutate(operation){
    return submit(async()=>{
      if(!active())return;
      try{
        if(await operation()===false || !active())return;
        draw(await read());
      }catch(error){
        if(!active())return;
        clear();status.textContent=error.message;
        if([401,403,409,503].includes(error.status)){replace(body,button('重新读取密码登录设置',load));throw error;}
      }
    });
  }
  function load(){return mutate(async()=>{status.textContent='正在读取设置…';});}
  replace(body,button('管理浏览器登录密码',load));
  return {el:section,close(){life.abort();clear();replace(body);}};
}

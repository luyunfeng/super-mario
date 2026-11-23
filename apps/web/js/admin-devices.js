import {h,replace} from './lib/dom.js';
import {browserPairLink} from './ui/browser-pair-link.js';
import {confirmDialog} from './ui/overlay.js';

const button=(label,action)=>h('button',{type:'button',class:'btn btn--sm',onclick:action},label);
const time=value=>new Date(value).toLocaleString('zh-CN');

// Keep the list and the one-time link within the authenticated page that requested them.
export function createAdminDevices({request,submit,csrf,current}){
  const life=new AbortController(),name=h('input',{class:'input',required:true,autocomplete:'off'});
  const controls=h('div',{class:'stack'}),list=h('div',{class:'stack'}),invite=h('div',{class:'stack'});
  const status=h('p',{class:'small muted'}),panel=h('section',{class:'stack','aria-label':'浏览器设备'},
    h('h2',{},'浏览器设备'),controls,status,invite,list);
  let verified=false,expiry,confirming;
  const active=()=>!life.signal.aborted && current() && panel.isConnected;
  function forgetLink(){clearTimeout(expiry);replace(invite);}
  function invalidate(){verified=false;confirming?.abort();forgetLink();replace(controls,button('刷新设备',load));replace(list);}
  async function perform(action){
    await submit(async()=>{
      if(!active())return;
      try{await action();}
      catch(error){if(active()){invalidate();status.textContent='';throw error;}}
    });
  }
  function load(){
    return perform(async()=>{
      verified=false;replace(list);status.textContent='正在读取设备列表…';
      const result=await request('devices',undefined,{},life.signal);
      if(!active())return;
      verified=true;status.textContent=result.devices.length?'已配对 '+result.devices.length+' 台浏览器。':'暂无已配对设备。';
      replace(controls,button('刷新设备',load),h('form',{class:'stack',onsubmit:event=>{
        event.preventDefault();void issue();
      }},h('label',{class:'field'},'设备名称',name),
        h('button',{type:'submit',class:'btn btn--primary'},'生成配对链接')));
      replace(list,result.devices.map(device=>h('article',{class:'card card__body','aria-label':device.name},
        h('strong',{},device.name),h('small',{},'创建于 '+time(device.createdAt)),
        h('small',{},device.lastSeenAt?'最近活跃 '+time(device.lastSeenAt):'暂无活跃记录'),
        button('撤销设备',()=>revoke(device)))));
    });
  }
  function issue(){
    if(!verified || !name.reportValidity())return;
    const deviceName=name.value.trim();
    if(!deviceName){status.textContent='请输入设备名称。';name.focus();return;}
    return perform(async()=>{
      forgetLink();
      const data=await request('devices/pairings',{name:deviceName},csrf,life.signal);
      if(!active())return;
      const remaining=new Date(data.expiresAt).getTime()-Date.now();
      if(!(remaining>0)){status.textContent='配对链接已过期。';return;}
      replace(invite,browserPairLink(data,deviceName,()=>{if(active())status.textContent='已复制配对链接。';}));
      expiry=setTimeout(()=>{forgetLink();if(active())status.textContent='配对链接已过期。';},remaining);
    });
  }
  async function revoke(device){
    if(!active() || !verified)return;
    if(confirming)return;
    confirming=new AbortController();
    const ok=await confirmDialog({title:'撤销浏览器设备',message:'撤销后，「'+device.name+'」将失去工作台访问权限。',
      confirmLabel:'确认撤销',danger:true,signal:AbortSignal.any([life.signal,confirming.signal])});
    confirming=undefined;
    if(!ok || !active() || !verified)return;
    let revoked=false;
    await perform(async()=>{
      const result=await request('devices/revoke',{id:device.id},csrf,life.signal);
      if(!active())return;
      if(result.revoked!==true)throw Error('未收到设备撤销回执，请刷新列表核对。');
      invalidate();revoked=true;
    });
    if(revoked && active())await load();
  }
  replace(controls,button('读取设备列表',load));
  return {el:panel,recheck(){if(verified && !confirming)return load();},close(){life.abort();invalidate();name.value='';}};
}

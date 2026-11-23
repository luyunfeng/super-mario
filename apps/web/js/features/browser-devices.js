import {h,replace} from '../lib/dom.js';
import {copyText} from '../lib/clipboard.js';
import {Button} from '../ui/kit.js';
import {confirmDialog,openDrawer} from '../ui/overlay.js';

const path='/browser/devices';
const fmt=value=>new Date(value).toLocaleString('zh-CN');

export function openBrowserDevices({api,store}){
  const owner=api.draftOwner(),life=new AbortController();
  const actions=h('div',{class:'stack'}),list=h('div',{class:'stack'}),status=h('p',{role:'status'}),pair=h('div',{class:'stack'});
  const name=h('input',{class:'input',maxLength:80,placeholder:'例如：家中电脑',autocomplete:'off','aria-label':'设备名称'});
  let expiry,request=0,view;
  const drawer=openDrawer({title:'浏览器设备',body:[status,actions,pair,list],onClose:()=>{
    life.abort();off();clearTimeout(expiry);replace(pair);
  }});
  const active=()=>drawer.el.open && owner===api.draftOwner() && !store.view.unauthorized &&
    store.view.snapshot?.plugins.some(plugin=>plugin.id==='browser-devices' && plugin.status==='active');
  const off=store.subscribe(()=>{if(!active())drawer.close();});
  async function issue(){
    if(!view?.canManage || !active())return;
    if(!name.value.trim()){status.textContent='请输入设备名称。';name.focus();return;}
    const deviceName=name.value.trim();
    try{
      const data=await api.post(path+'/pairings',{name:deviceName});
      if(!active())return;
      // Never copy the workspace's current query, fragment, or owner credential into an invite.
      const url=new URL('/',location.origin);url.hash='home?'+new URLSearchParams({browserPair:data.code});
      const output=h('input',{class:'input',readOnly:true,value:url.href,'aria-label':'一次性配对链接'});
      replace(pair,h('strong',{},deviceName+' 的一次性配对链接'),h('p',{},'请在要连接的浏览器中打开，仅可使用一次。'),
        data.qrOrigin===location.origin && data.qrDataUrl?.startsWith('data:image/png;base64,') &&
          h('img',{src:data.qrDataUrl,width:240,height:240,alt:'浏览器配对二维码'}),
        output,h('small',{},'有效至 '+fmt(data.expiresAt)),Button({label:'复制配对链接',onClick:async()=>{
          await copyText(output.value);if(active())status.textContent='已复制配对链接。';
        }}));
      clearTimeout(expiry);expiry=setTimeout(()=>{replace(pair);if(active())status.textContent='配对链接已过期。';},Math.max(0,Date.parse(data.expiresAt)-Date.now()));
      status.textContent='';
    }catch(error){if(active())status.textContent=error.message;}
  }
  async function load(){
    const seq=++request;
    try{
      const result=await api(path,{signal:life.signal});
      if(!active() || seq!==request)return;
      view=result;
      status.textContent=view.canManage?'使用主访问令牌管理设备。':view.currentDeviceId?'此浏览器已通过设备配对连接。':'请使用主访问令牌管理设备。';
      replace(actions,view.canManage && [h('label',{class:'field'},'设备名称',name),Button({label:'生成配对链接',onClick:issue})],
        Button({label:'刷新设备',onClick:load}));
      replace(list,view.devices.length?view.devices.map(device=>h('article',{class:'card card__body stack','aria-label':device.name},
        h('strong',{},device.name),device.id===view.currentDeviceId && h('span',{},'当前设备'),
        h('small',{},'创建于 '+fmt(device.createdAt)),h('small',{},device.lastSeenAt?'最近活跃 '+fmt(device.lastSeenAt):'暂无活跃记录'),
        view.canManage && Button({label:'撤销设备',onClick:async()=>{
          if(!await confirmDialog({title:'撤销浏览器设备',message:'撤销后，「'+device.name+'」将失去工作台访问权限。',confirmLabel:'确认撤销',danger:true,signal:life.signal}))return;
          if(!active())return;
          try{await api.del(path+'/'+encodeURIComponent(device.id));if(active())await load();}
          catch(error){if(active())status.textContent=error.message;}
        }}))):h('p',{},'暂无已配对设备。'));
    }catch(error){if(active()){view=undefined;replace(list);replace(actions,Button({label:'重新读取设备',onClick:load}));replace(pair);status.textContent=error.message;}}
  }
  void load();return drawer;
}

// Read only the fragment. Clear the code before initializing the authenticated workspace or offering consent.
export function takeBrowserPair(){
  const url=new URL(location.href),fragment=url.hash.slice(1);
  const index=fragment.indexOf('?');
  if(index<0)return;
  const code=new URLSearchParams(fragment.slice(index+1)).get('browserPair');
  if(code===null)return;
  url.hash='home';history.replaceState(history.state,'',url.pathname+'#home');
  return code;
}

export function acceptBrowserPair(code,api,store){
  const owner=api.draftOwner(),life=new AbortController(),status=h('p',{role:'status'});
  const button=Button({label:'确认连接这台浏览器',kind:'primary',onClick:async()=>{
    if(owner!==api.draftOwner() || !drawer.el.open)return;
    button.disabled=true;status.textContent='正在兑换一次性配对链接…';
    try{
      const response=await fetch('/api/v1/public/browser-pair',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({code}),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:life.signal});
      const result=await response.json();
      if(!response.ok || typeof result.token!=='string' || !result.token)throw Error(result.error || '未取得有效的设备凭据。');
      if(owner!==api.draftOwner() || !drawer.el.open)return;
      api.setToken(result.token);drawer.close();store.reset();
    }catch(error){if(!life.signal.aborted)status.textContent=error.message+' 请向主人获取新的配对链接。';}
  }});
  const drawer=openDrawer({title:'配对这台浏览器',body:[
    h('p',{},'确认后，此浏览器将作为已配对设备访问 '+location.host+' 上的工作台。'),
    api.token() && h('p',{},'此操作将替换当前浏览器保存的工作台登录凭据。'),status],
    footer:[Button({label:'取消',onClick:()=>drawer.close()}),button],onClose:()=>{life.abort();code='';}});
}

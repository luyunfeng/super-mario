import { h, replace } from '../lib/dom.js';
import { Button, Check, Field, Input } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

export function openSubscriptionSettings({row,api,path,remove,active,changed}) {
  let version = row.version;
  let busy = false, confirmed = true;
  const name = Input({required:true,value:row.name});
  const interval = Input({type:'number',min:1,max:10080,step:1,required:true,value:row.intervalMinutes});
  const checks = [['inbox','收件箱'],['knowledge','个人记忆']].map(([id,label]) =>
    Check({label,name:id,checked:row.destinations.includes(id)}));
  const notice = h('p',{role:'status',class:'small'});
  const reconcile = h('div',{class:'stack'});
  const action = Button({label:remove ? '确认删除订阅' : '保存订阅',kind:remove ? 'danger' : 'primary',type:'submit'});
  const controls = h('fieldset',{class:'stack'},remove ?
    h('p',null,'删除「'+row.name+'」将停止后续拉取，并清除这条订阅尚未投递的内容。已经投递的收件箱记录和个人记忆会保留。') :
    [Field({label:'订阅名称',control:name}),Field({label:'拉取间隔（分钟）',control:interval}),
      h('fieldset', {class:'row row--wrap'},h('legend',null,'投递位置'),checks)]);
  const form = h('form',{class:'stack',onsubmit:event => {event.preventDefault();void save();}},controls,
    notice,reconcile,h('div',{class:'row'},Button({label:'取消',onClick:() => drawer.close()}),action));
  const drawer = openDrawer({title:remove ? '删除订阅' : '编辑订阅',body:form});
  const valid = () => active() && drawer.el.open;
  async function verify() {
    confirmed=false; action.disabled=true; replace(reconcile);
    try {
      const state = await api.get(path);
      if (!valid()) return;
      const latest = state.subscriptions.find(item => item.id === row.id);
      if (!latest) {notice.textContent='当前订阅已不存在。';return;}
      replace(reconcile,h('p',null,'当前设置 · '+latest.name+' · 每 '+latest.intervalMinutes+' 分钟 · '+
        latest.destinations.map(id=>id==='inbox'?'收件箱':'个人记忆').join('、')+' · '+(latest.enabled?'已启用':'已暂停')),
        Button({label:'已核对当前版本',onClick:() => {
          confirmed=true;version=latest.version;action.disabled=false;replace(reconcile);
          notice.textContent = remove ? '请再次确认是否删除。' : '草稿已保留，可以重新保存。';
        }}));
    } catch(error) {
      if(valid()) replace(reconcile,h('span',null,error.message),Button({label:'重新核对',onClick:verify}));
    }
  }
  async function save() {
    if(busy || !confirmed || !valid()) return;
    const destinations=checks.map(label=>label.querySelector('input')).filter(input=>input.checked).map(input=>input.name);
    if(!remove && !destinations.length) {notice.textContent='请选择投递位置。';return;}
    busy=true;controls.disabled=true;action.disabled=true;notice.textContent='';
    const url=path+'/'+encodeURIComponent(row.id);
    try {
      if(remove) {
        const result=await api.del(url,{version});
        if(result?.deleted!==true) throw new Error('删除回执未确认。');
      } else {
        await api.patch(url,{version,name:name.value.trim(),intervalMinutes:Number(interval.value),destinations});
      }
      if(valid()) {drawer.close();changed(remove?'已删除订阅。':'已保存订阅。');}
    } catch(error) {
      if(!valid()) return;
      notice.textContent=error.message;
      if(error.status===409 || error.status===404 || !error.status) await verify();
    } finally {
      busy=false;controls.disabled=false;action.disabled=!confirmed;
    }
  }
  return drawer;
}

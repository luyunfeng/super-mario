import {h,replace} from '../lib/dom.js';
import {Button} from '../ui/kit.js';
import {confirmDialog,openDrawer} from '../ui/overlay.js';

const base='/usage/sources';
const kinds={relay:'账户池管理接口',relay_key:'个人密钥用量接口',generic:'通用 JSON 接口'};
const field=(label,input)=>h('label',{class:'field'},label,input);
const time=value=>new Date(value).toLocaleString('zh-CN');

function seenText(result){
  if(result.quotaHidden)return '提供商未共享该密钥的账户配额。';
  const prefix=result.partial?'仅读取部分账户，':'';
  if(!result.windows && result.listed)return prefix+'已列出 '+result.listed+' 个账户，尚无可显示的用量窗口。';
  return prefix+result.accounts+' 个账户，'+result.windows+' 个用量窗口。';
}

function editSource(api,saved,onSave){
  const type=h('select',{},Object.entries(kinds).map(([value,label])=>h('option',{value},label)));
  type.value=saved?.type ?? 'relay';
  const name=h('input',{value:saved?.name || '',maxLength:40});
  const url=h('input',{type:'url',value:saved?.url || '',placeholder:'https://'});
  const key=h('input',{type:'password',maxLength:512,autocomplete:'new-password',placeholder:saved?.hasKey?'已保存，留空沿用':'输入访问密钥'});
  const clear=h('input',{type:'checkbox'}),clearBox=h('label',{class:'check'},clear,'清除已存密钥');
  const hint=h('p',{class:'small muted'}),notice=h('p',{role:'status'});
  const test=Button({label:'试读来源',onClick:()=>perform(true)});
  const save=Button({label:'保存来源',kind:'primary',onClick:()=>perform(false)});
  const inputs=[name,url,key,type,clear],life=new AbortController();
  let busy=false;
  const editor=openDrawer({title:saved?'编辑用量来源':'新增用量来源',body:[field('来源类型',type),field('来源名称',name),
    field('接口地址',url),field('访问密钥',key),clearBox,hint,notice],footer:[test,save],onClose:()=>{life.abort();key.value='';}});
  function changed(){
    let address;
    try{address=new URL(url.value.trim());}catch{/* Incomplete address while typing. */}
    const valid=address && ['http:','https:'].includes(address.protocol) && !address.username && !address.password && !address.search && !address.hash;
    const moved=saved && (type.value!==saved.type || address?.href.replace(/\/+$/,'')!==saved.url.replace(/\/+$/,''));
    const required=type.value!=='generic';
    clearBox.hidden=!saved?.hasKey || required;
    if(required)clear.checked=false;
    hint.textContent=moved && saved.hasKey?'接口位置或类型已变更，请重新输入密钥。通用接口也可选择清除已存密钥。':
      required?'此接口需要访问密钥。':'公开 JSON 接口可以留空密钥。';
    const credentials=key.value.trim() || (!moved && saved?.hasKey && !clear.checked) || (!required && (!saved?.hasKey || !moved || clear.checked));
    test.disabled=busy || !valid || !credentials;
    save.disabled=test.disabled || (type.value==='generic' && !name.value.trim());
    key.disabled=busy || clear.checked;
  }
  for(const input of inputs)input.oninput=()=>{notice.textContent='';changed();};
  async function perform(probe){
    if(busy)return;
    busy=true;inputs.forEach(input=>input.disabled=true);changed();notice.textContent=probe?'正在试读…':'正在保存…';
    const body={type:type.value,url:url.value.trim(),...(key.value.trim() && !clear.checked?{key:key.value.trim()}:{}),...(clear.checked?{clearKey:true}:{})};
    try{
      if(probe){
        const result=await api(base+'/test',{method:'POST',body:{...body,...(saved?{id:saved.id}:{})},signal:life.signal});
        if(editor.el.open)notice.textContent='试读成功，'+seenText(result);
      }else{
        const payload={...body,...(name.value.trim()?{name:name.value.trim()}:{})};
        if(saved)await api.put(base+'/'+encodeURIComponent(saved.id),{...payload,revision:saved.revision});
        else await api.post(base,payload);
        if(editor.el.open){editor.close();onSave();}
      }
    }catch(error){if(editor.el.open)notice.textContent=error.message;}
    finally{busy=false;inputs.forEach(input=>input.disabled=false);changed();}
  }
  changed();
  return editor;
}

export function openUsageSources({api,store}){
  const body=h('div',{class:'usage-board'}),content=h('div'),notice=h('p',{role:'status'});
  body.append(notice,content);
  const owner=api.draftOwner(),life=new AbortController();
  let editor,settings,accounts=[],stamp=0,busy=false,draftSettings,change=store.view.usageSourcesChange;
  const drawer=openDrawer({title:'用量来源',body,wide:true,onClose:()=>{life.abort();off();editor?.close();}});
  drawer.el.classList.add('usage-drawer');
  const active=()=>drawer.el.open && api.draftOwner()===owner && !store.view.unauthorized &&
    store.view.snapshot?.plugins.some(p=>p.id==='usage-sources' && p.status==='active');
  const off=store.subscribe(view=>{
    if(!active()){drawer.close();return;}
    if(view.usageSourcesChange!==change){
      change=view.usageSourcesChange;
      if(!busy)void load();
    }
  });
  async function load(){
    const seq=++stamp;
    try{
      const [view,report]=await Promise.all([api.get(base),api.get('/usage/windows')]);
      if(!active() || seq!==stamp)return;
      settings=view;accounts=report.accounts;paint();
    }catch(error){if(active() && stamp===seq){notice.textContent=error.message;replace(content,Button({label:'重新读取',onClick:load}));}}
  }
  async function write(operation){
    if(busy || !active())return;
    busy=true;paint();notice.textContent='';
    try{await operation();}catch(error){if(active())notice.textContent=error.message;}
    finally{busy=false;if(active())await load();}
  }
  function paint(){
    const controls=h('div',{class:'usage-controls'});
    const form=draftSettings ?? settings;
    const master=h('input',{type:'checkbox',checked:form.enabled,disabled:busy});
    const interval=h('input',{type:'number',min:1,max:1440,step:1,value:form.pollMinutes,disabled:busy});
    const hidden=h('input',{value:draftSettings?.hiddenText ?? settings.hiddenProviders.join(', '),placeholder:'多个提供商用逗号分隔',disabled:busy});
    const revision=form.revision;
    for(const field of [master,interval,hidden])field.oninput=()=>{
      draftSettings={revision,enabled:master.checked,pollMinutes:interval.value,hiddenText:hidden.value};
    };
    const providerFields=h('div',{class:'row row--wrap'});
    for(const provider of new Set([...(settings.providers ?? []),...settings.hiddenProviders])){
      const check=h('input',{type:'checkbox',checked:!hidden.value.split(/[,，]/).some(key=>key.trim()===provider),disabled:busy,'aria-label':'显示 '+provider});
      check.onchange=()=>{
        const keys=new Set(hidden.value.split(/[,，]/).map(key=>key.trim()).filter(Boolean));
        if(check.checked)keys.delete(provider);else keys.add(provider);
        hidden.value=[...keys].join(', ');hidden.dispatchEvent(new Event('input'));
      };
      providerFields.append(h('label',{class:'check'},check,provider));
    }
    hidden.addEventListener('input',()=>{
      const excluded=new Set(hidden.value.split(/[,，]/).map(key=>key.trim()));
      for(const box of providerFields.querySelectorAll('input'))box.checked=!excluded.has(box.parentElement.textContent);
    });
    const saveSettings=Button({label:'保存轮询设置',disabled:busy,onClick:()=>{
      if(!interval.reportValidity() || !interval.value)return;
      return write(async()=>{await api.put(base+'/settings',{revision,enabled:master.checked,pollMinutes:Number(interval.value),
        hiddenProviders:[...new Set(hidden.value.split(/[,，]/).map(item=>item.trim()).filter(Boolean))]});draftSettings=undefined;});
    }});
    controls.append(Button({label:'新增用量来源',disabled:busy || settings.sources.length>=settings.limit,onClick:()=>{editor=editSource(api,null,load);}}),
      Button({label:'刷新面板',disabled:busy,onClick:()=>{notice.textContent='';return load();}}));
    const sources=settings.sources.map(source=>{
      const path=base+'/'+encodeURIComponent(source.id),s=source.status;
      const enabled=h('input',{type:'checkbox',checked:source.enabled,disabled:busy,onchange:e=>{const enabled=e.target.checked;void write(()=>api.put(path,{revision:source.revision,enabled}));}});
      return h('section',{class:'usage-panel stack','aria-label':source.name},h('h3',{},source.name),
        h('span',{},kinds[source.type]+' · '+source.url),h('label',{class:'check'},enabled,'启用此来源'),
        h('span',{},!source.enabled?'来源已停用':!settings.enabled?'自动轮询已暂停':s?.error?'读取失败':s?.okAt?'已读取':'尚未读取'),
        s?.error && h('p',{role:'status'},s.error),s?.checkedAt && h('small',{},'最近检查 '+time(s.checkedAt)),
        s?.okAt && h('small',{},'最近成功 '+time(s.okAt)+' · '+seenText(s.seen ?? s)),
        h('div',{class:'usage-controls'},Button({label:'立即读取',disabled:busy || !settings.enabled || !source.enabled,onClick:()=>write(()=>api.post(path+'/refresh',{}))}),
          Button({label:'编辑来源',disabled:busy,onClick:()=>{editor=editSource(api,source,load);}}),
          Button({label:'删除来源',disabled:busy,onClick:async()=>{
            if(await confirmDialog({title:'删除用量来源',message:'删除「'+source.name+'」及其已保存的密钥和用量窗口。',confirmLabel:'删除来源',danger:true,signal:life.signal}))
              await write(()=>api.del(path,{revision:source.revision}));
          }})));
    });
    replace(content,controls,h('section',{class:'usage-panel stack'},h('h3',{},'轮询设置'),h('label',{class:'check'},master,'启用自动轮询'),
      field('轮询间隔（分钟）',interval),providerFields,field('隐藏提供商',hidden),h('div',{class:'usage-controls'},saveSettings,Button({label:'还原为已保存设置',disabled:busy,
        onClick:()=>{draftSettings=undefined;notice.textContent='';return load();}}))),sources,
      h('section',{class:'usage-panel stack'},h('h3',{},'账户用量窗口'),accounts.length?accounts.map(accountWindow):h('p',{},'暂无可显示的账户用量窗口。')));
  }
  void load();
  return drawer;
}

function accountWindow(account){
  return h('article',{class:'stack','aria-label':account.name},h('strong',{},account.name),
    h('small',{},[account.provider,account.plan,account.sourceName].filter(Boolean).join(' · ')),
    h('small',{},[account.stale?'数据已过期':'',account.sampledAt?'采样于 '+time(account.sampledAt):''].filter(Boolean).join(' · ')),
    account.windows.map(w=>h('div',{class:'stack'},h('span',{},[w.label || w.windowMinutes+' 分钟',w.model,'已用 '+w.usedPercent+'%'].filter(Boolean).join(' · ')),
      h('progress',{value:w.usedPercent,max:100,'aria-label':w.label || '窗口用量'}),w.resetsAt && h('small',{},'重置于 '+time(w.resetsAt)))));
}

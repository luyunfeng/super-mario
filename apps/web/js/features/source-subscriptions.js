import { uuid } from '../lib/format.js';
import { subscriptionPaths } from './subscription-paths.js';
import { h, replace } from '../lib/dom.js';
import { externalSourceLink } from '../lib/markdown.js';
import { Button, Check, Field, Input, Select } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

import { openSubscriptionSettings } from './subscription-settings.js';

const path = '/source-subscriptions';
const destinations = {inbox:'收件箱', knowledge:'个人记忆'};
const date = value => new Date(value).toLocaleString('zh-CN');
const retryTime = value => h('time',{dateTime:value},new Date(value).toLocaleString('zh-CN',{timeZoneName:'short'}));

export function openSourceSubscriptions({api,store,router,draftId}) {
  const owner = api.draftOwner();
  const source = Select({options:[],required:true});
  const resource = Input({required:true});
  const resourceField = Field({label:'资源',control:resource});
  const name = Input({required:true});
  const interval = Input({type:'number',min:1,max:10080,step:1,value:60,required:true});
  const checks = Object.entries(destinations).map(([id,label]) => Check({label,name:id,checked:id === 'inbox'}));
  const notice = h('p',{role:'status',class:'small'});
  let selectedDraft = null;
  const draftNotice = h('p',{class:'small',role:'status',hidden:true});
  const drafts = h('div',{class:'stack'});
  const draftList = h('details',null,h('summary',null,'待核对的订阅草案'),drafts);
  draftList.addEventListener('toggle',() => {if(draftList.open) void loadDraftList();});
  const results = h('div',{class:'stack','aria-live':'polite'});
  const rows = h('div',{class:'stack'});
  const preview = Button({label:'预览来源',onClick:previewSource});
  const create = Button({label:'创建订阅',kind:'primary',type:'submit'});
  const fields = h('fieldset',{class:'stack'},
    Field({label:'来源连接器',control:source}), resourceField, h('div',null,preview), results,
    Field({label:'订阅名称',control:name}),Field({label:'拉取间隔（分钟）',control:interval}),
    h('fieldset', {class:'row row--wrap'}, h('legend',null,'新内容送往'), checks),h('div',null,create));
  const form = h('form',{onsubmit:event => {event.preventDefault(); void createSubscription();}},fields);
  const refresh = Button({label:'刷新订阅',size:'sm',onClick:load});
  const paths = subscriptionPaths(id => {
    const row = [...rows.children].find(el => el.dataset.id === id);
    row?.focus(); row?.scrollIntoView({block:'nearest'});
  });
  const body = h('div',{class:'stack stack--lg'},draftList,draftNotice,form,notice,paths.element,
    h('section',{class:'stack'},h('div',{class:'row row--between'},h('h3',null,'已登记订阅'),refresh),rows));
  let settings;
  const drawer = openDrawer({title:'来源订阅',body,onClose:() => {settings?.close();offStore();offRoute();}});
  const active = () => drawer.el.open && router.current.page === 'memory' && !store.view.unauthorized &&
    owner === api.draftOwner() && owner === store.view.snapshotOwner && store.view.snapshot?.plugins?.some(p => p.id === 'source-subscriptions' && p.status === 'active');
  const offRoute = router.subscribe(() => {if (!active()) drawer.close();});
  const pluginStates = view => JSON.stringify((view.snapshot?.plugins ?? []).map(p => [p.id,p.status]));
  let revision = store.view.sourceSubscriptionsChange, plugins = pluginStates(store.view);
  let connection = store.view.connection, pendingRead = false;
  const offStore = store.subscribe(view => {
    if (!active()) { drawer.close(); return; }
    const reconnect = connection !== view.connection && view.connection === 'online';
    connection = view.connection;
    if (connection !== 'online') settings?.close();
    const nextPlugins = pluginStates(view);
    if (revision !== view.sourceSubscriptionsChange || plugins !== nextPlugins || reconnect) {
      plugins = nextPlugins;
      revision = view.sourceSubscriptionsChange; pendingRead = true;
      if (draftList.open && connection === 'online') void loadDraftList();
    }
    sync(); refreshIfNeeded();
  });
  function refreshIfNeeded() {
    if (busy || !pendingRead || connection !== 'online' || !active()) return;
    pendingRead = false; void load(true);
  }
  let sources = [], subscriptions = [], busy = false, loaded = false;
  function sync() {
    fields.disabled = connection !== 'online' || busy || !loaded || !sources.length;
    refresh.disabled = busy || connection !== 'online';
    for (const button of drafts.querySelectorAll('button')) button.disabled = connection !== 'online' || busy;
    for (const button of rows.querySelectorAll('button')) button.disabled = connection !== 'online' || busy || button.dataset.unavailable === 'true';
  }
  function setResourceLabel() {
    resourceField.querySelector('label').textContent = sources.find(item => item.id === source.value)?.resourceLabel ?? '资源';
    replace(results);
  }
  source.addEventListener('change',setResourceLabel);
  resource.addEventListener('input',() => replace(results));
  function edit(row,remove=false) {
    settings=openSubscriptionSettings({row,remove,api,path,active:() => active() && store.view.connection === 'online',
      changed:message => {notice.textContent=message;pendingRead=true;refreshIfNeeded();}});
  }
  function paint() {
    paths.update(sources,subscriptions);
    replace(rows, subscriptions.length ? subscriptions.map(row => {
      const sourceName = sources.find(item => item.id === row.sourceId)?.name;
      const pull = Button({label:'立即拉取',size:'sm',onClick:() => change(row,true)});
      pull.dataset.unavailable = String(!sourceName || !row.enabled);
      return h('article',{class:'card card__body stack','aria-label':row.name,tabIndex:-1,dataset:{id:row.id}},
        h('div',{class:'row row--between'},h('strong',null,row.name),h('span',null,row.enabled ? '已启用' : '已暂停')),
        h('div',{class:'small'},(sourceName ?? row.sourceId + '（连接器不可用）') + ' · ' + row.resource),
        h('div',{class:'small muted'},row.destinations.map(id => destinations[id]).join('、') + ' · 每 ' + row.intervalMinutes + ' 分钟'),
        row.nextPageNumber && h('div',{class:'small'},'本轮尚有后续页，下次读取第 '+row.nextPageNumber+' 页。'),
        row.lastRunAt && h('div',{class:'small'},'最近拉取 · ' + date(row.lastRunAt)),
        Number.isFinite(Date.parse(row.retryAt)) && h('div',{class:'small'},
          '来源限流，可再次读取的时间 · ',retryTime(row.retryAt),
          row.enabled && h('p',{class:'muted small'},'等待期间，立即拉取可补投此前已收到的条目。')),
        row.enabled && row.nextRunAt && h('div',{class:'small'},'下次拉取 · ' + date(row.nextRunAt)),
        row.error && h('p',{class:'text-danger'},row.error),
        h('div',{class:'row row--wrap'},pull,Button({label:'编辑订阅',size:'sm',onClick:() => edit(row)}),
          Button({label:'删除订阅',size:'sm',onClick:() => edit(row,true)}),Button({label:row.enabled ? '暂停订阅' : '恢复订阅',size:'sm',onClick:() => change(row,false)})));
    }) : '暂无订阅。');
    sync();
  }
  async function readList() {
    const state = await api.get(path);
    if (!active()) return;
    const previous = source.value;
    sources = state.sources; subscriptions = state.subscriptions;
    replace(source,sources.map(item => h('option',{value:item.id},item.name)));
    if (sources.some(item => item.id === previous)) source.value = previous;
    else if (previous && sources.length) {
      source.prepend(h('option',{value:''},'请选择来源连接器')); source.value = '';
    }
    if (!previous || source.value !== previous) setResourceLabel();
    loaded = true;
    paint();
  }
  async function act(operation, mutation = false, quiet = false) {
    if (busy || !active() || connection !== 'online') return;
    busy = true; sync(); if (!quiet) notice.textContent = '';
    try {await operation();}
    catch (error) {
      if (!active()) return;
      if (mutation) {
        loaded = false; replace(rows);
        try {await readList();} catch { /* 使用刷新按钮重新核对。 */ }
      }
      if (active()) notice.textContent = (error.status === 409 ? '订阅已变化，请核对后再操作。' :
        mutation && !error.status ? '提交结果未确认，请先核对订阅。' : '') + error.message;
      if (active() && error.retryAt) notice.append(' 可再次读取的时间 · ',retryTime(error.retryAt));
    }
    finally {busy = false; if (active()) {sync(); refreshIfNeeded();}}
  }
  function load(quiet = false) {
    return act(async () => {
      await readList();
      if (active() && !sources.length) notice.textContent = '没有可用的来源连接器。';
    },false,quiet === true);
  }
  function previewSource() {
    if (!source.reportValidity() || !resource.reportValidity() || !resource.value.trim()) return;
    replace(results);
    return act(async () => {
      const {items,hasMore} = await api.post(path+'/preview',{sourceId:source.value,resource:resource.value.trim()});
      if (active()) replace(results,h('strong',null,'来源预览'),
        hasMore && h('p',{class:'small muted'},'仅预览首页，来源还有后续页。'),
        items.length ? items.map(item =>
        h('article',{class:'stack'},h('strong',null,item.title),
          h('div',{class:'small',style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},item.text),
          item.url && externalSourceLink(item.url,'打开来源原文'))) : hasMore ? '本页暂无条目。' : '暂无可预览的内容。');
    });
  }
  let createAttempt;
  function createSubscription() {
    const selected = checks.map(check => check.querySelector('input')).filter(check => check.checked).map(check => check.name);
    if (!selected.length) {notice.textContent = '请选择新内容的去向。'; return;}
    return act(async () => {
      const input = {sourceId:source.value,resource:resource.value.trim(),name:name.value.trim(),
        destinations:selected,intervalMinutes:Number(interval.value),...(selectedDraft && {draftId:selectedDraft})};
      const signature=JSON.stringify(input);
      if(createAttempt?.signature!==signature) createAttempt={signature,id:uuid()};
      const row = await api.post(path,{...input,requestId:createAttempt.id});
      createAttempt=undefined;
      if (!active()) return;
      subscriptions = [row,...subscriptions.filter(item => item.id !== row.id)];
      selectedDraft=null; draftNotice.hidden=true; if(draftList.open) void loadDraftList();
      name.value = ''; resource.value = ''; replace(results); paint(); notice.textContent = '已创建订阅。';
    },true);
  }
  function change(row,pull) {
    const url = path+'/'+encodeURIComponent(row.id);
    return act(async () => {
      const updated = pull ? await api.post(url+'/pull',{version:row.version}) :
        await api.patch(url,{version:row.version,enabled:!row.enabled});
      if (!active()) return;
      subscriptions = subscriptions.map(existing => existing.id === updated.id ? updated : existing);
      paint(); notice.textContent = updated.error || (pull
        ? updated.nextPageNumber ? '已拉取本页，下次读取第 '+updated.nextPageNumber+' 页。' : '本轮拉取完成。'
        : updated.enabled ? '已恢复订阅。' : '已暂停订阅。');
    },true);
  }
  let draftRead=0;
  async function loadDraftList() {
    const stamp=++draftRead;
    try {
      const {items}=await api.get(path+'/drafts');
      if(active() && stamp===draftRead) replace(drafts,items.length ? items.map(item =>
        Button({label:item.name+' · '+item.id,size:'sm',onClick:() => void openDraft(item.id)})) : '暂无待核对的草案。');
    } catch(error) {if(active() && stamp===draftRead) replace(drafts,error.message);}
    finally {if(active()) sync();}
  }
  function openDraft(id) {
    return act(async () => {
      const draft=await api.get(path+'/drafts/'+encodeURIComponent(id));
      if(!active() || draft.id!==id) return;
      if(!sources.some(item=>item.id===draft.sourceId)) throw new Error('草案的来源连接器已停用。');
      source.value=draft.sourceId;setResourceLabel();resource.value=draft.resource;name.value=draft.name;
      interval.value=String(draft.intervalMinutes);
      for(const label of checks) {
        const box=label.querySelector('input');box.checked=draft.destinations.includes(box.name);
      }
      selectedDraft=id;
      draftNotice.hidden=false;draftNotice.textContent='正在核对草案 '+id+'。检查来源和投递位置后，点击「创建订阅」保存。';
      draftList.open=false;
    });
  }
  async function initialize() {
    await load();
    if(active() && draftId && loaded) await openDraft(draftId);
  }
  void initialize();
  return drawer;
}

import { h, replace } from '../lib/dom.js';
import { openDrawer } from '../ui/overlay.js';

const fmt = value => value.toLocaleString('zh-CN');
const color = ['#8fa3ff','#62cbdc','#72dfa1','#e8c873','#d596ca'];
export function openTokenStatistics({ api, store }) {
  const body = h('div', { class: 'usage-board' });
  const drawer = openDrawer({ title: 'Token 统计', body, wide: true, onClose: () => off() });
  drawer.el.classList.add('usage-drawer');
  const token = api.token();
  const off = store.subscribe(({ snapshot, unauthorized }) => {
    if (api.token() !== token || unauthorized || !snapshot?.plugins.some(p => p.id === 'token-statistics' && p.status === 'active')) drawer.close();
  });
  let rows = [], days = 7, agent = '', model = '', note = '', busy = false;
  const controls = h('div', { class: 'usage-controls' }), report = h('div');
  body.append(controls, report);
  function paint() {
    const cutoff = days ? new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0,10) : '';
    const selected = rows.filter(r => r.day >= cutoff && (!agent || r.agent === agent) && (!model || r.model === model));
    function picker(label, field, value, set) {
      return h('select', { 'aria-label': label, onchange: e => { set(e.target.value); paint(); } },
        h('option', { value: '' }, '全部' + label), [...new Set(rows.map(r => r[field]))].sort().map(v => h('option', { value: v, selected: value === v }, v)));
    }
    replace(controls, h('div', { class: 'usage-range' }, [[1,'今天'],[7,'7 天'],[30,'30 天'],[0,'全部']].map(([n,label]) =>
      h('button', { type:'button', 'aria-pressed':String(days === n), onclick:() => { days=n; paint(); } }, label))),
      picker('Agent','agent',agent,v=>agent=v), picker('模型','model',model,v=>model=v),
      h('button',{ disabled:busy, onclick:load },busy?'读取中…':'刷新'));
    const totals = { input:0,output:0,cached:0,samples:0 }, models = new Map(), dates = new Map();
    for (const r of selected) {
      for (const key of Object.keys(totals)) totals[key] += r[key];
      const total = r.input + r.output;
      models.set(r.model,(models.get(r.model) ?? 0) + total);
      if (!dates.has(r.day)) dates.set(r.day,new Map());
      const group=dates.get(r.day); group.set(r.model,(group.get(r.model) ?? 0)+total);
    }
    const ranking=[...models].sort((a,b)=>b[1]-a[1]);
    const peak=Math.max(1,...[...dates.values()].map(group=>[...group.values()].reduce((a,b)=>a+b,0)));
    const cards=[['总 Token',fmt(totals.input+totals.output)],['输出 Token',fmt(totals.output)],['缓存读取占输入',totals.input?(100*totals.cached/totals.input).toFixed(1)+'%':'—'],['用量记录',fmt(totals.samples)]];
    replace(report, h('div',{class:'usage-cards'}, cards.map(([label,value])=>h('div',{},h('small',{},label),h('strong',{},value)))),
      h('section',{class:'usage-panel'},h('h3',{},'每日用量'),selected.length ? h('div',{class:'usage-chart'},[...dates].sort(([a],[b])=>a.localeCompare(b)).map(([day,group])=>
        h('div',{class:'usage-column'},h('div',{class:'usage-stack'},ranking.map(([name],i)=>h('span',{title:day+' · '+name+' · '+fmt(group.get(name)??0),style:{height:100*(group.get(name)??0)/peak+'%',background:color[i%color.length]}}))),h('small',{},day.slice(5))))) : h('p',{},busy?'正在读取会话用量…':'此范围内暂无带时间的用量记录')),
      h('section',{class:'usage-panel'},h('h3',{},'模型分布'),ranking.map(([name,n],i)=>h('div',{class:'usage-rank'},h('span',{},name),h('b',{},fmt(n)),h('i',{style:{width:100*n/(ranking[0][1]||1)+'%',background:color[i%color.length]}})))),
      h('small',{role:'status'},note));
  }
  async function load() {
    busy=true; paint();
    try {
      const data=await api.get('/agents/sessions');
      const sessions=data.machines.filter(m=>m.online && m.available).flatMap(m=>m.sessions.map(s=>({...s,machineId:m.machineId}))).sort((a,b)=>(b.fileModifiedAt??'').localeCompare(a.fileModifiedAt??''));
      const batch=sessions.slice(0,16), next=[]; let failures=0, partial=0;
      for (const s of batch) {
        if (!drawer.el.open || api.token()!==token) return;
        try {
          const q=new URLSearchParams({machineId:s.machineId,executorId:s.executorId,nativeSessionId:s.nativeSessionId,cwd:s.cwd});
          const usage=await api.get('/agents/sessions/usage?'+q);
          if (!Array.isArray(usage.daily)) { failures++; continue; }
          if (usage.partial) partial++;
          for(const r of usage.daily) next.push({...r,agent:s.executorId});
        } catch { failures++; }
      }
      rows=next; note='按 UTC 日期统计 · 已读 '+(batch.length-failures)+' / '+sessions.length+' 条已发现会话 · '+partial+' 条截断 · '+failures+' 条读取失败';
    } catch(error) { note=error.message; }
    finally { busy=false; if(drawer.el.open) paint(); }
  }
  load();
}

import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const statuses = {running:'运行中',completed:'已完成',failed:'失败',interrupted:'已中断'};
const destinations = {inbox:'收件箱',knowledge:'个人记忆'};
const formatTime = value => h('time',{dateTime:value},new Date(value).toLocaleString('zh-CN'));

function renderRun(run,expanded) {
  const entryLabels = values => values.map(id => destinations[id]).join('、');
  return h('article',{class:'card card__body stack','aria-label':(run.trigger==='manual'?'手动拉取':'定时拉取')+' · '+statuses[run.status]},
    h('div',{class:'row row--between'},h('strong',null,run.trigger==='manual'?'手动拉取':'定时拉取'),
      h('span',null,statuses[run.status])),
    h('div',{class:'small muted'},'开始 · ',formatTime(run.startedAt),' · 第 '+run.page+' 页'),
    run.finishedAt && h('div',{class:'small muted'},'结束 · ',formatTime(run.finishedAt),
      Number.isFinite(run.durationMs) && ' · 耗时 '+(run.durationMs<1000 ? run.durationMs+' 毫秒' : (run.durationMs/1000).toFixed(1)+' 秒')),
    run.interruptionObservedAt && h('div',{class:'small muted'},'发现中断 · ',formatTime(run.interruptionObservedAt)),
    h('div',null,run.readCount===null ? '尚无来源读取结果' : '来源返回 '+run.readCount+' 项',
      ' · 新增 '+run.newCount+' 项'),
    h('div',{class:'small'},'已投递 · 收件箱 '+run.delivered.inbox+'，个人记忆 '+run.delivered.knowledge),
    h('div',{class:'small'},(run.status==='interrupted'?'待确认 · 收件箱 ':'待投递 · 收件箱 ')+run.pending.inbox+'，个人记忆 '+run.pending.knowledge),
    run.error && h('p',{class:'text-danger'},run.error),
    run.entries.length>0 && h('details',{open:expanded,dataset:{run:run.id}},
      h('summary',null,run.entries.length<run.totalEntries
        ? '查看条目（展示 '+run.entries.length+' 项，共 '+run.totalEntries+' 项）'
        : '查看条目（'+run.totalEntries+' 项）'),
      h('ul',{class:'stack'},run.entries.map(item=>h('li',null,h('strong',null,item.title),
        item.delivered.length>0 && h('div',{class:'small'},'已投递至'+entryLabels(item.delivered)),
        item.pending.length>0 && h('div',{class:'small'},(run.status==='interrupted'?'待确认去向：':'待投递至')+entryLabels(item.pending)))))));
}

export function openSubscriptionRuns({api,path,row,active}) {
  const list=h('div',{class:'stack','aria-live':'polite'},'正在读取运行记录…');
  const drawer=openDrawer({title:'运行记录',subtitle:row.name+' · 最近 20 次',body:list});
  let sequence=0;
  async function refresh() {
    if(!drawer.el.open || !active()) return;
    const stamp=++sequence;
    const current=()=>stamp===sequence && drawer.el.open && active();
    try {
      const {items,currentPending}=await api.get(path+'/'+encodeURIComponent(row.id)+'/runs');
      if(!current()) return;
      const expanded=new Set(Array.from(list.querySelectorAll('details[open]'),el=>el.dataset.run));
      replace(list,h('section',{class:'stack','aria-label':'当前待确认投递'},
        h('strong',null,'当前待确认投递 · 收件箱 '+currentPending.inbox+'，个人记忆 '+currentPending.knowledge),
        currentPending.totalEntries>0 && h('details',null,h('summary',null,'查看当前待确认条目（'+currentPending.totalEntries+' 项）'),
          h('ul',null,currentPending.entries.map(entry=>h('li',null,entry.title+' · '+entry.destinations.map(d=>destinations[d]).join('、')))))),
        items.length ? items.map(run=>renderRun(run,expanded.has(run.id))) : '暂无运行记录。');
    } catch(error) {
      if(!current()) return;
      replace(list,h('p',{role:'status'},error.message),
        ![401,403,404].includes(error.status) && Button({label:'重新读取运行记录',size:'sm',onClick:refresh}));
    }
  }
  void refresh();
  return {...drawer,refresh};
}

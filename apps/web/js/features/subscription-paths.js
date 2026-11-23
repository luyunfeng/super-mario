import {h, replace} from '../lib/dom.js';
import {Button, Field, Select} from '../ui/kit.js';

// Render configured routes. A route can exist before its first successful delivery.
export function subscriptionPaths(focusSubscription) {
  const filter = Select({options:[
    ['all','全部'], ['inbox','收件箱'],
    ['knowledge','个人记忆'], ['idle','已暂停或异常'],
  ]});
  const tree = h('div',{class:'stack','aria-live':'polite'});
  const element = h('details',{class:'card card__body'},
    h('summary',null,'来源关系图'),Field({label:'筛选投递路径',control:filter}),tree);
  let sources = [], subscriptions = [];
  function draw() {
    const names = new Map(sources.map(source => [source.id,source.name]));
    const groups = new Map();
    for (const row of subscriptions) {
      const idle = !row.enabled || Boolean(row.error) || !names.has(row.sourceId);
      if (filter.value === 'idle' ? !idle : filter.value !== 'all' && !row.destinations.includes(filter.value)) continue;
      if (!groups.has(row.sourceId)) groups.set(row.sourceId,[]);
      groups.get(row.sourceId).push(row);
    }
    replace(tree,groups.size ? [...groups].map(([sourceId,rows]) =>
      h('section',null,h('h4',null,names.get(sourceId) ?? sourceId + '（不可用）'),
        h('ul',{class:'stack'},rows.map(row =>
          h('li',null,h('span',null,row.resource + ' → '),
            Button({label:row.name,size:'sm',onClick:()=>focusSubscription(row.id)}),
            h('span',null,' → ' + row.destinations.map(d => d === 'inbox' ? '收件箱' : '个人记忆').join('、')),
            (!row.enabled || row.error) && h('div',{class:'small muted'},row.enabled ? row.error : '已暂停'))))))
      : '没有符合条件的订阅路径。');
  }
  filter.addEventListener('change',draw);
  return {element, update(nextSources,nextSubscriptions) {
    sources = nextSources; subscriptions = nextSubscriptions; draw();
  }};
}

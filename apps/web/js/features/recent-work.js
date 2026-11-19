import { h, replace } from '../lib/dom.js';
import { recentWork } from '../lib/recent-work.js';
import { formatDate } from '../lib/format.js';
import { Button } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';
import { openTodoHistory } from './todo-history.js';

export function createRecentWork({ api, store, router, scope }) {
  let snapshot, drawer, body, drawSignature, limit = 20;
  const entry = Button({ label: '最近完成', size: 'sm', onClick: () => {
    if (drawer) return;
    limit = 20; drawSignature = undefined; body = h('div', { class: 'stack' });
    drawer = openDrawer({ title: '最近完成', subtitle: '最近 24 小时，查看后仍保留；更早记录在项目中查看。',
      body, onClose() { drawer = undefined; body = undefined; paint(); } });
    paint();
  } });
  const el = h('div', { class: 'recent-work-entry', hidden: true }, entry);
  function paint() {
    const items = recentWork(snapshot, scope.get());
    el.hidden = !items.length && !drawer;
    entry.textContent = `最近完成 ${items.length}`;
    if (!body) return;
    const signature = JSON.stringify([scope.get(), limit, items.map(item => [item.id, item.at, item.value.title, item.value.prompt]), snapshot?.projects]);
    if (signature === drawSignature) return;
    drawSignature = signature;
    const todoCount = items.filter(item => item.kind === 'todo').length;
    replace(body, h('p', { class: 'small muted' }, `待办完成 ${todoCount} 项 · 执行结束 ${items.length - todoCount} 次（仍需单独验收）`),
      items.slice(0, limit).map(item => {
        const value = item.value;
        const project = (snapshot?.projects ?? []).find(project => project.id === value.projectId)?.name ?? '未归项目';
        const title = item.kind === 'todo' ? value.title : value.prompt;
        const name = item.kind === 'todo' ? '待办已完成' : '执行已结束';
        const control = item.kind === 'todo'
          ? Button({ label: title, kind: 'ghost', onClick: () => { drawer.close(); openTodoHistory({ api, store, router, todo: value }); } })
          : h('a', { class: 'btn btn--ghost', href: router.href('projects', value.projectId || 'all', 'runs', value.id), onclick: () => drawer.close() }, title);
        return h('div', { class: 'item', dataset: { recentId: item.id } }, h('div', { class: 'item__main' }, control,
          h('span', { class: 'item__meta' }, `${name} · ${project} · ${formatDate(item.at, true)}`)));
      }), !items.length && h('p', { class: 'muted' }, '当前范围最近 24 小时没有完成记录。'),
      items.length > limit && Button({ label: `查看更多（剩余 ${items.length - limit}）`, onClick: () => { limit += 20; paint(); } }));
  }
  scope.subscribe(paint);
  // Age out records even without a business event. No model calls or writes.
  setInterval(() => { if (router.current.page === 'chat') paint(); }, 60000);
  return { el, update(value) { snapshot = value; paint(); }, refresh: paint };
}

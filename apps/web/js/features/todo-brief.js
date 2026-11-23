import { h, replace } from '../lib/dom.js';
import { createRunScope } from './run-scope.js';
import { Button } from '../ui/kit.js';

const sources = {
  web: '主人在 Web 填写',
  feishu: '主人在飞书交办',
  assistant: '助手登记',
  system: '系统登记',
  continuation: '创建续办时登记',
  reconstructed: '根据现有待办记录重建',
};

export function createTodoBrief({ api, store, router, todo, close }) {
  const owner = api.draftOwner();
  const body = h('div', { class: 'stack small', 'aria-live': 'polite' });
  const panel = h('details', { 'aria-label': '交办依据' }, h('summary', null, '交办依据'), body);
  let sequence = 0, signature, lastSnapshot, connection = store.view.connection;
  let ancestors = new Map();
  const editors = new Map();
  function runScope(row) {
    if (!editors.has(row.runId)) editors.set(row.runId, createRunScope({api,runId:row.runId,projectId:todo.projectId,
      valid:() => sameScope() && ancestors.has(row.todoId),
      canEdit:() => !ancestors.get(row.todoId)?.completedAt && (!todo.projectId ||
        store.view.snapshot.projects?.some(project => project.id === todo.projectId && !project.archivedAt)),
      saved:() => { void store.refresh(); }}));
    return editors.get(row.runId).panel;
  }
  const sameScope = () => owner === api.draftOwner() && owner === store.view.snapshotOwner && !store.view.unauthorized &&
    store.view.snapshot?.todos?.some(item => item.id === todo.id && (item.projectId ?? null) === (todo.projectId ?? null));
  const paragraph = text => h('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, text);
  const time = value => new Date(value).toLocaleString('zh-CN');
  async function load() {
    const stamp = ++sequence;
    const active = () => panel.open && panel.isConnected && panel.closest('dialog')?.open !== false &&
      stamp === sequence && sameScope();
    if (!active()) return;
    if (!body.childElementCount) body.textContent = '正在读取交办依据…';
    try {
      const query = new URLSearchParams({ expectedProjectId: todo.projectId ?? '' });
      const { origin, criteria, reconstructed } = await api.get('/todos/' + encodeURIComponent(todo.id) + '/brief?' + query);
      if (!active()) return;
      if (!ancestors.has(origin.todoId) || criteria.some(row => !ancestors.has(row.todoId))) {
        throw new Error('待办归属已变化，请核对交办依据。');
      }
      const rebuilt = reconstructed || origin.kind === 'reconstructed';
      replace(body, h('section', { class: 'stack' }, h('h4', null, rebuilt ? '重建的登记信息' : '原始登记'),
        h('div', { class: 'muted' }, (sources[origin.kind] || '来源未标明') + ' · ' + time(origin.createdAt)),
        h('strong', null, origin.title), origin.notes && paragraph(origin.notes),
        origin.requestText && h('div', null, h('strong', null,
          origin.kind === 'feishu' ? '交办正文摘录（已去除命令和机器人点名）' : '交办时的原话'), paragraph(origin.requestText),
          Array.from(origin.requestText).length >= 2000 && h('span', {class:'muted'}, '最多展示 2000 个字符。')),
        origin.continuationReason && paragraph('交接说明 · ' + origin.continuationReason),
        origin.sourceMessageId && h('div', { class: 'muted' }, '来源消息 · ' + origin.sourceMessageId)),
      h('section', { class: 'stack' }, h('h4', null, '各轮验收标准'), criteria.length ?
        h('ol', { class: 'stack' }, criteria.map(row => h('li', null,
          paragraph(row.doneWhen || '首派时未登记验收标准。'),
          h('div', { class: 'muted' }, [ancestors.get(row.todoId)?.title, time(row.createdAt), row.executorId,
            Number.isFinite(row.expectMinutes) && '预计 ' + row.expectMinutes + ' 分钟'].filter(Boolean).join(' · ')),
          h('a', { href: router.href('projects', todo.projectId ?? 'all', 'runs', row.runId), onclick: () => close?.() }, '来源执行 · ' + row.runId),runScope(row)))) :
        h('p', { class: 'muted' }, '尚未登记执行验收标准。')));
      const ids = new Set(criteria.map(row => row.runId));
      for (const [id, editor] of editors) { if (ids.has(id)) void editor.refresh(); else editors.delete(id); }
    } catch (error) {
      if (active()) replace(body, h('p', null, error.message), Button({ label: '重新读取交办依据', size: 'sm', onClick: load }));
    }
  }
  panel.addEventListener('toggle', () => {
    if (panel.open) void load(); else { ++sequence; replace(body); }
  });
  function update(current) {
    if (!current || !sameScope()) {
      ++sequence; editors.clear(); panel.hidden = true; panel.open = false; replace(body); signature = lastSnapshot = undefined; return;
    }
    const reconnected = connection !== 'online' && store.view.connection === 'online';
    connection = store.view.connection;
    if (store.view.snapshot === lastSnapshot && !reconnected) return;
    lastSnapshot = store.view.snapshot;
    const related = new Map(store.view.snapshot.todos.filter(item => item.projectId === current.projectId).map(item => [item.id, item]));
    ancestors = new Map();
    const root = current.continuationRootId ?? current.id;
    let item = current;
    while (item && !ancestors.has(item.id) && (item.continuationRootId ?? item.id) === root) {
      ancestors.set(item.id, item);
      item = related.get(item.continuesTodoId);
    }
    const runs = store.view.snapshot.runs.filter(row => ancestors.has(row.todoId) && row.projectId === current.projectId);
    const next = JSON.stringify([[...ancestors.values()].map(row => [row.id, row.title, row.notes, row.continuationReason, row.completedAt]),
      store.view.snapshot.projects?.find(project => project.id === todo.projectId)?.archivedAt,
      runs.map(row => [row.id, row.executorId, row.status, row.doneWhen, row.expectMinutes])]);
    panel.hidden = false;
    if (next === signature && !reconnected) return;
    signature = next;
    if (panel.open) void load();
  }
  return { panel, update };
}

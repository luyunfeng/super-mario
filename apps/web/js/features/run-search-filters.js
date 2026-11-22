import { h } from '../lib/dom.js';
import { runStatus } from '../lib/format.js';
import { Button, Check, Field, Select } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';
import { runCondition, searchRunHits } from './run-search.js';

export function openRunFilters({ query, snapshot, store, authorized, onApply }) {
  let words = query.split(/\s+/).filter(Boolean);
  const selected = field => words.map(runCondition).filter(item => item?.[0] === field).map(item => item[1]);
  const resetButtons = new Map();
  const count = h('span', { class: 'small muted', role: 'status' });
  const resetAll = Button({ label: '清除全部条件', onClick: () => clear() });
  function clear(field) {
    words = words.filter(word => {
      const condition = runCondition(word);
      return !condition || (field && condition[0] !== field);
    });
    if (!field) time.value = '';
    for (const input of drawer.body.querySelectorAll('input[type=checkbox]')) {
      if (!field || input.name === field) input.checked = false;
    }
    updateSummary();
  }
  function updateSummary() {
    const active = new Set(words.map(runCondition).filter(Boolean).map(([field]) => field));
    resetAll.disabled = active.size === 0;
    for (const [field, button] of resetButtons) button.hidden = !active.has(field);
    const summary = '匹配 ' + searchRunHits(words.join(' '), store.view.snapshot).length + ' 条执行记录';
    if (count.textContent !== summary) count.textContent = summary;
  }
  const time = Select({ options: [['', '不限'], ['今天', '今天'], ['昨天', '昨天'], ['本周', '本周'],
    ['24h', '最近 24 小时'], ['7d', '最近 7 天'], ['30d', '最近 30 天']], value: selected('since').at(-1) || '',
    onchange(event) {
      words = words.filter(word => runCondition(word)?.[0] !== 'since');
      const value = event.target.value;
      if (value) words.push(/^[0-9]/.test(value) ? 'since:' + value : value);
      updateSummary();
    } });
  const groups = [
    ['state', '执行状态', Object.entries(runStatus).map(([id, status]) => [id, status.text])],
    ...[['project', '项目', 'projects', 'projectId'], ['machine', '机器', 'machines', 'machineId'], ['agent', '执行器', 'executors', 'executorId']]
      .map(([key, label, list, property]) => {
        const names = new Map(snapshot[list]?.map(item => [item.id, item.name]));
        const ids = new Set(snapshot.runs?.map(run => run[property]).filter(id => id && !/\s/.test(id)));
        const labels = new Map();
        for (const id of ids) {
          const name = names.get(id) || id;
          labels.set(name, (labels.get(name) || 0) + 1);
        }
        return [key, label, [...ids].map(id => {
          const name = names.get(id) || id;
          return ['=' + id, labels.get(name) > 1 ? name + ' · ' + id : name];
        })];
      }),
  ];
  const fields = groups.map(([field, label, options]) => {
    const values = new Set(selected(field));
    const available = new Map(options);
    // Keep typed aliases and conditions referring to a machine that has since gone offline.
    for (const value of values) if (!available.has(value)) available.set(value, value);
    if (!available.size) return null;
    const reset = Button({ label: '清除' + label + '条件', size: 'sm', onClick: () => clear(field) });
    resetButtons.set(field, reset);
    return h('fieldset', { class: 'stack' }, h('legend', null, label), reset,
      [...available].map(([value, name]) => Check({ label: name, name: field, checked: values.has(value), onChange(checked) {
        words = words.filter(word => {
          const condition = runCondition(word);
          return condition?.[0] !== field || condition[1] !== value;
        });
        if (checked) words.push(field + ':' + value);
        updateSummary();
      } })));
  });
  let applied = false;
  const drawer = openDrawer({ title: '筛选执行记录', body: h('div', { class: 'stack' }, Field({ label: '更新时间', control: time }), fields),
    footer: h('div', { class: 'row row--wrap' }, count, resetAll, Button({ label: '应用筛选', kind: 'primary', onClick() { applied = true; drawer.close(); } })),
    onClose() { unsubscribe(); if (applied && authorized()) onApply(words.join(' ')); } });
  let lastSnapshot = snapshot;
  const unsubscribe = store.subscribe(() => {
    if (!authorized()) { drawer.close(); return; }
    if (store.view.snapshot !== lastSnapshot) {
      lastSnapshot = store.view.snapshot;
      updateSummary();
    }
  });
  updateSummary();
}

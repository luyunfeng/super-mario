// 全局搜索：待办、执行、记忆、项目。只在本地快照里查找，结果按类型分组。
import { h, replace } from '../lib/dom.js';

export function createSearch({ shell, store, router }) {
  const { searchInput: input, results } = shell;

  function groups(query, snapshot) {
    const match = (...values) => values.some(value => String(value ?? '').toLowerCase().includes(query));
    const projectKey = item => item.projectId || 'all';
    return [
      ['待办', (snapshot.todos ?? []).filter(item => match(item.title, item.notes)).map(item => ({ text: item.title, href: router.href('projects', projectKey(item), 'todos') }))],
      ['执行', (snapshot.runs ?? []).filter(item => match(item.prompt, item.output)).map(item => ({ text: item.prompt, href: router.href('projects', projectKey(item), 'runs', item.id) }))],
      ['记忆', (snapshot.knowledge ?? []).filter(item => match(item.title, item.content)).map(item => ({ text: item.title, href: `${router.href('memory')}?entry=${encodeURIComponent(item.id)}` }))],
      ['项目', (snapshot.projects ?? []).filter(item => !item.archivedAt && match(item.name, item.description)).map(item => ({ text: item.name, href: router.href('projects', item.id, 'todos') }))],
    ].filter(([, hits]) => hits.length);
  }

  function paint() {
    const query = input.value.trim().toLowerCase();
    const snapshot = store.view.snapshot;
    results.hidden = !query || !snapshot;
    if (results.hidden) return;
    const found = groups(query, snapshot);
    if (!found.length) { replace(results, h('p', { class: 'search__group' }, '没有找到匹配的内容')); return; }
    replace(results, found.map(([name, hits]) => [
      h('div', { class: 'search__group' }, name),
      hits.slice(0, 5).map(hit => h('a', { class: 'search__hit truncate', href: hit.href, onclick: () => { input.value = ''; results.hidden = true; } }, hit.text)),
    ]));
  }

  input.addEventListener('input', paint);
  input.addEventListener('focus', paint);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { results.hidden = true; input.blur(); }
    if (event.key === 'Enter') { results.querySelector('.search__hit')?.click(); }
  });
  document.addEventListener('click', (event) => { if (!event.target.closest('.search')) results.hidden = true; });
}

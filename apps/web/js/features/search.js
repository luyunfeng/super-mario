// 全局搜索：只在当前工作台快照里查找，结果按类型分组。
import { h, replace } from '../lib/dom.js';
import { searchRuns } from './run-search.js';
import { openSavedSearches } from './saved-searches.js';

export function conversationSearchActive(snapshot) {
  return snapshot?.plugins?.some(plugin => plugin.id === 'conversation-search' && plugin.status === 'active') ?? false;
}

export function createSearch({ shell, store, router, api }) {
  const { searchInput: input, results } = shell;

  function chatHits(query, messages) {
    const hits = [];
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    // 快照按消息插入顺序排列。只搜索主对话气泡的正文，不读取工具进展或通知详情。
    for (let i = messages.length - 1; i >= 0 && hits.length < 5; i--) {
      const message = messages[i];
      if (message.conversationId !== 'main' || (message.origin && message.origin !== 'user')) continue;
      const match = pattern.exec(message.text);
      if (!match) continue;
      const index = match.index;
      const after = index + match[0].length;
      const start = Math.max(0, index - 18);
      const end = Math.min(message.text.length, after + 32);
      hits.push({
        text: [message.role === 'user' ? '你 · ' : '主 Agent · ', start ? '…' : '', message.text.slice(start, index),
          h('mark', null, match[0]), message.text.slice(after, end), end < message.text.length ? '…' : ''],
        href: `${router.href('chat')}?at=${encodeURIComponent(message.id)}`,
      });
    }
    return hits;
  }

  function groups(query, snapshot) {
    const folded = query.toLowerCase();
    const match = (...values) => values.some(value => String(value ?? '').toLowerCase().includes(folded));
    const projectKey = item => item.projectId || 'all';
    const pluginActive = conversationSearchActive(snapshot);
    const runs = pluginActive ? searchRuns(query, snapshot)
      : (snapshot.runs ?? []).filter(item => match(item.prompt, item.output));
    return [
      ['主对话', pluginActive ? chatHits(query, snapshot.messages ?? []) : []],
      ['待办', (snapshot.todos ?? []).filter(item => match(item.title, item.notes)).map(item => ({ text: item.title, href: router.href('projects', projectKey(item), 'todos') }))],
      ['执行', runs.map(item => ({ text: item.prompt, href: router.href('projects', projectKey(item), 'runs', item.id) }))],
      ['记忆', (snapshot.knowledge ?? []).filter(item => match(item.title, item.content)).map(item => ({ text: item.title, href: `${router.href('memory')}?entry=${encodeURIComponent(item.id)}` }))],
      ['项目', (snapshot.projects ?? []).filter(item => !item.archivedAt && match(item.name, item.description)).map(item => ({ text: item.name, href: router.href('projects', item.id, 'todos') }))],
    ].filter(([, hits]) => hits.length);
  }

  function paint() {
    const query = input.value.trim();
    const snapshot = store.view.snapshot;
    const savedEnabled = conversationSearchActive(snapshot);
    results.hidden = !snapshot || store.view.unauthorized || (!query && !savedEnabled);
    if (results.hidden) { results.replaceChildren(); return; }
    const found = query ? groups(query, snapshot) : [];
    const open = initialQuery => {
      results.hidden = true;
      results.replaceChildren();
      openSavedSearches({
        api, store, initialQuery, isEnabled: () => conversationSearchActive(store.view.snapshot) && !store.view.unauthorized,
        onApply(value) { input.value = value; input.focus(); paint(); },
      });
    };
    replace(results, query && !found.length && h('p', { class: 'search__group' }, '没有找到匹配的内容'), found.map(([name, hits]) => [
      h('div', { class: 'search__group' }, name),
      hits.slice(0, 5).map(hit => h('a', { class: 'search__hit truncate', href: hit.href, onclick: event => {
        input.value = ''; results.hidden = true;
        if (hit.href === location.hash && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
          event.preventDefault(); router.go(hit.href);
        }
      } }, hit.text)),
    ]), savedEnabled && h('div', { class: 'saved-search-actions' },
      query && h('button', { class: 'btn btn--sm', type: 'button', onclick: () => open(query) }, '保存当前检索'),
      h('button', { class: 'btn btn--sm', type: 'button', onclick: () => open() }, '管理保存的检索')));
  }

  store.subscribe(({ snapshot, unauthorized }) => {
    const label = conversationSearchActive(snapshot) && !unauthorized ? '搜索对话、待办、执行、记忆与项目' : '搜索待办、执行、记忆与项目';
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    if (!snapshot || unauthorized) {
      results.hidden = true;
      results.replaceChildren();
    } else if (document.activeElement === input || !results.hidden) paint();
  });
  input.addEventListener('input', paint);
  input.addEventListener('focus', paint);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { results.hidden = true; input.blur(); }
    if (event.key === 'Enter') { results.querySelector('.search__hit')?.click(); }
  });
  document.addEventListener('click', (event) => { if (!event.target.closest('.search')) results.hidden = true; });
}

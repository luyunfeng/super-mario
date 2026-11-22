// 全局搜索按类型展示；项目工作消息通过插件查询，不进入全局快照。
import { h, replace } from '../lib/dom.js';
import { searchRuns } from './run-search.js';
import { openSavedSearches } from './saved-searches.js';

export function conversationSearchActive(snapshot) {
  return snapshot?.plugins?.some(plugin => plugin.id === 'conversation-search' && plugin.status === 'active') ?? false;
}

export function createSearch({ shell, store, router, api }) {
  const { searchInput: input, results } = shell;

  let searchKey, generation = 0, timer, projectHits = [], projectError = '', pending = false;
  function updateProjectSearch(query, enabled) {
    const key = enabled && query ? JSON.stringify([api.token(), query]) : '';
    if (searchKey === key) return;
    searchKey = key;
    const stamp = ++generation;
    clearTimeout(timer);
    projectHits = []; projectError = ''; pending = Boolean(key);
    if (!key) return;
    const current = () => stamp === generation && key === JSON.stringify([api.token(), query]) && conversationSearchActive(store.view.snapshot) && !store.view.unauthorized;
    timer = setTimeout(async () => {
      if (!current()) return;
      try {
        const reply = await api.post('/project-message-search', { query });
        if (!current()) return;
        projectHits = reply.hits;
      } catch (error) {
        if (!current()) return;
        projectError = '项目对话检索失败：' + error.message;
      }
      pending = false;
      if (!results.hidden) paint();
    }, 180);
  }

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
      ['项目工作对话', projectHits.flatMap(hit => {
        const project = snapshot.projects?.find(p => !p.archivedAt && p.id === hit.projectId);
        if (!project) return [];
        return [{ text: [project.name + ' · ' + (hit.role === 'user' ? '你' : '项目助手') + ' · ', hit.before,
          h('mark', null, hit.match), hit.after], href: router.href('projects', project.id, 'workspace') + '?at=' + encodeURIComponent(hit.id) }];
      })],
      ['待办', (snapshot.todos ?? []).filter(item => match(item.title, item.notes)).map(item => ({ text: item.title, href: router.href('projects', projectKey(item), 'todos', 'detail', item.id) }))],
      ['执行', runs.map(item => ({ text: item.prompt, href: router.href('projects', projectKey(item), 'runs', item.id) }))],
      ['记忆', (snapshot.knowledge ?? []).filter(item => match(item.title, item.content)).map(item => ({ text: item.title, href: `${router.href('memory')}?entry=${encodeURIComponent(item.id)}` }))],
      ['项目', (snapshot.projects ?? []).filter(item => !item.archivedAt && match(item.name, item.description)).map(item => ({ text: item.name, href: router.href('projects', item.id, 'todos') }))],
    ].filter(([, hits]) => hits.length);
  }

  function paint() {
    const query = input.value.trim();
    const snapshot = store.view.snapshot;
    const savedEnabled = conversationSearchActive(snapshot);
    updateProjectSearch(query, savedEnabled && !store.view.unauthorized);
    results.hidden = !snapshot || store.view.unauthorized || (!query && !savedEnabled);
    if (results.hidden) { results.replaceChildren(); return; }
    // A delayed project search or snapshot refresh can insert a group above the focused link.
    const focused = results.contains(document.activeElement) ? document.activeElement : null;
    const href = focused?.getAttribute('href');
    const action = focused?.tagName === 'BUTTON' ? focused.textContent : null;
    const found = query ? groups(query, snapshot) : [];
    const open = initialQuery => {
      results.hidden = true;
      results.replaceChildren();
      openSavedSearches({
        api, store, initialQuery, isEnabled: () => conversationSearchActive(store.view.snapshot) && !store.view.unauthorized,
        onApply(value) { input.value = value; input.focus(); paint(); },
      });
    };
    replace(results, query && !found.length && !pending && !projectError && h('p', { class: 'search__group' }, '没有找到匹配的内容'), projectError && h('p', { class: 'search__group' }, projectError), found.map(([name, hits]) => [
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
    if (focused) {
      const replacement = href ? [...results.querySelectorAll('a')].find(link => link.getAttribute('href') === href)
        : [...results.querySelectorAll('button')].find(button => button.textContent === action);
      (replacement ?? input).focus({ preventScroll: true });
    }
  }

  store.subscribe(({ snapshot, unauthorized }) => {
    const label = conversationSearchActive(snapshot) && !unauthorized ? '搜索对话、待办、执行、记忆与项目' : '搜索待办、执行、记忆与项目';
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    if (!snapshot || unauthorized) {
      updateProjectSearch('', false);
      results.hidden = true;
      results.replaceChildren();
    } else if (document.activeElement === input || !results.hidden) paint();
  });
  input.addEventListener('input', paint);
  input.addEventListener('focus', () => { searchKey = undefined; paint(); });
  function navigate(event) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.target.blur();
      results.hidden = true;
      return;
    }
    if (results.hidden) return;
    if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      results.querySelector('.search__hit')?.click();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const hits = [...results.querySelectorAll('.search__hit')];
    if (!hits.length || (event.target !== input && !hits.includes(event.target))) return;
    event.preventDefault();
    const index = hits.indexOf(event.target);
    const next = event.key === 'ArrowDown' ? index + 1 : (index < 0 ? hits.length : index) - 1;
    hits[(next + hits.length) % hits.length].focus();
  }
  input.addEventListener('keydown', navigate);
  results.addEventListener('keydown', navigate);
  document.addEventListener('click', (event) => { if (!event.target.closest('.search')) results.hidden = true; });
}

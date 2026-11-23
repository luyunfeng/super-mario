// 全局搜索按类型展示；项目工作消息通过插件查询，不进入全局快照。
import { h, replace } from '../lib/dom.js';
import { openDrawer, toast } from '../ui/overlay.js';
import { Button, copyText } from '../ui/kit.js';
import { searchRunHits } from './run-search.js';
import { openRunFilters } from './run-search-filters.js';
import { openSavedSearches } from './saved-searches.js';

export function conversationSearchActive(snapshot) {
  return snapshot?.plugins?.some(plugin => plugin.id === 'conversation-search' && plugin.status === 'active') ?? false;
}

function markedPath(path, query) {
  const chars = Array.from(path);
  const lower = chars.map(char => char.toLowerCase());
  const marked = new Set();
  for (const term of query.trim().toLowerCase().split(/\s+/u)) {
    const letters = Array.from(term);
    const contiguous = lower.findIndex((_, start) => letters.every((letter, i) => lower[start + i] === letter));
    if (contiguous >= 0) {
      letters.forEach((_, i) => marked.add(contiguous + i));
      continue;
    }
    let cursor = 0;
    for (const letter of letters) {
      const index = lower.indexOf(letter, cursor);
      if (index < 0) break;
      marked.add(index);
      cursor = index + 1;
    }
  }
  const parts = [];
  for (let start = 0; start < chars.length;) {
    let end = start + 1;
    while (end < chars.length && marked.has(end) === marked.has(start)) end++;
    const text = chars.slice(start, end).join('');
    parts.push(marked.has(start) ? h('mark', null, text) : text);
    start = end;
  }
  return parts;
}

export function createSearch({ shell, store, router, api, scope }) {
  const { searchInput: input, results } = shell;

  function remoteGroup(enabled, fetchHits, errorLabel, context = () => null, acceptEmpty = false) {
    let key, generation = 0, timer;
    const state = { hits: [], pending: false, error: '', truncated: false };
    const keyFor = query => JSON.stringify([api.token(), query, context()]);
    function update(query, refresh = false) {
      const next = (query || (acceptEmpty && query === '')) && enabled(store.view.snapshot) && !store.view.unauthorized ? keyFor(query) : '';
      if (next === key && !refresh) return;
      key = next;
      const stamp = ++generation;
      clearTimeout(timer);
      Object.assign(state, { hits: [], pending: Boolean(key), error: '', truncated: false });
      if (!key) return;
      const current = () => stamp === generation && enabled(store.view.snapshot) && !store.view.unauthorized &&
        next === keyFor(input.value.trim());
      timer = setTimeout(async () => {
        if (!current()) return;
        try {
          const { hits, truncated = false } = await fetchHits(query);
          if (!current()) return;
          state.hits = hits;
          state.truncated = truncated;
        } catch (error) {
          if (!current()) return;
          state.error = errorLabel + error.message;
        }
        state.pending = false;
        if (!results.hidden) paint();
      }, 180);
    }
    return { state, update };
  }
  let appliedShortcut;
  const savedAuthorized = () => !store.view.unauthorized && !!api.draftOwner() &&
    store.view.snapshotOwner === api.draftOwner() && conversationSearchActive(store.view.snapshot);
  const shortcuts = remoteGroup(savedAuthorized, async () => {
    const doc = await api.get('/saved-searches');
    return { hits: doc.searches.slice(0, 5) };
  }, '保存的检索读取失败：', () => [api.draftOwner(), store.view.savedSearchesRevision ?? null], true);
  function closeResults() {
    results.hidden = true;
    shortcuts.update(null);
    results.replaceChildren();
  }
  const conversations = remoteGroup(conversationSearchActive,
    async query => ({ hits: (await api.post('/project-message-search', { query, limit: 6 })).hits }), '项目对话检索失败：');
  const meetings = remoteGroup(snapshot => snapshot?.plugins?.some(p => p.id === 'knowledge-local' && p.status === 'active'),
    async query => ({ hits: (await api.get('/knowledge/meeting-search?' + new URLSearchParams({ query }))).meetings }), '会议检索失败：');

  function fileProject() {
    const { page, parts } = router.current;
    const id = page === 'projects' ? parts[0] : page === 'chat' ? scope.get() : '';
    return store.view.snapshot?.projects?.find(project => project.id === id && project.workspace && !project.archivedAt);
  }
  const files = remoteGroup(snapshot => conversationSearchActive(snapshot) && Boolean(fileProject()), async query => {
    const project = fileProject();
    const params = new URLSearchParams({ kind: 'search', query });
    const result = await api.get(`/projects/${encodeURIComponent(project.id)}/code?${params}`);
    return { truncated: result.truncated, hits: result.paths.map(path => ({
      text: markedPath(path, query), filePath: path, href: router.href('projects', project.id, 'workspace') + '?' + new URLSearchParams({ file: path }),
    })) };
  }, '项目文件检索失败：', () => {
    const project = fileProject();
    return project && [project.id, project.workspace.machineId, project.workspace.cwd];
  });

  function chatHits(query, messages, limit = 6, role = '', day = '') {
    const hits = [];
    const dayFormat = day && new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    // 快照按消息插入顺序排列。只搜索主对话气泡的正文，不读取工具进展或通知详情。
    for (let i = messages.length - 1; i >= 0 && hits.length < limit; i--) {
      const message = messages[i];
      if (role && message.role !== role) continue;
      if (dayFormat) {
        const instant = Date.parse(message.createdAt);
        if (!Number.isFinite(instant) || dayFormat.format(instant).padStart(10, '0') !== day) continue;
      }
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

  function meetingLinks(rows, snapshot) {
    return rows.flatMap(row => {
      const project = row.projectId && snapshot.projects?.find(p => p.id === row.projectId && !p.archivedAt);
      if (row.projectId && !project) return [];
      const page = row.pages.find(p => snapshot.knowledge?.some(entry => entry.id === p.id && entry.projectId === row.projectId));
      const params = page ? { entry: page.id, source: row.sourceId } : { curator: '1', job: row.sourceId };
      return [{ text: [row.title, ' · ', project?.name || '个人记忆', ' · ', row.startedAt || '日期未注明'],
        href: router.href('memory') + '?' + new URLSearchParams(params) }];
    });
  }

  function messageLinks(rows, snapshot) {
    return rows.flatMap(hit => {
      const project = snapshot.projects?.find(p => !p.archivedAt && p.id === hit.projectId);
      if (!project) return [];
      return [{ text: [project.name + ' · ' + (hit.role === 'user' ? '你' : '项目助手') + ' · ', hit.before,
        h('mark', null, hit.match), hit.after], href: router.href('projects', project.id, 'workspace') + '?at=' + encodeURIComponent(hit.id) }];
    });
  }

  function runLinks(query, snapshot) {
    return searchRunHits(query, snapshot).map(({ run, excerpt }) => ({
      text: excerpt ? [run.prompt, ' · ', excerpt] : run.prompt,
      href: router.href('projects', run.projectId || 'all', 'runs', run.id),
    }));
  }

  function openResults(query, kind) {
    results.hidden = true;
    const isMeeting = kind === '会议';
    const isRun = kind === '执行记录';
    const fromSnapshot = isRun || kind === '主对话消息';
    let visibleLimit = 25, generation = 0;
    const role = h('select', {}, h('option', { value: '' }, '全部'), h('option', { value: 'user' }, '用户'), h('option', { value: 'assistant' }, '助手'));
    const roleFilter = !isRun && !isMeeting && h('label', { class: 'row' }, '发言角色', role);
    const day = h('input', { type: 'date' });
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dayFilter = !isRun && !isMeeting && h('label', { class: 'row' }, '发言日期（' + timeZone + '）', day);
    const projectSelect = !fromSnapshot && h('select', {}, h('option', { value: '' }, isMeeting ? '全部项目及个人' : '全部项目'),
      store.view.snapshot.projects.filter(project => !project.archivedAt).map(project => h('option', { value: project.id }, project.name)));
    const projectFilter = projectSelect && h('label', { class: 'row' }, isMeeting ? '会议所属项目' : '对话所属项目', projectSelect);
    const moreLabel = '查看更多' + kind;
    const owner = api.draftOwner();
    const current = () => drawer.el.open && api.draftOwner() === owner && store.view.snapshotOwner === owner &&
      !store.view.unauthorized && store.view.snapshot?.plugins?.some(p => p.id === (isMeeting ? 'knowledge-local' : 'conversation-search') && p.status === 'active');
    const status = h('p', { role: 'status' });
    const list = h('div', { class: 'stack' });
    const rows = new Map();
    let cursor = isMeeting ? 0 : undefined;
    const more = Button({ label: moreLabel, size: 'sm', onClick: load });
    let signature;
    function render() {
      if (!current()) { drawer.close(); return; }
      const snapshot = store.view.snapshot;
      let links;
      if (fromSnapshot) {
        links = isRun ? runLinks(query, snapshot) : chatHits(query, snapshot.messages ?? [], visibleLimit + 1, role.value, day.value);
        more.hidden = links.length <= visibleLimit;
        links = links.slice(0, visibleLimit);
        status.textContent = '已显示 ' + links.length + (isRun ? ' 条执行记录' : ' 条消息');
      } else {
        links = (isMeeting ? meetingLinks : messageLinks)([...rows.values()], snapshot);
      }
      const next = JSON.stringify(links, (_key, value) => value instanceof Node ? value.textContent : value);
      if (next === signature) return;
      signature = next;
      const focusedHref = list.contains(document.activeElement) && document.activeElement.getAttribute('href');
      replace(list, links.map(hit =>
        h('a', { href: hit.href, onclick: event => {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); drawer.close(); input.value = ''; router.go(hit.href);
        } }, hit.text)));
      if (focusedHref) [...list.children].find(link => link.getAttribute('href') === focusedHref)?.focus({ preventScroll: true });
    }
    async function load() {
      if (!current() || more.disabled || cursor === null) return;
      if (fromSnapshot) {
        visibleLimit += 25;
        render();
        return;
      }
      const stamp = generation;
      more.disabled = true;
      status.textContent = '正在读取' + kind + '…';
      try {
        const projectScope = projectSelect.value ? { projectId: projectSelect.value } : {};
        const reply = isMeeting
          ? await api.get('/knowledge/meeting-search?' + new URLSearchParams({ query, offset: String(cursor), ...projectScope }))
          : await api.post('/project-message-search', { query, ...projectScope, before: cursor, limit: 25, ...(role.value && { role: role.value }), ...(day.value && { sentDay: day.value, timeZone }) });
        if (!current() || stamp !== generation) return;
        for (const row of (isMeeting ? reply.meetings : reply.hits)) rows.set(isMeeting ? row.sourceId : row.id, row);
        render();
        more.textContent = moreLabel;
        cursor = isMeeting ? reply.nextOffset : reply.nextBefore;
        more.hidden = cursor === null;
        const count = list.childElementCount;
        if (isMeeting) status.textContent = reply.total ? '已显示 ' + count + ' / ' + reply.total + ' 场会议' : '没有匹配的会议';
        else status.textContent = '已显示 ' + count + ' 条消息';
      } catch (error) {
        if (stamp === generation && current()) { status.textContent = kind + '检索失败：' + error.message; more.textContent = '重试'; more.hidden = false; }
      } finally { if (stamp === generation) more.disabled = false; }
    }
    function changeFilter() {
      generation++;
      visibleLimit = 25;
      rows.clear();
      cursor = isMeeting ? 0 : undefined;
      more.disabled = false;
      more.hidden = true;
      render();
      if (!fromSnapshot) void load();
    }
    if (projectSelect) projectSelect.addEventListener('change', changeFilter);
    role.addEventListener('change', changeFilter);
    day.addEventListener('change', changeFilter);
    const drawer = openDrawer({ title: kind + '搜索结果', subtitle: query, body: [projectFilter, roleFilter, dayFilter, status, list, more], onClose: () => unsubscribe() });
    const unsubscribe = store.subscribe(render);
    if (fromSnapshot) render();
    else void load();
  }

  function groups(query, snapshot) {
    const folded = query.toLowerCase();
    const match = (...values) => values.some(value => String(value ?? '').toLowerCase().includes(folded));
    const projectKey = item => item.projectId || 'all';
    const pluginActive = conversationSearchActive(snapshot);
    const runs = pluginActive ? runLinks(query, snapshot)
      : (snapshot.runs ?? []).filter(item => match(item.prompt, item.output)).map(item => ({ text: item.prompt, href: router.href('projects', projectKey(item), 'runs', item.id) }));
    return [
      ['主对话', pluginActive ? chatHits(query, snapshot.messages ?? []) : []],
      ['项目工作对话', messageLinks(conversations.state.hits, snapshot)],
      ['待办', (snapshot.todos ?? []).filter(item => match(item.title, item.notes)).map(item => ({ text: item.title, href: router.href('projects', projectKey(item), 'todos', 'detail', item.id) }))],
      ['执行', runs],
      ['会议', meetingLinks(meetings.state.hits, snapshot)],
      ['记忆', (snapshot.knowledge ?? []).filter(item => match(item.title, item.content)).map(item => ({ text: item.title, href: `${router.href('memory')}?entry=${encodeURIComponent(item.id)}` }))],
      ['项目', (snapshot.projects ?? []).filter(item => !item.archivedAt && match(item.name, item.description)).map(item => ({ text: item.name, href: router.href('projects', item.id, 'todos') }))],
      ['项目文件', files.state.hits],
    ].filter(([, hits]) => hits.length);
  }

  function paint(refresh = false) {
    const query = input.value.trim();
    const snapshot = store.view.snapshot;
    const savedEnabled = savedAuthorized();
    conversations.update(query, refresh === true);
    meetings.update(query, refresh === true);
    files.update(query, refresh === true);
    const searches = [conversations.state, meetings.state, files.state];
    results.hidden = !snapshot || store.view.unauthorized || (!query && !savedEnabled);
    if (results.hidden) { closeResults(); return; }
    shortcuts.update(query ? null : '', refresh === true);
    // A delayed project search or snapshot refresh can insert a group above the focused link.
    const focused = results.contains(document.activeElement) ? document.activeElement : null;
    const href = focused?.getAttribute('href');
    const action = focused?.tagName === 'BUTTON' ? focused.textContent : null;
    const found = query ? groups(query, snapshot) : [];
    const apply = value => { input.value = value; input.focus(); paint(); };
    const openFilters = () => {
      const owner = api.draftOwner();
      closeResults();
      openRunFilters({ query, snapshot, store, onApply: apply, authorized: () => api.draftOwner() === owner &&
        store.view.snapshotOwner === owner && conversationSearchActive(store.view.snapshot) && !store.view.unauthorized });
    };
    const open = initialQuery => {
      closeResults();
      openSavedSearches({
        api, store, initialQuery, isEnabled: savedAuthorized,
        onApply: apply,
      });
    };
    replace(results, query && !found.length && !searches.some(group => group.pending || group.error) && h('p', { class: 'search__group' }, '没有找到匹配的内容'), searches.map(group => group.error && h('p', { class: 'search__group' }, group.error)), found.map(([name, hits]) => [
      h('div', { class: 'search__group' }, name),
      (name === '项目文件' ? hits : hits.slice(0, 5)).map(hit => h('a', { class: 'search__hit truncate', href: hit.href,
        ...(hit.filePath && { dataset: { filePath: hit.filePath }, 'aria-label': hit.filePath, title: hit.filePath + ' · Ctrl/⌘+Enter 复制文件引用' }), onclick: event => {
        input.value = ''; results.hidden = true;
        if (hit.href === location.hash && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
          event.preventDefault(); router.go(hit.href);
        }
      } }, hit.text)),
      name === '执行' && savedEnabled && hits.length > 5 && Button({ label: '查看全部匹配执行', size: 'sm', onClick: () => openResults(query, '执行记录') }),
      name === '主对话' && hits.length > 5 && Button({ label: '查看全部主对话消息', size: 'sm', onClick: () => openResults(query, '主对话消息') }),
      name === '项目工作对话' && hits.length > 5 && Button({ label: '查看全部匹配消息', size: 'sm', onClick: () => openResults(query, '消息') }),
      name === '会议' && hits.length > 5 && Button({ label: '查看全部匹配会议', size: 'sm', onClick: () => openResults(query, '会议') }),
    ]), files.state.pending && h('p', { class: 'search__group', role: 'status' }, '正在检索项目文件…'),
    [[conversations, '重试项目对话检索'], [meetings, '重试会议检索'], [files, '重试文件检索']].map(([group, label]) =>
      group.state.error && Button({ label, size: 'sm', onClick: () => { group.update(query, true); paint(); } })),
    files.state.truncated && h('p', { class: 'search__group' }, '文件检索达到上限，可能还有其他匹配。'),
    !query && shortcuts.state.hits.length > 0 && h('div', { class: 'search__group' }, '保存的检索'),
    !query && shortcuts.state.hits.map(item => h('button', { class: 'search__hit saved-search-apply', type: 'button',
      'aria-label': '套用 ' + item.name, onclick() {
        if (!results.hidden && !input.value.trim() && savedAuthorized() && shortcuts.state.hits.includes(item)) {
          appliedShortcut = { owner: api.draftOwner(), query: item.query };
          apply(item.query);
        }
      } }, h('strong', null, item.name), h('span', { class: 'muted small' }, item.query))),
    !query && shortcuts.state.error && h('p', { class: 'search__group', role: 'status' }, shortcuts.state.error),
    savedEnabled && h('div', { class: 'saved-search-actions' },
      Button({ label: '筛选执行记录', size: 'sm', onClick: openFilters }),
      query && h('button', { class: 'btn btn--sm', type: 'button', onclick: () => open(query) }, '保存当前检索'),
      h('button', { class: 'btn btn--sm', type: 'button', onclick: () => open() }, '管理保存的检索')));
    if (focused) {
      const replacement = href ? [...results.querySelectorAll('a')].find(link => link.getAttribute('href') === href)
        : [...results.querySelectorAll('button')].find(button => button.textContent === action);
      (replacement ?? input).focus({ preventScroll: true });
    }
  }

  function refreshContext() {
    const { snapshot, unauthorized } = store.view;
    if (appliedShortcut && (!savedAuthorized() || appliedShortcut.owner !== api.draftOwner())) {
      if (input.value === appliedShortcut.query) input.value = '';
      appliedShortcut = undefined;
    }
    const types = ['待办', '执行', '记忆'];
    if (!unauthorized && snapshot?.plugins?.some(p => p.id === 'knowledge-local' && p.status === 'active')) types.push('会议');
    if (!unauthorized && conversationSearchActive(snapshot)) types.unshift('对话');
    if (!unauthorized && conversationSearchActive(snapshot) && fileProject()) types.push('文件');
    const label = '搜索' + types.join('、') + '与项目';
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    if (!snapshot || unauthorized) {
      conversations.update(''); meetings.update(''); files.update('');
      closeResults();
    } else if (document.activeElement === input || !results.hidden) paint();
  }
  store.subscribe(refreshContext);
  router.subscribe(refreshContext);
  scope.subscribe(refreshContext);
  input.addEventListener('input', () => { appliedShortcut = undefined; paint(); });
  input.addEventListener('focus', () => paint(true));
  function navigate(event) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return;
    if (event.ctrlKey || event.metaKey) {
      const hit = event.target === input ? results.querySelector('.search__hit') : event.target;
      if (!results.hidden && event.key === 'Enter' && hit?.dataset.filePath) {
        event.preventDefault();
        void copyText('@' + hit.dataset.filePath).then(() => toast('已复制文件引用。'), () => toast('无法复制文件引用。', 'danger'));
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.target.blur();
      closeResults();
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
  const search = input.closest('.search');
  // A retry can replace its own button before the click reaches the document.
  document.addEventListener('click', event => { if (!event.composedPath().includes(search)) closeResults(); });
}

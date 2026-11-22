// 提示词只在打开管理抽屉或输入 / 时读取。选择候选项只填写当前输入框。
import { h, replace } from '../lib/dom.js';
import { Button, Field, Input, TextArea } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const active = store => !store.view.unauthorized && !!store.view.snapshot?.plugins?.some(
  plugin => plugin.id === 'saved-prompts' && plugin.status === 'active');
const post = (api, body) => api.post('/saved-prompts', body);

// Preserve the user's order within each match group, including the bare "/" list.
function matchingPrompts(items, filter) {
  if (!filter) return items.slice(0, 25);
  const exact = [], prefix = [], substring = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name === filter) exact.push(item);
    else if (name.startsWith(filter)) prefix.push(item);
    else if (name.includes(filter)) substring.push(item);
  }
  return [...exact, ...prefix, ...substring].slice(0, 25);
}

function suggestedName(text, items) {
  const words = text.trim().match(/[\p{L}\p{Nd}\p{Mn}_.-]+/gu) ?? [];
  const base = [...words.join('-')].slice(0, 20).join('').replace(/-+$/, '').toLowerCase() || 'prompt';
  const existing = new Set(items.map(item => item.name.toLowerCase()));
  let name = base;
  for (let i = 2; existing.has(name); i++) name = base + '-' + i;
  return name;
}

// 列表事件只含版本。断线重连后再读取当前版本，补上断线期间的变更。
function watchChanges(store, onChange) {
  let revision = store.view.savedPromptsRevision, connection = store.view.connection;
  return store.subscribe(view => {
    const changed = revision !== view.savedPromptsRevision || (view.connection === 'online' && connection !== 'online');
    revision = view.savedPromptsRevision;
    connection = view.connection;
    if (changed) onChange();
  });
}

export function openSavedPrompts({ api, store, initialText, isCurrent = () => true }) {
  if (!active(store) || !isCurrent()) return;
  const token = api.token();
  let doc, draft, busy = false, stale = false, error = '';
  const drawer = openDrawer({ title: '常用提示词', onClose() { unsubscribe(); unwatch(); } });
  const current = () => drawer.el.open && token === api.token() && active(store) && isCurrent();
  const unsubscribe = store.subscribe(() => { if (!current()) drawer.close(); });

  let pendingRefresh = false;
  const conflict = h('div', { role: 'status', class: 'stack' });
  const unwatch = watchChanges(store, () => {
    if (!current()) return;
    if (busy) { pendingRefresh = true; return; }
    if (draft) {
      // 继续编辑原版本，保存时服务端会校验。这里不重绘表单，以保留焦点和选区。
      replace(conflict, '列表可能已更新。可保留草稿并读取最新版本。', Button({ label: '刷新列表', onClick: () => request() }));
    } else void request();
  });

  async function request(change) {
    if (busy || !current() || (change && stale)) return;
    busy = true;
    conflict.replaceChildren();
    error = '';
    draw();
    try {
      const next = await post(api, change ? { ...change, revision: doc.revision } : { action: 'list' });
      if (!current()) return;
      if (!doc && initialText !== undefined) draft = { name: suggestedName(initialText, next.items), text: initialText };
      if (change) draft = undefined;
      doc = next;
      stale = false;
    } catch (cause) {
      if (!current()) return;
      error = cause.message;
      const conflict = cause.status === 409 && !cause.message.includes('名称');
      if (change && (conflict || !cause.status || cause.status >= 500)) stale = true;
    } finally {
      busy = false;
      if (current()) {
        draw();
        if (pendingRefresh && !error && doc && store.view.savedPromptsRevision > doc.revision) {
          if (draft) replace(conflict, '列表已更新。保存时会核对版本。');
          else { pendingRefresh = false; void request(); }
        }
        pendingRefresh = false;
      }
    }
  }
  function edit(item) {
    draft = item ? { ...item } : { name: '', text: '' };
    error = '';
    draw();
    drawer.body.querySelector('input')?.focus();
  }
  function editor() {
    const name = Input({ required: true, value: draft.name, disabled: busy, oninput: e => { draft.name = e.target.value; } });
    const body = TextArea({ required: true, rows: 6, value: draft.text, disabled: busy, oninput: e => { draft.text = e.target.value; } });
    const exists = doc.items.some(item => item.id === draft.id);
    const gone = draft.id && !exists;
    return h('form', { class: 'stack', onsubmit(event) {
      event.preventDefault();
      const data = { name: draft.name.trim().replace(/^\//, ''), text: draft.text.trim() };
      void request(exists ? { action: 'update', id: draft.id, ...data } : { action: 'create', ...data });
    } },
    Field({ label: '名称', control: name, hint: '最多 32 个字符，可使用字母、汉字、数字、点、下划线和短横线。' }),
    Field({ label: '提示词正文', control: body, hint: '最多 8000 个字符。' }),
    gone && h('p', { role: 'status' }, '原提示词已删除，可将草稿另存为新提示词。'),
    h('div', { class: 'row row--wrap' },
      Button({ label: gone ? '另存为新提示词' : '保存', kind: 'primary', type: 'submit', disabled: busy || stale }),
      Button({ label: '取消', disabled: busy, onClick() { draft = undefined; error = ''; draw(); } })));
  }
  function move(index, direction) {
    const ids = doc.items.map(item => item.id);
    const next = index + direction;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    return request({ action: 'reorder', ids });
  }
  function list() {
    return h('div', { class: 'stack' },
      Button({ label: '新增提示词', disabled: busy || stale, onClick: () => edit() }),
      !doc.items.length && h('p', { class: 'muted' }, '还没有常用提示词。在输入框键入 / 可选择已保存的提示词。'),
      doc.items.map((item, index) => {
        const action = (label, onClick, atEnd = false) => Button({ label, size: 'sm',
          ariaLabel: label + ' ' + item.name, disabled: busy || stale || atEnd, onClick });
        return h('article', { class: 'card' }, h('div', { class: 'card__body stack' },
          h('strong', null, '/' + item.name), h('pre', { class: 'mailbox-content' }, item.text),
          h('div', { class: 'row row--wrap' },
            action('编辑', () => edit(item)), action('上移', () => move(index, -1), index === 0),
            action('下移', () => move(index, 1), index === doc.items.length - 1),
            action('删除', () => request({ action: 'remove', id: item.id })))));
      }));
  }
  function draw() {
    replace(drawer.body, conflict, error && h('p', { role: 'alert' }, error),
      stale && h('p', { role: 'status' }, '请刷新提示词列表后核对并重试。'),
      (stale || (!doc && !busy)) && Button({ label: '刷新列表', disabled: busy, onClick: () => request() }),
      doc ? (draft ? editor() : list()) : busy && h('p', { role: 'status' }, '正在读取提示词…'));
  }
  void request();
  return drawer;
}

export function attachSavedPrompts({ api, store, input, getScope = () => '' }) {
  let disposed = false;
  let token, enabled = false, epoch = 0, read = 0, items, matches = [], selected = 0, inserting = false, drawer;
  const menu = h('div', { hidden: true, role: 'group', 'aria-label': '提示词候选', class: 'stack',
    style: { maxHeight: 'min(24vh, 220px)', overflowY: 'auto' } });
  const manage = Button({ label: '常用提示词', size: 'sm', title: '管理提示词，在输入框键入 / 选择提示词', onClick: () => open() });

  function reset() {
    read++;
    items = undefined;
    matches = [];
    selected = 0;
    menu.hidden = true;
    menu.replaceChildren();
  }
  function changeScope() {
    epoch++;
    reset();
    drawer?.close();
  }
  function update() {
    const next = active(store);
    if (token === api.token() && enabled === next) return;
    token = api.token();
    enabled = next;
    manage.hidden = !enabled;
    changeScope();
  }
  const unsubscribe = store.subscribe(update);
  update();
  function owner() {
    const stamp = epoch, scope = getScope(), hash = location.hash;
    return () => !disposed && stamp === epoch && token === api.token() && active(store) && scope === getScope() && hash === location.hash;
  }
  function open(initialText) {
    const current = owner();
    reset();
    drawer = openSavedPrompts({ api, store, initialText, isCurrent: current });
  }
  function fromMessage(message) {
    if (!enabled || message.role !== 'user' || !message.text?.trim() || (message.origin && message.origin !== 'user')) return null;
    const credential = api.token();
    return Button({ label: '保存为提示词', kind: 'ghost', size: 'sm', onClick: (_, button) => {
      if (!disposed && button.isConnected && api.token() === credential && active(store)) open(message.text);
    } });
  }

  function choose(item) {
    reset();
    inserting = true;
    input.value = item.text;
    input.focus();
    input.setSelectionRange(item.text.length, item.text.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    inserting = false;
  }
  const query = () => /^\/[\p{L}\p{Nd}\p{Mn}_.-]*$/u.test(input.value) ? input.value.slice(1).toLowerCase() : null;
  let validMenu;
  function draw() {
    if (!validMenu?.()) { reset(); return; }
    const filter = query();
    if (filter === null) { reset(); return; }
    matches = matchingPrompts(items, filter);
    selected = Math.min(selected, Math.max(0, matches.length - 1));
    replace(menu, matches.length ? matches.map((item, index) =>
      Button({ label: '/' + item.name, kind: index === selected ? 'primary' : 'secondary', size: 'sm', onClick() {
        if (validMenu?.() && query() !== null) choose(item);
      } })) : h('p', { class: 'small muted' }, '没有匹配的提示词。'));
  }
  async function suggest() {
    if (disposed || inserting || !enabled || query() === null) { reset(); return; }
    selected = 0;
    if (!menu.hidden) { if (items) draw(); return; }
    const order = ++read, current = owner();
    validMenu = () => order === read && current();
    menu.hidden = false;
    replace(menu, h('p', { class: 'small muted' }, '正在读取提示词…'));
    try {
      const doc = await post(api, { action: 'list' });
      if (order !== read || !current()) return;
      items = doc.items;
      draw();
    } catch (cause) {
      if (order === read && current()) { items = []; replace(menu, h('p', { role: 'alert' }, cause.message)); }
    }
  }
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  input.addEventListener('input', suggest, options);
  input.addEventListener('focus', suggest, options);
  function leave(event) {
    if (event.relatedTarget !== input && !menu.contains(event.relatedTarget)) reset();
  }
  input.addEventListener('blur', leave, options);
  menu.addEventListener('focusout', leave, options);
  input.addEventListener('keydown', event => {
    if (menu.hidden || !validMenu?.() || event.isComposing || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') { event.preventDefault(); reset(); }
    if (matches.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      draw();
      menu.children[selected]?.scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter' && (!items || matches.length)) {
      event.preventDefault();
      if (matches.length) choose(matches[selected]);
    }
  }, options);
  const unwatch = watchChanges(store, () => {
    if (menu.hidden) return;
    reset();
    if (document.activeElement === input) void suggest();
  });
  window.addEventListener('hashchange', reset);
  function dispose() {
    disposed = true;
    listeners.abort();
    changeScope();
    unsubscribe();
    unwatch();
    window.removeEventListener('hashchange', reset);
  }
  return { dispose, manage, menu, changeScope, reset, fromMessage, get epoch() { return epoch; } };
}

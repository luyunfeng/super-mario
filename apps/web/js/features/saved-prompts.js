// 提示词只在打开管理抽屉或输入 / 时读取。选择候选项只填写当前输入框。
import { h, replace } from '../lib/dom.js';
import { Button, Field, Input, TextArea } from '../ui/kit.js';
import { openDrawer, toast } from '../ui/overlay.js';

export const savedPromptsActive = (store, assistantId) => {
  const enabled = id => store.view.snapshot?.plugins?.some(plugin => plugin.id === id && plugin.status === 'active');
  return !store.view.unauthorized && enabled('saved-prompts') && (!assistantId || enabled('assistant-profile'));
};
const post = (api, body, assistantId) => api.post('/saved-prompts' + (assistantId ? '?' + new URLSearchParams({assistantId}) : ''), body);

// Names and slash queries allow only letters, marks, digits, underscores, dots and hyphens.
function promptNamePattern(name, exact = false) {
  const literal = name.replaceAll('.', '\\.');
  return new RegExp(exact ? '^' + literal + '$' : literal, 'iu');
}

// Preserve the user's order within each match group, including the bare "/" list.
function matchingPrompts(items, filter) {
  if (!filter) return items;
  const exact = [], prefix = [], substring = [];
  const pattern = promptNamePattern(filter);
  for (const item of items) {
    const match = pattern.exec(item.name);
    if (!match) continue;
    if (match[0] === item.name) exact.push(item);
    else if (match.index === 0) prefix.push(item);
    else substring.push(item);
  }
  return [...exact, ...prefix, ...substring];
}

function suggestedName(text, items) {
  const words = text.trim().match(/[\p{L}\p{Nd}\p{Mn}_.-]+/gu) ?? [];
  const base = [...words.join('-')].slice(0, 20).join('').replace(/-+$/, '').toLowerCase() || 'prompt';
  const taken = candidate => {
    const pattern = promptNamePattern(candidate, true);
    return items.some(item => pattern.test(item.name));
  };
  let name = base;
  for (let i = 2; taken(name); i++) name = base + '-' + i;
  return name;
}

// 列表事件只含版本。断线重连后再读取当前版本，补上断线期间的变更。
function watchChanges(store, getAssistantId, onChange) {
  let last = store.view.savedPromptsChange, connection = store.view.connection;
  return store.subscribe(view => {
    const event = view.savedPromptsChange;
    const changed = event && event !== last && event.assistantId === getAssistantId();
    const reconnected = view.connection === 'online' && connection !== 'online';
    last = event;
    connection = view.connection;
    if (changed || reconnected) onChange(reconnected ? Infinity : event.revision);
  });
}

export function openSavedPrompts({ api, store, initialText, assistantId, assistantName, isCurrent = () => true }) {
  if (!savedPromptsActive(store, assistantId) || !isCurrent()) return;
  const token = api.token();
  let writing = false;
  let doc, draft, deleting, busy = false, stale = false, error = '';
  const drawer = openDrawer({ title: '常用提示词', subtitle: assistantName, canDismiss: () => !writing, onClose() { unsubscribe(); unwatch(); } });
  const current = () => drawer.el.open && token === api.token() && savedPromptsActive(store, assistantId) && isCurrent();
  const unsubscribe = store.subscribe(() => { if (!current()) drawer.close(); });

  let pendingRevision = -1;
  const conflict = h('div', { role: 'status', class: 'stack' });
  const unwatch = watchChanges(store, () => assistantId, revision => {
    if (!current()) return;
    if (busy) { pendingRevision = Math.max(pendingRevision, revision); return; }
    if (draft) {
      // 继续编辑原版本，保存时服务端会校验。这里不重绘表单，以保留焦点和选区。
      replace(conflict, '列表可能已更新。可保留草稿并读取最新版本。', Button({ label: '刷新列表', onClick: () => request() }));
    } else void request();
  });

  async function request(change) {
    if (busy || !current() || (change && stale)) return;
    const openingFromMessage = !doc && initialText !== undefined;
    deleting = undefined;
    busy = true;
    writing = Boolean(change);
    conflict.replaceChildren();
    error = '';
    draw();
    try {
      const next = await post(api, change ? { ...change, revision: doc.revision } : { action: 'list' }, assistantId);
      if (!current()) return;
      if (openingFromMessage) draft = { name: suggestedName(initialText, next.items), text: initialText };
      if (change) {
        const previous = doc.items.find(item => item.id === change.id);
        if (change.action === 'remove' && previous) toast('已删除 /' + previous.name);
        if (change.action === 'create' || change.action === 'update') {
          const saved = change.action === 'update' ? next.items.find(item => item.id === change.id)
            : next.items.find(item => !doc.items.some(old => old.id === item.id));
          if (saved) toast((change.action === 'create' ? '已保存 /' : '已更新 /') + saved.name);
        }
        draft = undefined;
      }
      doc = next;
      stale = false;
    } catch (cause) {
      if (!current()) return;
      if (cause.status === 401) { drawer.close(); return; }
      error = cause.message;
      const conflict = cause.status === 409 && !cause.message.includes('名称');
      if (change && (conflict || !cause.status || cause.status >= 500)) stale = true;
    } finally {
      busy = false;
      writing = false;
      if (current()) {
        draw();
        if (openingFromMessage && doc) {
          const body = drawer.body.querySelector('textarea');
          body?.focus();
          body?.setSelectionRange(body.value.length, body.value.length);
        }
        if (!error && doc && pendingRevision > doc.revision) {
          if (draft) replace(conflict, '列表已更新。保存时会核对版本。');
          else { pendingRevision = -1; void request(); }
        }
        pendingRevision = -1;
      }
    }
  }
  function edit(item) {
    deleting = undefined;
    draft = item ? { ...item, originalName: item.name, originalText: item.text } : { name: '', text: '' };
    error = '';
    draw();
    drawer.body.querySelector('input')?.focus();
  }
  function editor() {
    const name = Input({ required: true, value: draft.name, disabled: busy, autocomplete: 'off', autocapitalize: 'none', spellcheck: false, placeholder: '例如：审查改动' });
    const body = TextArea({ required: true, rows: 6, value: draft.text, disabled: busy, placeholder: '例如：审查本次改动，列出需要修正的位置和原因。' });
    const exists = doc.items.find(item => item.id === draft.id);
    const changed = exists && (exists.name !== draft.originalName || exists.text !== draft.originalText);
    const gone = draft.id && !exists;
    const full = !exists && doc.items.length >= 100;
    const nameHint = h('span'), bodyHint = h('span');
    const form = h('form', { class: 'stack', oninput: validate, onsubmit(event) {
      event.preventDefault();
      if (busy || stale || full || !form.reportValidity()) return;
      const data = { name: draft.name, text: draft.text };
      void request(exists ? { action: 'update', id: draft.id, ...data } : { action: 'create', ...data });
    }, onkeydown(event) {
      if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    } },
    changed && h('section', { class: 'stack', 'aria-label': '当前保存的版本' },
      h('strong', null, '当前保存的版本 · /' + exists.name), h('pre', { class: 'mailbox-content' }, exists.text)),
    Field({ label: '名称', control: name, hint: nameHint }),
    Field({ label: '提示词正文', control: body, hint: bodyHint }),
    full && h('p', { role: 'status' }, '已保存 100 条提示词。请先删除一条，再新增。'),
    gone && h('p', { role: 'status' }, '原提示词已删除，可将草稿另存为新提示词。'),
    h('div', { class: 'row row--wrap' },
      Button({ label: gone ? '另存为新提示词' : '保存', kind: 'primary', type: 'submit', disabled: busy || stale || full }),
      Button({ label: '取消', disabled: busy, onClick() { draft = undefined; error = ''; draw(); } })));
    for (const [input, hint] of [[name, nameHint], [body, bodyHint]]) {
      hint.id = input.id + '-hint';
      input.setAttribute('aria-describedby', hint.id);
    }
    function validate() {
      draft.name = name.value;
      draft.text = body.value;
      const trim = /^\p{White_Space}+|(?<!\p{White_Space})\p{White_Space}+$/gu;
      const label = name.value.replace(trim, '').replace(/^\//, '');
      const text = body.value.replace(trim, '');
      const count = [...text].length;
      let nameError = '', bodyError = '';
      if (!/^[\p{L}\p{Nd}\p{Mn}_.-]{1,32}$/u.test(label)) nameError = '请输入 1 至 32 个字母、汉字、组合标记、数字、点、下划线或短横线。';
      else {
        const same = promptNamePattern(label, true);
        if (doc.items.some(item => item.id !== draft.id && same.test(item.name))) nameError = '提示词名称已被使用。';
      }
      if (!count || count > 8000) bodyError = '正文须为 1 至 8000 个字符。';
      else if (/(?![\n\t])[\p{Cc}\p{Cs}]/u.test(text)) bodyError = '正文中的控制字符仅支持换行和制表符。';
      name.setCustomValidity(nameError);
      body.setCustomValidity(bodyError);
      name.setAttribute('aria-invalid', String(Boolean(name.value && nameError)));
      body.setAttribute('aria-invalid', String(Boolean(body.value && bodyError)));
      nameHint.textContent = nameError || '在输入框键入 /' + label + ' 可选择此模板。';
      bodyHint.textContent = (bodyError || '选取后会填入对话草稿，可编辑后发送。最多 8000 个字符。') + (count > 6400 ? ' 当前 ' + count + ' / 8000' : '');
    }
    validate();
    return form;
  }
  function move(index, direction) {
    const ids = doc.items.map(item => item.id);
    const next = index + direction;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    return request({ action: 'reorder', ids });
  }
  function list() {
    return h('div', { class: 'stack' },
      h('p', { class: 'muted' }, '已保存 ' + doc.items.length + ' / 100 条。上移或下移可调整斜杠菜单中的顺序。'),
      Button({ label: '新增提示词', disabled: busy || stale || doc.items.length >= 100, onClick: () => edit() }),
      !doc.items.length && h('p', { class: 'muted' }, '还没有常用提示词。在输入框键入 / 可选择已保存的提示词。'),
      doc.items.map((item, index) => {
        const action = (label, onClick, atEnd = false) => Button({ label, size: 'sm',
          ariaLabel: label + ' ' + item.name, disabled: busy || stale || atEnd, onClick });
        return h('article', { class: 'card' }, h('div', { class: 'card__body stack' },
          h('strong', null, '/' + item.name), h('pre', { class: 'mailbox-content' }, item.text),
          deleting === item.id ? h('div', { class: 'row row--wrap' },
            action('确认删除', () => request({ action: 'remove', id: item.id })),
            action('取消', () => { deleting = undefined; draw(); })) :
          h('div', { class: 'row row--wrap' },
            action('编辑', () => edit(item)), action('上移', () => move(index, -1), index === 0),
            action('下移', () => move(index, 1), index === doc.items.length - 1),
            action('删除', () => { deleting = item.id; draw(); }))));
      }));
  }
  function draw() {
    replace(drawer.body, conflict, writing && h('p', { role: 'status' }, '正在保存更改…'), error && h('p', { role: 'alert' }, error),
      stale && h('p', { role: 'status' }, '请刷新提示词列表后核对并重试。'),
      (stale || (!doc && !busy)) && Button({ label: '刷新列表', disabled: busy, onClick: () => request() }),
      doc ? (draft ? editor() : list()) : busy && h('p', { role: 'status' }, '正在读取提示词…'));
  }
  void request();
  return drawer;
}

export function attachSavedPrompts({ api, store, input, getScope = () => '', getAssistantId = () => undefined }) {
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
    const next = savedPromptsActive(store, getAssistantId());
    if (token === api.token() && enabled === next) return;
    token = api.token();
    enabled = next;
    manage.hidden = !enabled;
    changeScope();
  }
  const unsubscribe = store.subscribe(update);
  update();
  function owner() {
    const stamp = epoch, scope = getScope(), assistantId = getAssistantId(), hash = location.hash;
    return () => !disposed && stamp === epoch && token === api.token() && savedPromptsActive(store, assistantId) && scope === getScope() && assistantId === getAssistantId() && hash === location.hash;
  }
  function open(initialText) {
    const current = owner();
    reset();
    drawer = openSavedPrompts({ api, store, initialText, assistantId: getAssistantId(), isCurrent: current });
  }
  function fromMessage(message) {
    if (!enabled || message.role !== 'user' || !message.text?.trim() || (message.origin && message.origin !== 'user')) return null;
    const current = owner();
    return Button({ label: '保存为提示词', kind: 'ghost', size: 'sm', onClick: (_, button) => {
      if (button.isConnected && current()) open(message.text);
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
  const query = () => /^\/[\p{L}\p{Nd}\p{Mn}_.-]*$/u.test(input.value) ? input.value.slice(1) : null;
  let validMenu, visibleLimit = 25, matchCount = 0;
  function draw() {
    if (!validMenu?.()) { reset(); return; }
    const filter = query();
    if (filter === null) { reset(); return; }
    const results = matchingPrompts(items, filter);
    matchCount = results.length;
    matches = results.slice(0, visibleLimit);
    selected = Math.min(selected, Math.max(0, matches.length - 1));
    replace(menu, matches.length ? matches.map((item, index) =>
      Button({ label: '/' + item.name, kind: index === selected ? 'primary' : 'secondary', size: 'sm', onClick() {
        if (validMenu?.() && query() !== null) choose(item);
      } })) : h('p', { class: 'small muted' }, '没有匹配的提示词。'),
      results.length > matches.length && h('p', { class: 'small muted' }, '共匹配 ' + results.length + ' 条，已显示前 ' + matches.length + ' 条。继续输入名称可缩小范围。'),
      results.length > matches.length && Button({ label: '显示更多提示词', size: 'sm', onClick() {
        if (!validMenu?.() || query() !== filter) return;
        const firstNew = matches.length;
        input.focus();
        visibleLimit = firstNew + 25;
        selected = firstNew;
        draw();
        menu.children[selected]?.scrollIntoView({ block: 'nearest' });
      } }));
  }
  async function suggest() {
    if (disposed || inserting || !enabled || query() === null) { reset(); return; }
    selected = 0;
    visibleLimit = 25;
    if (!menu.hidden) { if (items) draw(); return; }
    const order = ++read, current = owner();
    validMenu = () => order === read && current();
    menu.hidden = false;
    replace(menu, h('p', { class: 'small muted' }, '正在读取提示词…'));
    try {
      const doc = await post(api, { action: 'list' }, getAssistantId());
      if (order !== read || !current()) return;
      items = doc.items;
      draw();
    } catch (cause) {
      if (order !== read || !current()) return;
      if (cause.status === 401) { reset(); return; }
      replace(menu, h('p', { role: 'alert' }, cause.message), Button({ label: '重新读取提示词', size: 'sm', onClick() {
        if (!validMenu?.()) return;
        input.focus();
        reset();
        void suggest();
      } }));
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
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); reset(); }
    if (matches.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + matchCount) % matchCount;
      if (selected >= visibleLimit) visibleLimit = Math.ceil((selected + 1) / 25) * 25;
      draw();
      menu.children[selected]?.scrollIntoView({ block: 'nearest' });
    }
    if ((event.key === 'Enter' && (!items || matches.length)) || (event.key === 'Tab' && matches.length)) {
      event.preventDefault();
      if (matches.length) choose(matches[selected]);
    }
  }, options);
  const unwatch = watchChanges(store, getAssistantId, () => {
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
  return { dispose, manage, menu, update, changeScope, reset, fromMessage, get epoch() { return epoch; } };
}

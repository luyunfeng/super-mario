// File suggestions operate only on the draft owned by the current project and browser identity.
import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';
import { conversationSearchActive } from './search.js';
import { attachFileDrop, sourceOf } from './file-mention-drag.js';

let nextMenu = 0;

export function attachFileMentions({ input, store, api, getProjectId }) {
  attachFileDrop({ input, store, api, getProjectId });
  const id = 'file-mentions-' + ++nextMenu;
  const menu = h('div', { id, hidden: true, role: 'listbox', 'aria-label': '文件提及候选', class: 'stack',
    style: { maxHeight: 'min(24vh, 220px)', overflowY: 'auto' } });
  const button = Button({ label: '引用文件', size: 'sm', onClick: open });
  let binding, active, dismissed, pending, timer, selected = 0, rows = [], chosenFolder, composing = false;

  function currentBinding() {
    return conversationSearchActive(store.view.snapshot) && sourceOf(api, store, getProjectId()) || '';
  }
  function close() {
    clearTimeout(timer);
    pending?.abort();
    pending = active = undefined;
    rows = [];
    selected = 0;
    menu.hidden = true;
    menu.replaceChildren();
    input.removeAttribute('aria-controls');
    input.removeAttribute('aria-activedescendant');
  }
  function update() {
    const next = currentBinding();
    button.hidden = !next;
    if (next !== binding) { binding = next; reset(); }
  }
  function reset() {
    close();
    dismissed = chosenFolder = undefined;
  }
  function token() {
    if (input.disabled || input.selectionStart !== input.selectionEnd) return;
    const end = input.selectionEnd;
    const before = input.value.slice(0, end);
    // Selecting a directory can insert spaces in its path. Keep that exact prefix
    // while navigating within it, including when typing a child filename.
    if (chosenFolder && before.startsWith(chosenFolder.prefix) && !/[\s@]/u.test(before.slice(chosenFolder.prefix.length))) {
      const start = chosenFolder.start;
      return { start, end, query: before.slice(start + 1) };
    }
    const match = /(?:^|\s)@([^\s@]*)$/u.exec(before);
    if (match) return { start: end - match[1].length - 1, end, query: match[1] };
  }
  function current(request) {
    const now = token();
    return request === active && binding && currentBinding() === binding && location.hash === request.hash &&
      now && now.start === request.start && now.end === request.end && now.query === request.query;
  }
  function open() {
    update();
    if (!binding || input.disabled) return;
    input.focus();
    if (!token()) {
      const prefix = input.value.slice(0, input.selectionStart);
      const insert = prefix && !/\s$/u.test(prefix) ? ' @' : '@';
      input.setRangeText(insert, input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    dismissed = undefined;
    suggest();
  }
  function choose(index) {
    const request = active, row = rows[index];
    if (!request || !row || !current(request)) return;
    const insert = '@' + row.path + (row.directory ? '/' : ' ');
    const end = request.end + (!row.directory && input.value[request.end] === ' ' ? 1 : 0);
    close();
    input.focus();
    input.setRangeText(insert, request.start, end, 'end');
    chosenFolder = row.directory ? { start: request.start, prefix: input.value.slice(0, input.selectionEnd) } : undefined;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function mark() {
    menu.querySelectorAll('[role=option]').forEach((el, i) => {
      el.className = 'btn btn--sm ' + (i === selected ? 'btn--primary' : 'btn--secondary');
      el.setAttribute('aria-selected', String(i === selected));
    });
    const option = menu.querySelector('[aria-selected=true]');
    if (option) input.setAttribute('aria-activedescendant', option.id);
  }
  async function load(request, signal) {
    const { query } = request, slash = query.lastIndexOf('/');
    const browse = !query || slash >= 0;
    const directory = slash >= 0 ? query.slice(0, slash) : '';
    const filter = query.slice(slash + 1).toLowerCase();
    try {
      if (query.startsWith('/') || query.split('/').includes('..')) throw new Error('请选择绑定项目内的相对路径。');
      const read = params => api('/projects/' + encodeURIComponent(request.projectId) + '/code?' + new URLSearchParams(params), { signal });
      const [listing, matches] = await Promise.all([
        read({ kind: 'tree', path: directory }),
        browse ? undefined : read({ kind: 'search', query }),
      ]);
      if (!current(request)) return;
      rows = listing.entries.filter(entry => !/[\p{Cc}]/u.test(entry.path) &&
        (!entry.name.startsWith('.') || filter.startsWith('.')) && entry.name.toLowerCase().includes(filter))
        .sort((a, b) => Number(b.directory) - Number(a.directory) ||
          Number(b.name.toLowerCase().startsWith(filter)) - Number(a.name.toLowerCase().startsWith(filter)));
      if (matches) {
        const seen = new Set(rows.map(row => row.path));
        for (const path of matches.paths) {
          if (!seen.has(path) && (filter.startsWith('.') || !path.split('/').some(part => part.startsWith('.')))) rows.push({ path, directory: false });
        }
      }
      const capped = rows.length > 50;
      if (capped) rows.length = 50;
      replace(menu, rows.map((row, i) => h('button', { type: 'button', id: id + '-' + i, role: 'option', tabIndex: -1,
        onmousedown: event => event.preventDefault(), onclick: () => choose(i) }, row.path + (row.directory ? '/' : ''))),
      !rows.length && h('span', { class: 'muted small', role: 'status' }, '没有匹配的文件。'),
      (capped || listing.truncated || matches?.truncated) && h('span', { class: 'muted small', role: 'status' }, '文件列表已截断，可缩小范围。'));
      mark();
    } catch (error) {
      if (!current(request)) return;
      replace(menu, h('span', { role: 'alert' }, error.message), Button({ label: '重试文件提及', size: 'sm',
        onClick() { if (current(request)) { input.focus(); suggest(true); } } }));
    }
  }
  function suggest(retry = false) {
    const next = token();
    if (composing || !binding || !next || document.activeElement !== input) { close(); return; }
    const key = JSON.stringify([binding, location.hash, next.start, next.end, next.query]);
    if (dismissed === key || (!retry && active?.key === key)) return;
    close();
    const request = active = { ...next, key, projectId: getProjectId(), hash: location.hash };
    pending = new AbortController();
    const { signal } = pending;
    input.setAttribute('aria-controls', id);
    menu.hidden = false;
    replace(menu, h('span', { role: 'status', class: 'muted small' }, '正在读取文件…'));
    timer = setTimeout(() => load(request, signal), 120);
  }
  input.addEventListener('input', () => { dismissed = undefined; suggest(); });
  for (const event of ['focus', 'click', 'selectionchange']) input.addEventListener(event, () => suggest());
  input.addEventListener('compositionstart', () => { composing = true; close(); });
  input.addEventListener('compositionend', () => { composing = false; suggest(); });
  input.addEventListener('keydown', event => {
    if (composing || event.isComposing || event.keyCode === 229) {
      if (event.key === 'Enter') event.stopImmediatePropagation();
      return;
    }
    if (!active || !current(active) || event.shiftKey) return;
    if (event.altKey) {
      if (event.key === 'Enter') event.preventDefault();
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissed = active.key; close(); return; }
    if (event.key === 'Enter' || (event.key === 'Tab' && rows.length)) {
      event.preventDefault();
      if (!event.metaKey && !event.ctrlKey && rows.length) choose(selected);
    }
    if (rows.length && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      selected = (selected + (event.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length;
      mark();
      menu.children[selected]?.scrollIntoView({ block: 'nearest' });
    }
  });
  function leave(event) { if (event.relatedTarget !== input && !menu.contains(event.relatedTarget)) close(); }
  input.addEventListener('blur', leave);
  menu.addEventListener('focusout', leave);
  store.subscribe(update);
  window.addEventListener('hashchange', reset);
  update();
  return { menu, button, reset, update };
}

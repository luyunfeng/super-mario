// Keep only text acknowledged by the server, under the same browser identity as drafts.
import { h, replace } from '../lib/dom.js';
import { openDrawer } from '../ui/overlay.js';

export function attachSentHistory({ input, store, context, currentConversationOnly = false }) {
  let recalled, searchDrawer;
  const prefix = owner => 'sm.sent-history.' + owner + '.';
  function entries(owner, key) {
    try {
      const value = JSON.parse(localStorage.getItem(prefix(owner) + key) || '[]');
      return value.filter(row => typeof row?.text === 'string' && Number.isFinite(row.at)).slice(-100);
    } catch { return []; }
  }
  function record({ key, owner, draft }) {
    const current = context();
    if (!current.draftsEnabled || !key || !owner || current.owner !== owner || !draft.trim()) return;
    const rows = entries(owner, key).filter(row => row.text !== draft);
    rows.push({ text: draft, at: Date.now() });
    try { localStorage.setItem(prefix(owner) + key, JSON.stringify(rows.slice(-100))); }
    catch { /* Storage limits must not affect an accepted send. */ }
  }
  function put(text) {
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.addEventListener('input', () => { recalled = undefined; });

  function search(scope) {
    const field = h('input', { class: 'input', 'aria-label': '搜索已发送内容', placeholder: '输入关键词' });
    const list = h('div', { class: 'stack' });
    let selected = 0, rows = [], unsubscribe;
    const drawer = openDrawer({ title: '已发送内容', body: [field, list], onClose() { unsubscribe?.(); if (searchDrawer === drawer) searchDrawer = undefined; } });
    searchDrawer = drawer;
    function valid() {
      const now = context();
      return drawer.el.open && input.isConnected && now.draftsEnabled && now.key === scope.key && now.owner === scope.owner;
    }
    function keys() {
      if (currentConversationOnly) return [scope.key];
      const result = [JSON.stringify(['main', ''])];
      for (const project of store.view.snapshot?.projects ?? []) {
        if (project.archivedAt) continue;
        for (const kind of ['main', 'project']) result.push(JSON.stringify([kind, project.id]));
      }
      return result;
    }
    function pick(row) {
      if (!row || !valid() || !keys().includes(row.key) ||
          !entries(scope.owner, row.key).some(entry => entry.at === row.at && entry.text === row.text)) return;
      drawer.close();
      put(row.text);
    }
    function readCandidates() {
      return keys().flatMap(key => entries(scope.owner, key).map(row => ({ ...row, key }))).sort((a, b) => b.at - a.at);
    }
    let candidates = readCandidates();
    function draw() {
      const words = field.value.toLowerCase().trim().split(/\s+/u);
      const seen = new Set();
      rows = candidates.filter(row => {
        if (seen.has(row.text) || !words.every(word => row.text.toLowerCase().includes(word))) return false;
        seen.add(row.text);
        return true;
      }).slice(0, 100);
      selected = Math.min(selected, Math.max(0, rows.length - 1));
      replace(list, rows.length ? rows.map((row, i) => h('button', { type: 'button',
        class: 'btn ' + (i === selected ? 'btn--primary' : 'btn--secondary'), onclick: () => pick(row) }, row.text.slice(0, 180))) :
        h('p', { class: 'small muted' }, '没有匹配的已发送内容。'));
    }
    let projects = store.view.snapshot?.projects;
    unsubscribe = store.subscribe(() => {
      if (!valid()) { drawer.close(); return; }
      if (projects !== store.view.snapshot?.projects) { projects = store.view.snapshot?.projects; candidates = readCandidates(); draw(); }
    });
    field.addEventListener('input', () => { selected = 0; draw(); });
    field.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;
      const ctrl = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      const bare = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      const key = e.key.toLowerCase();
      if (ctrl && key === 'g') { e.preventDefault(); drawer.close(); return; }
      const up = (bare && key === 'arrowup') || (ctrl && ['p', 'r'].includes(key));
      const down = (bare && key === 'arrowdown') || (ctrl && ['n', 's'].includes(key));
      if (rows.length && (up || down)) {
        e.preventDefault();
        selected = (selected + (up ? -1 : 1) + rows.length) % rows.length;
        for (const [i, button] of [...list.children].entries()) button.className = 'btn ' + (i === selected ? 'btn--primary' : 'btn--secondary');
        list.children[selected]?.scrollIntoView({ block: 'nearest' });
      } else if (rows.length && bare && ['Enter', 'Tab'].includes(e.key)) {
        e.preventDefault(); pick(rows[selected]);
      }
    });
    draw();
    field.focus();
  }
  input.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || input.disabled) return;
    const scope = context();
    if (!scope.draftsEnabled || !scope.key || !scope.owner || event.shiftKey || event.altKey || event.metaKey) return;
    if (event.ctrlKey && event.key.toLowerCase() === 'r') { event.preventDefault(); search(scope); return; }
    if (event.ctrlKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || input.selectionStart !== input.selectionEnd) return;
    const up = event.key === 'ArrowUp', text = input.value;
    if (text && (recalled?.text !== text || recalled.key !== scope.key || recalled.owner !== scope.owner)) return;
    if ((up ? text.slice(0, input.selectionStart) : text.slice(input.selectionEnd)).includes('\n')) return;
    const rows = entries(scope.owner, scope.key);
    const index = text ? rows.findIndex(row => row.text === text) : rows.length;
    if (!rows.length || index < 0 || (!up && index === rows.length)) return;
    event.preventDefault();
    const next = rows[Math.max(0, index + (up ? -1 : 1))]?.text ?? '';
    put(next);
    recalled = { key: scope.key, owner: scope.owner, text: next };
  });
  return { record, forget(owner,key) {
    try { localStorage.removeItem(prefix(owner)+key); } catch { /* Browser storage can be disabled. */ }
  }, reset() { recalled = undefined; searchDrawer?.close(); } };
}

// Global shortcuts only navigate, search, or open a form. Editing surfaces own their keys.
import { h, replace, readLocal, writeLocal } from '../lib/dom.js';
import { Button } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const commands = [
  ['search', '搜索', '/'], ['todo', '添加待办', 'c'], ['help', '快捷键帮助', '?'],
  ['chat', '前往对话', 'g c'], ['agent', '前往 Agent', 'g a'], ['projects', '前往项目', 'g p'],
  ['memory', '前往记忆', 'g m'], ['channels', '前往渠道', 'g h'],
  ['home', '前往首页', ''], ['inbox', '前往收件箱', ''], ['outbox', '前往发件箱', ''],
];
const storageKey = 'sm.shortcuts.v1';
const changed = 'workspace:shortcuts-changed';
const blank = () => ({ on: true, bindings: {}, disabled: {} });
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const display = chord => chord ? chord.replace('Mod+', mac ? '⌘+' : 'Ctrl+') : '未绑定';
const active = store => store.view.snapshot?.plugins?.some(p => p.id === 'shortcut-settings' && p.status === 'active');
const reserved = new Set('a c v x z y t w n r l d p s o u f g h q m'.split(' '));
const reservedShift = new Set('t n w r g i j c b f v z'.split(' '));
function customChord(value) {
  if (typeof value !== 'string' || !/^Mod\+(Shift\+)?[a-z]$/.test(value)) return false;
  const key = value.at(-1);
  return value.includes('Shift+') ? !reservedShift.has(key) : !reserved.has(key);
}
function read() {
  const raw = readLocal(storageKey, {}), value = blank(), used = new Set();
  value.on = raw?.on !== false;
  for (const [id, , base] of commands) {
    const binding = raw?.bindings?.[id];
    const chord = binding === '' || customChord(binding) ? binding : base;
    value.bindings[id] = used.has(chord) ? '' : chord;
    if (chord) used.add(chord);
    value.disabled[id] = raw?.disabled?.[id] === true;
  }
  return value;
}
let preferences = read();
function save(next) {
  preferences = next;
  writeLocal(storageKey, next);
  window.dispatchEvent(new Event(changed));
}
window.addEventListener('storage', event => {
  if (event.key === null || event.key === storageKey) {
    preferences = read(); window.dispatchEvent(new Event(changed));
  }
});
function eventChord(event) {
  if (event.altKey || event.getModifierState?.('AltGraph') || (mac ? event.ctrlKey : event.metaKey)) return '';
  if (!(mac ? event.metaKey : event.ctrlKey)) return event.key;
  return 'Mod+' + (event.shiftKey ? 'Shift+' : '') + event.key.toLowerCase();
}
const binding = (prefs, id, base) => prefs.bindings[id] ?? base;

export function openShortcutSettings(store) {
  const body = h('div', { class: 'stack' });
  let conflict;
  const drawer = openDrawer({ title: '快捷键设置', body, onClose() {
    window.removeEventListener(changed, paint); unsubscribe();
  } });
  const unsubscribe = store.subscribe(() => { if (!active(store)) drawer.close(); });
  function assign(id, chord) {
    const next = structuredClone(preferences);
    if (conflict) next.bindings[conflict.other] = '';
    next.bindings[id] = chord; next.disabled[id] = false;
    save(next);
  }
  function propose(id, chord) {
    const other = commands.find(([key, , base]) => chord && id !== key && binding(preferences, key, base) === chord);
    if (!other) { assign(id, chord); return; }
    conflict = { id, chord, other: other[0], label: other[1] };
    render();
  }
  function render() {
    const prefs = preferences;
    replace(body, h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: prefs.on, onchange: e =>
      save({ ...preferences, on: e.target.checked }) }), '启用全局快捷键'),
      h('p', { class: 'small muted' }, '设置保存在当前浏览器。更改按键时请按 ' + (mac ? '⌘' : 'Ctrl') + ' 加字母，可加 Shift。'),
      commands.map(([id, label, base]) => {
        const chord = binding(prefs, id, base);
        const notice = h('span', { role: 'status', class: 'small' });
        const record = Button({ label: '更改按键', size: 'sm', onClick: () => {
          notice.textContent = '请按新组合键，Esc 取消'; record.dataset.recording = '1';
        } });
        record.addEventListener('blur', () => { delete record.dataset.recording; notice.textContent = ''; });
        record.addEventListener('keydown', event => {
          if (!record.dataset.recording || event.isComposing || event.key === 'Tab') return;
          event.preventDefault(); event.stopPropagation();
          if (event.key === 'Escape') { delete record.dataset.recording; notice.textContent = ''; return; }
          if (['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return;
          const candidate = eventChord(event);
          if (!customChord(candidate)) { notice.textContent = '该按键不可用，请换一个组合键。'; return; }
          propose(id, candidate);
        });
        return h('section', { class: 'stack', 'aria-label': label, dataset: { command: id } }, h('div', { class: 'row row--wrap' },
          h('label', {}, h('input', { type: 'checkbox', checked: !prefs.disabled[id], onchange: e =>
            save({ ...preferences, disabled: { ...preferences.disabled, [id]: !e.target.checked } }) }), label),
          h('kbd', null, display(chord)), record,
          Button({ label: '清除', size: 'sm', onClick: () => assign(id, '') }),
          Button({ label: '恢复默认', size: 'sm', onClick: () => propose(id, base) })), notice);
      }), Button({ label: '恢复全部默认', onClick: () => save(blank()) }));
    if (conflict) {
      const { id, chord, label } = conflict;
      const cancel = Button({ label: '取消', onClick: paint });
      replace(body, h('p', { role: 'status' }, display(chord) + ' 已分配给「' + label + '」。替换后原命令将清除绑定。'),
        h('div', { class: 'row' }, cancel, Button({ label: '替换绑定', onClick: () => assign(id, chord) })));
      cancel.focus();
    }
  }
  function paint() {
    // Replacing the editor must not send a keyboard user back to the document.
    const previous = document.activeElement;
    const section = previous?.closest('section');
    const id = conflict?.id ?? section?.dataset.command;
    const index = section ? [...section.querySelectorAll('input,button')].indexOf(previous) : 1;
    const wasMaster = previous?.type === 'checkbox' && body.contains(previous) && !section;
    const wasReset = previous?.textContent === '恢复全部默认' && body.contains(previous);
    conflict = undefined; render();
    if (id) body.querySelector('[data-command="' + id + '"]')?.querySelectorAll('input,button')[index]?.focus();
    else if (wasMaster) body.querySelector('input')?.focus();
    else if (wasReset) body.lastElementChild?.focus();
  }
  window.addEventListener(changed, paint); paint();
}

export function installShortcuts({ shell, store, router, onQuickTodo }) {
  let goUntil = 0;
  const prefs = () => active(store) ? preferences : blank();
  function updateHint() {
    const p = prefs(), key = binding(p, 'search', '/');
    shell.searchHint.textContent = display(key);
    shell.searchHint.hidden = !p.on || p.disabled.search || !key;
  }
  store.subscribe(updateHint); window.addEventListener(changed, updateHint); updateHint();
  function help() {
    const p = prefs();
    const rows = commands.filter(([id, , base]) => !p.disabled[id] && binding(p, id, base))
      .map(([id, label, base]) => [display(binding(p, id, base)), label]);
    rows.push(['Shift + Enter', '对话中换行'], ['Esc', '关闭弹窗']);
    openDrawer({ title: '快捷键', body: h('dl', { class: 'kv' }, rows.map(([key, label]) =>
      [h('dt', null, h('kbd', null, key)), h('dd', null, label)])) });
  }
  document.addEventListener('keydown', event => {
    const p = prefs();
    if (!p.on || event.defaultPrevented || event.isComposing || event.repeat || event.target.isContentEditable ||
      event.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) { goUntil = 0; return; }
    const key = eventChord(event);
    const sequence = Date.now() < goUntil ? 'g ' + key : '';
    goUntil = 0;
    const enabled = commands.filter(([id]) => !p.disabled[id]);
    const match = enabled.find(([id, , base]) => sequence && binding(p, id, base) === sequence)
      ?? enabled.find(([id, , base]) => key && binding(p, id, base) === key);
    if (!match) {
      if (key === 'g' && enabled.some(([id, , base]) => binding(p, id, base).startsWith('g '))) goUntil = Date.now() + 1500;
      return;
    }
    event.preventDefault();
    const [id] = match;
    if (id === 'search') shell.searchInput.focus();
    else if (id === 'todo') onQuickTodo();
    else if (id === 'help') help();
    else router.go(router.href(id));
  });
}

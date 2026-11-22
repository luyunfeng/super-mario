import { splitLeadingQuote } from './markdown.js';
import { openDrawer } from '../ui/overlay.js';
import { h, replace } from './dom.js';

export const quoteDraftKey = key => JSON.stringify(['quote', key]);

// Store the selection separately so replacing a quote never overwrites typed words.
export function createMessageQuote({ drafts, input, store, router, scope }) {
  const bar = h('div', { class: 'message-quote message-quote--draft', dataset: { messageQuote: '' }, hidden: true });
  let currentKey = null, currentOwner, selected = '', passageDrawer;

  function decode(raw) {
    try {
      const value = JSON.parse(raw);
      if (typeof value?.text === 'string' && value.text.trim() && typeof value.label === 'string') return value;
    } catch { /* A missing or obsolete browser entry has no selection. */ }
    return null;
  }

  function choosePassage(value) {
    const key = currentKey, owner = currentOwner, original = selected;
    if (!key || owner !== drafts.owner()) return;
    const field = h('textarea', { class: 'textarea', rows: 5, readOnly: true, 'aria-label': '选择要引用的原文', value: value.text });
    const current = () => currentKey === key && owner === drafts.owner() && selected === original &&
      drawer.el.open && drafts.read(quoteDraftKey(key)) === original;
    const apply = h('button', { type: 'button', class: 'btn btn--primary btn--sm', disabled: true,
      onclick() {
        if (!current()) { restore(currentKey); return; }
        const passage = field.value.slice(field.selectionStart, field.selectionEnd);
        if (!passage.trim()) return;
        setSelection(JSON.stringify({ ...value, text: passage }));
        input.focus();
      } }, '引用选中段落');
    field.addEventListener('select', () => { apply.disabled = !field.value.slice(field.selectionStart, field.selectionEnd).trim(); });
    const drawer = openDrawer({ title: '选择引用片段', body: field, footer: apply, onClose() {
      if (passageDrawer === drawer) passageDrawer = undefined;
    } });
    passageDrawer = drawer;
    field.focus();
    field.setSelectionRange(0, 0);
  }

  function forward() {
    const key = currentKey, owner = currentOwner, raw = selected;
    if (!key || owner !== drafts.owner() || !raw) return;
    const targets = h('div', { class: 'stack' });
    const drawer = openDrawer({ title: '引用到其他对话', body: targets, onClose: () => unsubscribe() });
    const current = () => drawer.el.open && key === currentKey && owner === drafts.owner() &&
      owner === store.view.snapshotOwner && !store.view.unauthorized && raw === selected &&
      store.view.snapshot?.plugins?.some(p => p.id === 'conversation-quotes' && p.status === 'active');
    function destinations() {
      const projects = (store.view.snapshot?.projects ?? []).filter(p => !p.archivedAt);
      const mainScope = scope.get() || '';
      const project = projects.find(p => p.id === mainScope);
      return [
        { key: JSON.stringify(['main', mainScope]), name: project ? '主对话 · ' + project.name : '主对话', route: router.href('chat') },
        ...projects.map(p => ({ key: JSON.stringify(['project', p.id]), name: '项目工作对话 · ' + p.name,
          route: router.href('projects', p.id, 'workspace') })),
      ].filter(target => target.key !== key);
    }
    let lastChoices;
    function draw() {
      if (!current()) { drawer.close(); return; }
      const choices = destinations().map(item => ({ ...item, existing: drafts.read(quoteDraftKey(item.key)) }));
      const signature = JSON.stringify(choices);
      if (signature === lastChoices) return;
      lastChoices = signature;
      replace(targets, choices.length ? choices.map(target => {
        const path = quoteDraftKey(target.key);
        const existing = target.existing;
        return h('button', { class: 'btn btn--secondary', type: 'button', onclick() {
          if (!current() || !destinations().some(item => item.key === target.key)) { drawer.close(); return; }
          if (drafts.read(path) !== existing) { draw(); return; }
          drafts.write(path, raw);
          drawer.close();
          router.go(target.route);
        } }, target.name + (existing ? '（替换已有引用）' : ''));
      }) : h('p', { class: 'small muted' }, '暂无其他对话可选。'));
    }
    let projects = store.view.snapshot?.projects;
    const unsubscribe = store.subscribe(() => {
      if (!current()) drawer.close();
      else if (projects !== store.view.snapshot?.projects) { projects = store.view.snapshot?.projects; draw(); }
    });
    draw();
  }

  function paint(raw) {
    passageDrawer?.close();
    const value = decode(raw);
    selected = value ? raw : '';
    bar.hidden = !value;
    replace(bar, value && [
      h('div', { class: 'message-quote__preview', title: value.text },
        h('strong', null, value.label), ' · ', value.text),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => choosePassage(value) }, '选择引用片段'),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: forward }, '引用到其他对话'),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': '移除引用', onclick: () => {
        if (!currentKey || currentOwner !== drafts.owner()) return;
        drafts.clearIf(quoteDraftKey(currentKey), selected);
        restore(currentKey);
        input.focus();
      } }, '移除引用'),
    ]);
  }
  function restore(key) {
    currentKey = key;
    currentOwner = drafts.owner();
    paint(key ? drafts.read(quoteDraftKey(key)) : '');
  }
  function setSelection(raw) {
    if (!currentKey || currentOwner !== drafts.owner()) return;
    drafts.write(quoteDraftKey(currentKey), raw);
    paint(raw);
  }
  // With quote controls off, editing a sent message still replaces the whole
  // draft. An older hidden quote must not reappear beside its replacement.
  function swapHidden(key, raw) {
    if (currentKey || !key || currentOwner !== drafts.owner()) return '';
    const path = quoteDraftKey(key);
    const before = drafts.read(path);
    if (before !== raw) drafts.write(path, raw);
    return before;
  }
  function restoreMessage(text) {
    const reference = splitLeadingQuote(text);
    setSelection(reference ? JSON.stringify({ text: reference.passage, label: '原消息引用' }) : '');
    return reference ? reference.body : text;
  }
  function select(message, label) {
    if (!currentKey || currentOwner !== drafts.owner() || !message.text?.trim()) return;
    const raw = JSON.stringify({ id: message.id, text: message.text.trim(), label });
    setSelection(raw);
    input.focus();
  }
  function action(message, label) {
    if (!currentKey || !message.text?.trim()) return null;
    return h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': '引用消息',
      onclick: () => select(message, label) }, '引用');
  }
  function compose(raw, text) {
    const quote = decode(raw);
    if (!quote) return text;
    const block = quote.text.split(/\r\n|\r|\n/).map(line => '> ' + line).join('\n');
    return text ? block + '\n\n' + text : block;
  }
  function accepted(key, raw) {
    if (!raw) return;
    drafts.clearIf(quoteDraftKey(key), raw);
    if (key === currentKey) restore(key);
  }
  return { bar, restore, restoreMessage, setSelection, swapHidden, select, action, capture: () => selected, compose, accepted };
}

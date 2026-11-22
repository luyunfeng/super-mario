import { splitLeadingQuote } from './markdown.js';
import { h, replace } from './dom.js';

// Store the selection separately so replacing a quote never overwrites typed words.
export function createMessageQuote({ drafts, input }) {
  const bar = h('div', { class: 'message-quote message-quote--draft', dataset: { messageQuote: '' }, hidden: true });
  let currentKey = null, currentOwner, selected = '';
  const storageKey = key => JSON.stringify(['quote', key]);

  function decode(raw) {
    try {
      const value = JSON.parse(raw);
      if (typeof value?.text === 'string' && value.text.trim() && typeof value.label === 'string') return value;
    } catch { /* A missing or obsolete browser entry has no selection. */ }
    return null;
  }

  function paint(raw) {
    const value = decode(raw);
    selected = value ? raw : '';
    bar.hidden = !value;
    replace(bar, value && [
      h('div', { class: 'message-quote__preview', title: value.text },
        h('strong', null, value.label), ' · ', value.text),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': '移除引用', onclick: () => {
        if (!currentKey || currentOwner !== drafts.owner()) return;
        drafts.clearIf(storageKey(currentKey), selected);
        restore(currentKey);
        input.focus();
      } }, '移除引用'),
    ]);
  }
  function restore(key) {
    currentKey = key;
    currentOwner = drafts.owner();
    paint(key ? drafts.read(storageKey(key)) : '');
  }
  function setSelection(raw) {
    if (!currentKey || currentOwner !== drafts.owner()) return;
    drafts.write(storageKey(currentKey), raw);
    paint(raw);
  }
  // With quote controls off, editing a sent message still replaces the whole
  // draft. An older hidden quote must not reappear beside its replacement.
  function swapHidden(key, raw) {
    if (currentKey || !key || currentOwner !== drafts.owner()) return '';
    const path = storageKey(key);
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
    drafts.clearIf(storageKey(key), raw);
    if (key === currentKey) restore(key);
  }
  return { bar, restore, restoreMessage, setSelection, swapHidden, select, action, capture: () => selected, compose, accepted };
}

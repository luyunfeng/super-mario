import { h } from '../lib/dom.js';
import { needsTranslation } from '../lib/translation-language.js';
import { inboxTranslationPref, inboxTranslationSource } from './inbox-translation.js';

// Observe the original paragraphs, which keep their size before a translation exists.
// Only a dedicated, expanded conversation reads visible rows. Inbox previews stay local.
export function createThreadTranslations({ api, store, router }) {
  let active;
  const currentGroup = () => router.current.page === 'inbox' && router.current.query?.get('conversation');

  function stop(row) {
    row.request?.abort();
    row.request = null;
    row.key = '';
    row.line.hidden = true;
    row.line.textContent = '';
  }
  function clear() {
    if (!active) return;
    active.observer.disconnect();
    for (const row of active.rows.values()) stop(row);
    active = undefined;
  }
  function target(thread, row) {
    const { snapshot, snapshotOwner, unauthorized } = store.view;
    if (active !== thread || !thread.details.open || currentGroup() !== thread.id || !row.visible ||
        document.hidden || unauthorized || !thread.owner || thread.owner !== snapshotOwner || thread.owner !== api.draftOwner() ||
        !snapshot?.plugins.some(p => p.id === 'reply-translation' && p.status === 'active')) return;
    const { source, item } = row;
    if (item.raw.projectId && !snapshot.projects?.some(p => p.id === item.raw.projectId && !p.archivedAt)) return;
    const pref = inboxTranslationPref(thread.owner, source);
    if (pref.auto && !source.self && needsTranslation(item.text, pref.target)) return pref.target;
  }
  function sync() {
    const thread = active;
    if (!thread) return;
    if (currentGroup() !== thread.id || thread.mounted && !thread.details.isConnected) { clear(); return; }
    const revision = store.view.snapshot?.modelRevision;
    for (const row of thread.rows.values()) {
      const language = target(thread, row);
      const key = language ? JSON.stringify([language, revision]) : '';
      if (row.key === key) continue;
      stop(row);
      if (!key || document.querySelector('dialog[open]')) continue;
      const controller = new AbortController();
      row.request = controller;
      row.key = key;
      const current = () => !controller.signal.aborted && thread.details.isConnected &&
        revision === store.view.snapshot?.modelRevision && language === target(thread, row);
      api('/inbox-translation', { method: 'POST', signal: controller.signal, body: { ...row.source.ref, target: language } })
        .then(result => {
          if (!current()) return;
          if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('未收到译文');
          row.line.textContent = result.text;
          row.line.hidden = false;
        }).catch(() => {
          if (current()) { row.line.textContent = '未能翻译，可在消息详情中重试。'; row.line.hidden = false; }
        }).finally(() => { if (row.request === controller) row.request = null; });
    }
  }
  store.subscribe(sync);
  for (const event of ['hashchange', 'storage', 'sm:inbox-translation-preference']) window.addEventListener(event, sync);
  document.addEventListener('visibilitychange', sync);
  document.addEventListener('close', () => queueMicrotask(sync), true);

  function mount(id, details, items) {
    clear();
    const rows = new Map();
    const observer = new IntersectionObserver(entries => {
      if (active !== thread) return;
      thread.mounted = true;
      for (const entry of entries) rows.get(entry.target).visible = entry.isIntersecting;
      sync();
    });
    const thread = { id, owner: api.draftOwner(), details, rows, observer, mounted: false };
    active = thread;
    const byId = new Map(items.map(item => [item.id, item]));
    for (const paragraph of details.querySelectorAll('[data-thread-message]')) {
      const item = byId.get(paragraph.dataset.threadMessage), source = inboxTranslationSource(item);
      if (!source || source.self) continue;
      const line = h('p', { class: 'small muted mailbox-thread-body', 'aria-label': '消息译文', hidden: true });
      paragraph.after(line);
      rows.set(paragraph, { item, source, line, key: '', visible: false });
      observer.observe(paragraph);
    }
    details.addEventListener('toggle', sync);
  }
  return { mount, currentGroup };
}

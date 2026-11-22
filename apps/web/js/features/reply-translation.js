import { h, replace } from '../lib/dom.js';
import { renderFormattedText } from '../lib/markdown.js';

// Only the visible conversation holds translations. The saved message is always the source of truth.
export function createReplyTranslation({ api, store, getScope, getConversationId }) {
  const entries = new Map();
  let context = '', epoch = 0;

  function discard(id, entry) {
    entries.delete(id);
    entry.pending?.abort();
    entry.show = false;
    entry.paint?.();
  }
  function syncContext() {
    const { snapshot, snapshotOwner, unauthorized } = store.view;
    const owner = api.draftOwner();
    const scope = getScope();
    const active = !unauthorized && owner === snapshotOwner && snapshot?.plugins?.some(
      p => p.id === 'reply-translation' && p.status === 'active') &&
      (!scope || snapshot.projects?.some(p => p.id === scope && !p.archivedAt));
    const next = active ? JSON.stringify([owner, getConversationId(), scope, snapshot.modelRevision]) : '';
    if (next !== context) {
      context = next;
      epoch++;
      for (const [id, entry] of entries) discard(id, entry);
    }
  }
  function eligible(message) {
    const scope = getScope(), conversation = getConversationId();
    const inScope = conversation === 'main' ? !scope || message.projectId === scope : !message.projectId || message.projectId === scope;
    return context && inScope && message.conversationId === conversation && message.role === 'assistant' && (message.status ?? 'done') === 'done' &&
      (!message.origin || message.origin === 'user') &&
      typeof message.text === 'string' && message.text.trim();
  }
  function update(messages) {
    syncContext();
    const visible = new Map(messages.map(m => [m.id, m]));
    for (const [id, entry] of entries) {
      const current = visible.get(id);
      if (!current || !eligible(current) || current.text !== entry.source) discard(id, entry);
    }
    return epoch;
  }
  store.subscribe(syncContext);
  // A navigation can hide a composer without replacing its DOM or refreshing its list.
  window.addEventListener('hashchange', () => {
    for (const entry of entries.values()) if (entry.pending) {
      entry.pending.abort();
      entry.pending = null;
      entry.paint?.();
    }
  });

  function action(message, bubble) {
    if (!eligible(message)) return null;
    const id = message.id;
    let entry = entries.get(id);
    if (!entry) {
      entry = { source: message.text, text: '', show: false, error: '', pending: null };
      entries.set(id, entry);
    }
    const button = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: toggle });
    const feedback = h('span', { class: 'text-danger', role: 'status' });
    const controls = h('span', null, button, feedback);
    let showing = false;
    entry.paint = () => {
      if (showing !== entry.show) {
        showing = entry.show;
        replace(bubble, renderFormattedText(showing ? entry.text : entry.source));
      }
      controls.hidden = entries.get(id) !== entry;
      button.disabled = !!entry.pending;
      button.setAttribute('aria-busy', String(!!entry.pending));
      button.setAttribute('aria-pressed', String(entry.show));
      const label = entry.show ? '查看原文' : '翻译回复';
      button.setAttribute('aria-label', label);
      button.textContent = entry.pending ? '翻译中…' : label;
      feedback.textContent = entry.error;
    };
    entry.paint();

    async function toggle() {
      syncContext();
      if (entries.get(id) !== entry || entry.pending) return;
      if (entry.text) { entry.show = !entry.show; entry.paint(); return; }
      const request = new AbortController();
      entry.pending = request;
      entry.error = '';
      entry.paint();
      try {
        const answer = await api('/reply-translation', { method: 'POST', signal: request.signal,
          body: { messageId: id, conversationId: message.conversationId, target: 'zh-Hans' } });
        syncContext();
        if (entries.get(id) !== entry || entry.pending !== request) return;
        if (typeof answer?.text !== 'string' || !answer.text.trim()) throw new Error('服务未返回译文');
        entry.text = answer.text;
        entry.show = true;
      } catch (error) {
        syncContext();
        if (entries.get(id) === entry && entry.pending === request) entry.error = '翻译失败：' + error.message;
      } finally {
        if (entries.get(id) === entry && entry.pending === request) {
          entry.pending = null;
          entry.paint();
        }
      }
    }
    return controls;
  }
  function displayedText(message) {
    const entry = entries.get(message.id);
    return entry?.show && entry.source === message.text ? entry.text : message.text;
  }
  return { update, action, displayedText };
}

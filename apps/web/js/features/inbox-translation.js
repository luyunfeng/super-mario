import { h, readLocal, writeLocal } from '../lib/dom.js';
import { needsTranslation, translationLanguages } from '../lib/translation-language.js';
import { Select } from '../ui/kit.js';

const botSources = new Map([
  ['飞书机器人', 'feishu-in:'], ['飞书', 'feishu-collect:'], ['飞书总指挥群', 'feishu-command:in:'],
]);

export function inboxTranslationSource(item) {
  const { raw, kind, text } = item, origin = raw.origin;
  if (!origin?.chatId?.trim() || !['direct', 'group'].includes(origin.kind) || !text?.trim() || !Number.isSafeInteger(raw.version)) return;
  let account, appId = '', self = false;
  if (kind === 'personal' && raw.source?.startsWith('feishu:') && origin.connector === '飞书') {
    account = raw.source;
    const fields = account.split(':');
    self = fields.length === 3 && fields[1] !== 'web' && !!origin.senderId && origin.senderId === fields[2];
  } else if (kind === 'mailbox' && raw.direction === 'inbox' && raw.botId && raw.sourceMessageId && (!raw.target || raw.target === origin.chatId)) {
    const prefix = botSources.get(origin.connector);
    if (!prefix || !raw.eventKey?.startsWith(prefix)) return;
    account = raw.botId;
    // Old entries without an app identity keep message-local preferences after a bot is rebound.
    appId = 'legacy:' + raw.id;
    try {
      const parts = JSON.parse(raw.eventKey.slice(prefix.length));
      if (Array.isArray(parts) && typeof parts[1] === 'string' && parts[1]) appId = parts[1];
    } catch { /* Older event keys may contain only the original event id. */ }
  } else return;
  return { ref: { kind, id: raw.id, version: raw.version, account, chatId: origin.chatId }, appId, self };
}

export function inboxTranslationPref(owner, { ref, appId }) {
  const key = 'sm.inbox-translation.' + JSON.stringify([owner, ref.kind, ref.account, appId, ref.chatId]);
  const saved = readLocal(key, null);
  const target = translationLanguages.some(([code]) => code === saved?.target) ? saved.target : 'zh-Hans';
  return { key, target, auto: saved?.auto === true };
}

export function createInboxTranslation({ api, store, isSelected }) {
  let current;
  function owner() {
    const { snapshot, snapshotOwner, unauthorized } = store.view;
    const currentOwner = api.draftOwner();
    return !unauthorized && snapshotOwner === currentOwner && snapshot?.plugins?.some(p => p.id === 'reply-translation' && p.status === 'active')
      ? currentOwner : null;
  }
  function clear() {
    const old = current;
    current = undefined;
    old?.cancel();
  }
  store.subscribe(() => {
    if (current && (current.owner !== owner() || current.revision !== store.view.snapshot?.modelRevision)) clear();
  });

  window.addEventListener('storage', event => {
    if (current && (event.key === null || event.key === current.prefKey)) current.syncPreference();
  });

  function view(item) {
    const who = owner(), input = who && inboxTranslationSource(item);
    const projectId = item.kind === 'personal' ? item.raw.projectId : item.raw.scope?.projectId;
    if (!input || !isSelected(item.id) || projectId && !store.view.snapshot?.projects?.some(p => p.id === projectId && !p.archivedAt)) {
      clear();
      return null;
    }
    const { ref, appId, self } = input, revision = store.view.snapshot.modelRevision;
    const signature = JSON.stringify([who, ref, appId, self, item.text, revision]);
    if (current?.signature === signature) return current.el;
    clear();
    const pref = inboxTranslationPref(who, input);
    const language = Select({ 'aria-label': '翻译目标语言', options: translationLanguages, value: pref.target });
    const auto = h('input', { type: 'checkbox', 'aria-label': '本会话自动翻译', checked: pref.auto });
    const body = h('pre', { class: 'mailbox-content' }, item.text);
    const button = h('button', { type: 'button', class: 'btn btn--sm', onclick: () => {
      if (!live() || pending) return;
      if (show) { show = false; paint(); } else void translate();
    } });
    const feedback = h('span', { role: 'status', class: 'small text-danger' });
    const controls = h('div', { class: 'row row--wrap' }, button, h('label', { class: 'check' }, auto, '本会话自动翻译'), language, feedback);
    const el = h('div', { class: 'stack' }, body, controls);
    const cache = new Map();
    let pending, show = false, error = '';
    const selection = { signature, el, owner: who, revision, prefKey: pref.key,
      cancel() { stop(); controls.hidden = true; body.textContent = item.text; },
      syncPreference() {
        if (!live()) return;
        const saved = inboxTranslationPref(who, input);
        if (saved.auto === auto.checked && saved.target === language.value) return;
        auto.checked = saved.auto;
        language.value = saved.target;
        applyPreference();
      },
    };
    current = selection;
    function live() {
      return current === selection && owner() === who && store.view.snapshot?.modelRevision === revision && isSelected(item.id);
    }
    function stop() { pending?.abort(); pending = undefined; }
    function paint() {
      body.textContent = show ? cache.get(language.value) : item.text;
      button.disabled = !!pending;
      const label = show ? '查看原文' : '翻译消息';
      button.setAttribute('aria-label', label);
      button.textContent = pending ? '翻译中…' : label;
      feedback.textContent = error;
    }
    async function translate() {
      if (!live() || pending) return;
      const target = language.value;
      if (cache.has(target)) { show = true; error = ''; paint(); return; }
      const controller = new AbortController();
      pending = controller;
      error = ''; paint();
      try {
        const result = await api('/inbox-translation', { method: 'POST', body: { ...ref, target }, signal: controller.signal });
        if (pending !== controller || !live()) return;
        if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('服务未返回译文');
        cache.set(target, result.text); show = true;
      } catch (cause) {
        if (pending === controller && live()) error = '翻译失败：' + cause.message;
      } finally {
        if (pending === controller) { pending = undefined; if (live()) paint(); }
      }
    }
    function maybeTranslate() {
      if (auto.checked && !self && needsTranslation(item.text, language.value)) void translate();
    }
    function applyPreference() {
      stop(); error = ''; show = false; paint(); maybeTranslate();
    }
    function changed() {
      if (!live()) return;
      writeLocal(pref.key, { auto: auto.checked, target: language.value });
      window.dispatchEvent(new CustomEvent('sm:inbox-translation-preference', { detail: { key: pref.key } }));
      applyPreference();
    }
    language.addEventListener('change', changed);
    auto.addEventListener('change', changed);
    paint(); maybeTranslate();
    return el;
  }
  return { view, clear };
}

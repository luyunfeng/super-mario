import { createReplyReadAloud } from '../features/reply-read-aloud.js';
import { createVoiceInput } from '../features/voice-input.js';
import { attachSentHistory } from '../features/sent-history.js';
// 对话：主页。顶部是“等你处理”，中间是消息流，输入框固定在底部。
import { h, keyedList, replace } from '../lib/dom.js';
import { createMessageSubmissions } from '../lib/message-submissions.js';
import { createConversationDrafts } from '../lib/conversation-drafts.js';
import { createMessageQuote } from '../lib/message-quote.js';
import { createMessageEdit } from '../lib/message-edit.js';
import { timeAgo } from '../lib/format.js';
import { renderFormattedText } from '../lib/markdown.js';
import { icon } from '../ui/icons.js';
import { Button, Banner, Card, Pill } from '../ui/kit.js';
import { Hint, hintCopy } from '../ui/hint.js';
import { attachSavedPrompts } from '../features/saved-prompts.js';
import { officeDocumentsButton } from '../features/office-documents.js';
import { createReplyTranslation } from '../features/reply-translation.js';
import { createMessageFavorites, messageFavoritesActive } from '../features/message-favorites.js';
import { createConversationExport } from '../features/conversation-export.js';
import { conversationSearchActive } from '../features/search.js';
import { createAttention } from '../features/attention.js';
import { createCodeSidebar } from '../features/code-sidebar.js';
import { mainAssistantName } from '../features/assistant-profile.js';
import { createRecentWork } from '../features/recent-work.js';
import { systemText } from '../copy/terms.js';
import { agentProgress } from '../ui/agent-progress.js';

const EXAMPLES = ['梳理本周待办，给我下一步建议', '检查正在执行的任务进展', '把官网首页的报错修一下'];

const SETUP_STEPS = [
  { key: 'agent', title: '配置 Agent', desc: '选一个模型，再接入一台能运行 Claude Code 或 Codex 的电脑。', hint: 'nav.agent', route: 'agent', action: '去配置' },
  { key: 'project', title: '添加要跟进的项目', desc: '给项目起个名字，写一句目标，Agent 会据此跟进。', hint: 'nav.projects', route: 'projects', action: '新建项目' },
  { key: 'memory', title: '告诉我一些背景', desc: '写下你的工作原则，或粘贴项目资料。', hint: 'nav.memory', route: 'memory', action: '添加记忆' },
  { key: 'channel', title: '连接飞书机器人', desc: '之后可以在飞书里和我对话，别人发你的消息也能变成待办。', hint: 'nav.channels', route: 'channels', action: '去连接', skippable: true },
];

export function createChatPage({ api, store, scope, router }) {
  const translation = createReplyTranslation({ api, store, getScope: scope.get, getConversationId: () => 'main' });
  const favorites = createMessageFavorites({ api, store, router });
  const transcript = createConversationExport({ api, store });
  const attention = createAttention({ api, store });
  const code = createCodeSidebar({ api, store });
  const recent = createRecentWork({ api, store, router, scope });
  const banner = h('div', { id: 'chat-banner' });
  const setup = h('div', { id: 'onboarding' });
  const runStrip = h('div', { id: 'run-strip', hidden: true });
  const messages = h('div', { class: 'msgs', id: 'messages', 'aria-live': 'polite' });
  const hero = h('div', { class: 'hero', hidden: true },
    h('h2', { class: 'hero__title' }, '今天想推进什么？'),
    h('p', { class: 'muted' }, '说出目标，Agent 会结合记忆安排下一步。'),
    h('div', { class: 'hero__chips' }));
  // 上半部分（标题、等你处理、引导）固定在顶部；只有消息流滚动，输入框固定在底部。
  const top = h('div', { class: 'chat__top' },
    h('div', { class: 'chat__inner chat__inner--top' },
      h('header', { class: 'page__head' },
        h('div', { class: 'page__title' }, h('h1', null, '对话'), h('p', { class: 'page__sub' }, hintCopy('nav.chat').tag)),
        h('div', { class: 'page__actions' }, favorites.button, transcript.button, officeDocumentsButton({ api, store }), code.toggle, Hint('nav.chat'))),
      banner, attention.el, setup, runStrip));
  const scroller = h('div', { class: 'chat__scroll', id: 'chat-scroll' }, h('div', { class: 'chat__inner' }, messages, hero));

  // —— 输入框 ——
  const input = h('textarea', { class: 'composer__input', id: 'message-text', rows: 1, placeholder: '说出目标，Enter 发送，Shift + Enter 换行', 'aria-label': '给 Agent 的消息', maxLength: 20000 });
  const readAloud = createReplyReadAloud(router, () => voice.reset());
  const voice = createVoiceInput(input, readAloud.stop, api);
  const drafts = createConversationDrafts({ api, store });
  const quote = createMessageQuote({ drafts, input, store, router, scope });
  const edit = createMessageEdit({ input, quote, context: composerContext });
  const prompts = attachSavedPrompts({ api, store, input, getScope: scope.get });
  const history = attachSentHistory({ input, store, context: composerContext });
  const scopeSelect = h('select', { class: 'composer__scope', 'aria-label': '项目范围' }, h('option', { value: '' }, '全部项目'));
  const send = h('button', { class: 'btn btn--primary btn--sm composer__send', type: 'submit', 'aria-label': '发送' }, icon('send'), '发送');
  const status = h('p', { class: 'small composer__status', role: 'status' });
  const form = h('form', { class: 'composer', id: 'message-form' },
    recent.el,
    h('div', { class: 'composer__box' }, edit.notice, quote.bar, prompts.menu, input, voice.caption, h('div', { class: 'composer__bar' }, scopeSelect, prompts.manage, voice.button, voice.upload, h('span', { class: 'grow' }), send)), status);

  const el = h('section', { class: 'page page--chat', id: 'chat' }, h('div', { class: 'chat-code-main' }, top, scroller, form), code.el);

  const pending = new Map();
  let draftKey, owner, enabled, quotesEnabled, editEnabled, epoch = 0;
  const submissions = createMessageSubmissions({ api, context: submissionContext, onConfirmed: clearSubmittedDraft, captureEdit: edit.onAccepted,
    onStatus: message => { status.className = 'small composer__status'; status.textContent = message; } });
  send.before(submissions.button);
  function submissionContext() {
    const { key, owner } = composerContext();
    const draft = input.value, captured = quotesEnabled ? quote.capture() : '';
    const body = (captured ? quote.compose(captured, draft.trim()) : draft).trim();
    return { key, owner, draft, captured, body, epoch, conversation: 'main', projectId: scope.get() || undefined, url: '/messages' };
  }
  function clearSubmittedDraft(ctx) {
    history.record(ctx);
    const { key, draft, captured } = ctx;
    drafts.clearIf(key, draft);
    if (captured) quote.accepted(key, captured);
    if (draftKey === key && input.value === draft) { input.value = drafts.read(key); autosize(); }
  }
  function composerContext() {
    const { snapshot, snapshotOwner, unauthorized } = store.view;
    const currentOwner = drafts.owner();
    const valid = snapshot && !unauthorized && snapshotOwner === currentOwner;
    const nextOwner = valid ? currentOwner : null;
    const nextEnabled = !!valid && snapshot.plugins?.some(p => p.id === 'conversation-drafts' && p.status === 'active');
    const id = scope.get() || '';
    const key = valid && (!id || snapshot.projects?.some(p => p.id === id && !p.archivedAt)) ? JSON.stringify(['main', id]) : null;
    const nextQuotes = !!key && snapshot.plugins?.some(p => p.id === 'conversation-quotes' && p.status === 'active');
    const allowEdit = !!key && snapshot.plugins?.some(p => p.id === 'conversation-edit' && p.status === 'active');
    return { key, owner: nextOwner, enabled: allowEdit, quotesEnabled: nextQuotes, draftsEnabled: nextEnabled };
  }
  function syncDraft() {
    const { key, owner: nextOwner, enabled: allowEdit, quotesEnabled: nextQuotes, draftsEnabled: nextEnabled } = composerContext();
    readAloud.update(key, nextOwner, store.view.snapshot);
    voice.update(router.current.page === 'chat' && key, nextOwner, store.view.snapshot, scope.get());
    const sameDraft = owner === nextOwner && enabled === nextEnabled && quotesEnabled === nextQuotes && draftKey === key;
    if (sameDraft && editEnabled === allowEdit) return;
    editEnabled = allowEdit;
    edit.reset();
    if (sameDraft) return;
    quote.restore(nextQuotes ? key : null);
    if (owner !== nextOwner) pending.clear();
    if (owner !== nextOwner || enabled !== nextEnabled || quotesEnabled !== nextQuotes) epoch++;
    quotesEnabled = nextQuotes;
    owner = nextOwner; enabled = nextEnabled; draftKey = key;
    submissions.update();
    input.value = key ? drafts.read(key) : '';
    autosize();
    input.disabled = !key;
    send.disabled = !key || pending.has(key) || !store.view.snapshot?.agent.available;
    status.textContent = '';
  }
  router.subscribe(syncDraft);
  store.subscribe(syncDraft);
  syncDraft();
  let snapshot = null;
  let assistantLabel = '主 Agent';
  let lastCount = 0;
  let pendingMessage = '';
  let scrollFrame;
  let markedMessage;

  function revealMessage() {
    if (!snapshot || router.current.page !== 'chat') return;
    const canLocate = router.current.query.has('favorite') ? messageFavoritesActive(store) : conversationSearchActive(snapshot);
    if (!canLocate) {
      markedMessage?.classList.remove('is-search-hit');
      markedMessage = undefined;
      if (pendingMessage) scrollToEnd(true);
      pendingMessage = '';
      return;
    }
    if (!pendingMessage) return;
    const row = messages.querySelector(`[data-id="${CSS.escape(pendingMessage)}"]`);
    if (!row) return;
    pendingMessage = '';
    cancelAnimationFrame(scrollFrame);
    markedMessage?.classList.remove('is-search-hit');
    markedMessage = row;
    row.classList.add('is-search-hit');
    row.tabIndex = -1;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'center' });
  }

  function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; }
  input.addEventListener('input', () => {
    syncDraft();
    if (draftKey) drafts.write(draftKey, input.value);
    autosize();
  });
  input.addEventListener('keydown', (event) => {
    if (!event.defaultPrevented && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  scopeSelect.addEventListener('change', () => scope.set(scopeSelect.value));
  scope.subscribe(value => {
    syncDraft(); prompts.changeScope(); transcript.close(); scopeSelect.value = value; code.show(value);
    if (store.view.snapshot) paintMessages(store.view.snapshot.messages ?? []);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    syncDraft();
    const ctx = submissionContext(), { key, body: text, projectId } = ctx;
    if (!key || !text || pending.has(key) || !store.view.snapshot?.agent.available) return;
    voice.reset();
    const ticket = submissions.begin(ctx);
    if (!ticket) return;
    if (ticket.record.blocked) { status.textContent = '发送结果未知，请先核对发送回执。'; return; }
    const stamp = epoch, submission = Symbol();
    const finishEdit = edit.onAccepted();
    pending.set(key, submission); send.disabled = true; status.textContent = ''; status.className = 'small composer__status muted';
    try {
      const answer = await api.post(ctx.url, { text, ...(projectId ? { projectId } : {}) }, { 'Idempotency-Key': ticket.record.id });
      syncDraft();
      if (stamp !== epoch) return;
      const confirmed = submissions.accepted(ticket, answer, ctx, true);
      if (!confirmed) {
        const rejected = answer?.status === 'failed' && answer.requestId === undefined;
        if (!rejected) submissions.block(ticket);
        if (draftKey === key) {
          status.className = 'small composer__status text-danger';
          status.textContent = rejected ? '发送失败，内容已保留。' : '发送结果未知，内容已保留。请先核对对话。';
        }
      } else {
        finishEdit();
        clearSubmittedDraft(ctx);
        if (draftKey === key) {
          if (answer.status === 'failed') status.textContent = '消息已受理，处理失败。';
          scrollToEnd(true);
        }
      }
    } catch (error) {
      syncDraft();
      if (stamp !== epoch) return;
      if (error.status && /unknown|结果未知/i.test(error.message)) submissions.block(ticket);
      if (draftKey !== key) return;
      status.className = 'small composer__status text-danger';
      status.textContent = `发送未确认：${error.message}。内容已保留，请核对后重试。`;
    } finally {
      submissions.finish(ticket);
      if (pending.get(key) === submission) pending.delete(key);
      send.disabled = !draftKey || pending.has(draftKey) || !store.view.snapshot?.agent.available;
    }
    store.refresh();
  });

  for (const text of EXAMPLES) {
    hero.querySelector('.hero__chips').append(h('button', { class: 'chip', type: 'button', onclick: () => { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); } }, text));
  }

  function nearBottom() { return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 80; }
  function scrollToEnd(force = false) {
    if (!force && !nearBottom()) return;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }

  function renderMessage(message) {
    const mark = message.conversationId === 'main' ? favorites.mark(message) : null;
    const text = message.origin === 'notification' ? systemText(message.text) : message.text;
    if (message.origin === 'notification') {
      // 系统提醒只留一行摘要；完整内容（含原始数据）折叠在“详情”里。
      const [first, ...rest] = text.split('\n');
      return h('article', { class: 'msg msg--system', dataset: { id: message.id } },
        h('span', { class: 'msg__note' }, first, ' ', h('span', { class: 'msg__meta' }, timeAgo(message.createdAt))),
        rest.length > 0 && h('details', null, h('summary', null, '详情'), h('pre', null, rest.join('\n'))), mark);
    }
    const canQuote = quotesEnabled && message.conversationId === 'main' && typeof message.text === 'string' && message.text.trim();
    if (message.role === 'user') {
      const canEdit = editEnabled && message.conversationId === 'main' && (!scope.get() || scope.get() === message.projectId);
      return h('article', { class: 'msg msg--user', dataset: { id: message.id } },
        h('div', { class: 'msg__bubble' }, renderFormattedText(text)),
        h('span', { class: 'msg__meta' }, timeAgo(message.createdAt), message.status === 'failed' && ' · 处理失败', mark, transcript.copyMessage(message, translation.displayedText), canEdit && edit.action(message), canQuote && quote.action(message, '我'), message.conversationId === 'main' && prompts.fromMessage(message)));
    }
    const personal = message.conversationId === 'main' && (!message.origin || message.origin === 'user');
    const label = personal ? assistantLabel : message.origin === 'result' ? '执行结果' : '主 Agent';
    const bubble = h('div', { class: 'msg__bubble' }, renderFormattedText(text));
    return h('article', { class: 'msg msg--assistant', dataset: { id: message.id } },
      h('span', { class: 'msg__avatar', 'aria-hidden': 'true' }, 'M'),
      h('div', { class: 'msg__col' },
        h('span', { class: 'msg__label', dataset: personal ? { assistantName: 'true' } : undefined }, label),
        agentProgress(message, api),
        bubble,
        h('span', { class: 'msg__meta' }, timeAgo(message.createdAt), mark, transcript.copyMessage(message, translation.displayedText), translation.action(message, bubble), personal && readAloud.action(message, translation.displayedText), canQuote && message.role === 'assistant' && quote.action(message, label))));
  }

  function paintMessages(list) {
    const translationEpoch = translation.update(list);
    keyedList(messages, list, item => item.id, renderMessage, item => JSON.stringify([
      prompts.epoch, favorites.epoch, transcript.active, readAloud.active, translationEpoch, quotesEnabled, editEnabled, owner, draftKey, item,
    ]));
  }

  function renderSetup(state) {
    const s = state.setup;
    const hasMessages = (state.messages ?? []).length > 0;
    const todo = s ? SETUP_STEPS.filter(step => step.key === 'channel' ? s.channel === 'todo' : !s[step.key]) : [];
    setup.hidden = !s || hasMessages || todo.length === 0;
    if (setup.hidden) return;
    const doneCount = SETUP_STEPS.length - todo.length;
    const rows = todo.map((step, index) => h('li', { class: `step ${index === 0 ? 'is-next' : ''}`, dataset: { step: step.key } },
      h('span', { class: 'step__mark', 'aria-hidden': 'true' }, String(SETUP_STEPS.findIndex(item => item.key === step.key) + 1)),
      h('div', { class: 'step__main' }, h('strong', null, step.title), h('span', { class: 'muted small' }, step.desc)),
      h('div', { class: 'step__end' },
        step.skippable && Button({ label: '先跳过', kind: 'ghost', size: 'sm', onClick: async () => { await api.post('/setup/channel-skip', {}); await store.refresh(); } }),
        h('a', { class: `btn btn--sm ${index === 0 ? 'btn--primary' : ''}`, href: router.href(step.route) }, step.action))));
    replace(setup, Card({
      title: '让 Agent 更了解你的工作', sub: `已完成 ${doneCount}/${SETUP_STEPS.length}，随时可以直接在下面说话`,
      body: h('ol', { class: 'steps' }, rows), className: 'setup',
    }));
  }

  function renderBanner(state) {
    const items = [];
    if (!state.agent.available) {
      items.push(Banner({ tone: 'warn', children: `主 Agent 暂不可用：${state.agent.reason || '尚未配置模型'}`, action: h('a', { class: 'btn btn--sm', href: router.href('agent') }, '去配置') }));
    } else if (state.mode === 'demo' && sessionStorage.getItem('sm.demo-dismissed') !== '1') {
      const notice = Banner({ children: '演示模式：回复是固定内容，不调用真实模型，也不会运行真实执行者。' });
      notice.append(Button({ label: '知道了', kind: 'ghost', size: 'sm', onClick: () => { sessionStorage.setItem('sm.demo-dismissed', '1'); notice.remove(); } }));
      items.push(notice);
    }
    replace(banner, items);
  }

  function renderRuns(state) {
    const active = (state.runs ?? []).filter(run => run.status === 'queued' || run.status === 'running');
    runStrip.hidden = active.length === 0;
    if (!active.length) return;
    replace(runStrip, h('a', { class: 'strip', href: router.href('projects', 'all', 'runs') },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }), `Agent 正在执行 ${active.length} 项任务`, h('span', { class: 'muted' }, '查看进展 ›')));
  }

  return {
    el,
    onShow(route) {
      const savedDraft = draftKey ? drafts.read(draftKey) : '';
      if (input.value !== savedDraft) {
        input.value = savedDraft;
        autosize();
      }
      quote.restore(quotesEnabled ? draftKey : null);
      prompts.reset();
      recent.refresh();
      pendingMessage = route.query.get('favorite') || route.query.get('at') || '';
      markedMessage?.classList.remove('is-search-hit');
      if (pendingMessage) revealMessage();
      else scrollToEnd(true);
    },
    focus() { input.focus(); },
    onState({ snapshot: state, attention: items }) {
      snapshot = state;
      const nextLabel = mainAssistantName(store.view);
      if (nextLabel !== assistantLabel) {
        assistantLabel = nextLabel;
        // 只更新署名，保留气泡正文的选区、焦点和搜索定位。
        for (const label of messages.querySelectorAll('[data-assistant-name]')) label.textContent = assistantLabel;
      }
      code.show(scope.get());
      attention.update(items);
      renderBanner(state); renderSetup(state); renderRuns(state);
      recent.update(state);
      const list = state.messages ?? [];
      const follow = nearBottom();
      paintMessages(list);
      hero.hidden = list.length > 0 || !setup.hidden;
      if (list.length !== lastCount) { lastCount = list.length; if (follow) scrollToEnd(true); }
      else if (follow && list.at(-1)?.status === 'pending') scrollToEnd(true);
      revealMessage();
      send.disabled = !draftKey || pending.has(draftKey) || !state.agent.available;
      input.placeholder = state.agent.available ? '说出目标，Enter 发送，Shift + Enter 换行' : '主 Agent 暂不可用，请先完成模型配置';
      const projects = (state.projects ?? []).filter(item => !item.archivedAt);
      const signature = JSON.stringify(projects.map(item => [item.id, item.name]));
      if (scopeSelect.dataset.sig !== signature) {
        scopeSelect.dataset.sig = signature;
        replace(scopeSelect, h('option', { value: '' }, '全部项目'), projects.map(item => h('option', { value: item.id }, item.name)));
      }
      scopeSelect.value = scope.get();
    },
  };
}

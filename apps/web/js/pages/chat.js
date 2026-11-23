import { createMessageFiles, messageFiles } from '../features/message-files.js';
import { conversationImagesActive, createMessageImages, messageImages } from '../features/message-images.js';
import { createTurnRetry, turnRetryActive } from '../features/retry-turn.js';
import { stopTurnButton } from '../features/stop-turn.js';
import { createReplyReadAloud } from '../features/reply-read-aloud.js';
import { createVoiceInput } from '../features/voice-input.js';
import { attachSentHistory } from '../features/sent-history.js';
// 对话：主页。顶部是“等你处理”，中间是消息流，输入框固定在底部。
import { h, keyedList, replace } from '../lib/dom.js';
import { createMessageSubmissions, messagePayload } from '../lib/message-submissions.js';
import { createConversationDrafts } from '../lib/conversation-drafts.js';
import { createMessageQuote } from '../lib/message-quote.js';
import { createMessageEdit } from '../lib/message-edit.js';
import { timeAgo } from '../lib/format.js';
import { icon } from '../ui/icons.js';
import { Button, Banner, Card, Pill } from '../ui/kit.js';
import { Hint, hintCopy } from '../ui/hint.js';
import { conversationStatusButton } from '../features/conversation-status.js';
import { attachFileMentions } from '../features/file-mentions.js';
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
  const decisionText = h('span');
  const originalQuestion = Button({ label: '查看原提问通知', size: 'sm', kind: 'ghost', onClick: () => {
    const row = messages.querySelector(`[data-id="${CSS.escape(originalQuestion.dataset.notice)}"]`);
    if (!row) return;
    const details = row.querySelector('details');
    if (details) details.open = true;
    row.tabIndex = -1;
    row.focus();
    row.scrollIntoView({ block: 'center' });
  }});
  const decisionNotice = h('div', { role: 'status', hidden: true }, decisionText, originalQuestion);
  const messageStatus = h('span');
  const messageNotice = h('div', { role: 'status', hidden: true }, messageStatus, ' · ',
    h('a', { href: router.href('chat') }, '返回最新消息'));
  const decisionLabels = { approval: '审批', interaction: '交互请求', plan: '计划', mailbox: '信件', inbox: '收件' };
  let pendingDecision = '';
  function revealDecision() {
    if (!pendingDecision || router.current.page !== 'chat' || !store.view.snapshot) return;
    const found = attention.reveal(pendingDecision);
    decisionNotice.hidden = found;
    const [type, id] = pendingDecision.split(':');
    decisionText.textContent = found ? '' : `当前待处理列表中没有这条${decisionLabels[type]}。`;
    const noticeId = 'interaction-notice:' + id;
    originalQuestion.dataset.notice = noticeId;
    originalQuestion.hidden = found || type !== 'interaction' || !store.view.snapshot.messages?.some(message =>
      message.id === noticeId && message.origin === 'notification');
    if (found) pendingDecision = '';
  }
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
        h('div', { class: 'page__actions' }, conversationStatusButton({ api, store, scope, target: 'main', project: scope.get }), favorites.button, transcript.button, officeDocumentsButton({ api, store }), code.toggle, Hint('nav.chat'))),
      banner, decisionNotice, messageNotice, attention.el, setup, runStrip));
  const scroller = h('div', { class: 'chat__scroll', id: 'chat-scroll' }, h('div', { class: 'chat__inner' }, messages, hero));

  // —— 输入框 ——
  const input = h('textarea', { class: 'composer__input', id: 'message-text', rows: 1, placeholder: '说出目标，Enter 发送，Shift + Enter 换行', 'aria-label': '给 Agent 的消息', maxLength: 20000 });
  const retryTurn = createTurnRetry(api,store);
  const files = createMessageFiles(api,store,input);
  const pictures = createMessageImages(input);
  const readAloud = createReplyReadAloud(router, () => voice.reset());
  const voice = createVoiceInput(input, readAloud.stop, api);
  const drafts = createConversationDrafts({ api, store });
  const quote = createMessageQuote({ drafts, input, store, router, scope });
  const edit = createMessageEdit({ input, quote, context: composerContext });
  const prompts = attachSavedPrompts({ api, store, input, getScope: scope.get });
  const mentions = attachFileMentions({ api, store, input, getProjectId: scope.get });
  const history = attachSentHistory({ input, store, context: composerContext });
  const scopeSelect = h('select', { class: 'composer__scope', 'aria-label': '项目范围' }, h('option', { value: '' }, '全部项目'));
  const send = h('button', { class: 'btn btn--primary btn--sm composer__send', type: 'submit', 'aria-label': '发送' }, icon('send'), '发送');
  const status = h('p', { class: 'small composer__status', role: 'status' });
  const form = h('form', { class: 'composer', id: 'message-form' },
    recent.el,
    h('div', { class: 'composer__box' }, edit.notice, quote.bar, prompts.menu, mentions.menu, pictures.el, files.el, input, voice.caption, h('div', { class: 'composer__bar' }, scopeSelect, prompts.manage, mentions.button, pictures.button, files.button, voice.button, voice.upload, h('span', { class: 'grow' }), send)), status);

  const el = h('section', { class: 'page page--chat', id: 'chat' }, h('div', { class: 'chat-code-main' }, top, scroller, form), code.el);

  const pending = new Map();
  let draftKey, owner, enabled, quotesEnabled, editEnabled, outboxEnabled, epoch = 0;
  const submissions = createMessageSubmissions({ api, context: submissionContext, onConfirmed: clearSubmittedDraft, captureEdit: edit.onAccepted,
    isRecoveryEnabled: () => store.view.snapshot?.plugins?.some(p=>p.id==='conversation-outbox' && p.status==='active'),
    canPersistDraft: () => composerContext().draftsEnabled,
    onStatus: message => { status.className = 'small composer__status'; status.textContent = message; } });
  send.before(submissions.button);
  form.prepend(submissions.panel);
  function submissionContext() {
    const { key, owner } = composerContext();
    const draft = input.value, captured = quotesEnabled ? quote.capture() : '';
    const body = (captured ? quote.compose(captured, draft.trim()) : draft).trim();
    return { key, owner, draft, captured, images:pictures.capture(), files:files.capture(), body, epoch, conversation: 'main', projectId: scope.get() || undefined, url: '/messages' };
  }
  function clearSubmittedDraft(ctx) {
    history.record(ctx);
    pictures.accepted(ctx);
    files.accepted(ctx);
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
    if (router.current.page !== 'chat') pictures.closeEditor();
    files.update(key,nextOwner,nextEnabled,{conversationId:'main',...(scope.get() && {projectId:scope.get()})});
    pictures.update(key,nextOwner,nextEnabled,conversationImagesActive(store));
    readAloud.update(key, nextOwner, store.view.snapshot);
    voice.update(router.current.page === 'chat' && key, nextOwner, store.view.snapshot, scope.get());
    const sameDraft = owner === nextOwner && enabled === nextEnabled && quotesEnabled === nextQuotes && draftKey === key;
    const recovery = store.view.snapshot?.plugins?.some(p=>p.id==='conversation-outbox' && p.status==='active');
    if (outboxEnabled !== recovery) { outboxEnabled = recovery; submissions.update(); }
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
  let focusMessage = false;
  let scrollFrame;
  let markedMessage;

  function revealMessage() {
    if (!snapshot || router.current.page !== 'chat') return;
    const query = router.current.query;
    const id = query.get('favorite') || query.get('at');
    const favorite = Boolean(query.get('favorite'));
    const available = favorite ? messageFavoritesActive(store) : conversationSearchActive(snapshot);
    const row = id && available ? messages.querySelector(`[data-id="${CSS.escape(id)}"]`) : null;
    const reason = !id || row ? '' : available ? '当前主对话中找不到这条消息。'
      : `「${favorite ? '消息收藏' : '对话历史搜索'}」插件当前不可用，无法定位原消息。`;
    if (messageStatus.textContent !== reason) messageStatus.textContent = reason;
    messageNotice.hidden = !reason;
    if (markedMessage !== row) {
      markedMessage?.classList.remove('is-search-hit');
      markedMessage = row;
      row?.classList.add('is-search-hit');
    }
    if (!focusMessage) return;
    if (!available) {
      focusMessage = false;
      scrollToEnd(true);
    } else if (row) {
      focusMessage = false;
      cancelAnimationFrame(scrollFrame);
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'center' });
    }
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
    syncDraft(); mentions.update(); prompts.changeScope(); transcript.close(); scopeSelect.value = value; code.show(value);
    if (store.view.snapshot) paintMessages(store.view.snapshot.messages ?? []);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    syncDraft();
    const ctx = submissionContext(), { key, body: text, projectId } = ctx;
    if (!key || !pictures.ready() || !files.ready() || (!text && !ctx.images.length && !ctx.files.length) || pending.has(key) || !store.view.snapshot?.agent.available) return;
    let payload;
    try { payload=messagePayload(ctx,{text,...(projectId && {projectId})}); }
    catch(error) { status.textContent=error.message;return; }
    voice.reset();
    const ticket = submissions.begin(ctx);
    if (!ticket) return;
    if (ticket.record.blocked) { status.textContent = '发送结果未知，请先核对发送回执。'; return; }
    const stamp = epoch, submission = Symbol();
    const finishEdit = edit.onAccepted();
    pending.set(key, submission); send.disabled = true; status.textContent = ''; status.className = 'small composer__status muted';
    try {
      const receipt = await submissions.preflight(ticket,ctx);
      const current = submissionContext();
      if (current.owner!==ctx.owner || current.key!==ctx.key || current.epoch!==ctx.epoch) return;
      const answer = receipt ?? await api.post(ctx.url, payload, { 'Idempotency-Key': ticket.record.id });
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
          if (answer.status === 'failed') status.textContent = answer.stoppedByUser ? '已停止本轮。' : '消息已受理，处理失败。';
          scrollToEnd(true);
        }
      }
    } catch (error) {
      submissions.failed(ticket,error);
      if(error.status===410 && !error.receiptCheck) files.expired(ctx);
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
      const imageDraft = (!message.todoId && (message.projectId || '') === (scope.get() || ''))
        ? pictures.editCopy.bind(null,composerContext().key) : undefined;
      return h('article', { class: 'msg msg--user', dataset: { id: message.id } },
        h('div', { class: 'msg__bubble' }, transcript.renderMessage(message, text), messageImages(api,store,message,imageDraft),messageFiles(api,store,message,store.view.snapshot?.messages,messages)),
        h('span', { class: 'msg__meta' }, timeAgo(message.createdAt), message.stoppedByUser ? ' · 已停止本轮' : message.status === 'failed' && ' · 处理失败', stopTurnButton(api, message), mark, transcript.copyMessage(message, translation.displayedText), canEdit && edit.action(message), canQuote && quote.action(message, '我'), message.conversationId === 'main' && prompts.fromMessage(message)));
    }
    const personal = message.conversationId === 'main' && (!message.origin || message.origin === 'user');
    const label = personal ? assistantLabel : message.origin === 'result' ? '执行结果' : '主 Agent';
    const bubble = h('div', { class: 'msg__bubble' }, transcript.renderMessage(message, text));
    return h('article', { class: 'msg msg--assistant', dataset: { id: message.id } },
      h('span', { class: 'msg__avatar', 'aria-hidden': 'true' }, 'M'),
      h('div', { class: 'msg__col' },
        h('span', { class: 'msg__label', dataset: personal ? { assistantName: 'true' } : undefined }, label),
        agentProgress(message, api),
        bubble, messageFiles(api,store,message,store.view.snapshot?.messages,messages),
        (!scope.get() || message.projectId === scope.get()) && retryTurn(message,store.view.snapshot?.messages,'main',id=>router.href('chat')+'?at='+encodeURIComponent(id)),
        h('span', { class: 'msg__meta' }, timeAgo(message.createdAt), mark, transcript.copyMessage(message, translation.displayedText), translation.action(message, bubble, transcript.renderMessage), personal && readAloud.action(message, translation.displayedText), canQuote && message.role === 'assistant' && quote.action(message, label))));
  }

  function paintMessages(list) {
    const translationEpoch = translation.update(list);
    const retryEnabled = turnRetryActive(store);
    const retried = new Set(list.filter(m=>m.retryOf).map(m=>m.retryOf));
    keyedList(messages, list, item => item.id, renderMessage, item => JSON.stringify([
      prompts.epoch, favorites.epoch, transcript.active, readAloud.active, translationEpoch, quotesEnabled, editEnabled, owner, draftKey, retryEnabled, retried.has(item.id), item,
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
      mentions.reset();
      recent.refresh();
      const decisionType = Object.keys(decisionLabels).find(key => route.query.has(key));
      const decisionId = decisionType && route.query.get(decisionType);
      pendingDecision = decisionId ? decisionType + ':' + decisionId : '';
      decisionNotice.hidden = true;
      revealDecision();
      focusMessage = Boolean(route.query.get('favorite') || route.query.get('at'));
      revealMessage();
      if (!route.query.has('favorite') && !route.query.has('at')) scrollToEnd(true);
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
      revealDecision();
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

// 项目工作对话复用真实隔离会话。快照只更新消息区，草稿按身份和项目隔离。
import { h, replace, keyedList } from '../lib/dom.js';
import { createMessageSubmissions } from '../lib/message-submissions.js';
import { createConversationDrafts } from '../lib/conversation-drafts.js';
import { createMessageQuote } from '../lib/message-quote.js';
import { createMessageEdit } from '../lib/message-edit.js';
import { agentProgress } from '../ui/agent-progress.js';
import { renderFormattedText } from '../lib/markdown.js';
import { Button, Banner, Empty, TextArea } from '../ui/kit.js';
import { createCodeSidebar } from './code-sidebar.js';
import { attachSavedPrompts } from './saved-prompts.js';
import { createProjectInstructions } from './project-instructions.js';
import { createReplyTranslation } from './reply-translation.js';
import { createMessageFavorites } from './message-favorites.js';
import { createConversationExport } from './conversation-export.js';

export function createProjectConversation({ api, store, router, bindFolder }) {
  const code = createCodeSidebar({ api, store });
  let projectId = '';
  const translation = createReplyTranslation({ api, store, getScope: () => projectId, getConversationId: () => `project:${projectId}:work` });
  const instructions = createProjectInstructions({ api, store, getProjectId: () => projectId });
  const favorites = createMessageFavorites({ api, store, router });
  const transcript = createConversationExport({ api, store, getProjectId: () => projectId });
  let generation = 0;
  let request = 0;
  const drafts = createConversationDrafts({ api, store });
  const pending = new Map();
  const notices = new Map();
  let workspace, historyQuery = '', anchor = '', focused = false, navigationState;
  const locationNote = h('div', { class: 'row row--wrap small', hidden: true });
  const status = h('div', { 'aria-live': 'polite' });
  const progress = h('p', { class: 'muted small' });
  const messages = h('div', { class: 'project-conversation__messages', role: 'log', 'aria-label': '项目对话' });
  const text = TextArea({ rows: 3, placeholder: '告诉我这个文件夹里要做什么，我们持续推进。', 'aria-label': '项目目标' });
  const quote = createMessageQuote({ drafts, input: text });
  const edit = createMessageEdit({ input: text, quote, context: composerContext });
  const prompts = attachSavedPrompts({ api, store, input: text, getScope: () => projectId });
  text.addEventListener('input', () => {
    syncDraft();
    if (draftKey) drafts.write(draftKey, text.value);
  });
  text.addEventListener('keydown', (event) => {
    if (!event.defaultPrevented && event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });
  const send = Button({ label: '发送目标', kind: 'primary', onClick: submit });
  const notice = h('div', { 'aria-live': 'polite' });
  const composer = h('div', { class: 'project-conversation__composer stack' }, edit.notice, quote.bar, prompts.menu, text, h('div', { class: 'row row--between row--wrap' }, h('span', { class: 'muted small' }, '项目工作会话持续保留上下文。'), prompts.manage, send), notice);
  const el = h('div', { class: 'project-conversation code-conversation', id: 'panel-workspace', role: 'tabpanel' }, h('div', { class: 'stack code-conversation__main' }, h('div', { class: 'row row--between row--wrap' }, progress, h('div', { class: 'row row--wrap' }, instructions.button, favorites.button, transcript.button, code.toggle)), status, locationNote, messages, composer), code.el);
  const project = () => store.view.snapshot?.projects?.find(p => p.id === projectId && !p.archivedAt);
  let draftKey, owner, enabled, quotesEnabled, editEnabled, epoch = 0;
  const submissions = createMessageSubmissions({ api, context: submissionContext, onConfirmed: clearSubmittedDraft, captureEdit: edit.onAccepted,
    onStatus: message => { notices.set(projectId, message); paint(); } });
  send.before(submissions.button);
  function submissionContext() {
    const { key, owner } = composerContext();
    const draft = text.value, captured = quotesEnabled ? quote.capture() : '';
    const body = (captured ? quote.compose(captured, draft.trim()) : draft).trim();
    return { key, owner, draft, captured, body, epoch, conversation: `project:${projectId}:work`, projectId, url: `/projects/${encodeURIComponent(projectId)}/messages` };
  }
  function clearSubmittedDraft({ key, draft, captured }) {
    drafts.clearIf(key, draft);
    if (captured) quote.accepted(key, captured);
    if (draftKey === key && text.value === draft) { text.value = drafts.read(key); }
  }
  function composerContext() {
    const { snapshot, snapshotOwner, unauthorized } = store.view;
    const currentOwner = drafts.owner();
    const valid = snapshot && !unauthorized && snapshotOwner === currentOwner;
    const nextOwner = valid ? currentOwner : null;
    const nextEnabled = !!valid && snapshot.plugins?.some(p => p.id === 'conversation-drafts' && p.status === 'active');
    const key = valid && project() ? JSON.stringify(['project', projectId]) : null;
    const nextQuotes = !!key && snapshot.plugins?.some(p => p.id === 'conversation-quotes' && p.status === 'active');
    const allowEdit = !!key && snapshot.plugins?.some(p => p.id === 'conversation-edit' && p.status === 'active');
    return { key, owner: nextOwner, enabled: allowEdit, quotesEnabled: nextQuotes, draftsEnabled: nextEnabled };
  }
  function syncDraft() {
    const { key, owner: nextOwner, enabled: allowEdit, quotesEnabled: nextQuotes, draftsEnabled: nextEnabled } = composerContext();
    const sameDraft = owner === nextOwner && enabled === nextEnabled && quotesEnabled === nextQuotes && draftKey === key;
    if (sameDraft && editEnabled === allowEdit) return;
    editEnabled = allowEdit;
    edit.reset();
    if (sameDraft) return;
    quote.restore(nextQuotes ? key : null);
    if (owner !== nextOwner) {
      generation++; request++; workspace = undefined;
      pending.clear(); notices.clear();
    }
    if (owner !== nextOwner || enabled !== nextEnabled || quotesEnabled !== nextQuotes) epoch++;
    quotesEnabled = nextQuotes;
    owner = nextOwner; enabled = nextEnabled; draftKey = key;
    submissions.update();
    text.value = key ? drafts.read(key) : '';
    text.disabled = !key;
  }
  store.subscribe(syncDraft);
  syncDraft();

  function paint() {
    instructions.update();
    code.show(projectId);
    const p = project();
    const machine = store.view.snapshot?.machines?.find(m => m.id === p?.workspace?.machineId);
    const work = workspace?.agents?.work;
    replace(status, !p?.workspace ? Banner({ tone: 'warn', children: '这个项目还没有绑定文件夹。已有对话、待办和资料会保留。', action: Button({ label: '绑定文件夹', size: 'sm', onClick: () => bindFolder(p) }) })
      : !machine?.online ? Banner({ tone: 'warn', children: '绑定电脑离线。对话记录保留，文件夹是否存在尚未验证。' })
        : work?.available === false ? Banner({ tone: 'warn', children: work.reason || '项目工作会话暂不可用，请检查模型配置。' }) : null);
    progress.textContent = workspace?.progress ? `待办 ${workspace.progress.open ?? 0} · 正在执行 ${workspace.progress.running ?? 0} · 待核对 ${workspace.progress.review ?? 0}` : '';
    send.disabled = !draftKey || !p?.workspace || pending.has(projectId) || submissions.blocked() || !workspace || work?.available === false;
    replace(notice, notices.get(projectId) ? Banner({ tone: 'warn', children: notices.get(projectId) }) : null);
    const rows = workspace?.messages ?? [];
    const translationEpoch = translation.update(rows);
    const path = router.href('projects', projectId, 'workspace');
    const page = workspace?.historyPage;
    locationNote.hidden = !historyQuery && !page?.hasEarlier;
    const before = page?.hasEarlier && rows[0]?.id;
    const after = page?.hasLater && rows.at(-1)?.id;
    const missing = anchor && workspace && !rows.some(row => row.id === anchor);
    const navState = JSON.stringify([path, historyQuery, before, after, Boolean(missing)]);
    if (navState !== navigationState) {
      navigationState = navState;
      replace(locationNote, missing && '当前项目中找不到这条消息。',
        before && h('a', { href: path + '?before=' + encodeURIComponent(before) }, '较早消息'),
        after && h('a', { href: path + '?after=' + encodeURIComponent(after) }, '较新消息'),
        historyQuery && h('a', { href: path }, '返回最新消息'));
    }
    if (!rows.length) {
      const title = !workspace ? '正在读取项目对话…' : historyQuery ? '这个位置没有更多消息' : '在这个文件夹里持续工作';
      replace(messages, Empty({ title, text: workspace && !historyQuery ? '直接输入目标，项目工作会话负责拆解并跟进。' : undefined }));
      messages._keyed = undefined;
      return;
    }
    if (!messages._keyed) messages.replaceChildren();
    keyedList(messages, rows, m => m.id, m => {
      const user = m.role === 'user';
      const canQuote = quotesEnabled && m.conversationId === `project:${projectId}:work` && (user || m.role === 'assistant')
        && m.origin !== 'notification' && typeof m.text === 'string' && m.text.trim();
      const canEdit = editEnabled && user && m.conversationId === `project:${projectId}:work` && (!m.projectId || m.projectId === projectId);
      const statusText = { failed: '处理失败，请查看原因', unknown: '结果未知，请核对，勿重复发送', pending: '处理中' }[m.status];
      const bubble = h('div', { class: 'msg__bubble' }, user && !/^> /m.test(m.text) ? m.text : renderFormattedText(m.text));
      return h('div', { class: 'msg msg--' + (user ? 'user' : 'assistant') + (m.id === anchor ? ' is-search-hit' : ''), dataset: { id: m.id } },
        h('div', { class: 'msg__col' },
          h('span', { class: 'msg__label' }, user ? '我' : '项目助手'),
          agentProgress(m),
          bubble,
          statusText && h('span', { class: 'msg__meta' }, statusText),
          h('span', null, favorites.mark(m, projectId), prompts.fromMessage(m), translation.action(m, bubble), canEdit && edit.action(m), canQuote && quote.action(m, user ? '我' : '项目助手'))));
    }, m => JSON.stringify([prompts.epoch, favorites.epoch, translationEpoch, quotesEnabled, editEnabled, owner, projectId, anchor, m]));
    if (historyQuery && !focused && el.isConnected && router.current.page === 'projects' && router.current.parts[1] === 'workspace') {
      const row = anchor ? messages.querySelector('[data-id="' + CSS.escape(anchor) + '"]') : messages.firstElementChild;
      if (row) { focused = true; row.tabIndex = -1; row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'center' }); }
    }
  }
  async function load() {
    if (!draftKey) return;
    const id = projectId, stamp = generation, order = ++request;
    try {
      const value = await api.get(`/projects/${encodeURIComponent(id)}/workspace` + historyQuery);
      if (stamp !== generation || order !== request) return;
      workspace = value;
      paint();
    } catch (error) {
      if (stamp !== generation || order !== request) return;
      replace(notice, Banner({ tone: 'danger', children: `无法读取项目对话：${error.message}` }));
    }
  }
  async function submit() {
    syncDraft();
    const ctx = submissionContext(), { key, projectId: id, body } = ctx, sender = epoch;
    if (!key || send.disabled || !body) return;
    const ticket = submissions.begin(ctx);
    if (!ticket) return;
    if (ticket.record.blocked) { notices.set(id, '发送结果未知，请先核对发送回执。'); paint(); return; }
    const submission = Symbol();
    const finishEdit = edit.onAccepted();
    pending.set(id, submission); notices.delete(id); paint();
    try {
      const answer = await api.post(ctx.url, { text: body }, { 'Idempotency-Key': ticket.record.id });
      syncDraft();
      if (sender !== epoch) return;
      const confirmed = submissions.accepted(ticket, answer, ctx, true);
      if (!confirmed && answer?.status === 'failed' && answer.requestId === undefined) notices.set(id, '发送失败，内容已保留。');
      else if (!confirmed) {
        submissions.block(ticket); notices.set(id, '处理结果未知，请先核对发送回执。');
      } else {
        finishEdit();
        clearSubmittedDraft(ctx);
        if (answer.status === 'failed') notices.set(id, '消息已受理，处理失败。');
      }
      if (confirmed && draftKey === key && historyQuery && router.current.page === 'projects' && router.current.parts[1] === 'workspace') {
        router.go(router.href('projects', id, 'workspace'));
      } else if (draftKey === key) await load();
      void store.refresh().catch(() => {});
    } catch (error) {
      syncDraft();
      if (sender !== epoch) return;
      if (!error.status || error.status >= 500 || /unknown|结果未知/i.test(error.message)) {
        if (error.status && /unknown|结果未知/i.test(error.message)) submissions.block(ticket);
        notices.set(id, '发送结果未知，可核对发送回执。网络中断时手动重试将使用原请求号。');
      } else notices.set(id, `发送被拒绝：${error.message}`);
    } finally {
      submissions.finish(ticket);
      if (pending.get(id) === submission) pending.delete(id);
      if (draftKey === key) paint();
    }
  }
  return {
    el,
    show(id, query) {
      const kind = ['at', 'before', 'after'].find(key => query?.has(key));
      const next = kind ? '?' + kind + '=' + encodeURIComponent(query.get(kind)) : '';
      if (historyQuery !== next || projectId !== id) workspace = undefined;
      historyQuery = next; anchor = query?.get('at') || ''; focused = false;
      if (projectId !== id) {
        instructions.close();
        prompts.changeScope();
        transcript.close();
        generation++; request++; projectId = id; workspace = undefined;
        syncDraft();
      }
      paint(); void load();
    },
    update() { paint(); void load(); },
  };
}

import { conversationSearchActive } from './search.js';
import { conversationMessageSearch } from './conversation-message-search.js';
import { createQueuedDraftEditor } from './edit-queued.js';
import { createMessageFiles, messageFiles } from './message-files.js';
import { conversationImagesActive, createMessageImages, messageImages } from './message-images.js';
import { createTurnRetry, turnRetryActive } from './retry-turn.js';
import { createMessageQueue } from './message-queue.js';
import { stopTurnButton, queueLabel, turnQueueActive } from './stop-turn.js';
import { attachSentHistory } from './sent-history.js';
// 项目工作对话复用真实隔离会话。快照只更新消息区，草稿按身份和项目隔离。
import { h, replace, keyedList } from '../lib/dom.js';
import { createMessageSubmissions, messagePayload } from '../lib/message-submissions.js';
import { createConversationDrafts } from '../lib/conversation-drafts.js';
import { createMessageQuote } from '../lib/message-quote.js';
import { createMessageEdit } from '../lib/message-edit.js';
import { agentProgress } from '../ui/agent-progress.js';
import { Button, Banner, Empty, TextArea } from '../ui/kit.js';
import { createCodeSidebar } from './code-sidebar.js';
import { attachFileMentions } from './file-mentions.js';
import { attachSavedPrompts } from './saved-prompts.js';
import { createProjectInstructions } from './project-instructions.js';
import { conversationStatusButton } from './conversation-status.js';
import { createReplyTranslation } from './reply-translation.js';
import { createMessageFavorites } from './message-favorites.js';
import { createConversationSharing } from './conversation-sharing.js';
import { createConversationExport } from './conversation-export.js';

export function createProjectConversation({ api, store, router, scope, bindFolder }) {
  const code = createCodeSidebar({ api, store });
  let projectId = '', todoId = '', requestedFile = '';
  const statusButton = conversationStatusButton({ api, store, scope, target: 'project', project: () => projectId, todo: () => todoId });
  const translation = createReplyTranslation({ api, store, getScope: () => projectId, getConversationId: () => `project:${projectId}:work` });
  const instructions = createProjectInstructions({ api, store, getProjectId: () => projectId });
  const messageSearch=conversationMessageSearch({api,store,router});
  const favorites = createMessageFavorites({ api, store, router });
  const sharing = createConversationSharing({api,store,getRows:()=>workspace?.messages});
  const transcript = createConversationExport({ api, store, getProjectId: () => projectId });
  let generation = 0;
  let request = 0;
  const drafts = createConversationDrafts({ api, store });
  const pending = new Map();
  const notices = new Map();
  let workspace, readError = '', historyQuery = '', anchor = '', citationVersion = '', focused = false, navigationState;
  const locationNote = h('div', { class: 'row row--wrap small', hidden: true });
  const status = h('div', { 'aria-live': 'polite' });
  const readErrorText = h('span');
  const readNotice = h('div', { class: 'row row--wrap', role: 'status', hidden: true }, readErrorText,
    Button({ label: '重试读取对话', size: 'sm', onClick: load }));
  const progress = h('p', { class: 'muted small' });
  const messages = h('div', { class: 'project-conversation__messages', role: 'log', 'aria-label': '项目对话' });
  const queue = createMessageQueue(api,store,messages,id=>router.href('projects',projectId,'workspace')+'?at='+encodeURIComponent(id)+(todoId?'&todo='+encodeURIComponent(todoId):''),item=>queuedEdit.action(workspace?.messages?.find(m=>m.id===item.id) || item,true));
  const text = TextArea({ rows: 3, placeholder: '告诉我这个文件夹里要做什么，我们持续推进。', 'aria-label': '项目目标' });
  const retryTurn = createTurnRetry(api,store);
  const files = createMessageFiles(api,store,text);
  const pictures = createMessageImages(text);
  let visible = false;
  const quote = createMessageQuote({ drafts, input: text, store, router, scope });
  const edit = createMessageEdit({ input: text, quote, context: composerContext });
  const prompts = attachSavedPrompts({ api, store, input: text, getScope: () => projectId });
  const mentions = attachFileMentions({ api, store, input: text, getProjectId: () => projectId });
  const history = attachSentHistory({ input: text, store, context: composerContext });
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
  const topic = h('p', { class: 'small', hidden: true });
  const selectedTodo = () => store.view.snapshot?.todos?.find(t => t.id === todoId && t.projectId === projectId);
  const composer = h('div', { class: 'project-conversation__composer stack' }, topic, queue.el, edit.notice, quote.bar, prompts.menu, mentions.menu, pictures.el, files.el, text, h('div', { class: 'row row--between row--wrap' }, h('span', { class: 'muted small' }, '项目工作会话持续保留上下文。'), prompts.manage, mentions.button, pictures.button, files.button, send), notice);
  const el = h('div', { class: 'project-conversation code-conversation', id: 'panel-workspace', role: 'tabpanel' }, h('div', { class: 'stack code-conversation__main' }, h('div', { class: 'row row--between row--wrap' }, progress, h('div', { class: 'row row--wrap' }, instructions.button, statusButton, messageSearch.button, favorites.button, transcript.button, sharing.button, code.toggle)), status, locationNote, readNotice, messages, composer), code.el);
  const project = () => store.view.snapshot?.projects?.find(p => p.id === projectId && !p.archivedAt);
  let draftKey, owner, enabled, quotesEnabled, editEnabled, outboxEnabled, epoch = 0;
  const submissions = createMessageSubmissions({ api, context: submissionContext, onConfirmed: clearSubmittedDraft, captureEdit: edit.onAccepted,
    isRecoveryEnabled: () => store.view.snapshot?.plugins?.some(p=>p.id==='conversation-outbox' && p.status==='active'),
    canPersistDraft: () => composerContext().draftsEnabled,
    onStatus: message => { notices.set(draftKey, message); paint(); } });
  send.before(submissions.button);
  composer.prepend(submissions.panel);
  const queuedEdit=createQueuedDraftEditor({api,store,input:text,pictures,files,context:submissionContext,
    isEditing:()=>!edit.notice.hidden,isSending:key=>pending.has(key),persist:()=>composerContext().draftsEnabled});
  function submissionContext() {
    const { key, owner } = composerContext();
    const draft = text.value, captured = quotesEnabled ? quote.capture() : '';
    const body = (captured ? quote.compose(captured, draft.trim()) : draft).trim();
    return { key, owner, draft, captured, images:pictures.capture(), files:files.capture(), body, epoch, conversation: `project:${projectId}:work`, projectId, todoId: todoId || undefined, url: `/projects/${encodeURIComponent(projectId)}/messages` };
  }
  function clearSubmittedDraft(ctx) {
    history.record(ctx);
    pictures.accepted(ctx);
    files.accepted(ctx);
    const { key, draft, captured } = ctx;
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
    const key = valid && project() && (!todoId || selectedTodo()) ? JSON.stringify(todoId ? ['project', projectId, todoId] : ['project', projectId]) : null;
    const nextQuotes = !!key && snapshot.plugins?.some(p => p.id === 'conversation-quotes' && p.status === 'active');
    const allowEdit = !!key && snapshot.plugins?.some(p => p.id === 'conversation-edit' && p.status === 'active');
    return { key, owner: nextOwner, enabled: allowEdit, quotesEnabled: nextQuotes, draftsEnabled: nextEnabled };
  }
  function syncDraft() {
    const { key, owner: nextOwner, enabled: allowEdit, quotesEnabled: nextQuotes, draftsEnabled: nextEnabled } = composerContext();
    const searchScope = visible && key && router.current.page==='projects' && {conversationId:`project:${projectId}:work`,projectId,todoId:todoId||undefined};
    messageSearch.update(searchScope); sharing.update(searchScope);
    queuedEdit.observe(key,nextOwner,visible && router.current.page==='projects');
    queue.update(visible && router.current.page==='projects' && key && '/projects/'+encodeURIComponent(projectId)+'/messages/queue'+(todoId?'?todoId='+encodeURIComponent(todoId):''),`project:${projectId}:work`);
    if (!visible || router.current.page !== 'projects') pictures.closeEditor();
    files.update(key,nextOwner,nextEnabled,{conversationId:`project:${projectId}:work`,projectId,...(todoId && {todoId})});
    pictures.update(key,nextOwner,nextEnabled,conversationImagesActive(store));
    const sameDraft = owner === nextOwner && enabled === nextEnabled && quotesEnabled === nextQuotes && draftKey === key;
    const recovery = store.view.snapshot?.plugins?.some(p=>p.id==='conversation-outbox' && p.status==='active');
    if (outboxEnabled !== recovery) { outboxEnabled = recovery; submissions.update(); }
    if (sameDraft && editEnabled === allowEdit) return;
    editEnabled = allowEdit;
    edit.reset();
    if (sameDraft) return;
    quote.restore(nextQuotes ? key : null);
    if (owner !== nextOwner) {
      generation++; request++; workspace = undefined; readError = '';
      pending.clear(); notices.clear();
    }
    if (owner !== nextOwner || enabled !== nextEnabled || quotesEnabled !== nextQuotes) epoch++;
    quotesEnabled = nextQuotes;
    owner = nextOwner; enabled = nextEnabled; draftKey = key;
    submissions.update();
    text.value = key ? drafts.read(key) : '';
    text.disabled = !key;
  }
  router.subscribe(route => { if (route.page !== 'projects') { visible = false; syncDraft(); } });
  store.subscribe(syncDraft);
  syncDraft();

  // Project history exposes only tool names for this Web reply. The full trace
  // may contain model context, tool arguments and output from other sources.
  function toolRecords(message,range) {
    const originalOwner=api.draftOwner();
    const output=h('div',{class:'small muted',role:'status',hidden:true});
    const valid=()=>button.isConnected && visible && originalOwner===api.draftOwner() && originalOwner===store.view.snapshotOwner &&
      !store.view.unauthorized && conversationSearchActive(store.view.snapshot) && projectId===range.projectId && (todoId||undefined)===range.todoId;
    const button=Button({label:'查看工具记录',size:'sm',kind:'ghost',onClick:async()=>{
      if(!valid()) return;
      if(!output.hidden) {output.hidden=true;button.textContent='查看工具记录';return;}
      output.hidden=false;output.textContent='正在读取…';button.disabled=true;
      try {
        const result=await api.post('/conversation-tool-records',{...range,messageId:message.id});
        if(valid()) {
          replace(output,result.names.length?h('ul',null,result.names.map(name=>h('li',null,name))):'此答复没有已记录的工具调用。');
          button.textContent='收起工具记录';
        }
      } catch(error) {
        if(valid()) {output.textContent=error.status===404?'此答复没有可核对的工具记录。':'读取失败：'+error.message;button.textContent='收起工具记录';}
      } finally {button.disabled=false;}
    }});
    return h('div',null,button,output);
  }
  function paint() {
    instructions.update();
    code.show(projectId);
    if (visible && requestedFile && code.openFile(requestedFile)) requestedFile = '';
    const p = project();
    const machine = store.view.snapshot?.machines?.find(m => m.id === p?.workspace?.machineId);
    const work = workspace?.agents?.work;
    replace(status, !p?.workspace ? Banner({ tone: 'warn', children: '这个项目还没有绑定文件夹。已有对话、待办和资料会保留。', action: Button({ label: '绑定文件夹', size: 'sm', onClick: () => bindFolder(p) }) })
      : !machine?.online ? Banner({ tone: 'warn', children: '绑定电脑离线。对话记录保留，文件夹是否存在尚未验证。' })
        : work?.available === false ? Banner({ tone: 'warn', children: work.reason || '项目工作会话暂不可用，请检查模型配置。' }) : null);
    progress.textContent = workspace?.progress ? `待办 ${workspace.progress.open ?? 0} · 正在执行 ${workspace.progress.running ?? 0} · 待核对 ${workspace.progress.review ?? 0}` : '';
    topic.hidden = !todoId;
    const currentTodo = selectedTodo();
    if (todoId) replace(topic, currentTodo ? '当前待办：' + currentTodo.title : '待办已移出当前项目或不存在。',
      ' · ', h('a', { href: router.href('projects', projectId, 'workspace') }, '返回项目对话'));
    send.disabled = !draftKey || !p?.workspace || pending.has(draftKey) || submissions.blocked() || !workspace || work?.available === false;
    replace(notice, notices.get(draftKey) ? Banner({ tone: 'warn', children: notices.get(draftKey) }) : null);
    readNotice.hidden = !readError;
    const errorText = readError && (workspace ? '无法更新项目对话，当前显示上次读取的记录。' : '无法读取项目对话。') + readError;
    if (readErrorText.textContent !== errorText) readErrorText.textContent = errorText;
    const rows = workspace?.messages ?? [];
    sharing.refreshRows();
    const translationEpoch = translation.update(rows);
    const path = router.href('projects', projectId, 'workspace') + (todoId ? '?todo=' + encodeURIComponent(todoId) : '');
    const separator = todoId ? '&' : '?';
    const page = workspace?.historyPage;
    locationNote.hidden = !historyQuery && !page?.hasEarlier;
    const before = page?.hasEarlier && rows[0]?.id;
    const after = page?.hasLater && rows.at(-1)?.id;
    const missing = anchor && workspace && !rows.some(row => row.id === anchor);
    const changed = Boolean(anchor && citationVersion && page?.anchorVersion && citationVersion !== page.anchorVersion);
    const navState = JSON.stringify([path, historyQuery, before, after, Boolean(missing), changed]);
    if (navState !== navigationState) {
      navigationState = navState;
      replace(locationNote, missing && '当前项目中找不到这条消息。',
        changed && '原消息在引用后已修改，当前显示最新正文。',
        before && h('a', { href: path + separator + 'before=' + encodeURIComponent(before) }, '较早消息'),
        after && h('a', { href: path + separator + 'after=' + encodeURIComponent(after) }, '较新消息'),
        historyQuery && h('a', { href: path }, '返回最新消息'));
    }
    if (!rows.length) {
      const title = !workspace ? '正在读取项目对话…' : historyQuery ? '这个位置没有更多消息' : '在这个文件夹里持续工作';
      replace(messages, !readError && Empty({ title, text: workspace && !historyQuery ? '直接输入目标，项目工作会话负责拆解并跟进。' : undefined }));
      messages._keyed = undefined;
      return;
    }
    if (!messages._keyed) messages.replaceChildren();
    const queueEnabled = turnQueueActive(store);
    const searchable=conversationSearchActive(store.view.snapshot) && !store.view.unauthorized && !!owner;
    const range={conversationId:`project:${projectId}:work`,projectId,todoId:todoId||undefined};
    const webInputs=new Set(rows.filter(row=>row.role==='user' && row.directWebInput && row.conversationId===range.conversationId &&
      row.projectId===projectId && (!todoId || row.todoId===todoId)).map(row=>row.id));
    const toolRecordAllowed=m=>searchable && m.role==='assistant' && (!m.origin || m.origin==='user') && m.projectId===projectId &&
      m.conversationId===range.conversationId && (!todoId || todoId===m.todoId) && m.replyTo && (webInputs.has(m.replyTo) || m.id===anchor);
    const retryEnabled = turnRetryActive(store);
    const retried = new Set(rows.filter(m=>m.retryOf).map(m=>m.retryOf));
    keyedList(messages, rows, m => m.id, m => {
      const user = m.role === 'user';
      const canQuote = quotesEnabled && m.conversationId === `project:${projectId}:work` && (user || m.role === 'assistant')
        && m.origin !== 'notification' && typeof m.text === 'string' && m.text.trim();
      const canEdit = (m.todoId || '') === todoId && editEnabled && user && m.conversationId === `project:${projectId}:work` && (!m.projectId || m.projectId === projectId);
      const statusText = queueLabel(m,queueEnabled) || (m.stoppedByUser ? '已停止本轮' : { failed: '处理失败，请查看原因', unknown: '结果未知，请核对，勿重复发送', pending: '处理中' }[m.status]);
      const bubble = h('div', { class: 'msg__bubble' }, user && !/^> /m.test(m.text) ? m.text : transcript.renderMessage(m, m.text));
      return h('div', { class: 'msg msg--' + (user ? 'user' : 'assistant') + (m.id === anchor ? ' is-search-hit' : ''), dataset: { id: m.id } },
        h('div', { class: 'msg__col' },
          h('span', { class: 'msg__label' }, user ? '我' : '项目助手'),
          m.todoId && h('a', { class: 'small', href: router.href('projects', projectId, 'todos', 'detail', m.todoId) }, '查看关联待办'),
          agentProgress(m), toolRecordAllowed(m) && toolRecords(m,range),
          bubble, messageFiles(api,store,m,rows,messages), user && messageImages(api,store,m,(m.todoId || '') === (todoId || '') ? pictures.editCopy.bind(null,composerContext().key) : undefined),
          statusText && h('span', { class: 'msg__meta' }, statusText),
          (!todoId || todoId === m.todoId) && retryTurn(m,rows,`project:${projectId}:work`,
            id=>router.href('projects',m.projectId,'workspace')+'?at='+encodeURIComponent(id)+(m.todoId?'&todo='+encodeURIComponent(m.todoId):'')),
          h('span', null, stopTurnButton(api,m,projectId,queueEnabled), queuedEdit.action(m), favorites.mark(m, projectId), prompts.fromMessage(m), transcript.copyMessage(m, translation.displayedText), translation.action(m, bubble, transcript.renderMessage), canEdit && edit.action(m), canQuote && quote.action(m, user ? '我' : '项目助手'))));
    }, m => JSON.stringify([prompts.epoch, favorites.epoch, transcript.active, translationEpoch, quotesEnabled, editEnabled, owner, projectId, todoId, anchor, !!toolRecordAllowed(m), queueEnabled, retryEnabled, retried.has(m.id), m]));
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
      readError = '';
      workspace = value;
      paint();
    } catch (error) {
      if (stamp !== generation || order !== request) return;
      // Keep an already loaded page during transient failures. A rejected read invalidates its contents.
      if (error.status >= 400 && error.status < 500) workspace = undefined;
      readError = error.message || '读取失败，请重试。';
      paint();
    }
  }
  async function submit() {
    syncDraft();
    const ctx = submissionContext(), { key, projectId: id, body } = ctx, sender = epoch;
    if (!key || send.disabled || !pictures.ready() || !files.ready() || (!body && !ctx.images.length && !ctx.files.length)) return;
    let payload;
    try { payload=messagePayload(ctx,{text:body,todoId:ctx.todoId}); }
    catch(error) { notices.set(key,error.message);paint();return; }
    const ticket = submissions.begin(ctx);
    if (!ticket) return;
    if (ticket.record.blocked) { notices.set(key, '发送结果未知，请先核对发送回执。'); paint(); return; }
    const submission = Symbol();
    const finishEdit = edit.onAccepted();
    pending.set(key, submission); notices.delete(key); paint();
    try {
      const receipt = await submissions.preflight(ticket,ctx);
      const current = submissionContext();
      if (current.owner!==ctx.owner || current.key!==ctx.key || current.epoch!==ctx.epoch) return;
      const answer = receipt ?? await api.post(ctx.url, payload, { 'Idempotency-Key': ticket.record.id });
      syncDraft();
      if (sender !== epoch) return;
      const confirmed = submissions.accepted(ticket, answer, ctx, true);
      if (!confirmed && answer?.status === 'failed' && answer.requestId === undefined) notices.set(key, '发送失败，内容已保留。');
      else if (!confirmed) {
        submissions.block(ticket); notices.set(key, '处理结果未知，请先核对发送回执。');
      } else {
        finishEdit();
        clearSubmittedDraft(ctx);
        if (answer.status === 'failed') notices.set(key, answer.stoppedByUser ? '已停止本轮。' : '消息已受理，处理失败。');
      }
      if (confirmed && draftKey === key && historyQuery && router.current.page === 'projects' && router.current.parts[1] === 'workspace') {
        router.go(router.href('projects', id, 'workspace') + (ctx.todoId ? '?todo=' + encodeURIComponent(ctx.todoId) : ''));
      } else if (draftKey === key) await load();
      void store.refresh().catch(() => {});
    } catch (error) {
      submissions.failed(ticket,error);
      if(error.status===410 && !error.receiptCheck) files.expired(ctx);
      syncDraft();
      if (sender !== epoch) return;
      if (!error.status || error.status >= 500 || /unknown|结果未知/i.test(error.message)) {
        if (error.status && /unknown|结果未知/i.test(error.message)) submissions.block(ticket);
        notices.set(key, '发送结果未知，可核对发送回执。网络中断时手动重试将使用原请求号。');
      } else notices.set(key, `发送被拒绝：${error.message}`);
    } finally {
      submissions.finish(ticket);
      if (pending.get(key) === submission) pending.delete(key);
      paint();
    }
  }
  return {
    el,
    hide() { visible = false; mentions.reset(); syncDraft(); },
    show(id, query) {
      visible = true;
      requestedFile = query?.get('file') || '';
      todoId = query?.get('todo') || '';
      const kind = ['at', 'before', 'after'].find(key => query?.has(key));
      const next = kind ? '?' + kind + '=' + encodeURIComponent(query.get(kind)) : '';
      if (historyQuery !== next || projectId !== id) { workspace = undefined; readError = ''; }
      historyQuery = next; anchor = query?.get('at') || '';
      citationVersion = query?.get('version') || ''; focused = false;
      if (projectId !== id) {
        instructions.close();
        prompts.changeScope();
        transcript.close();
        generation++; request++; projectId = id; mentions.update(); workspace = undefined;
      }
      syncDraft();
      const savedDraft = draftKey ? drafts.read(draftKey) : '';
      if (text.value !== savedDraft) text.value = savedDraft;
      quote.restore(quotesEnabled ? draftKey : null);
      paint(); void load();
    },
    update() { paint(); void load(); },
  };
}

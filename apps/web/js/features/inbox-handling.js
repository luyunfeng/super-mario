import { h, replace, debounce } from '../lib/dom.js';
import { Banner, Button, Card, Field, Input, Select, TextArea } from '../ui/kit.js';
import { openDrawer, confirmDialog } from '../ui/overlay.js';

const TYPES = [['todo', '待办'], ['dispatch', '派发执行'], ['reply', '回复草稿'], ['conclusion', '处理结论']];
const STATUS = { draft: '草稿', submitted: '已提交审批（未执行）', executing: '执行中', applied: '已应用（不代表待办完成）', stale: '来源已过期', unknown: '结果未知', pending: '已持久受理，等待模型处理', completed: '模型请求已完成', failed: '模型请求失败' };
const locked = suggestion => ['applied', 'unknown', 'executing', 'stale'].includes(suggestion.status);
const sessions = new WeakMap();
const tokenWatches = new WeakMap();

// API 尚无令牌订阅接口。只在抽屉存活时观察 setter，避免另建轮询或 SSE。
function watchToken(api, listener) {
  let watch = tokenWatches.get(api);
  if (!watch) {
    const original = api.setToken;
    const listeners = new Set();
    const wrapped = function (...args) {
      const before = api.token?.();
      const result = original.apply(this, args);
      if (api.token?.() !== before) for (const fn of [...listeners]) fn();
      return result;
    };
    watch = { original, wrapped, listeners };
    tokenWatches.set(api, watch);
    api.setToken = wrapped;
  }
  watch.listeners.add(listener);
  return () => {
    watch.listeners.delete(listener);
    if (!watch.listeners.size) {
      if (api.setToken === watch.wrapped) api.setToken = watch.original;
      tokenWatches.delete(api);
    }
  };
}
function assistantText(message) {
  if (message.role !== 'assistant') return message.text;
  try {
    const data = JSON.parse(message.text);
    if (data && typeof data === 'object' && ('answer' in data || 'suggestions' in data)) return typeof data.answer === 'string' ? data.answer : '建议请查看下方真实建议列表。';
  } catch { /* 普通助手文本。 */ }
  return message.text;
}
function actionText(action) {
  if (action.kind === 'todo') return `标题：${action.title}\n备注：${action.notes}`;
  if (action.kind === 'dispatch') return `执行者：${action.executorId}\n执行内容：${action.prompt}\n验收要求：${action.doneWhen}\n预计分钟：${action.expectMinutes}\n工作目录：${action.cwd || '使用执行者默认目录'}`;
  return action.text;
}

export function openInboxHandlingDrawer({ api, store, source }) {
  if (!['personal', 'mailbox'].includes(source.kind) || !source.id) throw new Error('无效的收件来源');
  const token = api.token?.();
  let credentials = sessions.get(api);
  if (!credentials) { credentials = new Map(); sessions.set(api, credentials); }
  let records = credentials.get(token);
  if (!records) { records = new Map(); credentials.set(token, records); }
  const sourceKey = JSON.stringify([source.kind, source.id]);
  let local = records.get(sourceKey);
  if (!local) { local = { message: '', messageAttempt: null, writeLocks: new Set() }; records.set(sourceKey, local); }
  local.acknowledgedUnknown ??= new Set();
  const path = `/inbox-handling/${source.kind}/${encodeURIComponent(source.id)}`;
  let view, alive = true, readRevision = 0, writeRevision = 0, writing = false, editor, preview;
  let lastSnapshot = store.view.snapshot;
  const origin = h('div'), notice = h('div', { role: 'status' }), model = h('div'), conversation = h('div', { class: 'stack', 'aria-label': '单条处理对话' });
  const requests = h('div', { class: 'stack', 'aria-label': '模型请求状态' }), suggestions = h('div', { class: 'stack', 'aria-label': '建议列表' });
  const editorHost = h('div'), confirmation = h('div'), result = h('div', { role: 'status' });
  const message = TextArea({ rows: 3, 'aria-label': '处理指令', placeholder: '输入这条消息的处理要求', value: local.message });
  message.addEventListener('input', () => { local.message = message.value; });
  const send = Button({ label: '发送处理指令', onClick: sendMessage, disabled: true });
  const create = Button({ label: '手工新建建议', onClick: () => startEditor(), disabled: true });
  const fresh = Button({label:'核对后发起新分析',onClick:async()=>{
    if(!current()||writing)return;
    const approved=await confirmDialog({title:'发起新的只读分析',message:'原请求结果仍未知，可能已产生回答。新请求使用新标识，只做分析，不重发旧审批或外部动作。确认已核对后继续？',confirmLabel:'已核对，允许新分析'});
    if(!approved||!current())return;
    for(const request of view.requests)if(request.status==='unknown')local.acknowledgedUnknown.add(request.id);
    if(local.messageAttempt?.status==='unknown')local.messageAttempt=null;
    paint();message.focus();
  }});
  fresh.hidden=true;
  const body = h('div', { class: 'stack', style: { fontSize: '14px', minWidth: '0', overflowWrap: 'anywhere' } },
    origin, notice, model, conversation, requests, fresh, Field({ label: '普通用户指令', control: message }), send,
    h('p', { class: 'small muted' }, '发送只请求模型分析。保存建议不会执行；提交建议只创建审批。执行结束不等于待办完成。'),
    create, suggestions, editorHost, confirmation, result);
  const drawer = openDrawer({ title: '处理与建议', body, footer: Button({ label: '关闭', onClick: () => drawer.close() }), onClose: cleanup });
  const unwatch = watchToken(api, () => { cleanup(); drawer.close(); });
  const schedule = debounce(read, 100);
  const unsubscribe = store.subscribe(state => {
    if (!current()) return;
    if (state.snapshot !== lastSnapshot) { lastSnapshot = state.snapshot; schedule(); }
  });
  function cleanup() {
    if (!alive) return;
    alive = false; readRevision++; writeRevision++;
    if (local.messageAttempt?.status === 'submitting') local.messageAttempt.status = 'unknown';
    schedule.cancel(); unsubscribe?.(); unwatch();
  }
  function current() { return alive && drawer.el.open && api.token?.() === token; }
  function say(text) { replace(notice, text && Banner({ tone: 'warn', children: text })); }
  function scopeText() {
    const id = view.source.projectId;
    const project = id ? `项目：${store.view.snapshot?.projects?.find(p => p.id === id)?.name || id} (${id})`
      : source.kind === 'personal' ? '个人范围（未归项目）' : '来源范围：未标注项目（以服务端来源为准）';
    return `${project}${view.source.todoId ? ` · 待办：${view.source.todoId}` : ''}`;
  }
  function sourceText() { return `${source.kind}/${source.id} · ${view.source.title} · 来源版本 ${view.source.version} · ${scopeText()}`; }
  function confirmReason(item) {
    if (!view.source.active) return view.source.reason || '来源不可处理';
    if (item.status === 'stale' || item.sourceVersion !== view.source.version) return '来源已过期，请检查来源新版本后保存新版建议';
    if (locked(item) || item.status === 'submitted') return '此版本已提交或不可再次提交';
    if (item.action.kind === 'reply' && !view.source.replyAvailable) return view.source.replyReason || '当前来源不支持回复';
    if (local.writeLocks.has(item.id)) return '上次写入结果未知，请核对，禁止重复提交';
    return '';
  }
  async function read() {
    if (!current()) return;
    const revision = ++readRevision;
    try {
      const next = await api.get(path);
      if (!current() || revision !== readRevision) return;
      if (next.source.kind !== source.kind || next.source.id !== source.id) { say('服务返回的来源不匹配，已忽略。'); return; }
      view = next;
      const attempt = local.messageAttempt;
      const found = attempt && view.requests.find(r => r.key === attempt.key);
      if (found) {
        attempt.status = found.status;
        if (['completed', 'failed'].includes(found.status)) local.messageAttempt = null;
      }
      paint();
    } catch (error) {
      if (!current() || revision !== readRevision) return;
      say(error.status === 404 ? '当前服务不支持逐条处理与建议，请升级服务。' : `读取失败：${error.message}`);
    }
  }
  function paint() {
    replace(origin, h('strong', null, view.source.title), h('p', { class: 'small muted' }, sourceText()), h('pre', { class: 'mailbox-content' }, view.source.text));
    replace(model, !view.source.active && Banner({ tone: 'warn', children: view.source.reason || '来源不可处理' }), Banner({ children: view.available ? '主模型可用；只有显式发送指令才请求模型。' : `主模型不可用：${view.reason || '缺少模型配置'}。仍可手工写建议。` }));
    replace(conversation, view.messages.map(m => h('section', null, h('strong', null, m.role === 'user' ? '你' : '助手'), m.conversationId!==view.conversationId&&h('p',{class:'small muted'},'较早来源版本，仅作记录'), h('p', { style: { whiteSpace: 'pre-wrap' } }, assistantText(m)), m.status && h('span', { class: 'small muted' }, m.status === 'pending' ? '等待模型回复' : m.status === 'failed' ? '回复失败' : '对话已记录'))));
    replace(requests, view.requests.map(r => h('p', { class: 'small' }, `${r.id} · ${STATUS[r.status] || r.status}${r.error ? `：${r.error}` : ''}`)),
      local.messageAttempt && !view.requests.some(r => r.key === local.messageAttempt.key) && h('p', null, `本次请求 ${local.messageAttempt.key} · ${local.messageAttempt.status === 'unknown' ? '结果未知，禁止自动重放；等待读取持久记录核对。' : STATUS[local.messageAttempt.status] || '正在提交'}`));
    const unknown = view.requests.some(r=>r.status==='unknown'&&!local.acknowledgedUnknown.has(r.id))||local.messageAttempt?.status==='unknown';
    fresh.hidden=!unknown;
    send.disabled = writing || !view.available || !view.source.active || Boolean(local.messageAttempt) || unknown || view.requests.some(r=>r.status==='pending');
    create.disabled = writing || !view.source.active;
    replace(suggestions, view.suggestions.map(item => {
      const reason = confirmReason(item);
      return Card({ title: `${TYPES.find(([k]) => k === item.action.kind)?.[1] || item.action.kind} · 版本 ${item.version}`, body: h('div', { class: 'stack' },
        h('p', null, STATUS[item.status] || item.status), h('pre', { class: 'mailbox-content' }, actionText(item.action)),
        item.error && h('p', null, item.error), item.approvalId && h('p', null, `审批 ID：${item.approvalId}（不代表已执行、已发送或已完成）`, h('a', { href: '#chat',onClick:()=>drawer.close() }, '查看已提交审批')),
        item.result?.runId&&h('a',{href:`#projects/${encodeURIComponent(view.source.projectId||'all')}/runs/${encodeURIComponent(item.result.runId)}`,onClick:()=>drawer.close()},'查看实际执行记录'),
        item.result?.todoId&&h('p',null,`已关联待办：${item.result.todoId}`),
        item.result?.outboxId&&h('a',{href:'#outbox',onClick:()=>drawer.close()},'查看实际发件记录'),
        item.status === 'submitted' && h('p', { class: 'small muted' }, '可编辑并保存新版，旧审批将失效。'), reason && h('p', { class: 'small muted' }, reason),
        h('div', { class: 'row row--wrap' }, Button({ label: '编辑建议', disabled: writing || locked(item) || local.writeLocks.has(item.id), onClick: () => startEditor(item) }),
          Button({ label: '检查并提交审批', disabled: writing || Boolean(reason), onClick: () => showConfirmation(item) }))) });
    }));
    if (editor) updateEditorState();
    if (preview) showConfirmation(view.suggestions.find(s => s.id === preview.id) || preview);
  }
  function startEditor(item) {
    if (editor && !window.confirm('放弃当前未保存的建议草稿？')) return;
    preview = undefined; replace(confirmation);
    const action = item?.action || { kind: 'todo', title: '', notes: '' };
    editor = { id: item?.id, version: item?.version, sourceVersion: view.source.version, controls: {}, conflict: false };
    const type = Select({ 'aria-label': '建议类型', options: TYPES, value: action.kind });
    const fields = h('div', { class: 'stack' }), state = h('div');
    const save = Button({ label: '保存建议（不执行）', onClick: saveSuggestion });
    editor.type = type; editor.save = save; editor.state = state;
    function fieldsFor(kind, values = {}) {
      const specs = kind === 'todo' ? [['title', '待办标题'], ['notes', '待办备注']] : kind === 'dispatch'
        ? [['executorId', '执行者'], ['prompt', '执行内容'], ['doneWhen', '验收要求'], ['expectMinutes', '预计分钟'], ['cwd', '工作目录（可选）']] : [['text', kind === 'reply' ? '回复内容' : '结论内容']];
      editor.controls = {};
      replace(fields, specs.map(([key, label]) => {
        let control;
        if (key === 'executorId') {
          const executors = store.view.snapshot?.executors || [];
          const options = [['', '选择执行者'], ...executors.map(e => [e.id, `${e.name} (${e.id})${e.available ? '' : ' · 离线或不可用'}`])];
          if (values[key] && !executors.some(e => e.id === values[key])) options.push([values[key], `${values[key]} · 已不在快照中`]);
          control = Select({ options, value: values[key] || '', 'aria-label': label });
        } else if (key === 'expectMinutes') control = Input({ type: 'number', min: 1, step: 1, value: values[key] ?? 30, 'aria-label': label });
        else control = TextArea({ rows: key === 'title' || key === 'cwd' ? 2 : 3, value: values[key] || '', 'aria-label': label });
        editor.controls[key] = control;
        return Field({ label, control });
      }));
    }
    type.addEventListener('change', () => fieldsFor(type.value));
    fieldsFor(action.kind, action);
    replace(editorHost, Card({ title: item ? `编辑建议 · 原版本 ${item.version}` : '新建建议', body: h('div', { class: 'stack' },
      h('p', { class: 'small' }, '仅使用此来源范围。执行者来自实际快照，可选离线执行者；后端会做最终检查。'),
      Field({ label: '建议类型', control: type }), fields, state, h('div', { class: 'row row--wrap' }, save,
        Button({ label: '取消编辑', onClick: () => { editor = undefined; replace(editorHost); } }))) }));
    updateEditorState();
  }
  function updateEditorState() {
    const item = editor.id && view.suggestions.find(s => s.id === editor.id);
    const blocked = item && locked(item);
    editor.save.disabled = writing || blocked || local.writeLocks.has(editor.id || 'new') || editor.conflict || !view.source.active;
    editor.type.disabled = writing || Boolean(blocked);
    for (const control of Object.values(editor.controls)) control.disabled = writing || Boolean(blocked);
    replace(editor.state, h('p', { class: 'small muted' }, `草稿来源版本：${editor.sourceVersion}；当前来源版本：${view.source.version}`),
      blocked && h('p', null, '建议已进入不可编辑状态，保留草稿供核对。'),
      local.writeLocks.has(editor.id || 'new') && !writing && h('p', null, '上次保存结果未知，请核对持久记录。此请求已锁定，不可重复提交。'),
      editor.id && item?.status === 'submitted' && h('p', null, '保存新版后旧审批失效。'),
      editor.conflict && Button({ label: '已检查新版本，保留草稿继续编辑', onClick: () => {
        // 只有用户明确检查后才换版本；绝不在 409 或 SSE 到来时偷偷重试。
        editor.sourceVersion = view.source.version; editor.version = item?.version ?? editor.version; editor.conflict = false; updateEditorState();
      } }));
  }
  function readAction() {
    const kind = editor.type.value;
    const values = Object.fromEntries(Object.entries(editor.controls).map(([key, control]) => [key, control.value.trim()]));
    const required = kind === 'todo' ? ['title', 'notes'] : kind === 'dispatch' ? ['executorId', 'prompt', 'doneWhen'] : ['text'];
    if (required.some(key => !values[key])) throw new Error('请填写全部必填内容');
    if (kind === 'dispatch') {
      values.expectMinutes = Number(values.expectMinutes);
      if (!Number.isSafeInteger(values.expectMinutes) || values.expectMinutes <= 0) throw new Error('预计分钟必须是有效正数（正整数）');
      if (!(store.view.snapshot?.executors || []).some(e => e.id === values.executorId)) throw new Error('请选择当前快照中的执行者');
      if (!values.cwd) delete values.cwd;
    }
    return { kind, ...values };
  }
  async function post(suffix, payload, onSuccess, lockKey) {
    if (!current() || writing) return;
    writing = true; const revision = ++writeRevision; readRevision++;
    if (lockKey) local.writeLocks.add(lockKey);
    if (view) paint();
    try {
      const value = await api.post(path + suffix, payload);
      if (!current() || revision !== writeRevision) return;
      readRevision++;
      if (lockKey) local.writeLocks.delete(lockKey);
      onSuccess(value); schedule();
    } catch (error) {
      if (!current() || revision !== writeRevision) return;
      const unknown = !error.status || error.status >= 500;
      if (!unknown && lockKey) local.writeLocks.delete(lockKey);
      if (suffix === '/messages') {
        if (unknown) local.messageAttempt.status = 'unknown';
        else local.messageAttempt = null;
      }
      if (error.status === 409 && editor && suffix === '/suggestions') { editor.conflict = true; schedule(); }
      say(unknown ? '写入结果未知，已锁定该请求；不会自动重放，请核对持久记录。' : error.status === 409 ? '版本冲突。草稿已保留，请检查来源与建议的新版本后手动操作。' : `提交失败：${error.message}`);
    } finally {
      if (current() && revision === writeRevision) { writing = false; if (view) paint(); }
    }
  }
  async function sendMessage() {
    if (send.disabled || !message.value.trim()) return;
    const text = message.value.trim();
    const key = crypto.randomUUID();
    local.messageAttempt = { key, status: 'submitting' };
    await post('/messages', { sourceVersion: view.source.version, text, key }, request => {
      local.messageAttempt.status = request.status;
      if (message.value.trim() === text) { message.value = ''; local.message = ''; }
      say(`${STATUS[request.status] || request.status} · 请求 ID：${request.id}。受理不代表模型已完成。`);
    });
  }
  async function saveSuggestion() {
    if (!editor || editor.save.disabled) return;
    let action;
    try { action = readAction(); } catch (error) { say(error.message); return; }
    const draft = editor;
    await post('/suggestions', { sourceVersion: draft.sourceVersion, action, ...(draft.id ? { id: draft.id, version: draft.version } : {}) }, saved => {
      if (editor === draft) { editor = undefined; replace(editorHost); }
      view.suggestions = [...view.suggestions.filter(s => s.id !== saved.id), saved];
      say(`已保存建议版本 ${saved.version}，未执行。`);
    }, draft.id || 'new');
  }
  function showConfirmation(item) {
    preview = item;
    const reason = confirmReason(item);
    replace(confirmation, Card({ title: '核对当前完整建议', body: h('div', { class: 'stack' },
      h('p', null, sourceText()), h('p', null, `类型：${TYPES.find(([k]) => k === item.action.kind)?.[1]} · 建议版本 ${item.version} · 建议来源版本 ${item.sourceVersion}`),
      h('pre', { class: 'mailbox-content' }, actionText(item.action)),
      h('p', null, '只提交当前内容审批。审批通过后的执行或回复结果另行记录。未保存的编辑内容不会提交。'), reason && h('p', null, reason),
      Button({ label: '提交当前建议审批', disabled: writing || Boolean(reason), onClick: () => submit(item) })) }));
  }
  async function submit(item) {
    if (confirmReason(item)) return;
    await post(`/suggestions/${encodeURIComponent(item.id)}/confirm`, { sourceVersion: view.source.version, version: item.version }, approval => {
      preview = undefined; replace(confirmation);
      item.status = 'submitted'; item.approvalId = approval.id;
      replace(result, h('p', null, `已提交审批，审批 ID：${approval.id}。未执行、未发送，不代表已完成。`), h('a', { href: '#chat', onclick: () => drawer.close() }, '去对话审批'));
    }, item.id);
  }
  schedule();
  return drawer;
}

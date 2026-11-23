// 用户主动报告与验收。快照通知不重建抽屉；未知写请求跨抽屉锁定，绝不重放。
import { h, replace } from '../lib/dom.js';
import { Button, Field, Input, TextArea, Select } from '../ui/kit.js';
import { openDrawer, confirmDialog } from '../ui/overlay.js';

const uncertainByApi = new WeakMap();
const pendingByApi = new WeakMap();
let active;
export function refreshTaskClosure(api) {
  if (active?.api === api) active.refreshCandidates();
}

export function openTaskClosure({ api, store, router, todo, runId, expectedReview, title = '答复与验收' }) {
  active?.close();
  let alive = true, sequence = 0, busy = false, loaded = false, stale = false;
  let reporting, review, sources, configVersion, dirty = false;
  let locks = uncertainByApi.get(api);
  if (!locks) { locks = new Set(); uncertainByApi.set(api, locks); }
  let pending = pendingByApi.get(api);
  if (!pending) { pending = new Set(); pendingByApi.set(api, pending); }
  const base = `/todos/${encodeURIComponent(todo.id)}`;
  const required = Input({ type: 'checkbox', 'aria-label': '关闭前需答复' });
  const delivery = Input({ type: 'checkbox', 'aria-label': '需要渠道送达' });
  const message = Select({ options: [], 'aria-label': '选择真实答复' });
  const outbox = Select({ options: [], 'aria-label': '选择渠道回执' });
  const receiptState = h('p', { class: 'small muted', 'aria-live': 'polite' });
  const runs = Select({ options: [], 'aria-label': '选择交付' });
  const defects = TextArea({ rows: 3, placeholder: '说明具体缺陷与预期结果', 'aria-label': '返工缺陷' });
  const notice = h('p', { role: 'alert', class: 'small text-danger' });
  const state = h('p', { class: 'small muted', 'aria-live': 'polite' });
  const evidence = h('div', { class: 'stack small' });
  const deliveryHint = h('p', { class: 'small muted' });
  const controls = [];
  const action = (label, onClick, kind) => {
    const button = Button({ label, onClick, kind }); controls.push(button); return button;
  };
  function receipts() { return sources?.outbox ?? []; }
  function receiptAllowed(item) {
    const answer = (sources?.messages ?? store.view.snapshot?.messages ?? []).find(value => value.id === message.value);
    const linked = item.relatedTo?.kind === 'todo' && item.relatedTo.id === todo.id
      || answer && item.relatedTo?.kind === 'message' && item.relatedTo.id === answer.id;
    return linked && item.content?.text?.trim() && item.channel?.trim() && item.target?.trim()
      && (!answer || item.content.text === answer.text)
      && (!delivery.checked || item.status === 'sent');
  }
  function canReport() {
    const receipt = receipts().find(item => item.id === outbox.value);
    return Boolean((message.value || receipt) && (!outbox.value || receipt && receiptAllowed(receipt))
      && (!reporting?.requireDelivery || receipt?.status === 'sent'));
  }
  function resumeMismatch(run) {
    if (!run?.nativeResume) return '';
    if (!run.nativeSessionId || run.nativeSessionId !== run.nativeResume.nativeSessionId) return '原生会话编号缺失或与恢复请求不符。';
    const executor = run.nativeResume.executorId;
    const remoteMatch = run.machineId && run.executorId === run.machineId + '/' + executor;
    if (!executor || (run.executorId !== executor && !remoteMatch)) {
      return '执行者与恢复请求或绑定电脑不符。';
    }
    return '';
  }
  function sync() {
    const locked = busy || pending.has(todo.id) || !loaded || stale || locks.has(todo.id) || review?.status === 'unknown' || review?.status === 'dispatching';
    for (const input of [required, delivery]) input.disabled = busy || pending.has(todo.id) || !loaded;
    for (const button of controls) button.disabled = locked;
    save.disabled = locked || !dirty;
    report.disabled = locked || dirty || !canReport();
    for (const option of outbox.options) {
      if (option.value) option.disabled = !receiptAllowed(receipts().find(item => item.id === option.value));
    }
    const receipt = receipts().find(item => item.id === outbox.value);
    receiptState.textContent = receipt ? `${receipt.channel} → ${receipt.target} · ${receipt.status === 'sent' ? '已送达（sent）' : `未确认送达（${receipt.status}），不能作为送达证据`} · ${receipt.content?.text ?? ''}` : '';
    attach.disabled = locked || !runs.value || review?.status === 'accepted';
    const run = (store.view.snapshot?.runs ?? []).find(item => item.id === review?.runId && item.todoId === todo.id && item.projectId === todo.projectId);
    const nativeSources = run?.nativeResultSources ?? [];
    const source = run?.resultSource;
    const sourceOK = typeof source === 'string' && source.trim() !== ''
      && !['demo', 'screen', 'runner', 'terminal-idle', 'idle', 'unknown'].includes(source.trim().toLowerCase())
      && (source === 'real' || nativeSources.includes(source));
    accept.disabled = locked || dirty || review?.status !== 'pending' || run?.status !== 'completed' || !sourceOK || !run?.output?.trim() || Boolean(resumeMismatch(run));
    rework.disabled = locked || review?.status !== 'pending' || !['completed', 'failed'].includes(run?.status) || defects.value.trim().length < 4;
    deliveryHint.textContent = delivery.checked
      ? '必须选择实际 sent 出站回执才能满足渠道送达；queued / unknown 未确认送达，不能记录为送达证据。这里只记录已有回执，不触发发送。'
      : '可选择本地答复或渠道回执，也可同时选择。queued / unknown 未确认送达；记录不会触发发送。';
    if (locks.has(todo.id)) notice.textContent = '请求结果未知，已锁定重复提交。请只读刷新并核对服务端账本，不要重放请求。';
  }
  function candidates() {
    if (!alive) return;
    const snapshot = store.view.snapshot ?? {};
    const selectedMessage = message.value, selectedOutbox = outbox.value, selectedRun = runs.value || runId || '';
    const messages = (sources?.messages ?? snapshot.messages ?? []).filter(item => item.todoId === todo.id && item.projectId === todo.projectId && item.role === 'assistant' && item.status === 'done' && item.text?.trim());
    replace(message, h('option', { value: '' }, '选择真实答复'), messages.map(item => h('option', { value: item.id }, `${item.text}${item.conversationId && item.conversationId !== 'main' ? ` · 会话：${item.conversationId}` : ''}`)));
    message.value = messages.some(item => item.id === selectedMessage) ? selectedMessage : '';
    replace(outbox, h('option', { value: '' }, '不选择渠道回执'), receipts().map(item => h('option', { value: item.id }, `${item.channel} → ${item.target} · ${item.status === 'sent' ? '已送达（sent）' : `未确认送达（${item.status}）`} · ${item.content?.text ?? ''}`)));
    outbox.value = receipts().some(item => item.id === selectedOutbox) ? selectedOutbox : '';
    const deliveries = (snapshot.runs ?? []).filter(item => item.todoId === todo.id && item.projectId === todo.projectId && item.doneWhen?.trim());
    replace(runs, h('option', { value: '' }, '选择交付'), deliveries.map(item => h('option', { value: item.id }, `${item.prompt} · ${item.status} · ${item.doneWhen}`)));
    runs.value = deliveries.some(item => item.id === selectedRun) ? selectedRun : '';
    sync();
  }
  function paintState() {
    state.textContent = `答复版本 ${reporting.version} · 周期 ${reporting.cycle} · ${reporting.report ? '已记录答复' : '未记录答复'}${review ? ` · 验收 ${review.evidenceInvalidated ? '证据已失效（历史决定为通过）' : review.status} · ${review.round ? `返工第 ${review.round} 轮` : '首次交付'} · 版本 ${review.version}` : ' · 尚未关联交付'}`;
    const run = (store.view.snapshot?.runs ?? []).find(item => item.id === review?.runId && item.todoId === todo.id && item.projectId === todo.projectId);
    const mismatch = run?.status === 'completed' && resumeMismatch(run);
    replace(evidence, review ? [h('p', null, `完成标准：${review.doneWhen}`), h('p', null, `关联交付：${run?.prompt ?? review.runId}`), run && h('p', null, `执行状态：${run.status} · 证据来源：${run.resultSource ?? '无'}`), run?.nativeResume && h('dl', { class: 'kv' },
      h('dt', null, '请求恢复的会话'), h('dd', null, run.nativeResume.nativeSessionId),
      h('dt', null, '结果所属会话'), h('dd', null, run.nativeSessionId || '未上报'),
      h('dt', null, '执行者'), h('dd', null, run.executorId)),
      mismatch && h('p', { class: 'text-danger' }, mismatch), run?.output && h('pre', { class: 'output' }, run.output), h('p', { style: { overflowWrap: 'anywhere' } }, `证据版本：${review.evidenceVersion}`), review.error && h('p', { class: 'text-danger' }, review.error)] : []);
    candidates();
  }
  async function read() {
    if (busy) return;
    const stamp = ++sequence;
    try {
      const result = await api.get(`${base}/closure`);
      if (!alive || stamp !== sequence) return;
      if(expectedReview && (!result.review || result.review.status!=='pending' || result.review.todoId!==todo.id ||
          result.review.runId!==expectedReview.runId || result.review.version!==expectedReview.version || result.review.evidenceVersion!==expectedReview.evidenceVersion)){
        stale=true;loaded=false;notice.textContent='原交付或验收证据已变化，请关闭后重新核对。';replace(evidence);sync();return;
      }
      reporting = result.reporting; review = result.review; sources = result.sources; loaded = true; stale = false;
      // 编辑中的开关和其基准版本一起保留，避免迟到的读取覆盖用户意图。
      if (!dirty) { required.checked = reporting.required; delivery.checked = reporting.requireDelivery; configVersion = reporting.version; }
      notice.textContent = ''; paintState();
    } catch (error) { if (alive && stamp === sequence) { notice.textContent = `读取失败：${error.message}`; sync(); } }
  }
  async function write(path, body, method, apply) {
    if (busy || pending.has(todo.id) || !loaded || stale || locks.has(todo.id) || ['unknown', 'dispatching'].includes(review?.status)) return;
    busy = true; pending.add(todo.id); ++sequence; sync();
    try {
      const result = await api[method](`${base}${path}`, body);
      if (!alive) return;
      apply(result); notice.textContent = ''; paintState();
      // 通知刷新失败不改变已经收到确认的写请求结果。
      Promise.resolve().then(() => store.refresh()).catch(() => {});
    } catch (error) {
      // 4xx 明确拒绝；网络、5xx 或无法读取确认结果都可能已经执行。
      if (!error.status || error.status >= 500) locks.add(todo.id);
      if (alive) { stale = error.status === 409; notice.textContent = error.message; }
    } finally { busy = false; pending.delete(todo.id); if (alive) sync(); }
  }
  const save = action('保存答复要求', async () => {
    if (!dirty) return;
    await write('/reporting', { required: required.checked, requireDelivery: delivery.checked, version: configVersion }, 'put', value => {
      reporting = value; configVersion = value.version; dirty = false;
    });
  });
  const report = action('记录所选答复', async () => {
    if (dirty || !canReport()) return;
    await write('/report', { version: reporting.version, ...(message.value ? { messageId: message.value } : {}), ...(outbox.value ? { outboxId: outbox.value } : {}) }, 'post', value => { reporting = value; configVersion = value.version; });
  });
  const attach = action('关联所选交付', async () => {
    if (!runs.value) return;
    await write('/review', { runId: runs.value, version: review?.version ?? 0 }, 'post', value => { review = value; });
  });
  async function decide(action) {
    if (!review || busy) return;
    // 确认前固定用户看到的证据；事件刷新不能替换本次决定的版本。
    const body = { version: review.version, runId: review.runId, evidenceVersion: review.evidenceVersion, action };
    if (action === 'rework') {
      body.defects = defects.value.trim();
      if (body.defects.length < 4) return;
      busy = true; sync();
      const ok = await confirmDialog({ title: '确认返工？', message: `将派发第 ${review.round + 1} 轮返工。完成标准：${review.doneWhen}。本轮缺陷：${body.defects}`, confirmLabel: '确认派发返工', danger: true });
      busy = false; sync();
      if (!ok || !alive) return;
    }
    await write('/review/decide', body, 'post', value => { review = value; });
  }
  const accept = action('验收通过并完成待办', () => decide('accept'), 'primary');
  const rework = action('要求返工', () => decide('rework'), 'danger');
  const ledger = h('a', { href: router.href('agent', 'advanced') }, '打开高级账本（后台事件与发件箱）');
  ledger.addEventListener('click', () => drawer.close());
  const drawer = openDrawer({ title, subtitle: todo.title, body: h('div', { class: 'stack' },
    notice, state,
    h('label', { class: 'check' }, required, '关闭前需答复'), h('label', { class: 'check' }, delivery, '需要渠道送达'), save,
    deliveryHint, ledger, Field({ label: '真实答复', control: message }), Field({ label: '渠道回执（可选）', control: outbox }), receiptState, report,
    h('h3', null, '验收交付'), Field({ label: '交付', control: runs }), attach, evidence,
    accept, Field({ label: '返工缺陷', control: defects }), rework),
    footer: Button({ label: '只读刷新', onClick: read }),
    onClose: () => { alive = false; ++sequence; if (active === drawer) active = undefined; },
  });
  drawer.api = api; drawer.refreshCandidates = candidates;
  active = drawer;
  for (const input of [required, delivery]) input.addEventListener('change', () => { dirty = required.checked !== reporting?.required || delivery.checked !== reporting?.requireDelivery; sync(); });
  for (const input of [message, outbox, runs, defects]) input.addEventListener('input', sync);
  sync(); void read();
  return drawer;
}

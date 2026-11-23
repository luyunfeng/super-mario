import { h, replace } from '../lib/dom.js';
import { Button, Banner, Field, Input, TextArea, Select, Check } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const wrap = { minWidth: '0', maxWidth: '100%', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' };
const text = (value) => h('p', { class: 'small', style: wrap }, value);
// 两个入口共享同一申请回执；不同 API 客户端独立保存。
const requestsByApi = new WeakMap();
function requestKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function openSessionResume({ api, store, router, machine, session, projectId, todoId }) {
  let requests = requestsByApi.get(api);
  if (!requests) { requests = new Map(); requestsByApi.set(api, requests); }
  const ready = () => store.view.connection === 'online' && !store.view.unauthorized;
  const auth = api.token();
  const owner = api.draftOwner?.();
  const authorized = () => ready() && api.token() === auth && api.draftOwner?.() === owner &&
    (!owner || owner === store.view.snapshotOwner);
  const id = JSON.stringify([auth, owner, machine.machineId, session.executorId, session.nativeSessionId, session.cwd]);
  let record = requests.get(id);
  if (authorized() && record?.status === 'pending' && record.approval?.id) {
    const snapshot = store.view.snapshot;
    const approval = snapshot?.approvals?.find(row => row.id === record.approval.id && row.kind === 'dispatch');
    if (approval) record.approval = approval;
    // Approval completion alone only confirms dispatch. Require the resulting run to have finished.
    const run = approval?.status === 'completed' && approval.result?.accepted === true && approval.result.runId
      ? snapshot.runs?.find(row => row.id === approval.result.runId) : undefined;
    const finished = run?.status === 'completed' && run.machineId === machine.machineId &&
      run.executorId === machine.machineId + '/' + session.executorId && run.cwd === session.cwd &&
      run.nativeResume?.nativeSessionId === session.nativeSessionId;
    if (approval?.status === 'rejected' || finished) {
      requests.delete(id);
      record = undefined;
    }
  }
  const project = Select({ options: [['', '不关联项目'], ...(store.view.snapshot?.projects ?? []).filter(p => !p.archivedAt).map(p => [p.id, p.name])], value: record ? record.payload.projectId ?? '' : projectId ?? '' });
  const mode = Select({ options: [['task', '单次任务'], ['interactive', '交互会话']], value: record?.payload.executionMode ?? 'task' });
  const todo = Select({ options: [] });
  function refreshTodos(selected) {
    const rows = (store.view.snapshot?.todos ?? []).filter(row => !row.completedAt && (row.projectId ?? '') === project.value);
    replace(todo, h('option', { value: '' }, '不关联待办'), rows.map(row => h('option', { value: row.id }, row.title)));
    if (selected && record && !rows.some(row => row.id === selected)) todo.append(h('option', { value: selected }, selected));
    todo.value = selected ?? '';
  }
  refreshTodos(record ? record.payload.todoId : todoId);
  project.addEventListener('change', () => refreshTodos(''));
  const prompt = TextArea({ rows: 4, required: true, value: record?.payload.prompt ?? '' });
  const doneWhen = TextArea({ rows: 3, required: true, value: record?.payload.doneWhen ?? '' });
  const minutes = Input({ type: 'number', min: 1, step: 'any', required: true, value: record?.payload.expectMinutes ?? '' });
  const message = h('div', { style: wrap });
  const mismatch = h('div');
  const taskFields = h('div', { class: 'stack' }, Field({ label: '完成标准', control: doneWhen, required: true }),
    Field({ label: '预计用时（分钟）', control: minutes, required: true }));
  let confirmed = false;
  const locked = () => Boolean(record);
  const compatible = () => {
    const chosen = store.view.snapshot?.projects?.find(p => p.id === project.value);
    const root = chosen?.workspace?.cwd.replace(/\/+$/, '');
    return !chosen?.workspace || (chosen.workspace.machineId === machine.machineId && (root === session.cwd || session.cwd.startsWith(root + '/')));
  };
  function sync() {
    const task = mode.value === 'task';
    taskFields.hidden = !task;
    submit.disabled = locked() || !confirmed || !compatible() || !prompt.value.trim() || (task && (!doneWhen.value.trim() || !minutes.validity.valid || !(Number(minutes.value) > 0)));
    replace(mismatch, !compatible() && Banner({ tone: 'warn', children: '项目 workspace 与此会话的电脑或目录不匹配。请换项目或不关联；不会更换会话电脑或目录。' }));
    for (const control of [project, todo, mode, prompt, doneWhen, minutes]) control.disabled = locked();
  }
  for (const control of [project, todo, mode, prompt, doneWhen, minutes]) {
    control.addEventListener('input', sync); control.addEventListener('change', sync);
  }
  const confirmation = Check({ label: '我已确认原终端已停止', onChange: value => { confirmed = value; sync(); } });
  function approvalEntry(approval) {
    replace(message, Banner({ tone: 'warn', children: `审批 ${approval.id} · ${approval.status}。${approval.status === 'pending' ? '申请只创建审批，尚未执行；需要在审批中确认。' : '审批已有处理结果，请查看关联执行；不能据此认定CLI工作完成。'}` }),
      Button({ label: '查看审批', onClick: () => {
        if (!authorized()) return;
        openDrawer({ title: '恢复申请审批', subtitle: `审批 ${approval.id} · ${approval.status}`,
          body: [text('请到“等你处理”核对并确认审批。创建申请不表示恢复成功。'), text(approval.title ?? ''), text(JSON.stringify(approval.params, null, 2))],
          footer: Button({ label: '去待处理审批', onClick: () => { document.querySelectorAll('dialog.drawer').forEach(el => el.close()); router.go(router.href('chat')); } }) });
      } }));
  }
  const check = Button({ label: '只读核对申请', onClick: async () => {
    if (!authorized() || !record || record.status !== 'unknown') return;
    try {
      const result = await api.get(`/agents/sessions/resume-request?${new URLSearchParams({ machineId: record.payload.machineId, key: record.payload.key })}`);
      if (!authorized()) return;
      if (result.approval) { record.status = 'pending'; record.approval = result.approval; approvalEntry(result.approval); }
      else unknownNote('尚未查到审批。原请求仍保留且已锁定，不会自动重发。');
    } catch (cause) { if (authorized()) unknownNote(`核对失败：${cause.message}。原请求仍已锁定。`); }
  } });
  function unknownNote(note = '申请结果未知。已锁定重复提交，请只读核对。') {
    replace(message, Banner({ tone: 'danger', children: note }), text(`请求 key：${record.payload.key}`), check);
  }
  const submit = Button({ label: '提交恢复审批', kind: 'primary', disabled: true, onClick: async () => {
    // A second entry point can open a form before the first has submitted it.
    if (authorized() && !record && requests.has(id)) {
      drawer.close();
      openSessionResume({ api, store, router, machine, session, projectId, todoId });
      return;
    }
    sync(); if (submit.disabled) return;
    if (!authorized()) { replace(message, Banner({ tone: 'danger', children: '连接或令牌已变化，请关闭后重新读取。' })); return; }
    const current = store.view.snapshot?.machines?.find(m => m.id === machine.machineId);
    if (!current?.online) { replace(message, Banner({ tone: 'warn', children: '电脑已离线或已移除，请重新读取。' })); return; }
    const payload = { machineId: machine.machineId, executorId: session.executorId, nativeSessionId: session.nativeSessionId, cwd: session.cwd,
      ...(project.value ? { projectId: project.value } : {}), ...(todo.value && { todoId: todo.value }), prompt: prompt.value.trim(),
      ...(mode.value === 'task' ? { doneWhen: doneWhen.value.trim(), expectMinutes: Number(minutes.value) } : { executionMode: 'interactive' }), key: requestKey() };
    record = { payload, status: 'sending' }; requests.set(id, record); sync();
    try {
      const approval = await api.post('/agents/sessions/resume', payload);
      if (!approval?.id || approval.kind !== 'dispatch') throw new Error('unknown：未收到有效审批');
      record.status = 'pending'; record.approval = approval;
      if (authorized()) { approvalEntry(approval); store.refresh(); }
    } catch (cause) {
      if (!cause.status || cause.status >= 500 || /unknown/i.test(cause.message)) { record.status = 'unknown'; if (authorized()) unknownNote(); }
      else { requests.delete(id); record = null; if (authorized()) replace(message, Banner({ tone: 'danger', children: `申请未创建：${cause.message}` })); }
    }
    sync();
  } });
  const drawer = openDrawer({ title: '申请恢复 CLI 会话', body: [
    Banner({ tone: 'warn', children: '审批通过后会新建 CLI 进程，续用历史会话。请确认原终端已停止。单次任务采集执行结果；交互会话可继续接收输入。' }),
    text(`电脑：${machine.machineName}\n执行者：${session.executorId}\n原生 ID：${session.nativeSessionId}\n目录：${session.cwd}`),
    Field({ label: '关联项目（可选）', control: project }), mismatch,
    Field({ label: '关联待办（可选）', control: todo }), Field({ label: '恢复方式', control: mode }),
    Field({ label: '恢复后要做什么', control: prompt, required: true }), taskFields, confirmation, message], footer: submit });
  if (record?.approval) approvalEntry(record.approval);
  else if (record?.status === 'unknown') unknownNote();
  else if (record?.status === 'sending') replace(message, text('同一会话的恢复申请正在提交，请稍后重新打开。'));
  sync();
  return drawer;
}

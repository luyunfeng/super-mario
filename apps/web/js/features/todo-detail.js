import { h, replace } from '../lib/dom.js';
import { formatDate, todoPriorityLabels, isRunActive, runStatus } from '../lib/format.js';
import { Button, Field, Input, Select, TextArea } from '../ui/kit.js';
import { openDrawer, toast } from '../ui/overlay.js';
import { openTaskClosure } from './task-closure.js';
import { openTodoHistory } from './todo-history.js';
import { openWaitingReply } from './waiting-reply.js';

const section = (title, ...content) => h('section', { class: 'stack' }, h('h3', null, title), content);
const todoPath = todo => '/todos/' + encodeURIComponent(todo.id);

function matchesScope(store, todo) {
  const current = store.view.snapshot?.todos?.find(item => item.id === todo.id);
  return !!current && (current.projectId ?? null) === (todo.projectId ?? null);
}

function decisionSection(api, todo, valid) {
  const path = todoPath(todo) + '/decisions';
  const list = h('div', { class: 'stack', 'aria-live': 'polite' }, '正在读取决策…');
  const input = TextArea({ rows: 2 });
  let decisions = [];
  const add = Button({ label: '添加决策', disabled: true, onClick: async () => {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    await change(path, { text });
    if (input.value.trim() === text) input.value = '';
  } });

  function paint() {
    replace(list, decisions.length ? decisions.map(item => h('div', { class: 'item' },
      h('div', { class: 'item__main' }, h('span', null, item.text),
        h('span', { class: 'item__meta' }, [item.source === 'answer' ? '来自答复' : '手工记录', item.sourceId ?? item.id, item.active ? '生效中' : '已撤回'].join(' · '))),
      item.active && Button({ label: '撤回', size: 'sm', onClick: () => change(path + '/' + encodeURIComponent(item.id) + '/withdraw', {}) })
    )) : '暂无决策');
  }
  async function load() {
    add.disabled = true;
    try {
      decisions = (await api.get(path)).decisions;
      paint();
      add.disabled = false;
    } catch (error) {
      replace(list, error.message, Button({ label: '重新读取决策', onClick: load }));
    }
  }
  async function change(url, body) {
    if (!valid()) return;
    const result = await api.post(url, { ...body, expectedProjectId: todo.projectId ?? null });
    if (!valid()) return;
    if (!result?.id || typeof result.active !== 'boolean') { await load(); return; }
    const index = decisions.findIndex(item => item.id === result.id);
    if (index < 0) decisions.push(result);
    else decisions[index] = result;
    paint();
  }
  void load();
  return section('决策', list, Field({ label: '新决策', control: input }), add);
}

function replyRecord(api, store, todo) {
  const body = h('p', { class: 'small', 'aria-live': 'polite' });
  let request = 0;
  async function load() {
    const sequence = ++request;
    body.textContent = '正在读取…';
    try {
      const row = await api.get(todoPath(todo) + '/waiting-reply?view=summary');
      if (sequence !== request || !matchesScope(store, todo)) return;
      if (!row) { body.textContent = '没有可核对的回复跟踪记录。'; return; }
      const status = { waiting: '尚未匹配直接回复', matched: '已匹配直接回复', superseded: '已被后续等待替代', invalidated: '跟踪已失效' };
      const cycle = row.currentCycle === true ? '当前等待' : row.currentCycle === false ? '历史等待' : '归属周期待核对';
      body.textContent = [cycle + ' · 第 ' + row.cycle + ' 轮', row.waitingOn, status[row.status],
        row.repliedAt && '回复时间 ' + new Date(row.repliedAt).toLocaleString('zh-CN')].filter(Boolean).join(' · ');
    } catch (error) {
      if (sequence === request) body.textContent = '读取回复跟踪记录失败：' + error.message;
    }
  }
  const record = h('details', { ontoggle: () => { if (record.open) load(); } },
    h('summary', null, '回复跟踪记录'), body, Button({ label: '刷新记录', size: 'sm', onClick: load }));
  return record;
}

export function openTodoDetail({ api, store, router, todo, openEdit }) {
  if (!matchesScope(store, todo)) { toast('待办归属已变更，请重新打开'); return; }
  const detail = createTodoDetail({ api, store, router, todo, openEdit, close: () => drawer.close() });
  const drawer = openDrawer({ title: '待办详情', body: detail.el, onClose: () => unsubscribe?.() });
  const unsubscribe = store.subscribe?.(() => matchesScope(store, todo) ? detail.update() : drawer.close());
}

export function createTodoDetail({ api, store, router, todo, openEdit, close }) {
  const summary = h('div', { class: 'stack' });
  const next = h('div', { class: 'stack' });
  const el = h('div', { class: 'stack' }, summary, replyRecord(api, store, todo),
    decisionSection(api, todo, () => el.isConnected && el.closest('dialog')?.open !== false && matchesScope(store, todo)), next);
  function paint() {
    const snapshot = store.view.snapshot;
    const current = snapshot?.todos.find(item => item.id === todo.id);
    if (!current || !matchesScope(store, todo)) return;
    const project = snapshot.projects?.find(item => item.id === current.projectId);
    const sources = (snapshot.inbox ?? []).filter(item => item.todoId === current.id && (item.projectId ?? null) === (current.projectId ?? null));
    const runs = (snapshot.runs ?? []).filter(item => item.todoId === current.id && item.projectId === current.projectId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const latest = runs[0];
    const context = { api, store, router, todo: current };
    const action = (label, fn) => Button({ label, size: 'sm', onClick: () => { close?.(); fn(); } });
    replace(summary, h('h2', null, current.title), current.notes && h('p', null, current.notes),
      sources.length > 0 && section('来源', sources.map(item => h('p', null, [item.source, item.title || item.id].filter(Boolean).join(' · ')))),
      section('负责人', current.responsiblePerson || '未登记'),
      section('优先级', todoPriorityLabels[current.priority ?? 'normal']),
      section('归属', project?.name ?? current.projectId ?? '不归类', current.completedAt && ' · 已完成'),
      section('等待', current.waitingOn || '未设置等待对象', current.reminderAt && h('p', null, '提醒 ' + formatDate(current.reminderAt, true)),
        current.dueAt && h('p', null, '截止 ' + formatDate(current.dueAt, true))));
    replace(next, section('执行', latest ? h('p', null, '最近执行 · ', runStatus[latest.status]?.text ?? latest.status, ' · ',
      snapshot.executors?.find(item => item.id === latest.executorId)?.name ?? latest.executorId) : '当前快照中没有关联执行',
      action('执行历史', () => openTodoHistory(context))),
      section('下一步', h('p', null, current.completedAt ? '待办已完成，可查看验收记录。' :
        current.waitingOn ? '等待' + current.waitingOn : runs.some(isRunActive) ? '查看执行进展。' :
        latest?.status === 'completed' ? '核对交付结果并验收。' : latest ? '查看执行历史，确认是否重新派单。' : '可补充决策或发起派单。'),
      h('div', { class: 'row row--wrap' }, action('编辑待办', () => openEdit(current)),
        current.waitingOn && current.reminderAt && !current.completedAt && action('跟踪回复', () => openWaitingReply(context)),
        action('答复与验收', () => openTaskClosure(context)),
        !current.completedAt && action('交给 Agent', () => openTodoDelegate(context)))));
  }
  paint();
  return { el, update: paint, projectId: todo.projectId };
}

function dispatchOptions(snapshot, todo) {
  const project = snapshot.projects?.find(item => item.id === todo.projectId);
  const workspace = project?.workspace;
  const machines = snapshot.machines ?? [];
  let common = '';
  if (todo.completedAt) common = '待办已完成';
  else if (project?.archivedAt) common = '项目已归档';
  else if (workspace && !machines.find(item => item.id === workspace.machineId)?.online) common = '项目绑定的电脑离线或尚未连接';

  const choices = (snapshot.executors ?? []).map(executor => {
    const machine = machines.find(item => item.id === executor.machineId);
    let reason = common;
    if (!reason && workspace && (executor.machineId !== workspace.machineId || executor.mode !== 'real')) reason = '项目要求使用绑定电脑上的真实执行器';
    if (!reason && machine?.online === false) reason = '执行机离线';
    if (!reason && !executor.available) reason = executor.reason || '执行器不可用';
    // Only the remote RPC adapter needs a cwd. The main Agent can supply one when dispatching.
    const remote = machine?.executors?.some(info => executor.id === machine.id + '/' + info.id);
    const needsCwd = remote && !workspace?.cwd?.trim() && !executor.defaultCwd?.trim();
    return { executor, reason, explicitReason: reason || (needsCwd ? '执行机缺少工作目录' : '') };
  });
  const reasons = new Set(choices.map(choice => choice.reason));
  const autoReasons = [];
  if (common) autoReasons.push(common);
  else if (!choices.length) autoReasons.push(workspace ? '项目绑定的电脑没有可用执行器' : '没有可用执行器');
  else if (!reasons.has('')) autoReasons.push(...reasons);
  if (snapshot.agent?.available === false) autoReasons.push(snapshot.agent.reason || '主 Agent 不可用');
  return { choices, autoReason: autoReasons.join('；') };
}

const pendingDelegations = new WeakMap();

export function openTodoDelegate({ api, store, todo }) {
  let pending = pendingDelegations.get(api);
  if (!pending) { pending = new Set(); pendingDelegations.set(api, pending); }
  if (pending.has(todo.id)) { toast('派单请求正在处理中'); return; }
  const select = Select({ options: [], onchange: paint });
  const criteria = TextArea({ rows: 2, required: true });
  const minutes = Input({ type: 'number', step: 'any', max: 10080, required: true });
  const fields = h('div', { class: 'stack' }, Field({ label: '完成标准', control: criteria, required: true }),
    Field({ label: '预计分钟', control: minutes, required: true }));
  const status = h('p', { class: 'small', 'aria-live': 'polite' });
  const submit = Button({ label: '确认派单', kind: 'primary', onClick: async () => {
    const { reason, executor } = paint();
    if (reason || !matchesScope(store, todo) || pending.has(todo.id)) return;
    const payload = executor ? { executorId: executor.id } : {};
    if (executor?.mode === 'real') {
      if (!criteria.value.trim()) { criteria.focus(); throw new Error('请填写完成标准'); }
      if (!minutes.reportValidity() || !(minutes.valueAsNumber > 0)) { minutes.focus(); throw new Error('预计分钟须大于 0 且不超过 10080'); }
      Object.assign(payload, { doneWhen: criteria.value.trim(), expectMinutes: minutes.valueAsNumber });
    }
    pending.add(todo.id);
    submit.disabled = true;
    try {
      await api.post(todoPath(todo) + '/delegate', { ...payload, expectedProjectId: todo.projectId ?? null });
      drawer.close();
      store.refresh();
    } finally {
      pending.delete(todo.id);
      if (drawer.el.open) paint();
    }
  } });
  const drawer = openDrawer({ title: '选择派单方式', subtitle: todo.title,
    body: [Field({ label: '执行器', control: select }), status, fields], footer: submit, onClose: () => unsubscribe?.() });
  const unsubscribe = store.subscribe?.(paint);
  function paint() {
    const snapshot = store.view.snapshot ?? {};
    if (!matchesScope(store, todo)) { drawer.close(); return { reason: '待办归属已变更' }; }
    const current = snapshot.todos.find(item => item.id === todo.id);
    const selected = select.value;
    const { choices, autoReason } = dispatchOptions(snapshot, current);
    const choice = choices.find(item => item.executor.id === selected);
    const executor = choice?.executor;
    const reason = pending.has(todo.id) ? '正在派单…' : selected ? choice?.explicitReason ?? '执行器已不可用' : autoReason;
    const option = (id, name, block) => h('option', { value: id, disabled: !!block }, block ? name + ' · ' + block : name);
    replace(select, option('', '主 Agent 自动分派', autoReason),
      choices.map(({ executor, explicitReason }) => option(executor.id, executor.name + (executor.mode === 'demo' ? '（演示）' : ''), explicitReason)),
      selected && !executor && option(selected, selected, '执行器已不可用'));
    select.value = selected;
    fields.hidden = executor?.mode !== 'real';
    status.textContent = reason || '';
    submit.disabled = !!reason;
    return { reason, executor };
  }
  paint();
}

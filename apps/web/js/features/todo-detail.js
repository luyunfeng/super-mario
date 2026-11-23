import { h, replace } from '../lib/dom.js';
import { formatDate, deliveryLabels, todoPriorityLabels, isRunActive, runStatus } from '../lib/format.js';
import { Button, Field, Input, Select, TextArea } from '../ui/kit.js';
import { openDrawer, toast } from '../ui/overlay.js';
import { createAttention } from './attention.js';
import { openTaskClosure } from './task-closure.js';
import { createTodoThread } from './todo-thread.js';
import { openTodoContinuation } from './todo-continuation.js';
import { openTodoHistory } from './todo-history.js';
import { openWaitingReply } from './waiting-reply.js';

const section = (title, ...content) => h('section', { class: 'stack' }, h('h3', null, title), content);
const todoPath = todo => '/todos/' + encodeURIComponent(todo.id);

function matchesScope(store, todo) {
  const current = store.view.snapshot?.todos?.find(item => item.id === todo.id);
  return !!current && (current.projectId ?? null) === (todo.projectId ?? null);
}

function groupTaskOutcome(api, store, todo) {
  const owner = api.draftOwner();
  const input = Input({});
  const status = h('p', { class: 'small', role: 'status' });
  const savedText = h('p', { class: 'small muted', hidden: true });
  let base = '', latest = '', busy = false, review = false;
  const valid = () => panel.isConnected && panel.closest('dialog')?.open !== false && !store.view.unauthorized &&
    owner === api.draftOwner() && matchesScope(store, todo) && store.view.snapshot.todos.some(t => t.id === todo.id && t.groupTask === true);
  const save = Button({ label: '保存群内回报结论', size: 'sm', onClick: async () => {
    if (!valid() || busy || review) return;
    const text = input.value.trim();
    if (Array.from(text).length > 600 || /[\r\n\u2028\u2029]/u.test(text)) {
      status.textContent = '请输入不超过 600 个字符的单行结论。'; return;
    }
    busy = true; sync();
    try {
      const result = await api.patch(todoPath(todo), { groupTaskOutcome: text, expectedGroupTaskOutcome: base });
      if (!valid()) return;
      base = latest = result.groupTaskOutcome ?? '';
      input.value = base;
      status.textContent = base ? '已保存群内回报结论。' : '已清空结论，完成时仅回报已完成。';
      await store.refresh();
    } catch (error) {
      if (!valid()) return;
      if (error.status === 409 || !error.status || error.status >= 500) {
        review = true;
        status.textContent = error.status === 409 ? '群内回报结论已在别处修改，输入内容已保留。' : '保存结果未知，输入内容已保留。';
        await store.refresh();
      } else status.textContent = error.message;
    } finally {
      busy = false;
      if (valid()) update(store.view.snapshot.todos.find(t => t.id === todo.id));
    }
  } });
  const acknowledge = Button({ label: '核对后保留草稿', size: 'sm', onClick: async () => {
    if (!valid() || !review || busy) return;
    const previouslyShown = latest;
    busy = true; sync();
    try {
      await store.refresh();
      if (!valid() || store.view.loadError) return;
      latest = store.view.snapshot.todos.find(t => t.id === todo.id).groupTaskOutcome ?? '';
      if (latest === previouslyShown) { base = latest; review = false; status.textContent = '已保留草稿，可编辑后保存。'; }
    } finally { busy = false; if (valid()) sync(); }
  } });
  const panel = h('div', { class: 'stack' }, Field({ label: '群内回报结论', control: input,
    hint: '完成待办前保存可向原群公开的一句结论。留空时仅回报已完成。' }), savedText, save, acknowledge, status);
  function sync() {
    input.disabled = busy;
    save.disabled = busy || review || input.value.trim() === base;
    acknowledge.hidden = !review; acknowledge.disabled = busy;
    savedText.hidden = !review;
    savedText.textContent = review ? '当前已保存结论：' + (latest || '（空）') : '';
  }
  function update(current) {
    panel.hidden = !current?.groupTask || owner !== api.draftOwner() || store.view.unauthorized;
    if (panel.hidden) { input.value = base = latest = ''; review = false; status.textContent = ''; }
    else {
      latest = current.groupTaskOutcome ?? '';
      if (!busy && !review && base !== latest) {
        if (input.value === base) input.value = base = latest;
        else { review = true; status.textContent = '群内回报结论已在别处修改，输入内容已保留。'; }
      }
    }
    sync();
  }
  input.addEventListener('input', sync);
  return { panel, update };
}

function decisionSection(api, store, todo) {
  const path = todoPath(todo) + '/decisions';
  const owner = api.draftOwner();
  const list = h('div', { class: 'stack', 'aria-live': 'polite' }, '正在读取决策…');
  const input = TextArea({ rows: 2 });
  let sequence = 0, lastChange = store.view.todoDecisionsChange, connection = store.view.connection;
  const sameOwner = () => owner === api.draftOwner() && owner === store.view.snapshotOwner && !store.view.unauthorized;
  const valid = () => panel.isConnected && panel.closest('dialog')?.open !== false && sameOwner() && matchesScope(store, todo);
  const add = Button({ label: '添加决策', disabled: true, onClick: async () => {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    await change(path, { text });
    if (valid() && input.value.trim() === text) input.value = '';
  } });
  const panel = section('决策', list, Field({ label: '新决策', control: input }), add);

  function paint(decisions) {
    const byId = new Map(decisions.map(item => [item.id, item]));
    const successor = new Map(decisions.filter(item => item.supersedesId).map(item => [item.supersedesId, item]));
    const describe = item => item.choice || item.text || item.id;
    function row(item) {
      const agent = item.source === 'agent';
      const run = agent && store.view.snapshot.runs?.find(r => r.id === item.sourceId && (!r.todoId || r.todoId === todo.id) && r.projectId === todo.projectId);
      const executor = run && (store.view.snapshot.executors?.find(e => e.id === run.executorId)?.name || run.executorId);
      const origin = agent ? ['执行会话', executor].filter(Boolean).join(' · ') :
        ({ answer: '来自答复', topic: '飞书话题', manual: '手工记录' })[item.source] || '其他来源';
      const next = successor.get(item.id), previous = byId.get(item.supersedesId);
      const state = item.active ? '生效中' : next ? '已被替代' : '已撤回';
      return h('div', { class: 'item', dataset: { decisionId: item.id } },
        h('div', { class: 'item__main' },
          agent && item.question && h('span', null, '问题 · ' + item.question),
          h('span', null, agent && item.choice ? '选择 · ' + item.choice : item.text),
          agent && item.reason && h('span', null, '依据 · ' + item.reason),
          item.supersedesId && h('span', { class: 'item__meta' }, '替代了 · ' + (previous ? describe(previous) : item.supersedesId)),
          next && h('span', { class: 'item__meta' }, '由后续决定替代 · ' + describe(next)),
          h('span', { class: 'item__meta' }, [origin, item.sourceId ?? item.id, item.createdAt && new Date(item.createdAt).toLocaleString('zh-CN'), state].filter(Boolean).join(' · '))),
        item.active && Button({ label: '撤回', size: 'sm', onClick: () => change(path + '/' + encodeURIComponent(item.id) + '/withdraw', {}) }));
    }
    replace(list, decisions.length ? decisions.map(row) : '暂无决策');
  }
  async function load() {
    const stamp = ++sequence;
    try {
      const { decisions } = await api.get(path);
      if (stamp !== sequence || !valid()) return;
      paint(decisions); add.disabled = false;
    } catch (error) {
      if (stamp !== sequence || !valid()) return;
      add.disabled = true;
      replace(list, error.message, Button({ label: '重新读取决策', onClick: load }));
    }
  }
  async function change(url, body) {
    if (!valid()) return;
    await api.post(url, { ...body, expectedProjectId: todo.projectId ?? null });
    if (valid()) await load();
  }
  function update() {
    if (!sameOwner() || !matchesScope(store, todo)) {
      ++sequence; panel.hidden = true; replace(list); input.value = ''; add.disabled = true; return;
    }
    const event = store.view.todoDecisionsChange;
    const refresh = panel.hidden || (event !== lastChange && event?.todoId === todo.id) ||
      (connection !== 'online' && store.view.connection === 'online');
    lastChange = event; connection = store.view.connection; panel.hidden = false;
    if (refresh) void load();
  }
  void load();
  return { panel, update };
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

function reminderRecord(api, store, todo) {
  let generation, sequence = 0;
  const body = h('div', { class: 'stack small', role: 'status' });
  const panel = h('details', { ontoggle: () => { if (panel.open) load(); } },
    h('summary', null, '飞书提醒投递记录'), body, Button({ label: '刷新投递记录', size: 'sm', onClick: load }));
  async function load() {
    const stamp = ++sequence, token = api.token();
    const current = () => stamp === sequence && token === api.token() && panel.isConnected && matchesScope(store, todo);
    body.textContent = '正在读取…';
    try {
      const result = await api.get(todoPath(todo) + '/reminder-deliveries');
      if (!current()) return;
      if (result.projectId !== todo.projectId || generation !== JSON.stringify([result.reminderAt, result.version])) {
        body.textContent = '提醒已变更，请刷新后核对。';
        return;
      }
      replace(body, result.records.length ? result.records.map(row =>
        h('p', null, (deliveryLabels[row.status] ?? '未知状态') + ' · ' + formatDate(row.updatedAt, true))) : '未查到本次提醒的投递记录。');
    } catch (error) { if (current()) body.textContent = '读取投递记录失败：' + error.message; }
  }
  return { panel, update(current) {
    const next = JSON.stringify([current.reminderAt, current.reminderVersion ?? 1]);
    if (generation === next) return;
    generation = next;
    sequence++;
    body.replaceChildren();
    panel.hidden = !current.reminderAt;
    if (panel.hidden) panel.open = false;
    else if (panel.open) load();
  } };
}

function conversationHistory({ api, store, router, todo, close }) {
  const owner = store.view.snapshotOwner;
  const rows = h('div', { class: 'stack' });
  const notice = h('p', { class: 'small', role: 'status' });
  let before, question, sequence = 0;
  const selection = h('p', { class: 'small', hidden: true });
  const back = Button({ label: '返回全部关联消息', size: 'sm', onClick: () => { question = undefined; load(); } });
  back.hidden = true;
  const more = Button({ label: '查看更早消息', size: 'sm', onClick: () => load(before) });
  const refresh = Button({ label: '重新读取对话', size: 'sm', onClick: () => load() });
  const panel = h('details', { ontoggle: () => { if (panel.open) load(); } },
    h('summary', null, '关联的项目对话'), selection, back, rows, notice, more, refresh);
  more.hidden = true;
  function available() {
    return todo.projectId && owner === store.view.snapshotOwner && owner === api.draftOwner() &&
      !store.view.unauthorized && matchesScope(store, todo) &&
      store.view.snapshot.plugins.some(p => p.id === 'conversation-search' && p.status === 'active');
  }
  async function load(cursor) {
    if (!available()) return;
    const stamp = ++sequence;
    selection.hidden = back.hidden = !question;
    selection.textContent = question ? '原提问：' + question.preview : '';
    if (!cursor) { replace(rows); before = undefined; more.hidden = true; }
    more.disabled = refresh.disabled = true;
    notice.textContent = '正在读取…';
    try {
      const result = await api.post('/project-message-search', { projectId: todo.projectId, todoId: todo.id, replyTo: question?.id, before: cursor, limit: 10 });
      if (stamp !== sequence || !panel.isConnected || !available()) return;
      for (const message of result.hits) {
        const href = router.href('projects', todo.projectId, 'workspace') + '?' + new URLSearchParams({ at: message.id, todo: todo.id });
        const state = { pending: '处理中', failed: '处理失败', unknown: '结果未知' }[message.status];
        rows.append(h('div', { class: 'row row--wrap' },
          h('a', { href, onclick: () => close?.() }, [message.role === 'user' ? '我' : '项目助手',
            formatDate(message.createdAt, true), state, message.preview].filter(Boolean).join(' · ')),
          message.role === 'user' && Button({ label: '查看对应回答', size: 'sm', onClick: () => { question = message; load(); } })));

      }
      before = result.nextBefore;
      more.hidden = !before;
      notice.textContent = rows.childElementCount ? '' : question ? '尚未查到这条提问的对应回答。' : '尚无关联的项目对话。';
    } catch (error) {
      if (stamp === sequence && available()) notice.textContent = '读取失败：' + error.message;
    } finally {
      if (stamp === sequence) more.disabled = refresh.disabled = false;
    }
  }
  function update() {
    panel.hidden = !available();
    if (panel.hidden && panel.open) { ++sequence; panel.open = false; replace(rows); }
  }
  return { panel, update };
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
  const attention = createAttention({ api, store, task: true });
  const reminder = reminderRecord(api, store, todo);
  const history = conversationHistory({ api, store, router, todo, close });
  const outcome = groupTaskOutcome(api, store, todo);
  const thread = createTodoThread({ api, store, todo, sameScope: () => matchesScope(store, todo) });
  const decisions = decisionSection(api, store, todo);
  const el = h('div', { class: 'stack' }, summary, outcome.panel, thread.panel, attention.el, history.panel, reminder.panel, replyRecord(api, store, todo),
    decisions.panel, next);
  function paint() {
    const snapshot = store.view.snapshot;
    const current = snapshot?.todos.find(item => item.id === todo.id);
    decisions.update();
    if (!current || !matchesScope(store, todo)) return;
    outcome.update(current);
    thread.update();
    reminder.update(current);
    history.update();
    attention.update((store.view.attention ?? []).filter(item => item.type === 'interaction' && item.todoId === current.id && item.projectId === current.projectId));
    const project = snapshot.projects?.find(item => item.id === current.projectId);
    const sources = (snapshot.inbox ?? []).filter(item => item.todoId === current.id && (item.projectId ?? null) === (current.projectId ?? null));
    const runs = (snapshot.runs ?? []).filter(item => item.todoId === current.id && item.projectId === current.projectId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const related = snapshot.todos.filter(item => item.projectId === current.projectId);
    const rootId = item => item.continuesTodoId ? item.continuationRootId : item.id;
    const root = rootId(current);
    const lineage = root ? related.filter(item => item.id !== current.id && rootId(item) === root) : [];
    const predecessor = lineage.find(item => item.id === current.continuesTodoId);
    const successors = lineage.filter(item => item.continuesTodoId === current.id);
    const parent = related.find(item => item.id === current.parentTodoId);
    const children = related.filter(item => item.parentTodoId === current.id);
    const completedChildren = children.filter(item => item.completedAt).length;
    const todoLink = item => h('a', { href: router.href('projects', current.projectId ?? 'all', 'todos', 'detail', item.id), onclick: () => close?.() }, item.title);
    const latest = runs[0];
    const context = { api, store, router, todo: current };
    const action = (label, fn) => Button({ label, size: 'sm', onClick: () => { close?.(); fn(); } });
    replace(summary, h('h2', null, current.title), current.notes && h('p', null, current.notes),
      sources.length > 0 && section('来源', sources.map(item => h('p', null, [item.source, item.title || item.id].filter(Boolean).join(' · ')))),
      current.afterTodoIds?.length > 0 && section('前置子项', current.afterTodoIds.map(id => {
        const item = related.find(candidate => candidate.id === id && candidate.parentTodoId === current.parentTodoId);
        return item ? h('div', null, todoLink(item), item.completedAt ? ' · 已完成' : ' · 待完成') : '无法核对此子项';
      })),
      current.continuesTodoId && section('前序待办', predecessor ? todoLink(predecessor) : h('p', null, '当前范围内找不到前序待办。')),
      successors.length > 0 && section('后续待办', successors.map(item => h('div', null, todoLink(item)))),
      current.continuationReason && section('交接说明', h('p', { style: { whiteSpace: 'pre-wrap' } }, current.continuationReason)),
      parent && section('上级待办', todoLink(parent)),
      children.length > 0 && section('子待办', h('p', null, '已完成 ' + completedChildren + ' / ' + children.length),
        completedChildren === children.length && !current.completedAt && h('p', null, '上级待办仍未完成'),
        children.map(item => h('div', null, todoLink(item), item.completedAt ? ' · 已完成' : ' · 未完成'))),
      section('负责方', current.responsibleSession ? '会话 ' + current.responsibleSession.machineId + ' / ' + current.responsibleSession.sessionId : current.responsiblePerson || '未登记'),
      section('优先级', todoPriorityLabels[current.priority ?? 'normal']),
      section('归属', project?.name ?? current.projectId ?? '不归类', current.completedAt && ' · 已完成'),
      section('等待', current.waitingOn || '未设置等待对象', current.reminderAt && h('p', null, '计划提醒 ' + formatDate(current.reminderAt, true) + (current.remindedAt ? ' · 本地触发于 ' + formatDate(current.remindedAt, true) : current.completedAt ? ' · 待办已完成' : ' · 尚无触发记录')),
        current.dueAt && h('p', null, '截止 ' + formatDate(current.dueAt, true))));
    replace(next, section('执行', latest ? h('p', null, '最近执行 · ', runStatus[latest.status]?.text ?? latest.status, ' · ',
      snapshot.executors?.find(item => item.id === latest.executorId)?.name ?? latest.executorId) : '当前快照中没有关联执行',
      action('执行历史', () => openTodoHistory(context))),
      section('下一步', h('p', null, current.completedAt ? '待办已完成，可查看验收记录。' :
        current.waitingOn ? '等待' + current.waitingOn : runs.some(isRunActive) ? '查看执行进展。' :
        latest?.status === 'completed' ? '核对交付结果并验收。' : latest ? '查看执行历史，确认是否重新派单。' : '可补充决策或发起派单。'),
      h('div', { class: 'row row--wrap' }, action('编辑待办', () => openEdit(current)),
        (!current.projectId || project && !project.archivedAt) && action('创建续办', () => openTodoContinuation(context)),
        project && !project.archivedAt && h('a', { class: 'btn btn--sm', onclick: () => close?.(),
          href: router.href('projects', project.id, 'workspace') + '?todo=' + encodeURIComponent(current.id) }, '就此待办提问'),
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

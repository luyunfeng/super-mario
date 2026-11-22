// 项目的“待办”：顶部始终有添加输入框；按服务端算好的分区展示。
// 待办是否完成由你确认；执行结束不会自动完成待办。
import { h, replace, readLocal, writeLocal } from '../lib/dom.js';
import { formatDate, todoPriorityLabels } from '../lib/format.js';
import { Button, Empty, Fold, Field, Input, TextArea, Select, Segmented } from '../ui/kit.js';
import { openDrawer, toast } from '../ui/overlay.js';

import { todoCalendar, localDate, dueInstant, calendarRoute } from './todo-calendar.js';
import { openTaskClosure, refreshTaskClosure } from './task-closure.js';
import { createTodoDetail, openTodoDetail, openTodoDelegate } from './todo-detail.js';
import { openTodoHistory } from './todo-history.js';
import { openWaitingReply, refreshWaitingReply } from './waiting-reply.js';

const ORDER = ['需要你', '逾期', '今天', '等待中', '之后', '某天'];
const DONE = ['刚完成', '已完成'];

const periods = [['all', '全部期限'], ['none', '无截止日期'], ['today', '今天（含逾期）'], ['week', '本周（含逾期）'], ['month', '本月（含逾期）']];
const orders = [['recent', '最近更新'], ['due', '截止时间最早'], ['priority', '优先级最高']];

function dateRanges(now) {
  const year = now.getFullYear(), month = now.getMonth(), day = now.getDate();
  const midnight = offset => new Date(year, month, day + offset).getTime();
  const monday = -((now.getDay() + 6) % 7);
  return { today: [midnight(0), midnight(1)], week: [midnight(monday), midnight(monday + 7)],
    month: [+new Date(year, month, 1), +new Date(year, month + 1, 1)] };
}

function matchesPeriod(todo, period, ranges, now) {
  if (period === 'all') return true;
  const due = Date.parse(todo.dueAt);
  if (period === 'none') return !Number.isFinite(due);
  const [start, end] = ranges[period];
  return (!todo.completedAt && due < now) || (start <= due && due < end);
}

function orderTodos(items, order) {
  const rank = { high: 0, normal: 1, low: 2 };
  const due = todo => todo.dueAt ? Date.parse(todo.dueAt) : Infinity;
  return items.sort((a, b) => {
    if (order === 'priority') {
      const difference = rank[a.priority ?? 'normal'] - rank[b.priority ?? 'normal'];
      if (difference) return difference;
    }
    if (order !== 'recent' && due(a) !== due(b)) return due(a) - due(b);
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export function createTodosTab({ api, store, router }) {
  let projectId = 'all';
  let data = null;
  let loadError = '';
  let seq = 0;
  let signature = '';

  const title = Input({ placeholder: '添加待办：输入标题，回车添加', 'aria-label': '添加待办', id: 'todo-title', maxLength: 500 });
  const due = Input({ type: 'date', 'aria-label': '截止日期', style: { maxWidth: '170px' } });
  const priority = Select({ options: Object.entries(todoPriorityLabels), value: 'normal', 'aria-label': '新待办优先级', style: { width: 'auto' } });
  let calendar = null;
  let showDone = false;
  let calendarEnabled = false;
  const time = Input({ type: 'time', hidden: true, 'aria-label': '截止时间', style: { maxWidth: '125px' } });
  const form = h('form', { class: 'row row--wrap todo-add', onsubmit: async (event) => {
    event.preventDefault();
    const text = title.value.trim();
    if (!text) return;
    try {
      if (calendar && time.value && !due.value) throw new Error('请填写截止日期');
      await api.post('/todos', { title: text, priority: priority.value, ...(projectId !== 'all' ? { projectId } : {}),
        ...(due.value ? { dueAt: dueInstant(due.value, time.value || '23:59') } : {}) });
      priority.value = 'normal'; title.value = ''; due.value = ''; time.value = '';
      store.refresh();
    } catch (error) { toast(`没有添加成功：${error.message}`, 'danger'); }
  } }, h('div', { class: 'grow', style: { minWidth: '200px' } }, title), priority, due, time, h('button', { class: 'btn btn--primary', type: 'submit' }, '添加'));
  const search = Input({ type: 'search', placeholder: '搜索标题、备注、负责人或等待对象', 'aria-label': '搜索待办标题、备注、负责人或等待对象', oninput: paint });
  function preference(label, options, key) {
    const saved = readLocal(key, options[0][0]);
    const value = options.some(([id]) => id === saved) ? saved : options[0][0];
    return Select({ options, value, 'aria-label': label, style: { width: 'auto' },
      onchange: event => { writeLocal(key, event.target.value); paint(); } });
  }
  const period = preference('按截止日期筛选', periods, 'sm.todos.period');
  const sort = preference('分组内排序', orders, 'sm.todos.order');
  const listControls = h('div', { class: 'row row--wrap' }, period, sort);
  const list = h('div', { class: 'stack' });
  function navigate(mode, date) {
    const base = router.href('projects', projectId, 'todos');
    router.go(mode === 'list' ? base : `${base}/${mode}/${localDate(date)}`);
  }
  const views = Segmented({ options: [['list', '列表'], ['calendar', '日历']], label: '待办视图', value: 'list',
    onChange: view => navigate(view === 'calendar' ? 'month' : 'list', new Date()) });
  const listPanel = h('div', { class: 'stack stack--lg' }, form,
    h('div', { class: 'row row--wrap' }, h('div', { class: 'grow' }, search), listControls, views.el), list);
  const detailPanel = h('div', { class: 'stack', hidden: true });
  const el = h('div', { id: 'panel-todos', role: 'tabpanel' }, listPanel, detailPanel);
  let detailId, detail;
  function paintDetail(snapshot) {
    if (!detailId) return;
    const todo = snapshot?.todos.find(item => item.id === detailId && inScope(item));
    if (todo && detail && todo.projectId === detail.projectId) { detail.update(); return; }
    detail = todo ? createTodoDetail({ api, store, router, todo, openEdit }) : undefined;
    replace(detailPanel, h('a', { href: router.href('projects', projectId, 'todos') }, '返回待办列表'),
      detail?.el ?? (snapshot ? Empty({ title: '找不到这条待办', text: '请核对待办是否仍属于当前项目。' }) : '正在读取待办…'));
  }
  const inScope = (todo) => projectId === 'all' || todo.projectId === projectId;
  const projectName = (id) => (store.view.snapshot?.projects ?? []).find(item => item.id === id)?.name;

  function openEdit(todo) {
    const name = Input({ value: todo.title, required: true });
    const notes = TextArea({ value: todo.notes ?? '', rows: 4 });
    const editPriority = Select({ options: Object.entries(todoPriorityLabels), value: todo.priority ?? 'normal' });
    const originalDue = localDate(todo.dueAt);
    const originalReminder = localDate(todo.reminderAt, true);
    const dueInput = Input({ type: 'date', value: originalDue });
    const originalClock = localDate(todo.dueAt, true).slice(11);
    const clock = calendar ? Input({ type: 'time', value: originalClock }) : null;
    const reminder = Input({ type: 'datetime-local', value: originalReminder });
    const responsible = Input({ value: todo.responsiblePerson ?? '' });
    const waiting = Input({ value: todo.waitingOn ?? '', placeholder: '例如：张三回复' });
    const projects = (store.view.snapshot?.projects ?? []).filter(item => !item.archivedAt);
    const project = Select({ options: [['', '不归类'], ...projects.map(item => [item.id, item.name])], value: todo.projectId ?? '' });
    const drawer = openDrawer({
      title: '编辑待办',
      body: [Field({ label: '标题', control: name, required: true }), Field({ label: '备注', control: notes }),
        h('div', { class: 'form-row' }, Field({ label: '截止日期', control: dueInput, hint: '留空取消截止日期。' }), clock && Field({ label: '截止时间', control: clock }), Field({ label: '在等谁', control: waiting, hint: '填写后会进入“等待中”。' })),
        Field({ label: '提醒时间', control: reminder, hint: '按本机时区填写；留空取消。到点检查需在 Agent 中开启提醒，外发仍需渠道与发送授权。' }),
        Field({ label: '优先级', control: editPriority }), Field({ label: '负责人', control: responsible }), Field({ label: '所属项目', control: project })],
      footer: [Button({ label: '取消', onClick: () => drawer.close() }), Button({
        label: '保存', kind: 'primary', onClick: async () => {
          if (!name.value.trim()) throw new Error('请填写标题');
          if (!dueInput.reportValidity() || (clock && !clock.reportValidity()) || !reminder.reportValidity()) return;
          // Omit unchanged values: re-sending reminderAt clears its claim in the API.
          // It also preserves seconds/precision that these minute/date controls cannot show.
          const patch = {};
          if (dueInput.value !== originalDue || (clock && clock.value !== originalClock)) {
            if (!dueInput.value && clock?.value && !originalDue) throw new Error('请填写截止日期');
            patch.expectedDueAt = todo.dueAt ?? '';
            patch.dueAt = dueInput.value ? dueInstant(dueInput.value, clock?.value || '23:59') : '';
          }
          if (reminder.value !== originalReminder) {
            const at = reminder.value ? new Date(reminder.value) : undefined;
            if (at && (!Number.isFinite(at.getTime()) || localDate(at.toISOString(), true) !== reminder.value)) throw new Error('提醒时间无效，请检查本机时区和夏令时');
            patch.reminderAt = at ? at.toISOString() : '';
          }
          if (editPriority.value !== (todo.priority ?? 'normal')) patch.priority = editPriority.value;
          if (name.value.trim() !== todo.title) patch.title = name.value.trim();
          if (notes.value !== (todo.notes ?? '')) patch.notes = notes.value;
          if (project.value !== (todo.projectId ?? '')) patch.projectId = project.value;
          if (responsible.value.trim() !== (todo.responsiblePerson ?? '')) patch.responsiblePerson = responsible.value.trim();
          if (waiting.value.trim() !== (todo.waitingOn ?? '')) patch.waitingOn = waiting.value.trim();
          try {
            if (Object.keys(patch).length) await api.patch(`/todos/${encodeURIComponent(todo.id)}`, patch);
          } catch (error) {
            if (error.status === 409) await store.refresh();
            throw error;
          }
          drawer.close(); store.refresh();
        },
      })],
    });
  }

  function row(todo, done) {
    const overdue = !done && todo.dueAt && new Date(todo.dueAt).getTime() < Date.now();
    const toggle = h('button', { class: `todo__check ${done ? 'is-done' : ''}`, type: 'button', role: 'checkbox', 'aria-checked': String(done), 'aria-label': `${done ? '重新打开' : '完成'}：${todo.title}`,
      onclick: async () => { await api.patch(`/todos/${encodeURIComponent(todo.id)}`, { completed: !done }).catch(error => toast(error.message, 'danger')); store.refresh(); } });
    const meta = [
      todo.priority && todo.priority !== 'normal' && todoPriorityLabels[todo.priority],
      todo.dueAt && h('span', { class: overdue ? 'text-danger' : '' }, `${overdue ? '已逾期 · ' : '截止 '}${formatDate(todo.dueAt)}`),
      todo.responsiblePerson && `负责人 ${todo.responsiblePerson}`,
      todo.waitingOn && `等 ${todo.waitingOn}`,
      todo.reminderAt && `提醒 ${formatDate(todo.reminderAt, true)}${todo.remindedAt ? '（已记录）' : ''}`,
      projectId === 'all' && todo.projectId && projectName(todo.projectId),
      todo.notes && h('span', { class: 'truncate' }, todo.notes),
    ].filter(Boolean);
    return h('div', { class: 'item todo', dataset: { id: todo.id } }, toggle,
      h('div', { class: 'item__main item--click', onclick: () => openEdit(todo), tabindex: 0, role: 'button', onkeydown: (event) => { if (event.key === 'Enter') openEdit(todo); } },
        h('span', { class: `item__title ${done ? 'is-done' : ''}` }, todo.title),
        meta.length > 0 && h('span', { class: 'item__meta' }, meta.flatMap((part, index) => index ? [' · ', part] : [part]))),
      Button({ label: '详情', size: 'sm', onClick: () => openTodoDetail({ api, store, router, todo, openEdit }) }),
      !todo.completedAt && todo.waitingOn && todo.reminderAt && Button({ label: '跟踪回复', size: 'sm', onClick: () => openWaitingReply({ api, store, todo }) }),
      Button({ label: '答复与验收', size: 'sm', onClick: () => openTaskClosure({ api, store, router, todo }) }),
      Button({ label: '执行历史', size: 'sm', onClick: () => openTodoHistory({ api, store, router, todo }) }),
      !done && Button({ label: '交给 Agent', size: 'sm', onClick: () => openTodoDelegate({ api, store, todo }) }));
  }

  function paint() {
    if (loadError) { replace(list, h('p', { class: 'text-danger' }, loadError)); return; }
    if (!data) { replace(list, h('p', { class: 'muted' }, '正在读取…')); return; }
    const sections = data.sections ?? data;
    const query = search.value.trim().toLowerCase();
    const matches = todo => inScope(todo) && (!query || [todo.title, todo.notes, todo.responsiblePerson, todo.waitingOn].some(value => value?.toLowerCase().includes(query)));
    const now = new Date();
    const ranges = dateRanges(now);
    const selected = todo => calendar || matchesPeriod(todo, period.value, ranges, now);
    const rows = name => {
      const items = (sections[name] ?? []).filter(todo => matches(todo) && selected(todo));
      return calendar ? items : orderTodos(items, sort.value);
    };
    if (!calendar) {
      const candidates = Object.values(sections).flat().filter(matches);
      for (const [index, [key, label]] of periods.entries()) {
        period.options[index].textContent = label + ' · ' + candidates.filter(todo => matchesPeriod(todo, key, ranges, now)).length;
      }
    }
    const groups = ORDER.map(name => [name, rows(name)]).filter(([, items]) => items.length);
    const finished = DONE.flatMap(rows);
    if (calendar) {
      replace(list, todoCalendar({ ...calendar, todos: [...groups.flatMap(([, items]) => items), ...finished], showDone, navigate,
        onShowDone: value => { showDone = value; paint(); }, open: openEdit, showList: () => navigate('list'),
        add: (day, clock) => { due.value = day; time.value = clock; title.focus(); },
        move: async (todo, day, clock, originalDueAt) => {
          try {
            const original = new Date(originalDueAt);
            if (!clock && localDate(original) === day) return;
            const target = new Date(dueInstant(day, clock || localDate(original, true).slice(11)));
            if (!clock) target.setSeconds(original.getSeconds(), original.getMilliseconds());
            if (+target === +original) return;
            await api.patch(`/todos/${encodeURIComponent(todo.id)}`, { dueAt: target.toISOString(), expectedDueAt: originalDueAt });
            await store.refresh();
          } catch (error) {
            toast(`没有改期成功：${error.message}`, 'danger');
            if (error.status === 409) await store.refresh();
          }
        } }));
      return;
    }
    const blocks = groups.map(([name, items]) => h('div', { class: 'group', dataset: { section: name } },
      h('h3', { class: 'group__title' }, name, h('span', { class: 'tab__count' }, items.length)),
      h('div', { class: 'list' }, items.map(todo => row(todo, false)))));
    if (finished.length) blocks.push(Fold({ title: `已完成 ${finished.length}`, open: Boolean(query), body: h('div', { class: 'list' }, finished.map(todo => row(todo, true))) }));
    const hidden = (sections['需要你'] ?? []).filter(todo => matches(todo) && !selected(todo)).length;
    if (hidden) blocks.unshift(Button({ label: '另有 ' + hidden + ' 项需要你处理，查看全部期限', size: 'sm', onClick: () => {
      period.value = 'all'; writeLocal('sm.todos.period', 'all'); paint();
    } }));
    replace(list, blocks.length ? blocks : Empty(query || period.value !== 'all' ? { title: '没有匹配的待办', text: '试试其他关键词或截止日期范围。' } : { title: '还没有待办', text: '在上面写下第一件要做的事，回车即可添加。' }));
  }

  async function load() {
    const stamp = ++seq;
    try { const value = await api.get('/todos?view=sections'); if (stamp !== seq) return; data = value; loadError = ''; }
    catch (error) { if (stamp !== seq) return; loadError = `读取待办失败：${error.message}`; }
    paint();
  }

  const todoSignature = snapshot => JSON.stringify((snapshot?.todos ?? []).map(todo => [todo.id, todo.updatedAt]));

  const calendarActive = snapshot => snapshot?.plugins?.some(plugin =>
    plugin.id === 'todo-calendar' && plugin.enabled && plugin.status === 'active') === true;
  function syncCalendar(snapshot) {
    calendarEnabled = snapshot ? calendarActive(snapshot) : undefined;
    const route = router.current;
    const requested = route.page === 'projects' && route.parts[1] === 'todos' && calendarRoute(route.parts);
    calendar = calendarEnabled ? requested : null;
    if (!calendar) time.value = '';
    listControls.hidden = Boolean(calendar);
    time.hidden = !calendar;
    views.el.hidden = !calendarEnabled;
    views.set(calendar ? 'calendar' : 'list');
    if (snapshot && !calendarEnabled && requested) navigate('list');
  }

  return {
    el,
    show(id, selectedTodo) {
      detail = undefined; detailId = selectedTodo;
      detailPanel.replaceChildren();
      listPanel.hidden = Boolean(detailId);
      detailPanel.hidden = !detailId;
      if (id !== projectId) { search.value = ''; priority.value = 'normal'; title.value = ''; due.value = ''; time.value = ''; }
      projectId = id; syncCalendar(store.view.snapshot); signature = todoSignature(store.view.snapshot);
      if (detailId) paintDetail(store.view.snapshot);
      else { paint(); load(); }
    },
    /** 快照里的待办变了才重新读取分区。 */
    update(snapshot) {
      paintDetail(snapshot);
      if (calendarActive(snapshot) !== calendarEnabled) { syncCalendar(snapshot); paint(); }
      refreshTaskClosure(api);
      refreshWaitingReply(api);
      const next = todoSignature(snapshot);
      if (next !== signature) { signature = next; if (!detailId) load(); }
    },
    count: (snapshot, id) => (snapshot.todos ?? []).filter(todo => !todo.completedAt && (id === 'all' || todo.projectId === id)).length,
    focus() { title.focus(); },
  };
}

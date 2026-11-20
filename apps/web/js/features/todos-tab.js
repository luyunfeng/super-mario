// 项目的“待办”：顶部始终有添加输入框；按服务端算好的分区展示。
// 待办是否完成由你确认；执行结束不会自动完成待办。
import { h, replace } from '../lib/dom.js';
import { formatDate } from '../lib/format.js';
import { Button, Empty, Fold, Field, Input, TextArea, Select, Pill } from '../ui/kit.js';
import { openDrawer, toast } from '../ui/overlay.js';

import { openTaskClosure, refreshTaskClosure } from './task-closure.js';
import { openTodoHistory } from './todo-history.js';
import { openWaitingReply, refreshWaitingReply } from './waiting-reply.js';

const ORDER = ['需要你', '逾期', '今天', '等待中', '之后', '某天'];
const DONE = ['刚完成', '已完成'];

// HTML date controls use wall time in the browser's zone, not the UTC date prefix.
function localTime(value, withTime = false) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

export function createTodosTab({ api, store, router }) {
  let projectId = 'all';
  let data = null;
  let loadError = '';
  let seq = 0;
  let signature = '';

  const title = Input({ placeholder: '添加待办：输入标题，回车添加', 'aria-label': '添加待办', id: 'todo-title', maxLength: 500 });
  const due = Input({ type: 'date', 'aria-label': '截止日期', style: { maxWidth: '170px' } });
  const form = h('form', { class: 'row row--wrap todo-add', onsubmit: async (event) => {
    event.preventDefault();
    const text = title.value.trim();
    if (!text) return;
    await api.post('/todos', { title: text, ...(projectId !== 'all' ? { projectId } : {}), ...(due.value ? { dueAt: new Date(`${due.value}T23:59:00`).toISOString() } : {}) })
      .then(() => { title.value = ''; due.value = ''; }, (error) => { toast(`没有添加成功：${error.message}`, 'danger'); });
    store.refresh();
  } }, h('div', { class: 'grow', style: { minWidth: '200px' } }, title), due, h('button', { class: 'btn btn--primary', type: 'submit' }, '添加'));
  const search = Input({ type: 'search', placeholder: '搜索标题或备注', 'aria-label': '搜索待办标题或备注', oninput: paint });
  const list = h('div', { class: 'stack' });
  const el = h('div', { class: 'stack stack--lg', id: 'panel-todos', role: 'tabpanel' }, form, search, list);

  const inScope = (todo) => projectId === 'all' || todo.projectId === projectId;
  const projectName = (id) => (store.view.snapshot?.projects ?? []).find(item => item.id === id)?.name;

  function openEdit(todo) {
    const name = Input({ value: todo.title, required: true });
    const notes = TextArea({ value: todo.notes ?? '', rows: 4 });
    const originalDue = localTime(todo.dueAt);
    const originalReminder = localTime(todo.reminderAt, true);
    const dueInput = Input({ type: 'date', value: originalDue });
    const reminder = Input({ type: 'datetime-local', value: originalReminder });
    const waiting = Input({ value: todo.waitingOn ?? '', placeholder: '例如：张三回复' });
    const projects = (store.view.snapshot?.projects ?? []).filter(item => !item.archivedAt);
    const project = Select({ options: [['', '不归类'], ...projects.map(item => [item.id, item.name])], value: todo.projectId ?? '' });
    const drawer = openDrawer({
      title: '编辑待办',
      body: [Field({ label: '标题', control: name, required: true }), Field({ label: '备注', control: notes }),
        h('div', { class: 'form-row' }, Field({ label: '截止日期', control: dueInput, hint: '留空取消截止日期。' }), Field({ label: '在等谁', control: waiting, hint: '填写后会进入“等待中”。' })),
        Field({ label: '提醒时间', control: reminder, hint: '按本机时区填写；留空取消。到点检查需在 Agent 中开启提醒，外发仍需渠道与发送授权。' }),
        Field({ label: '所属项目', control: project })],
      footer: [Button({ label: '取消', onClick: () => drawer.close() }), Button({
        label: '保存', kind: 'primary', onClick: async () => {
          if (!name.value.trim()) throw new Error('请填写标题');
          if (!dueInput.reportValidity() || !reminder.reportValidity()) return;
          // Omit unchanged values: re-sending reminderAt clears its claim in the API.
          // It also preserves seconds/precision that these minute/date controls cannot show.
          const dates = {};
          if (dueInput.value !== originalDue) dates.dueAt = dueInput.value ? new Date(`${dueInput.value}T23:59:00`).toISOString() : '';
          if (reminder.value !== originalReminder) {
            const at = reminder.value ? new Date(reminder.value) : undefined;
            if (at && (!Number.isFinite(at.getTime()) || localTime(at.toISOString(), true) !== reminder.value)) throw new Error('提醒时间无效，请检查本机时区和夏令时');
            dates.reminderAt = at ? at.toISOString() : '';
          }
          await api.patch(`/todos/${encodeURIComponent(todo.id)}`, {
            title: name.value.trim(), notes: notes.value, projectId: project.value, waitingOn: waiting.value.trim(),
            ...dates,
          });
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
      todo.dueAt && h('span', { class: overdue ? 'text-danger' : '' }, `${overdue ? '已逾期 · ' : '截止 '}${formatDate(todo.dueAt)}`),
      todo.waitingOn && `等 ${todo.waitingOn}`,
      todo.reminderAt && `提醒 ${formatDate(todo.reminderAt, true)}${todo.remindedAt ? '（已记录）' : ''}`,
      projectId === 'all' && todo.projectId && projectName(todo.projectId),
      todo.notes && h('span', { class: 'truncate' }, todo.notes),
    ].filter(Boolean);
    return h('div', { class: 'item todo', dataset: { id: todo.id } }, toggle,
      h('div', { class: 'item__main item--click', onclick: () => openEdit(todo), tabindex: 0, role: 'button', onkeydown: (event) => { if (event.key === 'Enter') openEdit(todo); } },
        h('span', { class: `item__title ${done ? 'is-done' : ''}` }, todo.title),
        meta.length > 0 && h('span', { class: 'item__meta' }, meta.flatMap((part, index) => index ? [' · ', part] : [part]))),
      !todo.completedAt && todo.waitingOn && todo.reminderAt && Button({ label: '跟踪回复', size: 'sm', onClick: () => openWaitingReply({ api, store, todo }) }),
      Button({ label: '答复与验收', size: 'sm', onClick: () => openTaskClosure({ api, store, router, todo }) }),
      Button({ label: '执行历史', size: 'sm', onClick: () => openTodoHistory({ api, store, router, todo }) }),
      !done && Button({ label: '交给 Agent', size: 'sm', onClick: async () => { await api.post(`/todos/${encodeURIComponent(todo.id)}/delegate`, {}); toast('已交给 Agent，进展可以在“执行”里看到', 'ok'); store.refresh(); } }));
  }

  function paint() {
    if (loadError) { replace(list, h('p', { class: 'text-danger' }, loadError)); return; }
    if (!data) { replace(list, h('p', { class: 'muted' }, '正在读取…')); return; }
    const sections = data.sections ?? data;
    const query = search.value.trim().toLowerCase();
    const matches = todo => inScope(todo) && (!query || [todo.title, todo.notes].some(value => value?.toLowerCase().includes(query)));
    const groups = ORDER.map(name => [name, (sections[name] ?? []).filter(matches)]).filter(([, items]) => items.length);
    const finished = DONE.flatMap(name => (sections[name] ?? []).filter(matches));
    const blocks = groups.map(([name, items]) => h('div', { class: 'group', dataset: { section: name } },
      h('h3', { class: 'group__title' }, name, h('span', { class: 'tab__count' }, items.length)),
      h('div', { class: 'list' }, items.map(todo => row(todo, false)))));
    if (finished.length) blocks.push(Fold({ title: `已完成 ${finished.length}`, open: Boolean(query), body: h('div', { class: 'list' }, finished.map(todo => row(todo, true))) }));
    replace(list, blocks.length ? blocks : Empty(query ? { title: '没有匹配的待办', text: '试试其他关键词，或清空搜索查看全部待办。' } : { title: '还没有待办', text: '在上面写下第一件要做的事，回车即可添加。' }));
  }

  async function load() {
    const stamp = ++seq;
    try { const value = await api.get('/todos?view=sections'); if (stamp !== seq) return; data = value; loadError = ''; }
    catch (error) { if (stamp !== seq) return; loadError = `读取待办失败：${error.message}`; }
    paint();
  }

  return {
    el,
    show(id) {
      if (id !== projectId) search.value = '';
      projectId = id; signature = ''; paint(); load();
    },
    /** 快照里的待办变了才重新读取分区。 */
    update(snapshot) {
      refreshTaskClosure(api);
      refreshWaitingReply(api);
      const next = JSON.stringify((snapshot.todos ?? []).map(todo => [todo.id, todo.updatedAt]));
      if (next !== signature) { signature = next; load(); }
    },
    count: (snapshot, id) => (snapshot.todos ?? []).filter(todo => !todo.completedAt && (id === 'all' || todo.projectId === id)).length,
    focus() { title.focus(); },
  };
}

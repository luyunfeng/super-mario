// Calendar dates are local civil dates. Walk them with setDate so DST transitions
// do not shift the calendar by an hour. Only send ISO instants to the API.
import { h } from '../lib/dom.js';
import { Button, Check, Segmented } from '../ui/kit.js';

const dragType = 'application/x-super-mario-todo';
const pad = number => String(number).padStart(2, '0');
const modeLabels = [['day', '日'], ['week', '周'], ['month', '月']];
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export function localDate(value, withTime = false) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

export function dueInstant(day, time = '23:59') {
  const value = `${day}T${time}`;
  const date = new Date(value);
  if (localDate(date, true) !== value) throw new Error('截止时间无效，请检查本机时区和夏令时');
  return date.toISOString();
}

export function calendarRoute(parts) {
  const mode = parts[2];
  if (!modeLabels.some(([key]) => key === mode)) return null;
  const candidate = new Date(`${parts[3]}T12:00`);
  return { mode, anchor: localDate(candidate) === parts[3] ? candidate : new Date() };
}

function shift(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function daysFor(anchor, mode) {
  if (mode === 'day') return [anchor];
  const start = new Date(anchor);
  if (mode === 'month') start.setDate(1);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const days = [];
  do {
    for (let i = 0; i < 7; i++) days.push(shift(start, days.length));
  } while (mode === 'month' && shift(start, days.length).getMonth() === anchor.getMonth());
  return days;
}

export function todoCalendar({ mode, anchor, todos, showDone, onShowDone, navigate, open, add, move, showList }) {
  const days = daysFor(anchor, mode);
  const today = localDate(new Date());
  const dated = new Map();
  let undated = 0;
  for (const todo of todos) {
    if (!showDone && todo.completedAt) continue;
    const day = localDate(todo.dueAt);
    if (!day) { undated++; continue; }
    if (!dated.has(day)) dated.set(day, []);
    dated.get(day).push(todo);
  }
  for (const entries of dated.values()) entries.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));

  function step(direction) {
    if (mode !== 'month') return navigate(mode, shift(anchor, direction * (mode === 'week' ? 7 : 1)));
    const date = new Date(anchor);
    date.setDate(1);
    date.setMonth(date.getMonth() + direction);
    navigate(mode, date);
  }
  const caption = mode === 'month' ? `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`
    : mode === 'week' ? `${localDate(days[0])} 至 ${localDate(days[6])}` : localDate(anchor);
  const controls = h('div', { class: 'row row--wrap' },
    Button({ label: '上一页', size: 'sm', onClick: () => step(-1) }),
    Button({ label: '今天', size: 'sm', onClick: () => navigate(mode, new Date()) }),
    Button({ label: '下一页', size: 'sm', onClick: () => step(1) }),
    h('strong', { class: 'grow' }, caption),
    Segmented({ label: '日历范围', value: mode, options: modeLabels, onChange: value => navigate(value, anchor) }).el,
    Check({ label: '显示已完成', checked: showDone, onChange: onShowDone }));

  function entry(todo) {
    const time = localDate(todo.dueAt, true).slice(11);
    const overdue = !todo.completedAt && Date.parse(todo.dueAt) < Date.now();
    const status = todo.completedAt ? '已完成' : overdue ? '已逾期' : todo.waitingOn ? '等待中' : '待完成';
    const label = [time, todo.title, status, todo.reminderAt && '有提醒'].filter(Boolean).join(' · ');
    return h('button', { class: 'cal-entry', type: 'button', title: label, 'aria-label': label,
      dataset: { status }, draggable: true, onclick: () => open(todo),
      ondragstart: event => { event.dataTransfer.setData(dragType, todo.id); event.dataTransfer.effectAllowed = 'move'; } },
      h('span', null, time), ' ', todo.title, todo.reminderAt && ' ⏰');
  }
  function cell(day, hour, ...children) {
    const key = localDate(day);
    const time = hour === undefined ? undefined : hour === 'end' ? '23:59' : `${pad(hour)}:00`;
    return h('div', { class: 'cal-cell', dataset: { day: key, hour, today: key === today, outside: mode === 'month' && day.getMonth() !== anchor.getMonth() },
      onclick: event => { if (mode === 'month' && event.target === event.currentTarget) navigate('day', day); },
      ondragover: event => { if (event.dataTransfer.types.includes(dragType)) event.preventDefault(); },
      ondrop: event => {
        const id = event.dataTransfer.getData(dragType);
        const todo = todos.find(item => item.id === id);
        if (!todo) return;
        event.preventDefault();
        move(todo, key, time);
      } }, children);
  }
  function dayButton(day, label) {
    return h('button', { type: 'button', class: 'cal-day', 'aria-label': `查看 ${localDate(day)}`, onclick: () => navigate('day', day) }, label);
  }
  let content;
  if (mode === 'month') {
    content = h('div', { class: 'cal-grid cal-month' }, weekdays.map(name => h('strong', { class: 'cal-head' }, name)),
      days.map(day => {
        const entries = dated.get(localDate(day)) ?? [];
        return cell(day, undefined, dayButton(day, day.getDate()), entries.slice(0, 3).map(entry),
          entries.length > 3 && dayButton(day, `还有 ${entries.length - 3} 项`));
      }));
  } else {
    const headers = days.map(day => dayButton(day, `${weekdays[(day.getDay() + 6) % 7]} ${day.getMonth() + 1}/${day.getDate()}`));
    const hours = ['end', ...Array.from({ length: 24 }, (_, i) => i)];
    content = h('div', { class: 'cal-grid cal-axis', style: { gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(5rem, 1fr))` } },
      h('span', { class: 'cal-head' }, '时间'), headers,
      hours.map(hour => [h('span', { class: 'cal-hour' }, hour === 'end' ? '日末' : `${pad(hour)}:00`), ...days.map(day => {
        const key = localDate(day);
        const time = hour === 'end' ? '23:59' : `${pad(hour)}:00`;
        const entries = (dated.get(key) ?? []).filter(todo => {
          const clock = localDate(todo.dueAt, true).slice(11);
          return clock === '23:59' ? hour === 'end' : Number(clock.slice(0, 2)) === hour;
        });
        const slot = h('button', { type: 'button', class: 'cal-slot', 'aria-label': `添加待办 ${key} ${time}`, onclick: () => add(key, time) }, '+');
        return cell(day, hour, slot, entries.map(entry));
      })]));
  }
  return h('section', { class: 'stack todo-calendar', 'aria-label': '待办日历', onkeydown: event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.target.matches('input, textarea, select')) return;
    if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'ArrowRight') step(1);
    else if (event.key.toLowerCase() === 't') navigate(mode, new Date());
    else return;
    event.preventDefault();
  } }, controls,
    h('div', { class: 'cal-scroll' }, content),
    undated > 0 && Button({ label: `${undated} 项没有截止日期，查看列表`, size: 'sm', onClick: showList }));
}

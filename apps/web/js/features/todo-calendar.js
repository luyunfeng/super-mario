// Calendar dates are local civil dates. Walk them with setDate so DST transitions
// do not shift the calendar by an hour. Only send ISO instants to the API.
import { h } from '../lib/dom.js';
import { Button, Check, Segmented } from '../ui/kit.js';

const dragType = 'application/x-super-mario-todo';
const pad = number => String(number).padStart(2, '0');
const modeLabels = [['day', '日'], ['week', '周'], ['month', '月']];
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
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

// Intl numbers weekdays from Monday (1) through Sunday (7); Date uses Sunday (0).
function firstWeekday() {
  try {
    const locale = new Intl.Locale(navigator.language);
    const first = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay;
    if (first) return first % 7;
    const region = locale.maximize().region;
    if ('AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW'.split(' ').includes(region)) return 0;
    if ('AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY'.split(' ').includes(region)) return 6;
  } catch { /* Use the workbench default when the browser has no locale information. */ }
  return 1;
}

export function weekOffset(date) {
  return (date.getDay() - firstWeekday() + 7) % 7;
}

function daysFor(anchor, mode) {
  if (mode === 'day') return [anchor];
  const start = new Date(anchor);
  if (mode === 'month') start.setDate(1);
  start.setDate(start.getDate() - weekOffset(start));
  const days = [];
  do {
    for (let i = 0; i < 7; i++) days.push(shift(start, days.length));
  } while (mode === 'month' && shift(start, days.length).getMonth() === anchor.getMonth());
  return days;
}

export function todoCalendar({ mode, anchor, todos, showDone, onShowDone, navigate, open, add, move, showList }) {
  const days = daysFor(anchor, mode);
  const now = new Date();
  const today = localDate(now);
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
    h('span', { class: 'small muted' }, '时区 · ' + Intl.DateTimeFormat().resolvedOptions().timeZone),
    Segmented({ label: '日历范围', value: mode, options: modeLabels, onChange: value => navigate(value, anchor) }).el,
    Check({ label: '显示已完成', checked: showDone, onChange: onShowDone }));

  function entry(todo) {
    const time = localDate(todo.dueAt, true).slice(11);
    const overdue = !todo.completedAt && Date.parse(todo.dueAt) < Date.now();
    const status = todo.completedAt ? '已完成' : overdue ? '已逾期' : todo.waitingOn ? '等待中' : '待完成';
    const reminding = todo.reminderAt && !todo.remindedAt && !todo.completedAt;
    const high = todo.priority === 'high';
    const label = [time, todo.title, status, high && '高优先级', reminding && '有待触发提醒'].filter(Boolean).join(' · ');
    return h('button', { class: 'cal-entry', type: 'button', title: label, 'aria-label': label,
      dataset: { status }, draggable: true, onclick: () => open(todo),
      ondragstart: event => {
        event.dataTransfer.setData(dragType, todo.id);
        event.dataTransfer.setData(dragType + '-due', todo.dueAt);
        event.dataTransfer.effectAllowed = 'move';
      } },
      high && h('span', { 'aria-hidden': 'true' }, '⚑ '), h('span', null, time), ' ', todo.title, reminding && ' ⏰');
  }
  function slotTime(cell, hour, y) {
    if (hour === undefined) return undefined;
    if (hour === 'end') return '23:59';
    const box = cell.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (y - box.top) / box.height));
    const minutes = Math.min(23 * 60 + 45, hour * 60 + Math.round(fraction * 4) * 15);
    return pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60);
  }
  let previewCell;
  function clearPreview() {
    if (previewCell) delete previewCell.dataset.dropLabel;
    previewCell = undefined;
  }
  function cell(day, hour, ...children) {
    const key = localDate(day);
    return h('div', { class: 'cal-cell', dataset: { day: key, hour, today: key === today, outside: mode === 'month' && day.getMonth() !== anchor.getMonth() },
      onclick: event => { if (mode === 'month' && event.target === event.currentTarget) navigate('day', day); },
      ondragover: event => {
        if (!event.dataTransfer.types.includes(dragType)) return;
        event.preventDefault();
        const cell = event.currentTarget;
        if (previewCell !== cell) clearPreview();
        previewCell = cell;
        cell.dataset.dropLabel = slotTime(cell, hour, event.clientY) ?? key;
      },
      ondragleave: event => {
        if (event.currentTarget === previewCell && !previewCell.contains(event.relatedTarget)) clearPreview();
      },
      ondrop: event => {
        clearPreview();
        const id = event.dataTransfer.getData(dragType);
        const todo = todos.find(item => item.id === id);
        const originalDueAt = event.dataTransfer.getData(dragType + '-due');
        if (!todo || !originalDueAt) return;
        event.preventDefault();
        move(todo, key, slotTime(event.currentTarget, hour, event.clientY), originalDueAt);
      } }, children);
  }
  function dayButton(day, label) {
    return h('button', { type: 'button', class: 'cal-day', 'aria-label': `查看 ${localDate(day)}`, onclick: () => navigate('day', day) }, label);
  }
  let content;
  if (mode === 'month') {
    content = h('div', { class: 'cal-grid cal-month' }, days.slice(0, 7).map(day => h('strong', { class: 'cal-head' }, weekdays[day.getDay()])),
      days.map(day => {
        const entries = dated.get(localDate(day)) ?? [];
        return cell(day, undefined, dayButton(day, day.getDate()), entries.slice(0, 3).map(entry),
          entries.length > 3 && dayButton(day, `还有 ${entries.length - 3} 项`));
      }));
  } else {
    const headers = days.map(day => dayButton(day, `${weekdays[day.getDay()]} ${day.getMonth() + 1}/${day.getDate()}`));
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
        const slot = h('button', { type: 'button', class: 'cal-slot', 'aria-label': `添加待办 ${key} ${time}`, onclick: event => {
          // Keyboard and assistive activation have no pointer coordinates.
          const selected = event.detail ? slotTime(event.currentTarget.parentElement, hour, event.clientY) : time;
          add(key, selected);
        } }, '+');
        return cell(day, hour, slot, entries.map(entry));
      })]));
  }
  let firstHour;
  if (mode !== 'month') {
    const includeHour = hour => { firstHour = Math.min(firstHour ?? hour, hour); };
    for (const day of days) {
      const key = localDate(day);
      if (key === today) {
        const earlier = new Date(now.getTime() - 90 * 60_000);
        includeHour(localDate(earlier) === today ? earlier.getHours() : 0);
      }
      for (const todo of dated.get(key) ?? []) {
        const date = new Date(todo.dueAt);
        // The day-end row sits above the time axis.
        includeHour(date.getHours() === 23 && date.getMinutes() === 59 ? 0 : Math.max(0, date.getHours() - 1));
      }
    }
  }
  return h('section', { class: 'stack todo-calendar', 'aria-label': '待办日历', ondragend: clearPreview, onkeydown: event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.target.matches('input, textarea, select')) return;
    if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'ArrowRight') step(1);
    else if (event.key.toLowerCase() === 't') navigate(mode, new Date());
    else return;
    event.preventDefault();
  } }, controls,
    h('div', { class: 'cal-scroll', dataset: mode === 'month' ? {} : { firstHour: firstHour ?? 8 } }, content),
    undated > 0 && Button({ label: `${undated} 项没有截止日期，查看列表`, size: 'sm', onClick: showList }));
}

// Browser system notifications. The server only reports a notice with its source link.
// Whether to show it is decided here, by this browser's settings and which tab is in front.
import { h, readLocal, writeLocal } from '../lib/dom.js';
import { Button, Check, Field, Input, Select } from '../ui/kit.js';

const storageKey = 'sm.browser-notifications';
const seenKey = 'sm.browser-notifications.seen';
// Each notice also lands in the workspace event log with a sequence number. That number
// is the dedupe key, so a notice shown before a reload is not shown again.
const DONE_CHOICES = [['off', '不推送'], ['long', '只推长任务'], ['always', '每次都推']];
// A result the owner waited at least this long for counts as a long task.
const LONG_TASK_MS = 120000;
// Results wait briefly. Returning to the page meanwhile makes the notification unnecessary.
export const DONE_DELAY_MS = 20000;
const clock = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value ?? '');

export function notificationSettings() {
  const saved = readLocal(storageKey, {});
  return {
    enabled: saved?.enabled === true,
    always: saved?.always === true,
    done: DONE_CHOICES.some(([key]) => key === saved?.done) ? saved.done : 'off',
    quiet: {
      enabled: saved?.quiet?.enabled === true,
      start: clock(saved?.quiet?.start) ? saved.quiet.start : '22:00',
      end: clock(saved?.quiet?.end) ? saved.quiet.end : '08:00',
    },
  };
}

function inQuietHours(quiet, now) {
  if (!quiet.enabled) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = toMinutes(quiet.start), end = toMinutes(quiet.end);
  // A range that crosses midnight, such as 22:00–08:00, wraps.
  return start === end ? false : start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

// Returns 'show', 'silent' (shown without a sound) or 'skip'.
function decide(notice, settings, now) {
  if (notice.kind === 'done' && (settings.done === 'off' || (settings.done === 'long' && !(notice.durationMs >= LONG_TASK_MS)))) return 'skip';
  if (inQuietHours(settings.quiet, now)) return notice.kind === 'done' ? 'skip' : 'silent';
  return 'show';
}

async function pageIsInFront(api) {
  if (document.visibilityState === 'visible' && document.hasFocus()) return true;
  // Another tab of this browser may be in front. The server merges presence heartbeats from all tabs.
  try { return (await api('/presence')).present === true; } catch { return true; }
}

function markSeen(id) {
  const seen = new Set(readLocal(seenKey, []));
  if (seen.has(id)) return false;
  seen.add(id);
  writeLocal(seenKey, [...seen].slice(-200));
  return true;
}

// Tabs of one browser receive the same notice together. One of them shows it.
function claim(id) {
  return navigator.locks ? navigator.locks.request('sm-browser-notice', () => markSeen(id)) : Promise.resolve(markSeen(id));
}

// A test replaces the wait so it does not sit in real time. Production leaves it undefined.
export function installBrowserNotifications({ api, store, doneDelayMs = DONE_DELAY_MS }) {
  const active = () => store.view.snapshot?.plugins?.some(plugin => plugin.id === 'browser-notifications' && plugin.status === 'active');
  const shown = new Set(), timers = new Set();
  let change = 0;
  function closeShown() { for (const notification of shown) notification.close(); shown.clear(); }
  function cancelPending() { for (const timer of timers) clearTimeout(timer); timers.clear(); }
  async function present(notice) {
    if (!active() || !('Notification' in window) || Notification.permission !== 'granted') return;
    const settings = notificationSettings();
    if (!settings.enabled) return;
    // The server was asked whether any tab is in front. Ask the document again after that wait.
    if (!settings.always && (await pageIsInFront(api) || (document.visibilityState === 'visible' && document.hasFocus()))) return;
    const verdict = decide(notice, settings, new Date());
    if (verdict === 'skip') return;
    const notification = new Notification(notice.title, {
      body: notice.text.replace(/\s+/g, ' ').slice(0, 200), tag: notice.id, silent: verdict === 'silent' });
    notification.onclick = () => {
      notification.close();
      window.focus();
      if (typeof notice.href === 'string' && notice.href.startsWith('#')) location.hash = notice.href;
    };
    notification.onclose = () => shown.delete(notification);
    shown.add(notification);
  }
  const unsubscribe = store.subscribe(view => {
    if (!active()) { cancelPending(); closeShown(); return; }
    if (view.browserNoticeChange === change) return;
    change = view.browserNoticeChange;
    const notice = view.browserNotice;
    if (!notice) return;
    // Claim on arrival. Two tabs of one browser take this lock in turn, so the second
    // reads the record the first wrote, and only one tab queues the popup.
    const claimed = navigator.locks
      ? navigator.locks.request('sm-browser-notice', () => Promise.resolve(markSeen(notice.id)))
      : Promise.resolve(markSeen(notice.id));
    void claimed.then(first => {
      if (!first) return;
      if (notice.kind !== 'done') { void present(notice); return; }
      const delay = doneDelayMs;
      const timer = setTimeout(() => { timers.delete(timer); void present(notice); }, delay);
      timers.add(timer);
    });
  });
  // What the owner is already looking at in the page needs no system notification.
  const returned = () => { if (document.visibilityState === 'visible') { cancelPending(); closeShown(); } };
  document.addEventListener('visibilitychange', returned);
  window.addEventListener('pagehide', closeShown);
  return () => { unsubscribe(); cancelPending(); closeShown(); document.removeEventListener('visibilitychange', returned); window.removeEventListener('pagehide', closeShown); };
}

export function browserNotificationSettingsEditor() {
  const settings = notificationSettings();
  const status = h('p', { role: 'status', class: 'small' });
  const supported = 'Notification' in window;
  const permission = supported ? Notification.permission : 'unsupported';
  const enabled = Check({ label: '弹出系统通知', checked: settings.enabled });
  const always = Check({ label: '网页在前台时也弹出', checked: settings.always });
  const done = Select({ 'aria-label': 'Agent 做完时', value: settings.done, options: DONE_CHOICES });
  const quiet = Check({ label: '免打扰时段', checked: settings.quiet.enabled });
  const start = Input({ type: 'time', value: settings.quiet.start });
  const end = Input({ type: 'time', value: settings.quiet.end });
  const hints = {
    unsupported: '这个浏览器不支持系统通知。',
    denied: '浏览器不允许本站发通知，请在地址栏的网站设置里改成允许。',
  };
  if (permission !== 'granted' && permission !== 'default') status.textContent = hints[permission];
  return h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, '设置保存在当前浏览器。页面不在前台时提醒，点通知回到对应的消息或执行。开着多个标签页也只提醒一次。'),
    enabled, always,
    Field({ label: 'Agent 做完时', control: done }),
    h('p', { class: 'small muted' }, '只推长任务指等待两分钟以上的结果，并且过一会儿还没看才提醒。'),
    quiet,
    h('div', { class: 'form-row' }, Field({ label: '免打扰开始', control: start }), Field({ label: '免打扰结束', control: end })),
    h('p', { class: 'small muted' }, '按本机时间。这段时间里不提醒执行结果，需要你处理的事照常提醒但不响铃。'),
    status,
    Button({ label: '保存通知设置', kind: 'primary', onClick: async () => {
      if (enabled.querySelector('input').checked && supported && Notification.permission === 'default') await Notification.requestPermission();
      if (!start.reportValidity() || !end.reportValidity()) return;
      writeLocal(storageKey, {
        enabled: enabled.querySelector('input').checked, always: always.querySelector('input').checked, done: done.value,
        quiet: { enabled: quiet.querySelector('input').checked, start: start.value, end: end.value },
      });
      status.textContent = Notification.permission === 'denied' ? hints.denied : '通知设置已保存';
    } }));
}

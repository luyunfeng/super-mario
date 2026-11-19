import { h, svg, readLocal, writeLocal } from '../lib/dom.js';

let stopCurrent;
export function playSplash({ title = 'Super Mario', subtitle = '让每一个目标，都有下一步。', durationMs = 1200, force = false } = {}) {
  if (!force && readLocal('sm.splash.seen', false)) return;
  writeLocal('sm.splash.seen', true);
  stopCurrent?.();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const mark = svg([
    ['rect', { x: 2, y: 2, width: 20, height: 20, rx: 4, pathLength: 1, class: 'splash__stamp' }],
    ['path', { d: 'M6.8 16.2V7.8L12 13.2L17.2 7.8V16.2', pathLength: 1, class: 'splash__letter' }],
  ], 'splash__logo');
  const el = h('div', { class: 'splash', 'aria-hidden': 'true' }, mark,
    h('div', { class: 'splash__title' }, title), h('div', { class: 'splash__sub' }, subtitle));
  const duration = Math.min(1200, Math.max(600, durationMs));
  el.style.setProperty('--splash-time', duration + 'ms');
  document.body.append(el);

  // 输入仍交给下面的工作台。手动预览和自动播放共用一套清理逻辑。
  const events = new AbortController();
  function stop() {
    events.abort();
    clearTimeout(timer);
    el.remove();
    stopCurrent = undefined;
  }
  const timer = setTimeout(stop, duration);
  stopCurrent = stop;
  for (const event of ['pointerdown', 'keydown']) window.addEventListener(event, stop, { capture: true, signal: events.signal });
}

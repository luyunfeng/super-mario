// 开屏：只在第一次打开时出现，不拦截操作，1.5 秒后自动淡出。之后不再出现，可在 Agent → 高级里重新预览。
import { h, readLocal, writeLocal } from '../lib/dom.js';

export function playSplash({ title = 'Super Mario', subtitle = '让每一个目标，都有下一步。', durationMs = 1500, force = false } = {}) {
  if (!force && readLocal('sm.splash.seen', false)) return;
  writeLocal('sm.splash.seen', true);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = h('div', { class: 'splash', 'aria-hidden': 'true' },
    h('div', { class: 'splash__logo' }, 'M'), h('div', { class: 'splash__title' }, title), h('div', { class: 'splash__sub' }, subtitle));
  document.body.append(el);
  const stay = Math.min(Math.max(durationMs, 800), 3000);
  setTimeout(() => el.classList.add('is-leaving'), stay - 300);
  setTimeout(() => el.remove(), stay + 100);
}

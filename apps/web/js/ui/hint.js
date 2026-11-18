// 作用说明：每个页面和卡片右上角的 ⓘ。点击、悬停或聚焦展开：作用一句话 + 两句说明 + 例子。
import { h, readLocal, writeLocal } from '../lib/dom.js';
import { icon } from './icons.js';
import { hints } from '../copy/hints.js';

let serial = 0;
const openers = new Set();

export function hintCopy(key) {
  const copy = hints[key];
  if (!copy) throw new Error(`缺少作用说明：${key}`);
  return copy;
}

export function setHintsEnabled(enabled) {
  document.documentElement.dataset.hints = enabled ? 'on' : 'off';
  writeLocal('sm.hints', enabled);
}
export function hintsEnabled() { return readLocal('sm.hints', true) !== false; }
export function applyHintPreference() { document.documentElement.dataset.hints = hintsEnabled() ? 'on' : 'off'; }

export function Hint(key) {
  const copy = hintCopy(key);
  const popId = `hint-${++serial}`;
  const button = h('button', { class: 'hint__btn', type: 'button', 'aria-label': `说明：${copy.tag}`, 'aria-expanded': 'false', 'aria-controls': popId }, icon('info'));
  const pop = h('div', { class: 'hint__pop', id: popId, role: 'tooltip', hidden: true },
    h('strong', null, copy.tag), h('p', null, copy.detail), h('p', { class: 'hint__ex' }, `例如：${copy.example}`));
  const root = h('span', { class: 'hint', dataset: { hint: key } }, button, pop);
  const set = (open) => {
    pop.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) openers.add(set); else openers.delete(set);
  };
  button.addEventListener('click', () => set(pop.hidden));
  root.addEventListener('mouseenter', () => set(true));
  root.addEventListener('mouseleave', () => { if (!root.contains(document.activeElement)) set(false); });
  root.addEventListener('focusout', () => setTimeout(() => { if (!root.contains(document.activeElement)) set(false); }, 0));
  return root;
}

document.addEventListener('keydown', (event) => { if (event.key === 'Escape') for (const close of [...openers]) close(false); });
document.addEventListener('click', (event) => {
  for (const close of [...openers]) { /* 点击说明之外的地方关闭。 */
    const root = event.target.closest?.('.hint');
    if (!root) close(false);
  }
});

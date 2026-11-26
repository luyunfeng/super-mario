// 工作台的外观：浅色或深色。选择保存在当前浏览器，所有标签页跟着变。
// 页面开始绘制前就要定下来，那一小步在 index.html 里，这里只管之后的切换和跟随。
import { h, readLocal } from '../lib/dom.js';

export const themeKey = 'sm.theme';
export const themes = { light: '浅色', dark: '深色' };

/** The theme this browser chose, or light when it chose none or something unreadable. */
export function savedTheme() {
  const saved = readLocal(themeKey, {});
  return Object.hasOwn(themes, saved?.mode) ? saved.mode : 'light';
}

/** Puts the chosen theme on the page. Nothing else is touched. */
export function applyTheme() {
  document.documentElement.dataset.theme = savedTheme();
}

/** Follows the choice in other tabs, and the one made in this tab. */
export function installTheme() {
  applyTheme();
  window.addEventListener('storage', event => { if (!event.key || event.key === themeKey) applyTheme(); });
  window.addEventListener('sm-theme', applyTheme);
}

/** A row of buttons, one for each theme, with the chosen one marked. */
export function themePicker() {
  const group = h('div', { class: 'row', role: 'group', 'aria-label': '外观' });
  const paint = () => {
    const current = savedTheme();
    for (const button of group.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.theme === current));
  };
  for (const [mode, label] of Object.entries(themes)) {
    group.append(h('button', { type: 'button', class: 'btn', dataset: { theme: mode }, onclick() {
      try { localStorage.setItem(themeKey, JSON.stringify({ mode })); }
      catch { return; }
      window.dispatchEvent(new Event('sm-theme'));
    } }, label));
  }
  paint();
  window.addEventListener('sm-theme', paint);
  return group;
}

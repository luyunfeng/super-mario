import { h, readLocal } from '../lib/dom.js';

const storageKey = 'sm.reading-fonts';
const sizeChoices = { small: '小', standard: '标准', large: '大' };
const fields = [
  { key: 'body', label: '正文字体', presets: ['system-ui', 'Georgia', 'Source Han Serif SC'] },
  { key: 'code', label: '代码字体', presets: ['ui-monospace', 'Menlo', 'Consolas'] },
];

function valid(name) {
  return typeof name === 'string' && name.length <= 100 && !/[\x00-\x1f\x7f,;{}<>]/u.test(name);
}

export function installReadingFonts(store) {
  function apply() {
    const enabled = store.view.snapshot?.plugins.some(p => p.id === 'reading-fonts' && p.status === 'active');
    const saved = readLocal(storageKey, {});
    const scale = enabled && (saved?.size === 'small' ? 12 / 13 : saved?.size === 'large' ? 14 / 13 : null);
    if (scale) document.documentElement.style.setProperty('--reading-scale', String(scale));
    else document.documentElement.style.removeProperty('--reading-scale');
    for (const { key } of fields) {
      const name = saved?.[key];
      const property = '--reading-' + key;
      if (enabled && valid(name) && name.trim()) {
        const family = name.trim();
        const generic = family === 'system-ui' || family === 'ui-monospace';
        document.documentElement.style.setProperty(property, generic ? family : '"' + CSS.escape(family) + '"');
      } else document.documentElement.style.removeProperty(property);
    }
  }
  store.subscribe(apply);
  window.addEventListener('storage', event => { if (!event.key || event.key === storageKey) apply(); });
  window.addEventListener('sm-reading-fonts', apply);
  apply();
}

export function readingFontEditor() {
  const saved = readLocal(storageKey, {});
  const notice = h('p', { role: 'status' });
  const inputs = {};
  const size = h('select', {}, Object.entries(sizeChoices).map(([value, label]) => h('option', { value }, label)));
  let initialSize = Object.hasOwn(sizeChoices, saved?.size) ? saved.size : 'standard';
  size.value = initialSize;
  const controls = fields.map(({ key, label, presets }) => {
    const list = 'sm-font-' + key;
    const value = valid(saved?.[key]) ? saved[key] : '';
    const input = h('input', { list, value, placeholder: '工作台默认字体', maxLength: 100 });
    input.defaultValue = value;
    inputs[key] = input;
    return h('label', { class: 'pref-field' }, label, input, h('datalist', { id: list }, presets.map(font => h('option', { value: font }))));
  });
  return h('div', { class: 'stack' }, controls, h('label', { class: 'pref-field' }, '阅读字号', size), h('button', { type: 'button', class: 'btn btn--primary', onclick() {
    // Other tabs can save one font while this form is open.
    const current = readLocal(storageKey, {});
    const next = {};
    for (const { key, label } of fields) {
      const input = inputs[key];
      const name = input.value === input.defaultValue
        ? (valid(current?.[key]) ? current[key] : '') : input.value.trim();
      if (!valid(name)) { notice.textContent = label + '须填写单个字体名称。'; inputs[key].focus(); return; }
      if (name) next[key] = name;
    }
    const nextSize = size.value === initialSize ? current?.size : size.value;
    if (nextSize === 'small' || nextSize === 'large') next.size = nextSize;
    try { localStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { notice.textContent = '当前浏览器未能保存字体设置。'; return; }
    for (const { key } of fields) inputs[key].defaultValue = inputs[key].value = next[key] ?? '';
    initialSize = size.value = next.size ?? 'standard';
    window.dispatchEvent(new Event('sm-reading-fonts'));
    notice.textContent = '字体设置已保存';
  } }, '保存字体'), h('button', { type: 'button', class: 'btn', onclick() {
    try { localStorage.removeItem(storageKey); }
    catch { notice.textContent = '当前浏览器未能恢复字体设置。'; return; }
    for (const { key } of fields) inputs[key].defaultValue = inputs[key].value = '';
    initialSize = size.value = 'standard';
    window.dispatchEvent(new Event('sm-reading-fonts'));
    notice.textContent = '已恢复工作台默认字体和字号';
  } }, '恢复默认字体和字号'), notice);
}

// 基础组件。每个组件是一个返回 DOM 节点的函数；样式全部在 components.css。
import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { Hint, hintCopy } from './hint.js';
import { toastError } from './overlay.js';

/**
 * 按钮。onClick 可以是异步函数：执行期间忽略重复点击，抛出的错误统一用轻提示显示。
 * kind: primary | secondary | ghost | danger。
 */
export function Button({ label, icon: iconName, kind = 'secondary', size, onClick, title, type = 'button', ariaLabel, disabled, dataset, iconOnly }) {
  const classes = ['btn', `btn--${kind}`, size === 'sm' ? 'btn--sm' : '', iconOnly ? 'btn--icon' : ''].filter(Boolean).join(' ');
  const el = h('button', { class: classes, type, title, 'aria-label': ariaLabel ?? (iconOnly ? label : undefined), disabled, dataset },
    iconName && icon(iconName), !iconOnly && label);
  if (onClick) {
    el.addEventListener('click', async (event) => {
      if (el.dataset.busy) return;
      el.dataset.busy = '1'; el.classList.add('is-busy'); el.setAttribute('aria-busy', 'true');
      try { await onClick(event, el); }
      catch (error) { toastError(error); }
      finally { delete el.dataset.busy; el.classList.remove('is-busy'); el.removeAttribute('aria-busy'); }
    });
  }
  return el;
}

export function Pill(text, tone = '') {
  return h('span', { class: `pill ${tone ? `pill--${tone}` : ''}` }, text);
}

export function Dot(tone = '') { return h('span', { class: `dot ${tone ? `dot--${tone}` : ''}`, 'aria-hidden': 'true' }); }

/**
 * 卡片。title 左上，右上是作用说明（hint 键）和自定义工具。
 * 作用的一句话显示在标题下，更多说明在 ⓘ 里。
 */
export function Card({ title, hint, sub, tools, body, id, className = '' }) {
  const subtitle = sub ?? (hint ? hintCopy(hint).tag : undefined);
  return h('section', { class: `card ${className}`, id },
    title && h('header', { class: 'card__head' },
      h('div', { class: 'card__title' }, h('h2', null, title), subtitle && h('span', { class: 'card__sub' }, subtitle)),
      h('div', { class: 'card__tools' }, tools, hint && Hint(hint))),
    h('div', { class: 'card__body' }, body));
}

export function Field({ label, hint, required, control, className = '' }) {
  const id = control.id || (control.id = `f-${Math.random().toString(36).slice(2, 8)}`);
  return h('div', { class: `field ${className}` },
    label && h('label', { class: 'field__label', for: id }, label, required && h('span', { class: 'field__req', 'aria-hidden': 'true' }, '*')),
    control,
    hint && h('span', { class: 'field__hint' }, hint));
}

export const Input = (props) => h('input', { class: 'input', autocomplete: 'off', ...props });
export const TextArea = (props) => h('textarea', { class: 'textarea', ...props });
export function Select({ options, value, ...props }) {
  const el = h('select', { class: 'select', ...props },
    options.map(([val, text]) => h('option', { value: val }, text)));
  if (value !== undefined) el.value = value;
  return el;
}
export function Check({ label, checked, onChange, name }) {
  const input = h('input', { type: 'checkbox', checked, name });
  if (onChange) input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'check' }, input, h('span', null, label));
}

/**
 * 选项卡：当前项带下划线。items: [{ id, label, count, alert }]。
 * 返回 { el, set(active), update(items) }。
 */
export function Tabs({ items, active, onSelect, label = '分区' }) {
  const el = h('div', { class: 'tabs', role: 'tablist', 'aria-label': label });
  let current = active;
  let data = items;
  function paint() {
    el.replaceChildren(...data.map((item) => {
      const tab = h('button', {
        class: 'tab', type: 'button', role: 'tab', id: `tabbtn-${item.id}`, 'aria-controls': `panel-${item.id}`,
        'aria-selected': String(item.id === current), tabindex: item.id === current ? 0 : -1, dataset: { tab: item.id },
      }, item.label, item.count !== undefined && item.count !== null && h('span', { class: `tab__count ${item.alert ? 'tab__count--alert' : ''}` }, item.count));
      tab.addEventListener('click', () => onSelect(item.id));
      tab.addEventListener('keydown', (event) => {
        const index = data.findIndex(entry => entry.id === item.id);
        const move = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (move) { event.preventDefault(); onSelect(data[(index + move + data.length) % data.length].id); }
      });
      return tab;
    }));
  }
  paint();
  return {
    el,
    set(next) { if (next !== current) { current = next; paint(); } },
    update(next, nextActive = current) { data = next; current = nextActive; paint(); },
  };
}

/** 分段控件：几个互斥选项。 */
export function Segmented({ options, value, onChange, label }) {
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  let current = value;
  function paint() {
    el.replaceChildren(...options.map(([key, text]) => {
      const button = h('button', { class: 'seg__btn', type: 'button', 'aria-pressed': String(key === current), dataset: { value: key } }, text);
      button.addEventListener('click', () => { if (key === current) return; current = key; paint(); onChange(key); });
      return button;
    }));
  }
  paint();
  return { el, set(next) { current = next; paint(); }, get value() { return current; } };
}

export function Banner({ tone = '', children, action }) {
  return h('div', { class: `banner ${tone ? `banner--${tone}` : ''}`, role: tone === 'danger' ? 'alert' : 'status' },
    h('div', { class: 'banner__text' }, children), action);
}

export function Empty({ title, text, action }) {
  return h('div', { class: 'empty' }, title && h('div', { class: 'empty__title' }, title), text && h('div', null, text), action);
}

/** 折叠区：默认收起，展开时才调用 onOpen（用于按需加载）。 */
export function Fold({ title, body, onOpen, open = false }) {
  const content = h('div', { class: 'fold__body' }, body);
  const el = h('details', { class: 'fold', open }, h('summary', null, title), content);
  let opened = false;
  el.addEventListener('toggle', () => { if (el.open && !opened) { opened = true; onOpen?.(content); } });
  if (open) { opened = true; queueMicrotask(() => onOpen?.(content)); }
  return Object.assign(el, { content });
}

export function copyText(text) {
  return navigator.clipboard?.writeText(text);
}

// 极小的 DOM 工具：h() 建元素，keyedList() 只重绘变化的行，避免整页重渲染冲掉用户正在输入的内容。

const attributeOnly = new Set(['role', 'list', 'form', 'for', 'viewBox', 'd']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'for') el.htmlFor = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key.includes('-') || attributeOnly.has(key)) el.setAttribute(key, value === true ? '' : value);
      else if (key in el) el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function replace(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 用 DOM 接口构造 SVG（不拼接 HTML 字符串）。shapes: [[标签, 属性], …]。 */
export function svg(shapes, className = '') {
  const root = document.createElementNS(SVG_NS, 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) root.setAttribute(name, value);
  if (className) root.setAttribute('class', className);
  for (const [tag, attributes] of shapes) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) child.setAttribute(name, value);
    root.append(child);
  }
  return root;
}

/**
 * 把 items 同步到 container。key 相同且内容签名未变的行原样保留；
 * 内容变了才调用 render 重建。返回是否有变化。
 */
export function keyedList(container, items, key, render, signature = item => JSON.stringify(item)) {
  const previous = container._keyed ?? new Map();
  const next = new Map();
  const nodes = [];
  for (const item of items) {
    const id = key(item);
    const sig = signature(item);
    const old = previous.get(id);
    const node = old && old.sig === sig ? old.node : render(item);
    next.set(id, { sig, node });
    nodes.push(node);
  }
  container._keyed = next;
  const current = [...container.children];
  if (current.length === nodes.length && current.every((node, index) => node === nodes[index])) return false;
  container.replaceChildren(...nodes);
  return true;
}

/** 防抖：合并短时间内的多次调用。 */
export function debounce(fn, wait) {
  let timer;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function readLocal(key, fallback) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); } catch { return fallback; }
}
export function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 无存储时只影响本次会话。 */ }
}

// 隐藏只是当前浏览器的显示偏好，不删除远端目录，不归档项目。
import { h, replace, readLocal, writeLocal } from '../lib/dom.js';
const storageKey = 'sm.project-folders.hidden.v1';
const eventName = 'project-folder-visibility';
export const folderKey = (machineId, cwd) => JSON.stringify([machineId, cwd]);
export function hiddenFolders() {
  const values = readLocal(storageKey, []);
  return new Set(Array.isArray(values) ? values.filter(value => typeof value === 'string') : []);
}
export function setFolderHidden(machineId, cwd, hidden) {
  const values = hiddenFolders(), key = folderKey(machineId, cwd);
  if (hidden) values.add(key); else values.delete(key);
  writeLocal(storageKey, [...values]);
  window.dispatchEvent(new Event(eventName));
}
export function onFolderVisibilityChange(listener) {
  const storage = event => { if (event.key === storageKey || event.key === null) listener(); };
  window.addEventListener(eventName, listener);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(eventName, listener); window.removeEventListener('storage', storage); };
}

// Build only paths leading to discovered candidates. Ancestors are navigation rows.
export function folderTree({ machineId, homeDir, items, expansion, searching, renderCandidate }) {
  const roots = new Map();
  const home = homeDir?.startsWith('/') ? homeDir.replace(/\/+$/, '') || '/' : undefined;
  function node(map, path, name) {
    if (!map.has(path)) map.set(path, { path, name, children: new Map() });
    return map.get(path);
  }
  for (const item of items) {
    if (!item.cwd?.startsWith('/')) continue;
    const insideHome = home && (home === '/' || item.cwd === home || item.cwd.startsWith(home + '/'));
    const base = insideHome ? home : '/';
    let parent = node(roots, base, base);
    for (const part of item.cwd.slice(base.length).split('/').filter(Boolean)) {
      parent = node(parent.children, (parent.path === '/' ? '' : parent.path) + '/' + part, part);
    }
    parent.item = item;
  }
  function render({ path, name, children, item }, depth) {
    const row = item ? renderCandidate(item) : h('div', { class: 'folder-tree__branch' }, h('strong', null, name));
    const li = h('li', null, row);
    li.style.setProperty('--folder-depth', depth);
    if (!children.size) return li;
    const key = folderKey(machineId, path);
    let open = searching || (expansion.get(key) ?? depth === 0);
    const list = h('ul', { class: 'folder-tree__children' });
    const toggle = h('button', { class: 'folder-tree__toggle', type: 'button', onClick() {
      open = !open;
      if (!searching) expansion.set(key, open);
      update();
    } });
    function update() {
      toggle.textContent = open ? '▾' : '▸';
      toggle.setAttribute('aria-label', (open ? '收起 ' : '展开 ') + path);
      toggle.setAttribute('aria-expanded', String(open));
      list.hidden = !open;
      if (open && !list.childElementCount) replace(list, sorted(children).map(child => render(child, depth + 1)));
    }
    row.prepend(toggle);
    update();
    li.append(list);
    return li;
  }
  const sorted = map => [...map.values()].sort((a, b) => Number(b.path === home) - Number(a.path === home) || a.name.localeCompare(b.name));
  return h('ul', { class: 'folder-tree' }, sorted(roots).map(root => render(root, 0)));
}

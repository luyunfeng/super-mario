// 快捷键：只做最小集合，不提供“按键直接批准”这类高风险操作。
import { h } from '../lib/dom.js';

const GO = { c: 'chat', a: 'agent', p: 'projects', m: 'memory', h: 'channels' };
const typing = target => target.closest?.('input, textarea, select, [contenteditable="true"]');

export function installShortcuts({ shell, router, onQuickTodo }) {
  let goUntil = 0;

  function help() {
    if (document.querySelector('dialog[open]')) return;
    const rows = [['/', '搜索'], ['c', '添加待办'], ['g 然后 c / a / p / m / h', '对话 / Agent / 项目 / 记忆 / 渠道'], ['Shift + Enter', '对话中换行'], ['Esc', '关闭弹窗']];
    const dialog = h('dialog', { class: 'modal', 'aria-label': '快捷键' },
      h('h2', null, '快捷键'),
      h('dl', { class: 'kv' }, rows.map(([key, text]) => [h('dt', null, h('kbd', null, key)), h('dd', null, text)])),
      h('div', { class: 'modal__actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, '关闭')));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (typing(event.target) || document.querySelector('dialog[open]')) return;
    if (Date.now() < goUntil) {
      goUntil = 0;
      const page = GO[event.key];
      if (page) { event.preventDefault(); router.go(router.href(page)); return; }
    }
    if (event.key === 'g') { goUntil = Date.now() + 1500; return; }
    if (event.key === '/') { event.preventDefault(); shell.searchInput.focus(); }
    else if (event.key === 'c') { event.preventDefault(); onQuickTodo(); }
    else if (event.key === '?') { event.preventDefault(); help(); }
  });
}

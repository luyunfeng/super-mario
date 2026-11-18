// 快速添加待办：任意页面按 c，一行输入，回车创建。
import { h } from '../lib/dom.js';
import { Select } from '../ui/kit.js';
import { toastError } from '../ui/overlay.js';

export function openQuickTodo({ api, store, scope }) {
  if (document.querySelector('dialog[open]')) return;
  const projects = (store.view.snapshot?.projects ?? []).filter(item => !item.archivedAt);
  const input = h('input', { class: 'input', name: 'title', required: true, maxLength: 500, placeholder: '下一步要做什么？', autocomplete: 'off', 'aria-label': '待办标题' });
  const project = Select({ options: [['', '全部项目（不归类）'], ...projects.map(item => [item.id, item.name])], value: scope.get(), 'aria-label': '所属项目' });
  const dialog = h('dialog', { class: 'modal', 'aria-label': '添加待办', id: 'quick-todo' });
  const note = h('p', { class: 'small text-danger', role: 'alert' });
  const form = h('form', { class: 'stack', onsubmit: async (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    try {
      await api.post('/todos', { title, ...(project.value ? { projectId: project.value } : {}) });
      dialog.close();
      store.refresh();
    } catch (error) { note.textContent = `没有添加成功：${error.message}`; toastError(error); }
  } },
    h('h2', null, '添加待办'), input, project, note,
    h('div', { class: 'modal__actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, '取消'),
      h('button', { class: 'btn btn--primary', type: 'submit' }, '添加')));
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}

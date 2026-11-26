import { h, replace } from '../lib/dom.js';
import { makeFileDraggable } from './file-mention-drag.js';
import { Button } from '../ui/kit.js';
import { TextArea } from '../ui/kit.js';
import { confirmDialog } from '../ui/overlay.js';

function diffLineClass(line) {
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
    return 'diff-line diff-line--meta';
  }
  if (line.startsWith('@@')) return 'diff-line diff-line--hunk';
  if (line.startsWith('+')) return 'diff-line diff-line--add';
  if (line.startsWith('-')) return 'diff-line diff-line--del';
  return 'diff-line';
}

export function renderDiffLines(text) {
  const lines = text.split('\n');
  const nodes = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1 && lines[i] === '') break;
    nodes.push(h('span', { class: diffLineClass(lines[i]) }, lines[i]));
    if (i < lines.length - 1) nodes.push('\n');
  }
  return nodes;
}

/** Both conversations browse the saved computer binding through the same read-only API. */
export function createCodeSidebar({ api, store }) {
  let projectId = '', selected = '', sequence = 0, binding = '', opened = false, mode = 'file';
  const body = h('div', { class: 'code-sidebar__body' });
  const crumbs = h('div', { class: 'code-sidebar__crumbs small muted' });
  const output = h('pre', { class: 'code-sidebar__text', tabindex: 0 });
  const status = h('p', { class: 'muted small', role: 'status' });
  const tree = h('nav', { 'aria-label': '项目目录' });
  // Editing a file: what was read, and the editor for it. A file can be saved only as it was read.
  const editor = h('div', { class: 'stack code-sidebar__edit', 'aria-label': '编辑文件', hidden: true });
  let editing = null;
  const edit = Button({ label: '编辑', size: 'sm', onClick: () => { if (editing) showEditor(); } });
  const save = Button({ label: '保存到电脑', size: 'sm', kind: 'primary', onClick: () => saveFile() });
  const undo = Button({ label: '撤销上次保存', size: 'sm', onClick: () => undoFile() });
  edit.disabled = true; undo.disabled = true;
  const title = h('p', { class: 'small code-sidebar__binding' });
  const fileBtn = Button({ label: '文本', size: 'sm', onClick: () => selected && read('file', selected) });
  const diffBtn = Button({ label: 'Git diff', size: 'sm', onClick: () => selected && read('diff', selected) });
  function syncModeButtons() {
    fileBtn.classList.toggle('is-active', mode === 'file');
    diffBtn.classList.toggle('is-active', mode === 'diff');
  }
  function renderCrumbs(pathStr) {
    const parts = pathStr ? pathStr.split('/').filter(Boolean) : [];
    const nodes = [h('span', { class: 'code-sidebar__crumb' }, '根目录')];
    for (const part of parts) {
      nodes.push(h('span', { class: 'code-sidebar__sep', 'aria-hidden': 'true' }, ' / '), h('span', { class: 'code-sidebar__crumb' }, part));
    }
    replace(crumbs, nodes);
  }
  const el = h('aside', { class: 'code-sidebar', 'aria-label': '项目代码', hidden: true },
    h('div', { class: 'row row--between' }, h('h2', null, '项目代码'), Button({ label: '关闭代码', size: 'sm', onClick: () => { el.hidden = true; opened = false; } })), title, body);
  body.append(crumbs, tree, status, h('div', { class: 'row' }, fileBtn, diffBtn, edit), output, editor);
  const toggle = Button({ label: '查看代码', size: 'sm', onClick: () => { opened = !opened; el.hidden = !opened; if (opened) void read('tree', ''); } });
  syncModeButtons();
  function project() { return store.view.snapshot?.projects?.find(p => p.id === projectId); }
  function sync() {
    const p = project();
    title.textContent = p?.workspace ? `${p.name} · ${p.workspace.machineId}\n${p.workspace.cwd}` : '请先选择并绑定项目文件夹';
    toggle.disabled = !p?.workspace;
    const next = JSON.stringify([projectId, p?.workspace]);
    if (next !== binding) {
      binding = next; sequence++; selected = ''; mode = 'file'; syncModeButtons();
      replace(crumbs); replace(tree); output.textContent = ''; status.textContent = '';
      // Another project: the file being edited belongs to the one before.
      editing = null; edit.disabled = true; undo.disabled = true; editor.hidden = true;
      if (opened && p?.workspace) void read('tree', '');
    }
  }
  async function read(kind, path) {
    if (!project()?.workspace) return;
    if (kind === 'tree') selected = '';
    else { mode = kind; syncModeButtons(); }
    const stamp = ++sequence;
    status.textContent = '正在读取绑定电脑…'; output.textContent = '';
    try {
      const value = await api.get(`/projects/${encodeURIComponent(projectId)}/code?${new URLSearchParams({ kind, path })}`);
      if (stamp !== sequence) return;
      renderCrumbs(path);
      status.textContent = value.truncated ? '目录条目达到上限，请进入子目录查看。' : value.note || '';
      if (kind === 'tree') {
        const parent = path.split('/').slice(0, -1).join('/');
        const parentBtn = path ? Button({ label: '上级目录', size: 'sm', onClick: () => read('tree', parent) }) : null;
        if (parentBtn) parentBtn.classList.add('code-tree__item', 'code-tree__item--dir');
        const entries = (value.entries ?? []).map((e) => {
          const btn = Button({
            label: `${e.directory ? '▸ ' : ''}${e.name}`,
            size: 'sm',
            onClick: () => {
              if (!e.directory) {
                selected = e.path;
                for (const item of tree.querySelectorAll('.code-tree__item--file')) item.classList.remove('is-active');
                btn.classList.add('is-active');
              }
              void read(e.directory ? 'tree' : 'file', e.path);
            },
          });
          makeFileDraggable(btn, { api, store, projectId, path: e.path, directory: e.directory });
          btn.classList.add('code-tree__item', e.directory ? 'code-tree__item--dir' : 'code-tree__item--file');
          if (!e.directory && selected === e.path) btn.classList.add('is-active');
          return btn;
        });
        replace(tree, parentBtn, entries);
      } else {
        status.textContent = `${path}${value.note ? ' · ' + value.note : ''}`;
        if (kind === 'diff' && value.text) replace(output, renderDiffLines(value.text));
        else output.textContent = value.text || (kind === 'diff' ? '没有已跟踪文件差异。' : '');
        // A file as read can be edited: what was read is kept, with its hash, so that saving is
        // refused if the file changed on the computer in the meantime.
        if (kind === 'file') {
          editing = { path, text: value.text, hash: value.hash };
          edit.disabled = !value.hash;
        }
      }
    } catch (error) { if (stamp === sequence) status.textContent = `读取失败：${error.message}`; }
  }
  function openFile(path) {
    if (!project()?.workspace) return false;
    opened = true; el.hidden = false; selected = path;
    replace(tree, Button({ label: '所在目录', size: 'sm', onClick: () => read('tree', path.split('/').slice(0, -1).join('/')) }));
    void read('file', path);
    return true;
  }
  function showEditor() {
    if (!editing) return;
    const box = TextArea({ 'aria-label': '文件内容', rows: 14, spellcheck: false });
    box.value = editing.text;
    const feedback = h('p', { class: 'small', role: 'status' });
    replace(editor, h('strong', { class: 'small' }, '编辑 ' + editing.path), box, h('div', { class: 'row' }, save, undo), feedback);
    editor.hidden = false;
    editor._box = box; editor._feedback = feedback;
    box.addEventListener('input', () => { save.disabled = box.value === editing.text; });
    save.disabled = true;
  }
  async function saveFile() {
    if (!editing || !editor._box || !project()?.workspace) return;
    const box = editor._box, feedback = editor._feedback;
    save.disabled = true;
    try {
      const result = await api.put(`/projects/${encodeURIComponent(projectId)}/code/file`, { path: editing.path, text: box.value, expected: editing.hash });
      if (result?.written !== true) throw new Error('保存结果与这台电脑对不上');
      editing = { path: editing.path, text: box.value, hash: result.hash, undoId: result.undoId };
      undo.disabled = false;
      feedback.textContent = '已保存到电脑。';
      // What the page shows is what is on the computer now.
      output.textContent = box.value;
      save.disabled = true;
    } catch (error) {
      // The file changed on the computer: the owner is told to read it again, and nothing was written.
      feedback.textContent = error?.status === 409 ? `没有保存：${error.message}` : '保存失败或结果未知，请重新读取文件核对。';
      if (error?.status === 409) { edit.disabled = true; save.disabled = true; }
    }
  }
  async function undoFile() {
    if (!editing?.undoId || !project()?.workspace) return;
    const feedback = editor._feedback;
    if (!await confirmDialog({ title: '撤销上次保存？', message: '文件会恢复成保存前的内容。保存后文件又变过的话，不会撤销。', confirmLabel: '撤销' })) return;
    undo.disabled = true;
    try {
      await api.post(`/projects/${encodeURIComponent(projectId)}/code/file/undo`, { undoId: editing.undoId, expected: editing.hash });
      editing.undoId = undefined;
      await read('file', editing.path);
      showEditor();
      editor._feedback.textContent = '已撤销，文件恢复成保存前的内容。';
    } catch (error) {
      feedback.textContent = error?.status === 409 ? `没有撤销：${error.message}` : '撤销失败或结果未知，请重新读取文件核对。';
      undo.disabled = false;
    }
  }
  return { el, toggle, openFile, show(id) { projectId = id || ''; sync(); }, update: sync };
}

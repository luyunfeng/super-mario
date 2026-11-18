import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';

function diffLineClass(line) {
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
    return 'diff-line diff-line--meta';
  }
  if (line.startsWith('@@')) return 'diff-line diff-line--hunk';
  if (line.startsWith('+')) return 'diff-line diff-line--add';
  if (line.startsWith('-')) return 'diff-line diff-line--del';
  return 'diff-line';
}

function renderDiffLines(text) {
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
  body.append(crumbs, tree, status, h('div', { class: 'row' }, fileBtn, diffBtn), output);
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
          btn.classList.add('code-tree__item', e.directory ? 'code-tree__item--dir' : 'code-tree__item--file');
          if (!e.directory && selected === e.path) btn.classList.add('is-active');
          return btn;
        });
        replace(tree, parentBtn, entries);
      } else {
        status.textContent = `${path}${value.note ? ' · ' + value.note : ''}`;
        if (kind === 'diff' && value.text) replace(output, renderDiffLines(value.text));
        else output.textContent = value.text || (kind === 'diff' ? '没有已跟踪文件差异。' : '');
      }
    } catch (error) { if (stamp === sequence) status.textContent = `读取失败：${error.message}`; }
  }
  return { el, toggle, show(id) { projectId = id || ''; sync(); }, update: sync };
}

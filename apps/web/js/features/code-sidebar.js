import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';

/** Both conversations browse the saved computer binding through the same read-only API. */
export function createCodeSidebar({ api, store }) {
  let projectId = '', selected = '', sequence = 0, binding = '', opened = false;
  const body = h('div', { class: 'code-sidebar__body' });
  const output = h('pre', { class: 'code-sidebar__text', tabindex: 0 });
  const status = h('p', { class: 'muted small', role: 'status' });
  const tree = h('nav', { 'aria-label': '项目目录' });
  const title = h('p', { class: 'small code-sidebar__binding' });
  const el = h('aside', { class: 'code-sidebar', 'aria-label': '项目代码', hidden: true },
    h('div', { class: 'row row--between' }, h('h2', null, '项目代码'), Button({ label: '关闭代码', size: 'sm', onClick: () => { el.hidden = true; opened = false; } })), title, body);
  body.append(tree, status, h('div', { class: 'row' },
    Button({ label: '文本', size: 'sm', onClick: () => selected && read('file', selected) }),
    Button({ label: 'Git diff', size: 'sm', onClick: () => selected && read('diff', selected) })), output);
  const toggle = Button({ label: '查看代码', size: 'sm', onClick: () => { opened = !opened; el.hidden = !opened; if (opened) void read('tree', ''); } });
  function project() { return store.view.snapshot?.projects?.find(p => p.id === projectId); }
  function sync() {
    const p = project();
    title.textContent = p?.workspace ? `${p.name} · ${p.workspace.machineId}\n${p.workspace.cwd}` : '请先选择并绑定项目文件夹';
    toggle.disabled = !p?.workspace;
    const next = JSON.stringify([projectId, p?.workspace]);
    if (next !== binding) { binding = next; sequence++; selected = ''; replace(tree); output.textContent = ''; status.textContent = ''; if (opened && p?.workspace) void read('tree', ''); }
  }
  async function read(kind, path) {
    if (!project()?.workspace) return;
    if (kind === 'tree') selected = '';
    const stamp = ++sequence;
    status.textContent = '正在读取绑定电脑…'; output.textContent = '';
    try {
      const value = await api.get(`/projects/${encodeURIComponent(projectId)}/code?${new URLSearchParams({ kind, path })}`);
      if (stamp !== sequence) return;
      status.textContent = value.truncated ? '目录条目达到上限，请进入子目录查看。' : value.note || '';
      if (kind === 'tree') {
        const parent = path.split('/').slice(0, -1).join('/');
        replace(tree, path ? Button({ label: '上级目录', size: 'sm', onClick: () => read('tree', parent) }) : null,
          (value.entries ?? []).map(e => Button({ label: `${e.directory ? '▸ ' : ''}${e.name}`, size: 'sm', onClick: () => { if (!e.directory) selected = e.path; void read(e.directory ? 'tree' : 'file', e.path); } })));
      } else { status.textContent = `${path}${value.note ? ' · ' + value.note : ''}`; output.textContent = value.text || (kind === 'diff' ? '没有已跟踪文件差异。' : ''); }
    } catch (error) { if (stamp === sequence) status.textContent = `读取失败：${error.message}`; }
  }
  return { el, toggle, show(id) { projectId = id || ''; sync(); }, update: sync };
}

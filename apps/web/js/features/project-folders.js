// 文件夹发现只读远端电脑。只有用户点击添加或绑定才写入项目。
import { h, replace } from '../lib/dom.js';
import { Button, Banner, Field, Input, Select } from '../ui/kit.js';
import { folderKey, hiddenFolders, setFolderHidden, onFolderVisibilityChange } from './project-folder-visibility.js';
import { openDrawer } from '../ui/overlay.js';

// 保留来源语义，界面不暴露本机工具的产品名。
const sourceLabel = value => ({ codex: '本机会话历史', claude: '本机项目历史', git: '代码仓库' })[value] ?? value;

export function openProjectFolders({ api, store, router, project }) {
  const machines = store.view.snapshot?.machines ?? [];
  const initial = machines.find(m => m.id === project?.workspace?.machineId) ?? machines.find(m => m.online && m.capabilities?.includes('workspace.projects')) ?? machines[0];
  const computer = Select({ options: machines.length ? machines.map(m => [m.id, `${m.name} · ${m.online ? '在线' : '离线'}`]) : [['', '没有已连接的电脑']], value: initial?.id, 'aria-label': '电脑' });
  const root = Input({ placeholder: '绝对目录，例如 /home/me/code', 'aria-label': '扫描根目录' });
  const cwd = Input({ placeholder: '电脑上已存在的绝对目录', value: project?.workspace?.cwd ?? '', 'aria-label': '文件夹' });
  const name = Input({ placeholder: '留空使用文件夹名称', 'aria-label': '项目名称' });
  const results = h('div', { class: 'stack folder-results', 'aria-live': 'polite' });
  const message = h('div', { 'aria-live': 'polite' });
  const filter = Input({ type: 'search', placeholder: '搜索文件夹或路径', 'aria-label': '搜索可绑定文件夹' });
  const showHidden = h('input', { type: 'checkbox' });
  const visibility = h('div', { class: 'row row--wrap' }, filter, h('label', { class: 'check' }, showHidden, '显示已隐藏'));
  function filterResults() {
    const hidden = hiddenFolders(), query = filter.value.trim().toLocaleLowerCase();
    for (const row of results.querySelectorAll('[data-cwd]')) {
      const isHidden = hidden.has(folderKey(computer.value, row.dataset.cwd));
      row.hidden = (!showHidden.checked && isHidden) || !`${row.dataset.name} ${row.dataset.cwd}`.toLocaleLowerCase().includes(query);
      const button = row.querySelector('[data-folder-hide]');
      if (button) { button.textContent = isHidden ? '恢复显示' : '隐藏'; button.setAttribute('aria-label', `${button.textContent} ${row.dataset.name}`); }
    }
  }
  filter.addEventListener('input', filterResults);
  showHidden.addEventListener('change', filterResults);
  const unsubscribe = onFolderVisibilityChange(filterResults);
  const roots = new Map();
  const added = new Set();
  let generation = 0;
  let closed = false;
  let pending = false;
  let uncertain = false;
  const machine = () => machines.find(m => m.id === computer.value);
  const capable = () => Boolean(machine()?.online && machine()?.capabilities?.includes('workspace.projects'));
  const addedKey = (id, path) => `${id}\n${path}`;
  const existing = (id, path) => (store.view.snapshot?.projects ?? []).find(p => p.workspace?.machineId === id && p.workspace.cwd === path);
  const drawer = openDrawer({ title: project ? '绑定文件夹' : '添加项目文件夹', subtitle: '发现电脑上的项目；浏览不会添加项目或启动执行。',
    body: [Field({ label: '电脑', control: computer }), h('div', { class: 'row row--wrap' }, Field({ label: '添加扫描根目录', control: root }), Button({ label: '扫描此目录', onClick: () => scan(true) })), visibility, results,
      h('hr'), h('strong', null, '手动选择已存在的文件夹'), Field({ label: '文件夹', control: cwd }), !project && Field({ label: '项目名称（可选）', control: name }),
      Button({ label: project ? '绑定此文件夹' : '添加此文件夹', kind: 'primary', dataset: { folderWrite: '1' }, onClick: () => save(cwd.value.trim(), name.value.trim()) }), message],
    onClose() { unsubscribe(); closed = true; generation++; },
  });

  async function save(path, label) {
    if (pending || uncertain || closed) return;
    if (!machine()?.online) { replace(message, Banner({ tone: 'warn', children: '电脑离线，无法校验文件夹。' })); return; }
    if (!machine()?.capabilities?.includes('workspace.directory')) { replace(message, Banner({ tone: 'warn', children: '这台电脑暂不支持校验文件夹，请更新电脑上的连接程序。' })); return; }
    if (!path.startsWith('/')) { replace(message, Banner({ tone: 'warn', children: '请输入电脑上的绝对目录。' })); return; }
    const machineId = computer.value;
    const binding = { machineId, cwd: path };
    pending = true;
    try {
      const value = project ? await api.patch(`/projects/${encodeURIComponent(project.id)}`, { workspace: binding })
        : await api.post('/projects', { name: label || path.split('/').filter(Boolean).at(-1) || path, workspace: binding });
      if(value.archivedAt){if(!closed)replace(message,Banner({tone:'warn',children:'这个目录对应的项目已归档，历史数据仍保留。'}));return;}
      added.add(addedKey(machineId, value.workspace?.cwd ?? path));
      // 写入只执行一次；刷新失败不应被误报成添加失败。
      await store.refresh().catch(() => {});
      if (!closed) { drawer.close(); router.go(router.href('projects', value.id, 'workspace')); }
    } catch (error) {
      if (closed) return;
      if (!error.status || error.status >= 500 || /unknown/i.test(error.message)) {
        uncertain = true;
        for (const button of drawer.body.querySelectorAll('[data-folder-write]')) button.disabled = true;
        replace(message, Banner({ tone: 'warn', children: '添加或绑定结果未知，请先核对项目列表。本面板不会重复发送。' }));
      } else replace(message, Banner({ tone: 'danger', children: error.message }));
    } finally { pending = false; }
  }

  async function scan(addRoot = false) {
    const stamp = ++generation;
    const id = computer.value;
    if (!uncertain) replace(message);
    if (!machine()?.online) { replace(results, Banner({ tone: 'warn', children: machine() ? '这台电脑离线，无法扫描或验证目录。' : '请先连接一台电脑。' })); return; }
    if (!capable()) { replace(results, Banner({ tone: 'warn', children: '这台电脑暂不支持文件夹发现，请更新电脑上的连接程序。' })); return; }
    if (addRoot) {
      const path = root.value.trim();
      if (!path.startsWith('/')) { replace(message, Banner({ tone: 'warn', children: '扫描根目录必须是绝对目录。' })); return; }
      roots.set(id, [...new Set([...(roots.get(id) ?? []), path])]);
    }
    const query = new URLSearchParams();
    for (const path of roots.get(id) ?? []) query.append('root', path);
    replace(results, h('p', { class: 'muted' }, '正在读取项目历史和所选目录…'));
    try {
      const value = await api.get(`/machines/${encodeURIComponent(id)}/projects${query.size ? `?${query}` : ''}`);
      if (closed || stamp !== generation) return;
      if (!roots.has(id)) roots.set(id, value.roots ?? []);
      replace(results,
        h('p', { class: 'small muted folder-path' }, value.roots?.length ? `扫描目录：${value.roots.join('、')}` : '来源：本机 AI 项目历史（未遍历代码目录）'),
        ...(value.warnings ?? []).map(text => Banner({ tone: 'warn', children: text })),
        value.truncated && Banner({ tone: 'warn', children: '结果已截断，可添加更具体的扫描根目录。' }),
        !(value.projects ?? []).length && h('p', { class: 'muted' }, '没有发现项目，可以手动填写已存在的文件夹。'),
        ...(value.projects ?? []).map(item => {
          const existingProject = existing(id, item.cwd);
          const isAdded = existingProject || added.has(addedKey(id, item.cwd));
          return h('div', { class: 'folder-result', dataset: { cwd: item.cwd, name: item.name } },
            h('div', { class: 'stack' }, h('strong', null, item.name), h('code', { class: 'folder-path' }, item.cwd), h('span', { class: 'small muted' }, `来源：${item.sources?.map(sourceLabel).join('、') || '目录扫描'}`)),
            !item.exists ? h('span', { class: 'text-danger' }, '目录不存在') : existingProject?.archivedAt ? h('span', { class: 'muted' }, '已归档') : isAdded && !project ? h('span', { class: 'muted' }, '已添加')
              : Button({ label: project ? '绑定' : '添加', size: 'sm', disabled: uncertain, dataset: { folderWrite: '1' }, onClick: () => save(item.cwd, item.name) }),
            Button({ label: '隐藏', ariaLabel: `隐藏 ${item.name}`, kind: 'ghost', size: 'sm', dataset: { folderHide: '1' },
              onClick: () => setFolderHidden(id, item.cwd, !hiddenFolders().has(folderKey(id, item.cwd))) }));
        }));
      filterResults();
    } catch (error) { if (!closed && stamp === generation) replace(results, Banner({ tone: 'danger', children: `无法发现项目：${error.message}` })); }
  }
  computer.addEventListener('change', () => { root.value = ''; void scan(); });
  void scan();
  return drawer;
}

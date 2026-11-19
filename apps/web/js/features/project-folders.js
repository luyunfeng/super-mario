// 目录发现只读。新建文件夹写入执行机，添加或绑定才写入工作台项目。
import { h, replace } from '../lib/dom.js';
import { Button, Banner, Field, Fold, Input, Select } from '../ui/kit.js';
import { folderTree, folderKey, hiddenFolders, setFolderHidden, onFolderVisibilityChange } from './project-folder-visibility.js';
import { openDrawer } from '../ui/overlay.js';

// 保留来源语义，界面不暴露本机工具的产品名。
const sourceLabel = value => ({ codex: '本机会话历史', claude: '本机项目历史', git: '代码仓库' })[value] ?? value;

export function openProjectFolders({ api, store, router, project }) {
  const machines = store.view.snapshot?.machines ?? [];
  const initial = machines.find(m => m.id === project?.workspace?.machineId) ?? machines.find(m => m.online && m.capabilities?.includes('workspace.projects')) ?? machines[0];
  const computer = Select({ options: machines.length ? machines.map(m => [m.id, `${m.name} · ${m.online ? '在线' : '离线'}`]) : [['', '没有已连接的电脑']], value: initial?.id, 'aria-label': '电脑' });
  const root = Input({ placeholder: '绝对目录，例如 /home/me/code', 'aria-label': '筛选目录' });
  const cwd = Input({ placeholder: '电脑上已存在的绝对目录', value: project?.workspace?.cwd ?? '', 'aria-label': '文件夹' });
  const name = Input({ placeholder: '留空使用文件夹名称', 'aria-label': '项目名称' });
  const results = h('div', { class: 'stack folder-results', 'aria-live': 'polite' });
  const message = h('div', { 'aria-live': 'polite' });
  const filter = Input({ type: 'search', placeholder: '搜索文件夹或路径', 'aria-label': '搜索可绑定文件夹' });
  const showHidden = h('input', { type: 'checkbox' });
  const visibility = h('div', { class: 'row row--wrap' }, filter, h('label', { class: 'check' }, showHidden, '显示已隐藏'));
  const expansion = new Map();
  let redraw;
  function filterResults() { redraw?.(); }
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
  const parent = Input({ placeholder: '留空使用主目录，可填 code-work 或绝对路径' });
  const folderName = Input({ placeholder: '例如 官网改版' });
  const createMessage = h('div', { 'aria-live': 'polite' });
  const createButton = Button({ label: '创建文件夹', onClick: createFolder });
  const createPanel = Fold({ title: '新建文件夹', body: [
    Field({ label: '新文件夹名称', control: folderName }), Field({ label: '位置（可选）', control: parent, hint: '默认位置 ~，即所选电脑的用户主目录。' }),
    createButton, createMessage,
  ] });
  let selection = 0, creating = false, filledPath = '';
  const unknownCreates = new Set();
  const createKey = () => JSON.stringify([computer.value, parent.value.trim(), folderName.value.trim()]);
  function updateCreate() {
    const current = store.view.snapshot?.machines?.find(m => m.id === computer.value);
    const supported = current?.online && current.capabilities?.includes('workspace.directory.create');
    const unknown = unknownCreates.has(createKey());
    createButton.disabled = creating || !supported || unknown;
    parent.disabled = folderName.disabled = creating || !supported;
    if (!supported) replace(createMessage, Banner({ tone: 'warn', children: current?.online
      ? '这台电脑暂不支持新建文件夹，请更新电脑代理。' : '请选择在线电脑。' }));
    else if (unknown) replace(createMessage, Banner({ tone: 'warn', children: '创建结果未知，请在电脑上核对该目录。' }));
  }
  for (const input of [parent, folderName]) input.addEventListener('input', () => { replace(createMessage); updateCreate(); });
  cwd.addEventListener('input', () => { filledPath = ''; });
  async function createFolder() {
    updateCreate();
    if (closed || createButton.disabled) return;
    const base = parent.value.trim(), child = folderName.value.trim();
    if (base.split('/').includes('..') || /\p{Cc}/u.test(base) || !child || child === '.' || child === '..' || /[/\\\p{Cc}]/u.test(child)) {
      replace(createMessage, Banner({ tone: 'warn', children: '请填写单个文件夹名称，位置中不能含有 .. 路径段。' }));
      return;
    }
    const stamp = selection, key = createKey();
    const isCurrent = () => !closed && selection === stamp;
    creating = true;
    updateCreate();
    replace(createMessage);
    try {
      const value = await api.post(`/machines/${encodeURIComponent(computer.value)}/directories`, { ...(base ? { parent: base } : {}), name: child });
      if (value?.exists !== true || typeof value.cwd !== 'string' || !value.cwd.startsWith('/')) throw new Error('缺少完整路径');
      if (!isCurrent()) return;
      cwd.value = filledPath = value.cwd;
      folderName.value = '';
      replace(createMessage, Banner({ children: '文件夹已创建，完整路径已填入下方。' }));
    } catch (error) {
      if (!error.status || error.status >= 500) unknownCreates.add(key);
      else if (isCurrent()) {
        const reason = /EEXIST|已存在|重名/.test(error.message) ? '该名称已存在，请更换文件夹名称。' : error.message;
        replace(createMessage, Banner({ tone: 'danger', children: reason }));
      }
    } finally {
      creating = false;
      if (!closed) updateCreate();
    }
  }
  updateCreate();
  const drawer = openDrawer({ title: project ? '绑定文件夹' : '添加项目文件夹', subtitle: '按目录筛选已有会话中的项目文件夹，不遍历目录。',
    body: [Field({ label: '电脑', control: computer }), h('div', { class: 'folder-filter-row' }, Field({ label: '筛选目录', control: root }), Button({ label: '加入目录筛选', onClick: () => scan(true) })), visibility, Button({ label: '刷新目录', size: 'sm', onClick: () => scan() }), results,
      h('hr'), h('strong', null, '手动选择文件夹'), createPanel, Field({ label: '文件夹', control: cwd }), !project && Field({ label: '项目名称（可选）', control: name }),
      Button({ label: project ? '绑定此文件夹' : '添加此文件夹', kind: 'primary', dataset: { folderWrite: '1' }, onClick: () => save(cwd.value.trim(), name.value.trim()) }), message],
    onClose() { unsubscribe(); closed = true; generation++; },
  });

  async function save(path, label, archived) {
    if (pending || uncertain || closed) return;
    if (!machine()?.online) { replace(message, Banner({ tone: 'warn', children: '电脑离线，无法校验文件夹。' })); return; }
    if (!machine()?.capabilities?.includes('workspace.directory')) { replace(message, Banner({ tone: 'warn', children: '这台电脑暂不支持校验文件夹，请更新电脑上的连接程序。' })); return; }
    if (!path.startsWith('/')) { replace(message, Banner({ tone: 'warn', children: '请输入电脑上的绝对目录。' })); return; }
    const machineId = computer.value;
    const binding = { machineId, cwd: path };
    pending = true;
    try {
      const value = archived ? await api.post(`/projects/${encodeURIComponent(archived.id)}/restore`, {})
        : project ? await api.patch(`/projects/${encodeURIComponent(project.id)}`, { workspace: binding })
        : await api.post('/projects', { name: label || path.split('/').filter(Boolean).at(-1) || path, workspace: binding });
      if (value.archivedAt) {
        if (!closed && computer.value === machineId) replace(message, Banner({ tone: 'warn', children: `「${value.name}」已归档，恢复后可继续使用原项目。`,
          action: Button({ label: '恢复项目', dataset: { folderWrite: '1' }, onClick: () => save(path, label, value) }) }));
        return;
      }
      added.add(addedKey(machineId, value.workspace?.cwd ?? path));
      // 写入只执行一次；刷新失败不应被误报成添加失败。
      await store.refresh().catch(() => {});
      if (!closed) { drawer.close(); router.go(router.href('projects', value.id, 'workspace')); }
    } catch (error) {
      if (closed) return;
      if (!error.status || error.status >= 500 || /unknown/i.test(error.message)) {
        uncertain = true;
        for (const button of drawer.body.querySelectorAll('[data-folder-write]')) button.disabled = true;
        replace(message, Banner({ tone: 'warn', children: archived ? '恢复结果未知，请先核对项目列表。本面板不会重复发送。' : '添加或绑定结果未知，请先核对项目列表。本面板不会重复发送。' }));
      } else replace(message, Banner({ tone: 'danger', children: error.message }));
    } finally { pending = false; }
  }

  async function scan(addRoot = false) {
    const stamp = ++generation;
    const id = computer.value;
    if (!uncertain) replace(message);
    if (!machine()?.online) { replace(results, Banner({ tone: 'warn', children: machine() ? '这台电脑离线，无法读取会话历史或验证目录。' : '请先连接一台电脑。' })); return; }
    if (!capable()) { replace(results, Banner({ tone: 'warn', children: '这台电脑暂不支持文件夹发现，请更新电脑上的连接程序。' })); return; }
    if (addRoot) {
      const path = root.value.trim();
      if (!path.startsWith('/')) { replace(message, Banner({ tone: 'warn', children: '筛选目录必须是绝对目录。' })); return; }
      roots.set(id, [...new Set([...(roots.get(id) ?? []), path])]);
    }
    redraw = undefined;
    const query = new URLSearchParams();
    for (const path of roots.get(id) ?? []) query.append('root', path);
    replace(results, h('p', { class: 'muted' }, '正在读取会话历史…'));
    try {
      const value = await api.get(`/machines/${encodeURIComponent(id)}/projects${query.size ? `?${query}` : ''}`);
      if (closed || stamp !== generation) return;
      if (!roots.has(id)) roots.set(id, value.roots ?? []);
      const tree = h('div');
      replace(results,
        h('p', { class: 'small muted folder-path' }, value.roots?.length ? `筛选目录：${value.roots.join('、')}` : '来源：本机会话历史'),
        ...(value.warnings ?? []).map(text => Banner({ tone: 'warn', children: text })),
        value.truncated && Banner({ tone: 'warn', children: '结果已截断。找不到目标文件夹时，可在下方输入绝对路径，手动绑定。' }),
        !(value.projects ?? []).length && h('p', { class: 'muted' }, '没有发现项目，可以手动填写已存在的文件夹。'),
        tree);
      redraw = () => {
        const hidden = hiddenFolders(), query = filter.value.trim().toLocaleLowerCase();
        const items = (value.projects ?? []).filter(item => (showHidden.checked || !hidden.has(folderKey(id, item.cwd)))
          && `${item.name} ${item.cwd}`.toLocaleLowerCase().includes(query));
        replace(tree, folderTree({ machineId: id, homeDir: value.homeDir, items, expansion, searching: Boolean(query), renderCandidate: item => renderCandidate(item, hidden) }));
        if (!items.length && value.projects?.length) tree.append(h('p', { class: 'muted' }, '没有符合条件的文件夹。'));
      };
      function renderCandidate(item, hidden) {
        const isHidden = hidden.has(folderKey(id, item.cwd));
        const hideLabel = isHidden ? '恢复显示' : '隐藏';
        const existingProject = existing(id, item.cwd);
        const isAdded = existingProject || added.has(addedKey(id, item.cwd));
        return h('div', { class: 'folder-result', dataset: { cwd: item.cwd, name: item.name } },
          h('div', { class: 'stack' }, h('strong', null, item.name), h('code', { class: 'folder-path' }, item.cwd), h('span', { class: 'small muted' }, `来源：${item.sources?.map(sourceLabel).join('、') || '来源未知'}`)),
          !item.exists ? h('span', { class: 'text-danger' }, '目录不存在') : existingProject?.archivedAt ? (project ? h('span', { class: 'muted' }, '已归档')
              : Button({ label: '恢复项目', size: 'sm', disabled: uncertain, dataset: { folderWrite: '1' }, onClick: () => save(item.cwd, item.name, existingProject) })) : isAdded && !project ? h('span', { class: 'muted' }, '已添加')
            : Button({ label: project ? '绑定' : '添加', size: 'sm', disabled: uncertain, dataset: { folderWrite: '1' }, onClick: () => save(item.cwd, item.name) }),
          Button({ label: hideLabel, ariaLabel: `${hideLabel} ${item.name}`, kind: 'ghost', size: 'sm', dataset: { folderHide: '1' },
            onClick: () => setFolderHidden(id, item.cwd, !hiddenFolders().has(folderKey(id, item.cwd))) }));
      }
      filterResults();
    } catch (error) { if (!closed && stamp === generation) replace(results, Banner({ tone: 'danger', children: `无法发现项目：${error.message}` })); }
  }
  computer.addEventListener('change', () => {
    selection++;
    if (filledPath) cwd.value = filledPath = '';
    parent.value = folderName.value = root.value = '';
    replace(createMessage);
    updateCreate();
    redraw = undefined;
    void scan();
  });
  void scan();
  return drawer;
}

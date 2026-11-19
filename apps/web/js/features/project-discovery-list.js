// 进入项目页自动发现目录。候选项是只读清单，不是已导入的项目。
import { h, replace } from '../lib/dom.js';
import { folderTree, folderKey, hiddenFolders, setFolderHidden, onFolderVisibilityChange } from './project-folder-visibility.js';
import { Button, Banner, Input } from '../ui/kit.js';

export function createProjectDiscoveryList({ api, store, router, openFolders }) {
  const rows = h('div', { class: 'project-discovered__rows', 'aria-live': 'polite' });
  const message = h('div');
  const count = h('span', { class: 'small muted', 'aria-live': 'polite' });
  const search = Input({ type: 'search', placeholder: '搜索文件夹、路径或电脑', 'aria-label': '搜索发现的文件夹' });
  let showHidden = false;
  const toggle = Button({ label: '显示已隐藏', size: 'sm', onClick: () => { showHidden = !showHidden; paint(); } });
  const el = h('section', { class: 'project-discovered stack' },
    h('div', { class: 'row row--between row--wrap' }, h('div', null,
      h('h2', null, '电脑上的项目文件夹'),
      h('p', { class: 'muted small' }, '文件夹来自电脑上的会话历史。隐藏仅影响当前浏览器。')),
      Button({ label: '更多文件夹 / 手动绑定', size: 'sm', onClick: openFolders })),
    h('div', { class: 'project-discovered__tools' }, search, count, toggle, Button({ label: '刷新目录', size: 'sm', onClick: () => scan(true) })), message, rows);
  let items = [], key = '', read = 0, loading = false, scannedAt = 0;
  const expansion = new Map(), foundArchived = new Map();
  const pending = new Set(), uncertain = new Set();
  const bindingKey = folderKey;
  const computers = () => (store.view.snapshot?.machines ?? []).filter(machine => machine.online && machine.capabilities?.includes('workspace.projects'));
  const registered = () => new Set((store.view.snapshot?.projects ?? []).filter(project => project.workspace).map(project => bindingKey(project.workspace.machineId, project.workspace.cwd)));
  function paint() {
    const bound = registered(), hidden = hiddenFolders();
    // Archived bindings still own their directory. Only an explicit restore may surface the project.
    const candidates = items.filter(item => item.exists && !bound.has(bindingKey(item.machineId, item.cwd)));
    const hiddenCount = candidates.filter(item => hidden.has(bindingKey(item.machineId, item.cwd))).length;
    const query = search.value.trim().toLocaleLowerCase();
    const visible = candidates.filter(item => (showHidden || !hidden.has(bindingKey(item.machineId, item.cwd))) &&
      (!query || [item.name, item.cwd, item.machineName].some(value => value.toLocaleLowerCase().includes(query))));
    count.textContent = `已发现 ${candidates.length} 个 · 已隐藏 ${hiddenCount} 个 · 当前显示 ${visible.length} 个`;
    toggle.textContent = showHidden ? '收起已隐藏' : `显示已隐藏（${hiddenCount}）`;
    toggle.setAttribute('aria-pressed', String(showHidden));
    function renderCandidate(item) {
      const id = bindingKey(item.machineId, item.cwd), isHidden = hidden.has(id);
      const archived = foundArchived.get(id);
      const label = archived ? '恢复项目' : '添加';
      const button = Button({ label, ariaLabel: label + ' ' + (archived?.name ?? item.name), size: 'sm', onClick: () => add(item, archived) });
      button.disabled = pending.has(id) || uncertain.has(id);
      return h('div', { class: `project-discovered__item${isHidden ? ' is-hidden-folder' : ''}`, dataset: { folderKey: id } },
        h('div', { class: 'project-discovered__info' }, h('strong', null, item.name), h('code', { class: 'folder-path' }, item.cwd)), button,
        Button({ label: isHidden ? '恢复显示' : '隐藏', ariaLabel: `${isHidden ? '恢复显示' : '隐藏'} ${item.name}`, size: 'sm', kind: 'ghost',
          onClick: () => setFolderHidden(item.machineId, item.cwd, !isHidden) }));
    }
    replace(rows, computers().map(machine => {
      const matches = visible.filter(item => item.machineId === machine.id);
      if (!matches.length) return null;
      return h('section', { 'aria-label': machine.name }, h('h3', null, machine.name),
        folderTree({ machineId: machine.id, homeDir: matches[0].homeDir, items: matches, expansion, searching: Boolean(query), renderCandidate }));
    }));
    if (!visible.length) rows.append(h('p', { class: 'muted small' }, loading ? '正在读取在线电脑的会话历史…' : candidates.length ? '没有符合条件的文件夹，可清空搜索或显示已隐藏。' : computers().length ? '这次没有发现可添加的项目，可手动选择目录。' : (store.view.snapshot?.machines ?? []).some(machine=>machine.online) ? '当前电脑需升级连接程序才能自动发现目录。' : '连接电脑后会自动发现项目文件夹。'));
  }
  search.addEventListener('input', paint);
  onFolderVisibilityChange(paint);
  async function scan(force = false) {
    if (router.current.page !== 'projects') return;
    const machines = computers();
    const nextKey = JSON.stringify(machines.map(machine => [machine.id, machine.connectedAt]));
    if (force !== true && key === nextKey && Date.now() - scannedAt < 30000) { paint(); return; }
    key = nextKey; scannedAt = Date.now(); const stamp = ++read, credential = api.token?.(); loading = true; paint();
    const results = await Promise.allSettled(machines.map(async machine => {
      const value = await api.get(`/machines/${encodeURIComponent(machine.id)}/projects`);
      return { items: value.projects.map(project => ({ ...project, machineId: machine.id, machineName: machine.name, homeDir: value.homeDir })), incomplete: value.truncated, warnings: value.warnings ?? [], name: machine.name };
    }));
    if (stamp !== read || credential !== api.token?.()) return;
    loading = false; items = results.flatMap(result => result.status === 'fulfilled' ? result.value.items : []);
    const failed = results.filter(result => result.status === 'rejected').length;
    replace(message, failed ? Banner({ tone: 'warn', children: `${failed} 台电脑的会话历史未能读取，可点击“刷新目录”重试。` }) : null,
      results.filter(result => result.status === 'fulfilled' && (result.value.incomplete || result.value.warnings.length)).map(result => Banner({ tone: 'warn', children: `${result.value.name}：${result.value.incomplete ? '结果已截断。找不到目标文件夹时，可在“更多文件夹 / 手动绑定”中输入绝对路径。' : ''}${result.value.warnings.join('；')}` })));
    paint();
  }
  async function add(item, archived) {
    const id = bindingKey(item.machineId, item.cwd); if (pending.has(id) || uncertain.has(id)) return;
    const route = router.current.canonical, credential = api.token?.(); pending.add(id); paint();
    try {
      const project = archived ? await api.post(`/projects/${encodeURIComponent(archived.id)}/restore`, {}) : await api.post('/projects', { name: item.name, workspace: { machineId: item.machineId, cwd: item.cwd } });
      if (credential !== api.token?.()) return;
      if (project.archivedAt) {
        foundArchived.set(id, project);
        replace(message, Banner({ tone: 'warn', children: `「${project.name}」已归档。可点击该目录的“恢复项目”打开原项目。` }));
        return;
      }
      foundArchived.delete(id);
      await store.refresh();
      if (router.current.canonical === route) router.go(router.href('projects', project.id, 'workspace'));
    } catch (error) {
      if (credential !== api.token?.()) return;
      const unknown = !error.status || error.status >= 500; if (unknown) uncertain.add(id);
      replace(message, Banner({ tone: 'warn', children: unknown ? '操作结果尚未确认，请先核对项目列表，不会自动重复提交。' : error.message }));
    } finally { pending.delete(id); paint(); }
  }
  window.addEventListener('focus', () => { if (router.current.page === 'projects') void scan(); });
  return { el, show: scan, update() { if (router.current.page === 'projects') void scan(); } };
}

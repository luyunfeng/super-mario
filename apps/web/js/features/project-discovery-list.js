// 进入项目页自动发现目录。候选项是只读清单，不是已导入的项目。
import { h, replace } from '../lib/dom.js';
import { folderKey, hiddenFolders, setFolderHidden, onFolderVisibilityChange } from './project-folder-visibility.js';
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
      h('p', { class: 'muted small' }, '根据本机 AI 项目历史发现，由你选择添加或隐藏。隐藏仅影响当前浏览器。')),
      Button({ label: '更多文件夹 / 手动绑定', size: 'sm', onClick: openFolders })),
    h('div', { class: 'project-discovered__tools' }, search, count, toggle), message, rows);
  let items = [], key = '', read = 0, loading = false, scannedAt = 0;
  const pending = new Set(), uncertain = new Set();
  const bindingKey = folderKey;
  const computers = () => (store.view.snapshot?.machines ?? []).filter(machine => machine.online && machine.capabilities?.includes('workspace.projects'));
  const registered = () => new Set((store.view.snapshot?.projects ?? []).filter(project => project.workspace).map(project => bindingKey(project.workspace.machineId, project.workspace.cwd)));
  function paint() {
    const bound = registered(), hidden = hiddenFolders();
    const priority = item => (item.preferredRoot ? 5 : 0) + (item.sources?.includes('git') ? 2 : 0) - (/^\/(?:tmp|var\/tmp)(?:\/|$)/.test(item.cwd) ? 20 : 0);
    const candidates = items.filter(item => item.exists && !bound.has(bindingKey(item.machineId, item.cwd))).sort((a,b)=>priority(b)-priority(a));
    const hiddenCount = candidates.filter(item => hidden.has(bindingKey(item.machineId, item.cwd))).length;
    const query = search.value.trim().toLocaleLowerCase();
    const visible = candidates.filter(item => (showHidden || !hidden.has(bindingKey(item.machineId, item.cwd))) &&
      (!query || [item.name, item.cwd, item.machineName].some(value => value.toLocaleLowerCase().includes(query))));
    count.textContent = `已发现 ${candidates.length} 个 · 已隐藏 ${hiddenCount} 个 · 当前显示 ${visible.length} 个`;
    toggle.textContent = showHidden ? '收起已隐藏' : `显示已隐藏（${hiddenCount}）`;
    toggle.setAttribute('aria-pressed', String(showHidden));
    replace(rows, visible.map(item => {
      const id = bindingKey(item.machineId, item.cwd), isHidden = hidden.has(id);
      const button = Button({ label: item.name, kind: 'ghost', size: 'sm', onClick: () => add(item) });
      button.disabled = pending.has(id) || uncertain.has(id);
      return h('div', { class: `project-discovered__item${isHidden ? ' is-hidden-folder' : ''}`, dataset: { folderKey: id } },
        h('div', { class: 'project-discovered__info' }, button,
          h('span', { class: 'muted small' }, item.machineName), h('code', { class: 'folder-path' }, item.cwd)),
        Button({ label: isHidden ? '恢复显示' : '隐藏', ariaLabel: `${isHidden ? '恢复显示' : '隐藏'} ${item.name}`, size: 'sm', kind: 'ghost',
          onClick: () => setFolderHidden(item.machineId, item.cwd, !isHidden) }));
    }));
    if (!visible.length) rows.append(h('p', { class: 'muted small' }, loading ? '正在扫描在线电脑…' : candidates.length ? '没有符合条件的文件夹，可清空搜索或显示已隐藏。' : computers().length ? '这次没有发现可添加的项目，可手动选择目录。' : (store.view.snapshot?.machines ?? []).some(machine=>machine.online) ? '当前电脑需升级连接程序才能自动发现目录。' : '连接电脑后会自动发现项目文件夹。'));
  }
  search.addEventListener('input', paint);
  onFolderVisibilityChange(paint);
  async function scan() {
    if (router.current.page !== 'projects') return;
    const machines = computers();
    const nextKey = JSON.stringify(machines.map(machine => [machine.id, machine.connectedAt]));
    if (key === nextKey && Date.now() - scannedAt < 30000) { paint(); return; }
    key = nextKey; scannedAt = Date.now(); const stamp = ++read, credential = api.token?.(); loading = true; paint();
    const results = await Promise.allSettled(machines.map(async machine => {
      const value = await api.get(`/machines/${encodeURIComponent(machine.id)}/projects`);
      return { items: value.projects.map(project => ({ ...project, machineId: machine.id, machineName: machine.name, preferredRoot: (value.roots ?? []).includes(project.cwd) })), incomplete: value.truncated, warnings: value.warnings ?? [], name: machine.name };
    }));
    if (stamp !== read || credential !== api.token?.()) return;
    loading = false; items = results.flatMap(result => result.status === 'fulfilled' ? result.value.items : []);
    const failed = results.filter(result => result.status === 'rejected').length;
    replace(message, failed ? Banner({ tone: 'warn', children: `${failed} 台电脑的目录未能读取，可以在“更多文件夹”中重新扫描。` }) : null,
      results.filter(result => result.status === 'fulfilled' && (result.value.incomplete || result.value.warnings.length)).map(result => Banner({ tone: 'warn', children: `${result.value.name}：${result.value.incomplete ? '部分项目历史或目录未完整读取，可在“更多文件夹”查看详情或指定目录。' : ''}${result.value.warnings.join('；')}` })));
    paint();
  }
  async function add(item) {
    const id = bindingKey(item.machineId, item.cwd); if (pending.has(id) || uncertain.has(id)) return;
    const route = router.current.canonical, credential = api.token?.(); pending.add(id); paint();
    try {
      const project = await api.post('/projects', { name: item.name, workspace: { machineId: item.machineId, cwd: item.cwd } });
      if (credential !== api.token?.()) return;
      if(project.archivedAt){replace(message,Banner({tone:'warn',children:'这个目录对应的项目已归档，历史数据仍保留。'}));return;}
      await store.refresh();
      if (router.current.canonical === route) router.go(router.href('projects', project.id, 'workspace'));
    } catch (error) {
      if (credential !== api.token?.()) return;
      const unknown = !error.status || error.status >= 500; if (unknown) uncertain.add(id);
      replace(message, Banner({ tone: 'warn', children: unknown ? '添加结果尚未确认，请先核对项目列表，不会自动重复提交。' : error.message }));
    } finally { pending.delete(id); paint(); }
  }
  window.addEventListener('focus', () => { if (router.current.page === 'projects') void scan(); });
  return { el, show: scan, update() { if (router.current.page === 'projects') void scan(); } };
}

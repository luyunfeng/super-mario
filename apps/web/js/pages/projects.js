// 项目：让 Agent 持续跟进。左侧项目列表（首项“全部”），右侧是所选项目的待办 / 执行 / 资料 / 跟进。
// 地址：#projects/<项目或 all>/<标签>/<执行编号>
import { h, replace, keyedList } from '../lib/dom.js';
import { Button, Tabs, Empty } from '../ui/kit.js';
import { Hint } from '../ui/hint.js';
import { createProjectDiscoveryList } from '../features/project-discovery-list.js';
import { openProjectFolders } from '../features/project-folders.js';
import { createProjectConversation } from '../features/project-conversation.js';
import { createTodosTab } from '../features/todos-tab.js';
import { createRunsTab } from '../features/runs.js';
import { createProjectSettings } from '../features/project-settings.js';
import { knowledgeRow, openKnowledgeDrawer } from '../features/knowledge.js';

const TABS = ['workspace', 'todos', 'runs', 'memory', 'settings'];

export function createProjectsPage({ api, store, router, scope, consoleDrawer, markRunSeen }) {
  let projectId = 'all';
  let tab = 'todos';
  let runId = '';
  let lastProjects = '';

  const todos = createTodosTab({ api, store, router });
  const runs = createRunsTab({ api, store, router, consoleDrawer, markRunSeen });
  const folders = (project) => openProjectFolders({ api, store, router, project });
  const discovered = createProjectDiscoveryList({ api, store, router, openFolders: () => folders() });
  const settings = createProjectSettings({ api, store, router, bindFolder: folders });
  const conversation = createProjectConversation({ api, store, bindFolder: folders });
  const memoryList = h('div', { class: 'list' });
  const memory = h('div', { class: 'stack stack--lg', id: 'panel-memory', role: 'tabpanel' },
    h('div', { class: 'row row--between' }, h('span', { class: 'muted' }, '只对这个项目生效的背景和资料。'),
      Button({ label: '添加资料', icon: 'plus', kind: 'primary', size: 'sm', onClick: () => openKnowledgeDrawer({ api, store, defaults: { layer: 'project', projectId } }) })),
    memoryList);
  const panels = { workspace: conversation.el, todos: todos.el, runs: runs.el, memory, settings: settings.el };
  const panelHost = h('div', { class: 'proj__panel' });

  // —— 列表 ——
  const projectList = h('nav', { class: 'proj__list', 'aria-label': '项目列表' });
  const newButton = Button({ label: '从电脑添加 / 发现项目', icon: 'plus', size: 'sm', onClick: () => folders() });

  function itemFor(id, name, snapshot) {
    const open = todos.count(snapshot, id);
    const { problem } = runs.count(snapshot, id);
    return h('a', { class: 'proj__item', href: router.href('projects', id, id === 'all' ? (['workspace', 'settings', 'memory'].includes(tab) ? 'todos' : tab) : 'workspace'), 'aria-current': id === projectId ? 'page' : undefined, dataset: { project: id } },
      h('span', { class: 'proj__name truncate' }, name),
      problem > 0 && h('span', { class: 'alert alert--dot alert--inline', 'aria-label': '有失败的执行' }),
      open > 0 && h('span', { class: 'proj__count' }, open));
  }

  function paintList(snapshot) {
    const items = [{ id: 'all', name: '全部' }, ...(snapshot.projects ?? []).filter(item => !item.archivedAt)];
    const signature = JSON.stringify([projectId, tab, items.map(item => [item.id, item.name]), snapshot.todos.map(todo => [todo.id, todo.projectId, !!todo.completedAt]), snapshot.runs.map(run => [run.id, run.status, run.projectId])]);
    if (signature === lastProjects) return;
    lastProjects = signature;
    replace(projectList, items.map(item => itemFor(item.id, item.name, snapshot)));
  }

  // —— 详情 ——
  const HINT_KEYS = { todos: 'project.todos', runs: 'project.runs', memory: 'project.memory', settings: 'project.followup' };
  const detailHint = h('div', { class: 'row' });
  const title = h('h2', { class: 'proj__title' });
  const sub = h('p', { class: 'muted' });
  const binding = h('div', { class: 'project-binding' });
  const tabs = Tabs({ items: [], active: tab, label: '项目分区', onSelect: (id) => router.go(router.href('projects', projectId, id)) });
  const detail = h('div', { class: 'proj__detail stack stack--lg' },
    h('div', { class: 'row row--between' }, h('div', null, title, sub), detailHint),
    binding, tabs.el, panelHost);

  const empty = h('div', { hidden: true }, Empty({ title: '还没有项目', text: '从电脑发现项目文件夹，添加后持续推进工作。' }));
  const layout = h('div', { class: 'proj' }, h('aside', { class: 'proj__side' }, h('div', { class: 'row row--between proj__side-head' }, h('strong', null, '项目'), newButton), projectList), detail);

  const el = h('section', { class: 'page', id: 'projects' },
    h('div', { class: 'page__inner page__inner--wide' },
      h('header', { class: 'page__head' },
        h('div', { class: 'page__title' }, h('h1', null, '项目'), h('p', { class: 'page__sub' }, '选择电脑上的文件夹，持续推进项目')),
        h('div', { class: 'page__actions' }, Hint('nav.projects'))),
      layout, empty, discovered.el));

  function paintMemory(snapshot) {
    const rows = (snapshot.knowledge ?? []).filter(item => item.layer === 'project' && item.projectId === projectId);
    if (!rows.length) { replace(memoryList, Empty({ title: '这个项目还没有资料', text: '写下项目背景、约定或链接，Agent 工作时会参考。' })); memoryList._keyed = undefined; return; }
    if (!memoryList._keyed) memoryList.replaceChildren();
    keyedList(memoryList, rows, item => item.id, item => knowledgeRow(item, { onOpen: entry => openKnowledgeDrawer({ api, store, entry }) }), item => `${item.id}:${item.updatedAt}`);
  }

  function paintDetail(snapshot) {
    const isAll = projectId === 'all';
    const project = (snapshot.projects ?? []).find(item => item.id === projectId);
    title.textContent = isAll ? '全部项目' : project?.name ?? '项目不存在';
    sub.textContent = isAll ? '所有项目与未归类的待办和执行' : project?.description || '直接在工作区输入目标，持续推进这个项目。';
    const open = todos.count(snapshot, projectId);
    const { active, problem } = runs.count(snapshot, projectId);
    const machine = snapshot.machines?.find(m => m.id === project?.workspace?.machineId);
    binding.hidden = isAll;
    replace(binding, project?.workspace
      ? [
          h('span', { class: 'project-binding__machine' },
            h('span', { class: `dot dot--${machine?.online ? 'ok' : 'danger'}`, 'aria-hidden': 'true' }),
            h('strong', null, `电脑：${machine?.name ?? project.workspace.machineId} · ${machine?.online ? '在线' : '离线'}`)),
          h('code', { class: 'folder-path' }, `文件夹：${project.workspace.cwd}`),
          h('span', { class: 'small muted' }, '文件夹将在操作前检查是否存在。'),
          h('span', { class: 'grow' }),
          Button({ label: '更换绑定文件夹', size: 'sm', onClick: () => folders(project) }),
        ]
      : [
          h('span', { class: 'dot dot--warn', 'aria-hidden': 'true' }),
          h('span', null, '尚未绑定文件夹，已有项目数据保留。'),
          h('span', { class: 'grow' }),
          Button({ label: '绑定文件夹', size: 'sm', onClick: () => folders(project) }),
        ]);
    const items = [
      ...(isAll ? [] : [{ id: 'workspace', label: '工作区' }]),
      { id: 'todos', label: '待办', count: open || null },
      { id: 'runs', label: '执行', count: problem || active || null, alert: problem > 0 },
      ...(isAll ? [] : [{ id: 'memory', label: '资料', count: (snapshot.knowledge ?? []).filter(k => k.layer === 'project' && k.projectId === projectId).length || null }, { id: 'settings', label: '跟进' }]),
    ];
    tabs.update(items, tab);
    if (detailHint.dataset.key !== tab) { detailHint.dataset.key = tab; replace(detailHint, HINT_KEYS[tab] ? Hint(HINT_KEYS[tab]) : null); }
    const panel = panels[tab];
    if (panelHost.firstChild !== panel) panelHost.replaceChildren(panel);
  }

  function render() {
    const snapshot = store.view.snapshot;
    if (!snapshot) return;
    const projects = (snapshot.projects ?? []).filter(item => !item.archivedAt);
    const known = projectId === 'all' || projects.some(item => item.id === projectId);
    if (!known) { router.go(router.href('projects')); return; }
    paintList(snapshot);
    paintDetail(snapshot);
    if (tab === 'memory') paintMemory(snapshot);
  }

  // 顶栏切换项目范围时，项目页跟着切换。
  scope.subscribe((value) => {
    if (router.current.page !== 'projects') return;
    const next = value || 'all';
    if (next === projectId) return;
    router.go(router.href('projects', next, next === 'all' ? 'todos' : 'workspace'));
  });

  return {
    el,
    onShow(route) {
      const [id, nextTab, nextRun] = route.parts;
      projectId = id || scope.get() || 'all';
      tab = TABS.includes(nextTab) ? nextTab : projectId === 'all' ? 'todos' : 'workspace';
      if (projectId === 'all' && ['workspace', 'memory', 'settings'].includes(tab)) tab = 'todos';
      scope.set(projectId === 'all' ? '' : projectId);  // 顶栏的项目范围跟随当前所看的项目
      runId = tab === 'runs' ? nextRun ?? '' : '';
      if (!id) { router.go(router.href('projects', projectId, tab)); return; }
      lastProjects = '';
      todos.show(projectId);
      runs.show(projectId, runId);
      if (tab === 'settings') settings.show(projectId);
      if (tab === 'workspace') conversation.show(projectId);
      render(); void discovered.show();
    },
    onState({ snapshot }) {
      todos.update(snapshot);
      runs.update();
      if (tab === 'settings') settings.update();
      if (tab === 'workspace') conversation.update();
      render(); discovered.update();
    },
  };
}

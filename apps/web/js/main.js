// 启动：创建接口、数据仓库、路由和各页面，把它们接到外壳上。
import { h, readLocal, writeLocal } from './lib/dom.js';
import { createApi } from './lib/api.js';
import { installPresence } from './features/presence.js';
import { createStore } from './lib/store.js';
import { createRouter } from './lib/router.js';
import { createScope } from './lib/scope.js';
import { computeAlerts } from './lib/alerts.js';
import { createShell, PAGE_NAMES } from './shell.js';
import { applyHintPreference } from './ui/hint.js';
import { Banner, Button } from './ui/kit.js';
import { closeOverlays } from './ui/overlay.js';
import { createSearch } from './features/search.js';
import { installShortcuts } from './features/shortcuts.js';
import { openQuickTodo } from './features/quick-todo.js';
import { playSplash } from './features/splash.js';
import { createConsole } from './legacy/terminal.js';
import { createChatPage } from './pages/chat.js';
import { createMailboxPage } from './pages/mailbox.js';
import { createAgentPage } from './pages/agent.js';
import { createProjectsPage } from './pages/projects.js';
import { createMemoryPage } from './pages/memory.js';
import { createChannelsPage } from './pages/channels.js';

applyHintPreference();

const api = createApi();
installPresence(api);
const store = createStore(api);
const router = createRouter();
const scope = createScope();
const shell = createShell({ api, store, router, scope });
document.getElementById('root').append(shell.root);

const consoleDrawer = createConsole({ api, getToken: () => api.token() });
const ctx = {
  api, store, router, scope, shell, consoleDrawer,
  /** 打开执行详情后，该执行不再计入“需要你查看”的红点。 */
  markRunSeen(id) {
    const seen = new Set(readLocal('sm.seenRuns', []));
    if (seen.has(id)) return;
    seen.add(id);
    writeLocal('sm.seenRuns', [...seen].slice(-200));
    renderChrome(store.view);
  },
  quickTodo: () => openQuickTodo({ api, store, scope }),
};

const pages = {
  chat: createChatPage(ctx),
  inbox: createMailboxPage({ ...ctx, direction: 'inbox' }),
  outbox: createMailboxPage({ ...ctx, direction: 'outbox' }),
  agent: createAgentPage(ctx),
  projects: createProjectsPage(ctx),
  memory: createMemoryPage(ctx),
  channels: createChannelsPage(ctx),
};
for (const page of Object.values(pages)) shell.view.append(page.el);

createSearch({ shell, store, router });
installShortcuts({ shell, router, onQuickTodo: ctx.quickTodo });

function renderChrome(view) {
  const alerts = computeAlerts(view.snapshot, view.attention, { seenRunIds: readLocal('sm.seenRuns', []) });
  shell.setAlerts(alerts, view.connection !== 'online');
  const unread = alerts.chat?.count ? `(${alerts.chat.count}) ` : '';
  document.title = `${unread}Super Mario · ${PAGE_NAMES[router.current.page]}`;
}

store.subscribe((view) => {
  shell.setConnection(view);
  const snapshot = view.snapshot;
  shell.view.classList.toggle('is-loading', !snapshot);
  if (!snapshot) {
    shell.showLoading(view.loadError ? '' : '正在加载工作台…');
    shell.showFailure(view.loadError ? Banner({
      tone: 'danger', children: view.unauthorized ? `${view.loadError}。请在右上角的连接状态里输入访问令牌。` : `无法读取工作台数据：${view.loadError}`,
      action: Button({ label: '重试', size: 'sm', onClick: () => store.refresh() }),
    }) : null);
    return;
  }
  shell.showLoading('');
  shell.showFailure(null);
  scope.validate(snapshot.projects ?? []);
  shell.setProjects(snapshot.projects ?? []);
  renderChrome(view);
  for (const page of Object.values(pages)) page.onState?.(view);
  consoleDrawer.update(snapshot.runs);
});

let shown = '';
router.subscribe((route) => {
  closeOverlays();
  for (const [key, page] of Object.entries(pages)) page.el.classList.toggle('is-active', key === route.page);
  shell.setActive(route.page);
  renderChrome(store.view);
  if (shown !== route.page) shell.view.scrollTop = 0;
  shown = route.page;
  pages[route.page].onShow?.(route);
});

window.addEventListener('workspace:preview-splash', () => {
  const entry = (store.view.snapshot?.webExtensions ?? []).find(item => item.value?.renderer === 'brand-splash');
  playSplash({ ...(entry?.value ?? {}), force: true });
});
// 开屏由“开屏”插件提供：插件启用且是第一次打开时播放一次，不拦截操作。
let splashChecked = false;
store.subscribe(({ snapshot }) => {
  if (!snapshot || splashChecked) return;
  splashChecked = true;
  const entry = (snapshot.webExtensions ?? []).find(item => item.value?.renderer === 'brand-splash');
  if (entry) playSplash(entry.value);
});
store.connect();
router.start();

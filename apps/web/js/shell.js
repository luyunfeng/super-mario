// 外壳：左侧导航、顶栏（搜索 / 项目范围 / 连接状态）、内容区。
import { h, replace } from './lib/dom.js';
import { icon } from './ui/icons.js';
import { Button, Input } from './ui/kit.js';
import { hintCopy } from './ui/hint.js';
import { alertLabel } from './lib/alerts.js';
import { PAGES } from './lib/router.js';

export const PAGE_NAMES = { chat: '对话', inbox: '收件箱', outbox: '发件箱', agent: 'Agent', projects: '项目', memory: '记忆', channels: '渠道' };
const NAV_ICONS = { chat: 'chat', inbox: 'inbox', outbox: 'outbox', agent: 'agent', projects: 'projects', memory: 'memory', channels: 'channels' };

export function createShell({ api, store, router, scope }) {
  // —— 导航 ——
  const navItems = {};
  const nav = h('nav', { class: 'nav', 'aria-label': '主导航' }, PAGES.map((page) => {
    const copy = hintCopy(`nav.${page}`);
    const badge = h('span', { class: 'alert', hidden: true, 'aria-hidden': 'true' });
    const el = h('a', { class: 'nav__item', href: router.href(page), dataset: { nav: page }, title: `${PAGE_NAMES[page]}：${copy.tag}` },
      h('span', { class: 'nav__icon' }, icon(NAV_ICONS[page]), badge),
      h('span', { class: 'nav__text' }, h('span', { class: 'nav__name' }, PAGE_NAMES[page]), h('span', { class: 'nav__desc' }, copy.tag)));
    navItems[page] = { el, badge };
    return el;
  }));
  const sidebar = h('aside', { class: 'sidebar' },
    h('a', { class: 'brand', href: router.href('chat'), 'aria-label': 'Super Mario，回到对话' },
      h('span', { class: 'brand__logo', 'aria-hidden': 'true' }, 'M'),
      h('span', { class: 'brand__name' }, 'Super Mario', h('span', { class: 'brand__sub' }, '个人 AI 工作台'))),
    nav);

  // —— 搜索 ——
  const searchInput = h('input', { class: 'search__input', type: 'search', id: 'workspace-search', placeholder: '搜索待办、执行与记忆', autocomplete: 'off', 'aria-label': '搜索待办、执行与记忆', 'aria-controls': 'search-results' });
  const results = h('div', { class: 'search__results', id: 'search-results', hidden: true });
  const search = h('div', { class: 'search' }, icon('search', 'search__icon'), searchInput, h('kbd', { class: 'search__kbd' }, '/'), results);

  // —— 项目范围 ——
  const scopeSelect = h('select', { class: 'select topbar__scope', 'aria-label': '项目范围', id: 'scope-select' }, h('option', { value: '' }, '全部项目'));
  const syncScopeClass = () => scopeSelect.classList.toggle('is-scoped', Boolean(scopeSelect.value));
  scopeSelect.addEventListener('change', () => { scope.set(scopeSelect.value); syncScopeClass(); });
  scope.subscribe((value) => { scopeSelect.value = value; syncScopeClass(); });
  syncScopeClass();

  // —— 连接状态 ——
  const connDot = h('span', { class: 'dot', 'aria-hidden': 'true' });
  const connLabel = h('span', { class: 'conn__label' }, '连接中');
  const connButton = h('button', { class: 'conn__btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', id: 'connection' }, connDot, connLabel);
  const connMessage = h('p', { class: 'small', role: 'status' });
  const tokenInput = Input({ type: 'password', placeholder: '本地服务可留空', id: 'token', name: 'token', 'aria-label': '服务访问令牌' });
  const tokenForm = h('form', { class: 'stack', id: 'auth-form' },
    h('label', { class: 'field__label', for: 'token' }, '服务访问令牌'), tokenInput,
    h('div', { class: 'row' }, h('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, '连接工作台'), Button({ label: '立即重试', size: 'sm', onClick: () => store.reconnect() })));
  const connPop = h('div', { class: 'conn__pop', hidden: true }, connMessage, tokenForm);
  const conn = h('div', { class: 'conn' }, connButton, connPop);
  const toggleConn = (open) => { connPop.hidden = !open; connButton.setAttribute('aria-expanded', String(open)); if (open) tokenInput.focus(); };
  connButton.addEventListener('click', () => toggleConn(connPop.hidden));
  document.addEventListener('click', (event) => { if (!conn.contains(event.target)) toggleConn(false); });
  tokenForm.addEventListener('submit', (event) => {
    event.preventDefault();
    api.setToken(tokenInput.value);
    toggleConn(false);
    store.reset();
  });
  tokenInput.value = api.token();

  const topbar = h('header', { class: 'topbar' }, search, h('span', { class: 'topbar__space' }), scopeSelect, conn);

  // —— 内容区 ——
  const loading = h('div', { class: 'page__inner', id: 'loading', role: 'status' }, h('p', { class: 'muted' }, '正在加载工作台…'));
  const failure = h('div', { class: 'page__inner', id: 'error', role: 'alert', hidden: true });
  const view = h('main', { id: 'view', tabindex: '-1' }, loading, failure);
  const mainCol = h('div', { class: 'main-col' }, topbar, view);
  const root = h('div', { class: 'app', id: 'workspace' }, sidebar, mainCol);

  return {
    root, view, searchInput, results,
    setActive(page) {
      for (const [key, { el }] of Object.entries(navItems)) {
        if (key === page) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
      }
    },
    setAlerts(alerts, stale) {
      for (const [page, { el, badge }] of Object.entries(navItems)) {
        const alert = alerts[page];
        badge.hidden = !alert;
        badge.textContent = alert?.count ? (alert.count > 99 ? '99+' : String(alert.count)) : '';
        badge.classList.toggle('alert--dot', Boolean(alert && !alert.count));
        badge.classList.toggle('alert--stale', Boolean(alert && stale));
        el.setAttribute('aria-label', `${alertLabel(alert, PAGE_NAMES[page])}${alert && stale ? '（可能已过期）' : ''}`);
      }
    },
    setProjects(projects) {
      const items = projects.filter(item => !item.archivedAt);
      const signature = JSON.stringify(items.map(({ id, name }) => [id, name]));
      if (scopeSelect.dataset.sig === signature) return;
      scopeSelect.dataset.sig = signature;
      replace(scopeSelect, h('option', { value: '' }, '全部项目'), items.map(item => h('option', { value: item.id }, item.name)));
      scopeSelect.value = scope.get();
      syncScopeClass();
    },
    setConnection({ connection, unauthorized, loadError }) {
      const tone = connection === 'online' ? 'ok' : connection === 'connecting' ? 'warn' : 'danger';
      connDot.className = `dot dot--${tone}`;
      connLabel.textContent = unauthorized ? '需要令牌' : connection === 'online' ? '已连接' : connection === 'connecting' ? '连接中' : '重连中';
      connMessage.textContent = unauthorized ? (loadError || '访问令牌无效，请重新输入。')
        : connection === 'online' ? '实时更新已连接，数据会自动更新。' : '连接已断开，正在自动重连。';
      if (unauthorized) toggleConn(true);
    },
    showLoading(text) { loading.hidden = !text; if (text) loading.firstChild.textContent = text; },
    showFailure(content) { failure.hidden = !content; replace(failure, content); },
  };
}

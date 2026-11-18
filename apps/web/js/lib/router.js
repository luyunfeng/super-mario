// 地址即状态：#页面/子页/…。旧地址只做重定向，不再各占一个页面。

export const PAGES = ['chat', 'inbox', 'outbox', 'agent', 'projects', 'memory', 'channels'];

const ALIASES = {
  overview: 'chat', interactions: 'chat', approvals: 'chat',
  todos: 'projects/all/todos', runs: 'projects/all/runs', plans: 'projects/all/runs', terminals: 'projects/all/runs',
  knowledge: 'memory', supervision: 'agent/follow-up', policies: 'agent/rules', settings: 'agent',
};

export function parseRoute(hash) {
  let raw = hash.replace(/^#/, '');
  const queryAt = raw.indexOf('?');
  const query = new URLSearchParams(queryAt < 0 ? '' : raw.slice(queryAt + 1));
  if (queryAt >= 0) raw = raw.slice(0, queryAt);
  let parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  const alias = ALIASES[parts[0]];
  if (alias) parts = [...alias.split('/'), ...parts.slice(1)];
  const page = PAGES.includes(parts[0]) ? parts[0] : 'chat';
  const canonical = PAGES.includes(parts[0]) ? parts : ['chat'];
  return { page, parts: canonical.slice(1), canonical: `#${canonical.map(encodeURIComponent).join('/')}`, query };
}

export function createRouter() {
  const listeners = new Set();
  let current = parseRoute(location.hash);

  function sync() {
    current = parseRoute(location.hash);
    // 旧地址在地址栏里就换成新地址，书签不失效、后退也不会回到旧地址。
    if (location.hash && current.canonical !== location.hash.replace(/\?.*$/, '')) {
      history.replaceState(history.state, '', current.canonical);
    }
    for (const fn of listeners) fn(current);
  }
  window.addEventListener('hashchange', sync);

  return {
    get current() { return current; },
    start() { sync(); },
    go(path) {
      const target = path.startsWith('#') ? path : `#${path}`;
      if (location.hash === target) sync();
      else location.hash = target;
    },
    href: (...segments) => `#${segments.map(part => encodeURIComponent(part)).join('/')}`,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

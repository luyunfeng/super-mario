import { h, replace } from '../lib/dom.js';
import { Button, Pill } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const statuses = { working: '处理中', completed: '已送达', failed: '失败', unknown: '送达结果未知', recalled: '已撤回' };

export function openGroupReads({ api, bot, store, onClose }) {
  const path = '/feishu/bots/' + encodeURIComponent(bot.id) + '/group-reads';
  const owner = api.draftOwner(), route = location.hash;
  const body = h('div', { class: 'stack', 'aria-live': 'polite' });
  let request = 0, pending, rows = [], cursor = null;
  let lastChange = store.view.feishuBotChange, connection = store.view.connection;
  let updatedAt = bot.updatedAt, depth = 1, refreshTimer;
  const allowed = () => location.hash === route && owner === api.draftOwner() && !store.view.unauthorized &&
    store.view.snapshot?.plugins?.some(plugin => plugin.id === 'feishu' && plugin.status === 'active');
  const drawer = openDrawer({ title: '读群记录', subtitle: bot.name, body, onClose() {
    discard(); unsubscribe(); window.removeEventListener('hashchange', checkRoute); onClose();
  } });
  function discard() {
    clearTimeout(refreshTimer); request++; pending?.abort(); rows = []; cursor = null; replace(body);
  }
  function close() { discard(); drawer.close(); }
  function checkRoute() { if (!allowed()) close(); }
  function paint() {
    replace(body, Button({ label: '刷新', size: 'sm', onClick: () => read() }),
      rows.length ? rows.map(row => h('article', { class: 'card stack' },
        h('div', { class: 'row row--wrap' }, Pill(statuses[row.status] ?? '状态未知'),
          h('time', { class: 'muted small', dateTime: row.createdAt }, new Date(row.createdAt).toLocaleString())),
        h('strong', { style: 'white-space: pre-wrap' }, row.status === 'recalled' ? '请求内容已撤回' : row.task || '读群总结'),
        h('span', { class: 'muted small' }, row.totalParts == null ? '已确认送达 ' + row.confirmedParts + ' 段'
          : '已确认送达 ' + row.confirmedParts + ' / ' + row.totalParts + ' 段'),
        row.status !== 'recalled' && row.confirmedParts > 0 && row.answer && h('p', { style: 'white-space: pre-wrap' }, row.answer)))
        : h('p', { class: 'muted' }, '暂无读群记录。'),
      cursor && Button({ label: '加载更早记录', onClick: () => read(cursor) }));
  }
  async function read(before, pages = 1) {
    if (!allowed()) return close();
    if (!before) { discard(); depth = pages; }
    if (store.view.connection !== 'online') {
      discard(); replace(body, h('p', { role: 'status' }, '实时连接已断开，重连后将重新读取。')); return;
    }
    const id = ++request;
    pending?.abort(); pending = new AbortController();
    if (!before) replace(body, h('p', { role: 'status' }, '正在读取…'));
    try {
      let after = before, loaded = 0;
      const seen = new Set(rows.map(row => row.id));
      do {
        const page = await api(path + (after ? '?before=' + encodeURIComponent(after) : ''), { signal: pending.signal });
        if (id !== request || !drawer.el.open || !allowed()) return;
        for (const row of page.items) {
          if (!seen.has(row.id)) { rows.push(row); seen.add(row.id); }
        }
        cursor = page.nextBefore;
        loaded++;
        if (!cursor || cursor === after) break;
        after = cursor;
      } while (loaded < pages);
      depth = before ? depth + 1 : loaded;
      paint();
    } catch (error) {
      if (id !== request || !drawer.el.open) return;
      if (!allowed() || [401, 403, 404].includes(error.status) || (error.status === 503 && error.message.includes('停用'))) return close();
      discard();
      replace(body, h('p', { role: 'alert' }, error.message), Button({ label: '重新读取', onClick: () => read() }));
    }
  }
  const unsubscribe = store.subscribe(() => {
    if (!allowed()) return close();
    const event = store.view.feishuBotChange;
    const changed = event !== lastChange && event?.botId === bot.id;
    lastChange = event;
    const next = store.view.connection;
    const networkChanged = next !== connection;
    connection = next;
    if (networkChanged || (changed && event.bindingChanged)) { void read(undefined, networkChanged ? depth : 1); return; }
    if (changed) {
      discard();
      replace(body, h('p', { role: 'status' }, '正在更新读群记录…'));
      refreshTimer = setTimeout(() => { if (drawer.el.open) void read(undefined, depth); }, 75);
    }
  });
  window.addEventListener('hashchange', checkRoute);
  void read();
  return { close, refresh: () => read(), verify(bots) {
    const current = bots.find(b => b.id === bot.id && b.appId === bot.appId && b.paired && b.enabled && b.scope.kind === 'global');
    if (!current) return close();
    if (current.updatedAt !== updatedAt) { updatedAt = current.updatedAt; void read(); }
  } };
}

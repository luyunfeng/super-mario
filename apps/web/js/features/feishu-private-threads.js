import { h, replace } from '../lib/dom.js';
import { conversationModelPicker } from './model-drawer.js';
import { Button, Field, Input, copyText } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

export function openPrivateThreads({ api, bot, store, onClose }) {
  const base = '/feishu/bots/' + encodeURIComponent(bot.id) + '/threads';
  const owner = api.draftOwner(), route = location.hash;
  const body = h('div', { class: 'stack', 'aria-live': 'polite' });
  let loadId = 0;
  const valid = () => api.draftOwner() === owner && location.hash === route && !store.view.unauthorized &&
    store.view.snapshot?.plugins?.some(plugin => plugin.id === 'feishu' && plugin.status === 'active');
  const drawer = openDrawer({ title: '独立对话记录', subtitle: bot.name, body,
    onClose() { loadId++; unsubscribe(); onClose(); } });
  let archived = false;
  let query = '';
  // Keep loaded search pages when returning from a message. A write invalidates the cache.
  let searchPage;
  const hasSearch = () => store.view.snapshot?.plugins?.some(plugin => plugin.id === 'conversation-search' && plugin.status === 'active');
  let searchEnabled = hasSearch();
  let lastSnapshot = store.view.snapshot;
  let showingList = false;
  function setSearchEnabled(enabled) {
    if (enabled === searchEnabled) return;
    searchEnabled = enabled;
    query = '';
    searchPage = undefined;
    if (showingList) void list();
    else body.querySelector('mark')?.remove();
  }
  const unsubscribe = store.subscribe(() => {
    if (!valid()) return drawer.close();
    if (lastSnapshot !== store.view.snapshot) {
      lastSnapshot = store.view.snapshot;
      setSearchEnabled(hasSearch());
    }
  });
  const current = id => id === loadId && drawer.el.open && valid();
  const back = () => Button({ label: '返回列表', onClick: () => list() });
  function inaccessible(error) {
    if (![401, 403, 404].includes(error.status) && !(error.status === 503 && error.message.includes('飞书插件已停用'))) return false;
    drawer.close();
    return true;
  }
  async function load(path, show, retry) {
    const id = ++loadId;
    replace(body, h('p', { role: 'status' }, '正在读取…'));
    try {
      const result = await api.get(path);
      if (current(id)) show(result, id);
    } catch (error) {
      if (!current(id) || inaccessible(error)) return;
      if (error.status === 409) searchPage = undefined;
      replace(body, h('p', { role: 'alert' }, error.message),
        Button({ label: '重试', onClick: retry }), back());
    }
  }
  function list() {
    showingList = true;
    const id = ++loadId;
    const input = Input({ value: query, type: 'text', maxLength: 500 });
    const results = h('div', { class: 'stack', 'aria-live': 'polite' });
    const search = (text, scope) => {
      query = text.trim();
      archived = scope;
      searchPage = undefined;
      return list();
    };
    const filter = value => Button({ label: value ? '已归档' : '未归档', disabled: value === archived,
      onClick: () => search(input.value, value) });
    replace(body, h('div', { class: 'row' }, filter(false), filter(true)),
      searchEnabled ? h('form', { class: 'stack', onsubmit: event => { event.preventDefault(); void search(input.value, archived); } },
        Field({ label: '搜索独立对话', control: input }),
        h('div', { class: 'row' }, Button({ label: '搜索', type: 'submit' }),
          query && Button({ label: '清除搜索', onClick: () => search('', archived) })))
        : h('p', { class: 'muted' }, '对话历史搜索插件已停用。'), results);
    const openThread = row => Button({ label: row.title + ' · ' + row.count + ' 条消息', onClick: () => detail(row) });
    function showResults() {
      const items = searchPage.items;
      replace(results, items.length ? items.map(row => h('div', { class: 'stack' }, openThread(row),
        row.titleMatch && h('span', { class: 'small muted' }, '标题匹配'),
        row.hits.map(hit => Button({ label: (hit.role === 'user' ? '用户' : '助手') + ' · ' + hit.excerpt,
          size: 'sm', onClick: () => detail(row, '', undefined, hit.id) }))))
        : h('p', { class: 'muted' }, '没有找到匹配的独立对话。'),
        searchPage.nextBefore && Button({ label: '加载更多结果', onClick: () => read(searchPage.nextBefore) }));
    }
    async function read(before) {
      if (!before) replace(results, h('p', { role: 'status' }, '正在读取…'));
      try {
        if (!query) {
          const rows = await api.get(base + (archived ? '?archived=1' : ''));
          if (current(id)) replace(results, rows.length ? rows.map(openThread)
            : h('p', { class: 'muted' }, archived ? '暂无已归档对话。' : '暂无独立对话。可在机器人私聊发送 /new 加第一条消息。'));
          return;
        }
        const params = new URLSearchParams({ q: query, archived: archived ? '1' : '0' });
        if (before) params.set('before', before);
        const page = await api.get(base + '/search?' + params);
        if (!current(id)) return;
        searchPage = { items: before ? [...searchPage.items, ...page.items] : page.items, nextBefore: page.nextBefore };
        showResults();
      } catch (error) {
        if (!current(id) || inaccessible(error)) return;
        if (query && error.status === 503 && error.message.includes('搜索插件已停用')) {
          setSearchEnabled(false);
          void store.refresh();
          return;
        }
        if (before && error.status !== 409) showResults();
        else { searchPage = undefined; replace(results, Button({ label: '重新读取', onClick: () => read() })); }
        results.append(h('p', { role: 'alert' }, error.message));
      }
    }
    if (query && searchPage) showResults();
    else return read();
  }
  function detail(row, notice = '', draft, around) {
    showingList = false;
    const path = base + '/' + encodeURIComponent(row.threadId);
    return load(path + (around ? '?around=' + encodeURIComponent(around) : ''), (page, id) => {
      renderDetail(path, { ...row, ...page }, page.messages, page.nextBefore, page.nextAfter, notice, id, draft, around);
    }, () => detail(row, notice, draft, around));
  }
  function renderDetail(path, row, messages, nextBefore, nextAfter, notice, id, draft, around) {
    if (!query) archived = !!row.archived;
    const feedback = h('p', { role: 'status', class: 'small muted' }, notice);
    const title = Input({ value: draft ?? row.title });
    const edit = h('fieldset', { class: 'stack', 'aria-label': '对话管理' });
    async function save(change) {
      if (!current(id) || edit.disabled) return;
      if (change.title && Array.from(change.title).length > 80) {
        feedback.textContent = '对话标题最多 80 个字符。';
        return;
      }
      edit.disabled = true;
      searchPage = undefined;
      try {
        const saved = await api.patch(path, { version: row.version, ...change });
        if (!current(id)) return;
        renderDetail(path, { ...row, ...saved }, messages, nextBefore, nextAfter,
          change.archived === true ? '已归档。收到新的用户消息后会自动恢复。' :
          change.archived === false ? '已恢复对话。' : '已保存标题。', ++loadId, undefined, around);
      } catch (error) {
        if (!current(id) || inaccessible(error)) return;
        if (error.status === 409 || !error.status || error.status >= 500) {
          searchPage = undefined;
          const conflict = error.status === 409;
          await detail(row, conflict ? '对话已在别处修改，已重新读取，请核对后再操作。' : '保存结果未知，已重新读取，请核对。',
            conflict && change.title ? change.title : undefined, around);
        } else {
          feedback.textContent = error.message;
          edit.disabled = false;
        }
      }
    }
    edit.append(Field({ label: '对话标题', control: title }),
      h('div', { class: 'row' }, Button({ label: '保存标题', size: 'sm', onClick: () => save({ title: title.value.trim() }) }),
        Button({ label: '还原默认标题', size: 'sm', onClick: () => save({ title: '' }) }),
        Button({ label: row.archived ? '恢复对话' : '归档对话', size: 'sm', onClick: () => save({ archived: !row.archived }) })));
    const picker = conversationModelPicker(api, path + '/model', row.title);
    const history = h('div', { class: 'stack' });
    const entries = items => items.map(message => h('section', { class: 'stack' },
      query && around && message.id === around && h('mark', { tabIndex: -1 }, '命中消息'),
      h('strong', null, (message.role === 'user' ? '用户' : '助手') + ' · ' + new Date(message.createdAt).toLocaleString()),
      h('p', { style: 'white-space: pre-wrap' }, message.text)));
    history.append(...entries(messages));
    const more = older => Button({ label: older ? '加载更早消息' : '加载后续消息', onClick: async (_, button) => {
      try {
        const cursor = older ? nextBefore : nextAfter;
        const page = await api.get(path + (older ? '?before=' : '?after=') + encodeURIComponent(cursor));
        if (!current(id)) return;
        if (older) {
          messages = [...page.messages, ...messages];
          history.prepend(...entries(page.messages));
          nextBefore = page.nextBefore;
        } else {
          messages = [...messages, ...page.messages];
          history.append(...entries(page.messages));
          nextAfter = page.nextAfter;
        }
        button.hidden = !(older ? nextBefore : nextAfter);
      } catch (error) {
        if (!current(id) || inaccessible(error)) return;
        if (error.status === 409) await detail(row, '消息位置已变化，已重新读取最新消息。');
        else feedback.textContent = error.message;
      }
    } });
    replace(body, back(), h('h3', null, row.title), edit,
      Button({ label: '复制对话 ID', size: 'sm', onClick: async () => {
        try { await copyText(row.threadId); if (current(id)) feedback.textContent = '已复制对话 ID。'; }
        catch { if (current(id)) feedback.textContent = '复制失败，请检查剪贴板权限。'; }
      } }), feedback, ...picker.controls, nextBefore && more(true), history, nextAfter && more(false));
    history.querySelector('mark')?.focus();
  }
  void list();
  return {
    verify(bots) {
      if (!bots.some(current => current.enabled && current.paired && current.id === bot.id && current.appId === bot.appId && current.updatedAt === bot.updatedAt))
        drawer.close();
    },
    close: drawer.close,
  };
}

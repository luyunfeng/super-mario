import { h, replace } from '../lib/dom.js';
import { conversationModelPicker } from './model-drawer.js';
import { Button } from '../ui/kit.js';
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
  const unsubscribe = store.subscribe(() => { if (!valid()) drawer.close(); });
  async function load(path, show, retry) {
    const id = ++loadId;
    replace(body, h('p', { role: 'status' }, '正在读取…'));
    try {
      const result = await api.get(path);
      if (id === loadId && drawer.el.open && valid()) show(result);
    } catch (error) {
      if (id === loadId && drawer.el.open && valid()) replace(body, h('p', { role: 'alert' }, error.message),
        Button({ label: '重试', onClick: retry }), Button({ label: '返回列表', onClick: list }));
    }
  }
  function list() {
    return load(base, rows => replace(body, ...(rows.length ? rows.map(row =>
      Button({ label: row.title + ' · ' + row.count + ' 条消息', onClick: () => detail(row) }))
      : [h('p', { class: 'muted' }, '暂无独立对话。可在机器人私聊发送 /new 加第一条消息。')])), list);
  }
  function detail(row, before, later = []) {
    const path = base + '/' + row.threadId + (before ? '?before=' + encodeURIComponent(before) : '');
    return load(path, page => {
      const messages = [...page.messages, ...later];
      const picker = conversationModelPicker(api, base + '/' + row.threadId + '/model', row.title);
      replace(body, Button({ label: '返回列表', onClick: list }), h('h3', null, row.title), ...picker.controls,
        page.nextBefore && Button({ label: '加载更早消息', onClick: () => detail(row, page.nextBefore, messages) }),
        ...messages.map(message => h('section', { class: 'stack' },
          h('strong', null, (message.role === 'user' ? '用户' : '助手') + ' · ' + new Date(message.createdAt).toLocaleString()),
          h('p', { style: 'white-space: pre-wrap' }, message.text))));
    }, () => detail(row, before, later));
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

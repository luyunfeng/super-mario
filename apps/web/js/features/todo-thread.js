import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';
import { confirmDialog } from '../ui/overlay.js';

export function createTodoThread({ api, store, todo, sameScope }) {
  const path = '/todos/' + encodeURIComponent(todo.id) + '/thread';
  const owner = api.draftOwner();
  const info = h('div', { class: 'stack small' });
  const notice = h('p', { class: 'small', role: 'status' });
  const panel = h('section', { class: 'stack', 'aria-label': '飞书话题' }, h('h3', null, '飞书话题'), info, notice);
  let generation = 0;
  let lastChange = store.view.todoThreadChange;
  let lastConnection = store.view.connection;

  function valid() {
    return panel.isConnected && panel.closest('dialog')?.open !== false && !store.view.unauthorized &&
      owner === api.draftOwner() && store.view.snapshotOwner === owner && sameScope();
  }
  function paint(thread) {
    if (!thread) { replace(info, '未绑定飞书话题'); return; }
    const group = thread.chatName ? thread.chatName + '（' + thread.chatId + '）' : thread.chatId;
    const topic = thread.title ? thread.title + '（' + thread.threadId + '）' : thread.threadId;
    const unbind = Button({ label: '解除话题绑定', size: 'sm', onClick: async () => {
      const stamp = generation;
      const confirmed = await confirmDialog({ title: '解除飞书话题绑定？',
        message: '解除后，这项待办将停止向群聊“' + group + '”的话题 ' + topic + ' 发送状态更新。',
        confirmLabel: '确认解除', danger: true });
      if (!confirmed || !valid() || stamp !== generation) return;
      try {
        const result = await api.del(path, { expectedVersion: thread.version });
        if (!valid() || stamp !== generation) return;
        if (result?.thread !== null) { await load(); return; }
        paint(null);
        notice.textContent = '已解除话题绑定。';
      } catch (error) {
        if (!valid() || stamp !== generation) return;
        if (error.status === 409) await load('绑定已变化，请核对最新话题。');
        else await load(error.message);
      }
    } });
    replace(info, thread.botName && h('div', null, '机器人 · ' + thread.botName),
      h('div', null, '群聊 · ' + group), h('div', null, '话题 · ' + topic), unbind);
  }

  async function load(message = '') {
    const stamp = ++generation;
    replace(info);
    notice.textContent = '正在读取话题绑定…';
    try {
      const result = await api.get(path);
      if (!valid() || stamp !== generation) return;
      paint(result.thread);
      notice.textContent = message;
    } catch (error) {
      if (!valid() || stamp !== generation) return;
      notice.textContent = error.message;
      replace(info, Button({ label: '重新读取话题绑定', size: 'sm', onClick: () => load() }));
    }
  }
  void load();
  return { panel, update() {
    if (owner !== api.draftOwner() || store.view.unauthorized || !sameScope()) {
      ++generation; panel.hidden = true; replace(info); notice.textContent = ''; return;
    }
    const change = store.view.todoThreadChange;
    const reconnected = store.view.connection === 'online' && lastConnection !== 'online';
    const refresh = panel.hidden || reconnected || (change !== lastChange && change?.todoId === todo.id);
    panel.hidden = false;
    lastChange = change;
    lastConnection = store.view.connection;
    if (refresh) void load();
  } };
}

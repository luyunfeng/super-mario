import { h, replace } from '../lib/dom.js';
import { Button, Field, Input, Select } from '../ui/kit.js';
import { confirmDialog } from '../ui/overlay.js';

export function createTodoThread({ api, store, todo, sameScope }) {
  const path = '/todos/' + encodeURIComponent(todo.id) + '/thread';
  const owner = api.draftOwner();
  const info = h('div', { class: 'stack small' });
  const notice = h('p', { class: 'small', role: 'status' });
  const panel = h('section', { class: 'stack', 'aria-label': '飞书话题' }, h('h3', null, '飞书话题'), info, notice);
  let generation = 0;
  const pluginActive = () => store.view.snapshot?.plugins?.some(item => item.id === 'feishu' && item.status === 'active');
  let lastPlugin = pluginActive(), lastBotChange = store.view.feishuBotChange;
  let lastChange = store.view.todoThreadChange;
  let lastConnection = store.view.connection;

  function valid() {
    return panel.isConnected && panel.closest('dialog')?.open !== false && !store.view.unauthorized &&
      owner === api.draftOwner() && store.view.snapshotOwner === owner && sameScope();
  }
  async function edit(thread, titleOnly = false) {
    const stamp = ++generation;
    const current = () => valid() && stamp === generation && pluginActive();
    const cancel = Button({ label: '取消编辑', size: 'sm', onClick: () => load() });
    replace(info, cancel);
    notice.textContent = '正在读取可用机器人…';
    try {
      const bots = (await api.get('/feishu/bots')).filter(bot => bot.scope?.kind === 'global' && bot.enabled && bot.paired && !bot.archivedAt);
      if (!current()) return;
      if (!bots.length || (titleOnly && !bots.some(bot => bot.id === thread.botId))) {
        notice.textContent = titleOnly ? '原机器人已停用或配对已变化。' : '请先启用并配对全局机器人。'; return;
      }
      const bot = Select({ options: [['', '请选择机器人'], ...bots.map(b => [b.id, b.name])],
        value: titleOnly ? thread.botId : bots.length === 1 ? bots[0].id : '', disabled: titleOnly });
      const chat = Select({ options: [], disabled: titleOnly });
      const topic = Input({ value: titleOnly ? thread.threadId : '', readOnly: titleOnly, placeholder: '飞书话题 ID' });
      const title = Input({ value: titleOnly ? thread.title ?? '' : '' });
      let list, sequence = 0;
      const save = Button({ label: titleOnly ? '保存标题' : '保存绑定', size: 'sm', kind: 'primary', onClick: async () => {
        if (!current() || !list?.binding) return;
        const item = list.items.find(row => row.chatId === chat.value);
        const threadId = topic.value.trim(), name = title.value.trim();
        if (!item || !threadId || /[\s\p{Cc}]/u.test(threadId) || Array.from(threadId).length > 256) {
          notice.textContent = '请选择已登记的群，并填写有效的话题 ID。'; return;
        }
        if (Array.from(name).length > 200) { notice.textContent = '话题标题最多 200 个字符。'; return; }
        const data = { channel: 'feishu', botId: bot.value, chatId: item.chatId, threadId,
          expectedProjectId: todo.projectId ?? null, expectedVersion: thread?.version ?? null, expectedBotBinding: list.binding, expectedRegistryVersion: list.version,
          ...(titleOnly ? { titleOnly: true, expectedTitle: thread.title ?? '', title: name } : name ? { title: name } : {}) };
        if (!titleOnly) {
          const confirmed = await confirmDialog({ title: thread ? '确认更换飞书话题？' : '确认绑定飞书话题？',
            message: '主人在目标话题有效发言后，此待办的状态更新可发往 ' + (item.name || item.chatId) + '（' + item.chatId + '）的话题 ' + threadId + '。',
            confirmLabel: thread ? '确认更换' : '确认绑定' });
          if (!confirmed || !current()) return;
        }
        try {
          await api.put(path, data);
          if (current()) await load(titleOnly ? '已保存话题标题。' : '已保存话题绑定。');
        } catch (error) {
          if (current()) await load(error.status === 409 ? '绑定或群登记已变化，请核对后再编辑。' : error.message);
        }
      } });
      async function groups() {
        const id = bot.value, ticket = ++sequence;
        list = undefined; save.disabled = true; chat.disabled = true; replace(chat);
        notice.textContent = id ? '正在读取已登记的话题群…' : '';
        if (!id) return;
        try {
          const state = await api.get('/feishu/bots/' + encodeURIComponent(id) + '/topic-chats');
          if (!current() || ticket !== sequence) return;
          list = state;
          const items = titleOnly ? state.items.filter(item => item.chatId === thread.chatId) : state.items;
          replace(chat, ...items.map(item => h('option', { value: item.chatId }, item.name ? item.name + '（' + item.chatId + '）' : item.chatId)));
          chat.disabled = titleOnly || !items.length;
          save.disabled = !state.binding || !items.length;
          notice.textContent = items.length ? '' : '该机器人没有可用的已登记话题群。';
        } catch (error) { if (current() && ticket === sequence) notice.textContent = error.message; }
      }
      bot.addEventListener('change', groups);
      replace(info, Field({ label: '飞书机器人', control: bot }), Field({ label: '已登记的话题群', control: chat }),
        Field({ label: '话题 ID', control: topic }), Field({ label: '话题标题（可选）', control: title }),
        h('div', { class: 'row' }, save, cancel));
      await groups();
    } catch (error) { if (current()) notice.textContent = error.message; }
  }
  function paint(thread) {
    const bind = pluginActive() && Button({ label: thread ? '更换话题绑定' : '绑定飞书话题', size: 'sm', onClick: () => edit(thread) });
    if (!thread) { replace(info, h('span', null, '未绑定飞书话题'), bind); return; }
    const group = thread.chatName ? thread.chatName + '（' + thread.chatId + '）' : thread.chatId;
    const topic = thread.title ? thread.title + '（' + thread.threadId + '）' : thread.threadId;
    const unbind = Button({ label: '解除话题绑定', size: 'sm', onClick: async () => {
      const stamp = generation;
      const confirmed = await confirmDialog({ title: '解除飞书话题绑定？',
        message: '解除后，这项待办将停止向群聊“' + group + '”的话题 ' + topic + ' 发送状态更新。',
        confirmLabel: '确认解除', danger: true });
      if (!confirmed || !valid() || stamp !== generation) return;
      try {
        const result = await api.del(path, { expectedProjectId: todo.projectId ?? null, expectedVersion: thread.version });
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
      h('div', null, '群聊 · ' + group), h('div', null, '话题 · ' + topic), h('div', { class: 'row row--wrap' }, bind,
        pluginActive() && thread.botId && Button({ label: '修改话题标题', size: 'sm', onClick: () => edit(thread, true) }), unbind));
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
    const botChange = store.view.feishuBotChange;
    const refresh = panel.hidden || reconnected || pluginActive() !== lastPlugin ||
      (botChange !== lastBotChange && botChange?.bindingChanged) || (change !== lastChange && change?.todoId === todo.id);
    panel.hidden = false;
    lastChange = change;
    lastPlugin = pluginActive(); lastBotChange = botChange;
    lastConnection = store.view.connection;
    if (refresh) void load();
  } };
}

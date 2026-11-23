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
  const unsubscribe = store.subscribe(() => { if (!valid()) drawer.close(); });
  let archived = false;
  const current = id => id === loadId && drawer.el.open && valid();
  const back = () => Button({ label: '返回列表', onClick: () => list() });
  function inaccessible(error) {
    if (![401, 403, 404].includes(error.status)) return false;
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
      if (current(id) && !inaccessible(error)) replace(body, h('p', { role: 'alert' }, error.message),
        Button({ label: '重试', onClick: retry }), back());
    }
  }
  function list() {
    return load(base + (archived ? '?archived=1' : ''), rows => {
      const filter = value => Button({ label: value ? '已归档' : '未归档', disabled: value === archived,
        onClick: () => { archived = value; return list(); } });
      replace(body, h('div', { class: 'row' }, filter(false), filter(true)), rows.length ? rows.map(row =>
        Button({ label: row.title + ' · ' + row.count + ' 条消息', onClick: () => detail(row) }))
        : h('p', { class: 'muted' }, archived ? '暂无已归档对话。' : '暂无独立对话。可在机器人私聊发送 /new 加第一条消息。'));
    }, list);
  }
  function detail(row, notice = '', draft) {
    const path = base + '/' + encodeURIComponent(row.threadId);
    return load(path, (page, id) => {
      renderDetail(path, { ...row, ...page }, page.messages, page.nextBefore, notice, id, draft);
    }, () => detail(row, notice, draft));
  }
  function renderDetail(path, row, messages, nextBefore, notice, id, draft) {
    archived = !!row.archived;
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
      try {
        const saved = await api.patch(path, { version: row.version, ...change });
        if (current(id)) renderDetail(path, { ...row, ...saved }, messages, nextBefore,
          change.archived === true ? '已归档。收到新的用户消息后会自动恢复。' :
          change.archived === false ? '已恢复对话。' : '已保存标题。', ++loadId);
      } catch (error) {
        if (!current(id) || inaccessible(error)) return;
        if (error.status === 409 || !error.status || error.status >= 500) {
          const conflict = error.status === 409;
          await detail(row, conflict ? '对话已在别处修改，已重新读取，请核对后再操作。' : '保存结果未知，已重新读取，请核对。',
            conflict && change.title ? change.title : undefined);
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
      h('strong', null, (message.role === 'user' ? '用户' : '助手') + ' · ' + new Date(message.createdAt).toLocaleString()),
      h('p', { style: 'white-space: pre-wrap' }, message.text)));
    history.append(...entries(messages));
    const earlier = Button({ label: '加载更早消息', onClick: async () => {
      try {
        const page = await api.get(path + '?before=' + encodeURIComponent(nextBefore));
        if (!current(id)) return;
        messages = [...page.messages, ...messages];
        history.prepend(...entries(page.messages));
        nextBefore = page.nextBefore;
        earlier.hidden = !nextBefore;
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
      } }), feedback, ...picker.controls, nextBefore && earlier, history);
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

import { h, replace } from '../lib/dom.js';
import { Button, Field, Input, Check } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

export function openTopicChats({ api, bot, store, onClose }) {
  const path = '/feishu/bots/' + encodeURIComponent(bot.id) + '/topic-chats';
  const owner = api.draftOwner(), route = location.hash;
  const body = h('div', { class: 'stack' });
  const drawer = openDrawer({ title: '话题群管理', subtitle: bot.name, body, onClose() {
    drafts.clear(); unsubscribe(); window.removeEventListener('hashchange', verifyScope); onClose();
  } });
  const active = () => drawer.el.open && api.draftOwner() === owner && location.hash === route &&
    !store.view.unauthorized && store.view.snapshot?.plugins?.some(p => p.id === 'feishu' && p.status === 'active');
  function close() { replace(body); drawer.close(); }
  function verifyScope() { if (!active()) close(); }
  let drafts = new Map();
  let binding, lastChange = store.view.feishuBotChange, connection = store.view.connection;
  const unsubscribe = store.subscribe(() => {
    if (!active()) return close();
    const change = store.view.feishuBotChange, next = store.view.connection;
    const rebound = change !== lastChange && change?.botId === bot.id && change.bindingChanged;
    lastChange = change;
    const disconnected = next !== connection && next !== 'online';
    connection = next;
    if (rebound || disconnected) close();
  });
  window.addEventListener('hashchange', verifyScope);
  async function load(notice = '') {
    replace(body, h('p', { role: 'status' }, '正在读取话题群…'));
    try {
      const state = await api.get(path);
      if (!active()) return;
      if (binding !== undefined && binding !== state.binding) return close();
      binding = state.binding;
      paint(state, notice);
    } catch (error) {
      if (!active()) return;
      if ([401, 403, 404].includes(error.status)) return close();
      replace(body, h('p', { role: 'alert' }, error.message), Button({ label: '重新读取', onClick: () => load(notice) }));
    }
  }
  function paint(state, notice) {
    const rows = [];
    let selected;
    const form = h('fieldset', { class: 'stack', 'aria-label': '话题群设置' });
    const list = h('div', { class: 'stack' });
    const empty = h('p', { class: 'muted' }, '尚未登记话题群。');
    const feedback = h('p', { class: 'small', role: 'status' }, notice);
    function append(item) {
      const chatId = Input({ value: item?.chatId ?? '', placeholder: 'oc_…', readOnly: !!item, required: true });
      const name = Input({ value: item?.name ?? '' });
      const mention = Check({ label: '仅在主人明确 @ 本机器人时响应', checked: !!item?.requireOwnerMention });
      const radio = h('input', { type: 'radio', name: 'topic-home', checked: !!item?.home });
      const row = { chatId, name, radio, mention: mention.querySelector('input') };
      radio.addEventListener('click', () => { selected = row; });
      const el = h('div', { class: 'card stack', role: 'group', 'aria-label': item?.chatId || '新增话题群' },
        Field({ label: '群 chatId', control: chatId }), Field({ label: '群名称（可选）', control: name }), mention,
        h('label', { class: 'check' }, radio, h('span', null, '主话题群')),
        Button({ label: '移除此群', size: 'sm', onClick: () => row.remove() }));
      row.remove = () => {
        rows.splice(rows.indexOf(row), 1); el.remove(); if (selected === row) selected = undefined;
        empty.hidden = rows.length > 0;
      };
      rows.push(row); list.append(el); empty.hidden = true;
      if (!item) chatId.focus();
      return row;
    }
    function changes(items) {
      const result = new Map();
      const previous = new Map(state.items.map(item => [item.chatId, item]));
      for (const item of items) {
        const old = previous.get(item.chatId);
        previous.delete(item.chatId);
        const patch = {};
        if (!old || old.name !== item.name) patch.name = item.name;
        if (!old || old.requireOwnerMention !== item.requireOwnerMention) patch.requireOwnerMention = item.requireOwnerMention;
        if (item.home) patch.home = true;
        if (Object.keys(patch).length) result.set(item.chatId, patch);
      }
      for (const id of previous.keys()) result.set(id, { removed: true });
      return result;
    }
    // Drafts describe only local edits. The editable form always starts with the newly fetched server version.
    const review = h('section', { class: 'card stack', 'aria-label': '未保存的修改' });
    function showDrafts() {
      review.hidden = drafts.size === 0;
      replace(review, h('strong', null, '未保存的修改'), h('p', { class: 'small muted' }, '请对照当前设置逐群核对，采用后再保存。'));
      for (const [id, patch] of drafts) {
        const summary = [id, patch.removed && '移除此群', 'name' in patch && ('群名称：' + (patch.name || '空')),
          'requireOwnerMention' in patch && (patch.requireOwnerMention ? '要求主人明确 @' : '允许主人直接发言'), patch.home && '设为主话题群'].filter(Boolean).join(' · ');
        const resolve = () => { drafts.delete(id); showDrafts(); };
        review.append(h('div', { class: 'stack' }, h('span', null, summary), h('div', { class: 'row' },
          Button({ label: '采用此项', size: 'sm', onClick: () => {
            let row = rows.find(r => r.chatId.value.trim() === id);
            if (patch.removed) row?.remove();
            else {
              if (!row) {
                row = append();
                row.chatId.value = id;
              }
              if ('name' in patch) row.name.value = patch.name;
              if ('requireOwnerMention' in patch) row.mention.checked = patch.requireOwnerMention;
              if (patch.home) row.radio.click();
            }
            resolve();
          } }), Button({ label: '放弃此项', size: 'sm', onClick: resolve }))));
      }
    }
    async function save() {
      if (!active() || form.disabled) return;
      if (drafts.size) { feedback.textContent = '请先采用或放弃每项未保存的修改。'; return; }
      const seen = new Set();
      const items = [];
      for (const row of rows) {
        const id = row.chatId.value.trim();
        if (!id || /\s/.test(id) || seen.has(id)) {
          feedback.textContent = '请填写有效且不重复的群 chatId。'; row.chatId.focus(); return;
        }
        seen.add(id);
        // An effective default home in GET must not become an explicit preference during unrelated edits.
        items.push({ chatId: id, name: row.name.value.trim(), requireOwnerMention: row.mention.checked, ...(selected === row && { home: true }) });
      }
      const attempted = changes(items);
      form.disabled = true;
      try {
        const saved = await api.put(path, { binding: state.binding, version: state.version, items });
        if (!active()) return;
        if (saved.binding !== binding) return close();
        drafts.clear();
        paint(saved, '话题群设置已保存。');
      } catch (error) {
        if (!active()) return;
        if ([401, 403, 404].includes(error.status)) return close();
        if (error.status === 409 || !error.status || error.status >= 500) {
          drafts = attempted;
          await load(error.status === 409 ? '话题群设置已在别处修改。请核对最新设置和未保存的修改。' : '保存结果未知，已重新读取话题群设置。');
        } else { form.disabled = false; feedback.textContent = error.message; }
      }
    }
    for (const row of state.items) append(row);
    form.append(h('p', { class: 'muted small' }, '选择主话题群可指定从其他群发起的任务在哪个群承接。'), empty, list,
      h('div', { class: 'row row--wrap' }, Button({ label: '添加话题群', onClick: () => append() }),
        Button({ label: '保存话题群设置', kind: 'primary', onClick: save })));
    showDrafts();
    form.prepend(review);
    replace(body, form, feedback);
  }
  void load();
  return { close, verify(bots) {
    if (!bots.some(b => b.id === bot.id && b.appId === bot.appId && b.updatedAt === bot.updatedAt && b.scope.kind === 'global' && b.enabled && b.paired)) close();
  } };
}

import { h, replace } from '../lib/dom.js';
import { Button, Field, Input, TextArea } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';
import { openInboxHandlingDrawer } from './inbox-handling.js';

const path = '/feishu/personal/ai';
const statusLabel = { pending: '待处理', completed: '处理已完成', failed: '处理失败', unknown: '结果未知' };
const ids = value => [...new Set(value.trim().split(/[\s,，]+/).filter(Boolean))];

export function createPersonalAI({ api, store, accountState }) {
  let drawer;
  let account;
  let token;
  const collection = h('p', { class: 'small muted' });
  function current() {
    const state = accountState();
    return drawer?.el.open && state && state.account?.name === account && api.token?.() === token;
  }
  function sync() {
    if (!drawer) return;
    if (!current()) { drawer.close(); return; }
    collection.textContent = accountState().enabled ? '个人消息采集已开启。' : '个人消息采集已停止。开启采集后才能处理新触发。';
  }

  function open() {
    const state = accountState();
    if (!state || drawer) return;
    account = state.account?.name;
    token = api.token?.();
    const notice = h('p', { role: 'status' }, '正在读取设置…');
    const body = h('div', { class: 'stack' });
    const dialog = openDrawer({ title: '个人消息 /ai 设置', body: [collection, notice, body], onClose: () => { drawer = undefined; } });
    drawer = dialog;
    sync();
    const active = () => drawer === dialog && current();
    function render(value) {
      const key = value.accountKey;
      if (typeof key !== 'string' || !key) {
        replace(body, '当前没有可核验的飞书个人账号，请检查授权后重新打开。');
        return;
      }
      const enabled = h('input', { type: 'checkbox', checked: value.enabled });
      const prefix = Input({ value: value.prefix, required: true });
      const count = Input({ type: 'number', value: value.contextCount, required: true, min: 0, max: 50, step: 1 });
      const chats = TextArea({ rows: 3, value: value.chatIds.join('\n') });
      const senders = TextArea({ rows: 3, value: value.triggerSenderIds.join('\n') });
      const turns = h('div', { class: 'stack', 'aria-label': '近期触发结果', style: { overflowWrap: 'anywhere' } });
      function renderTurns(records) {
        replace(turns, records.length ? records.map(turn => h('div', { class: 'item' },
          h('div', { class: 'item__main' }, h('span', null, statusLabel[turn.status] ?? '状态未知'),
            h('span', { class: 'item__meta' }, turn.messageId), turn.error && h('p', { class: 'text-danger' }, turn.error)),
          turn.inboxId && Button({ label: '查看草稿与建议', size: 'sm', onClick: () => {
            if (!active()) return;
            dialog.close();
            openInboxHandlingDrawer({ api, store, source: { kind: 'personal', id: turn.inboxId } });
          } }))) : '暂无触发记录。');
      }
      renderTurns(value.turns);
      const controls = h('fieldset', { class: 'stack' },
        h('label', { class: 'check' }, enabled, '启用 /ai'),
        Field({ label: '触发前缀', control: prefix, hint: '在消息开头输入前缀，空一格后写问题。' }),
        Field({ label: '上下文条数', control: count }),
        Field({ label: '群 ID 白名单', control: chats, hint: '每行一个群 ID。留空时不接受群触发。' }),
        Field({ label: '触发人 open_id', control: senders, hint: '默认仅本人。每行可添加一个允许触发的 open_id。' }));
      let busy = false;
      async function update(save) {
        if (!active() || busy) return;
        if (save && (!prefix.value.trim() || !count.reportValidity())) {
          notice.textContent = '请填写触发前缀和有效的上下文条数。';
          return;
        }
        const payload = { expectedAccountKey: key, enabled: enabled.checked, prefix: prefix.value.trim(), contextCount: count.valueAsNumber,
          chatIds: ids(chats.value), triggerSenderIds: ids(senders.value) };
        busy = true;
        controls.disabled = save;
        reload.disabled = submit.disabled = true;
        notice.textContent = save ? '正在保存…' : '正在读取近期触发结果…';
        try {
          const result = save ? await api.put(path, payload) : await api.get(path);
          if (!active()) return;
          if (result.accountKey !== key) {
            replace(body, '飞书账号已变化，请重新打开设置。');
            notice.textContent = '';
            return;
          }
          if (save) render(result);
          else renderTurns(result.turns);
          notice.textContent = save ? '设置已保存。' : '近期触发结果已更新。';
        } catch (error) {
          if (active() && [401, 403, 409].includes(error.status)) replace(body, '请核对当前账号并重新打开设置。');
          if (active()) notice.textContent = (save ? '保存未确认：' : '读取失败：') + error.message;
        } finally {
          busy = false;
          controls.disabled = reload.disabled = submit.disabled = false;
        }
      }
      const submit = Button({ label: '保存设置', kind: 'primary', onClick: () => update(true) });
      const reload = Button({ label: '刷新触发结果', size: 'sm', onClick: () => update(false) });
      replace(body, controls, submit, h('h3', null, '近期触发结果'),
        h('p', { class: 'small muted' }, '可在「处理与建议」中查看回复草稿和审批进度。发送结果以实际回执为准。'), reload, turns);
    }
    async function load() {
      if (!active()) return;
      try {
        const value = await api.get(path);
        if (active()) { render(value); notice.textContent = ''; }
      } catch (error) {
        if (!active()) return;
        notice.textContent = '无法读取 /ai 设置：' + error.message;
        replace(body, Button({ label: '重试读取设置', onClick: load }));
      }
    }
    void load();
  }
  return { open, sync };
}

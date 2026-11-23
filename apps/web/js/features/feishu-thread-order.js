import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

export function editThreadOrder({ api, base, valid, onSaved, onInvalid }) {
  const body = h('div', { class: 'stack' });
  const drawer = openDrawer({ title: '调整对话顺序', body });
  const active = () => drawer.el.open && valid();
  const path = base + '/order';
  let state, rows, dragged;
  const notice = h('p', { class: 'muted small', role: 'status' });
  const list = h('ol', { class: 'stack', 'aria-label': '未归档对话顺序' });
  const controls = h('fieldset', { class: 'stack', 'aria-label': '未归档对话排序' });
  function move(from, to, direction) {
    if (controls.disabled || from < 0 || to < 0 || to >= rows.length || from === to) return;
    rows.splice(to, 0, ...rows.splice(from, 1));
    paint();
    notice.textContent = rows[to].title + ' 已移至第 ' + (to + 1) + ' 位。';
    if (direction) {
      const buttons = list.children[to].querySelectorAll('button');
      const target = buttons[direction < 0 ? 0 : 1];
      (target.disabled ? buttons[direction < 0 ? 1 : 0] : target).focus();
    }
  }
  function paint() {
    replace(list, rows.map((row, index) => h('li', { class: 'row row--wrap', draggable: true,
      ondragstart: event => {
        if (controls.disabled) { event.preventDefault(); return; }
        dragged = row.threadId;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-super-mario-thread', 'move');
      },
      ondragend: () => { dragged = undefined; },
      ondragover: event => { if (dragged) event.preventDefault(); },
      ondrop: event => {
        if (!dragged) return;
        event.preventDefault();
        move(rows.findIndex(entry => entry.threadId === dragged), index);
        dragged = undefined;
      } }, h('span', null, row.title),
      Button({ label: '上移', ariaLabel: '上移 ' + row.title, size: 'sm', disabled: !index, onClick: () => move(index, index - 1, -1) }),
      Button({ label: '下移', ariaLabel: '下移 ' + row.title, size: 'sm', disabled: index === rows.length - 1, onClick: () => move(index, index + 1, 1) }))));
  }
  function orderToSave() {
    const order = rows.map(row => row.threadId);
    const visible = new Set(order);
    return order.concat(state.order.filter(id => !visible.has(id)));
  }
  const invalid = error => [401, 403, 404].includes(error.status) || (error.status === 503 && error.message.includes('飞书插件已停用'));
  async function save(order) {
    if (!active() || controls.disabled) return;
    controls.disabled = true;
    try {
      await api.patch(path, { binding: state.binding, version: state.version, order });
      if (valid()) { drawer.close(); onSaved(); }
    } catch (error) {
      if (!active()) return;
      if (invalid(error)) { drawer.close(); onInvalid(); return; }
      if (error.status === 409 || !error.status || error.status >= 500) {
        await load(error.status === 409 ? '排序已在别处修改，请核对最新顺序。' : '保存结果未知，请核对最新顺序。');
      } else { notice.textContent = error.message; controls.disabled = false; }
    }
  }
  async function load(message = '') {
    replace(body, h('p', { role: 'status' }, '正在读取未归档对话…'));
    try {
      const [latest, all] = await Promise.all([api.get(path), api.get(base)]);
      if (!active()) return;
      if (state && latest.binding !== state.binding) { drawer.close(); onInvalid(); return; }
      state = latest;
      const rank = new Map(state.order.map((id, i) => [id, i]));
      rows = all.slice().sort((a, b) => (rank.get(a.threadId) ?? rank.size) - (rank.get(b.threadId) ?? rank.size));
      paint();
      controls.disabled = false;
      notice.textContent = message;
      replace(controls, rows.length ? list : h('p', { class: 'muted' }, '暂无未归档对话。'),
        h('div', { class: 'row row--wrap' },
          Button({ label: '保存顺序', disabled: !rows.length, onClick: () => save(orderToSave()) }),
          Button({ label: '恢复按最近活动', disabled: !state.order.length, onClick: () => save([]) }),
          Button({ label: '取消', onClick: drawer.close })));
      replace(body, h('p', { class: 'muted small' }, '拖动对话或用上下移动按钮调整全部未归档对话。'), controls, notice);
    } catch (error) {
      if (!active()) return;
      if (invalid(error)) { drawer.close(); onInvalid(); return; }
      replace(body, h('p', { role: 'alert' }, error.message), Button({ label: '重新读取', onClick: () => load(message) }),
        Button({ label: '取消', onClick: drawer.close }));
    }
  }
  void load();
  return drawer;
}

import { h, replace } from '../lib/dom.js';
import { Button, Field, Input } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

export function editThreadTagFilters({ api, path, state, onSaved, onInvalid }) {
  let saved = state;
  let chosen = [...(saved.filters ?? saved.tags)];
  const owner = api.draftOwner(), route = location.hash;
  const body = h('div', { class: 'stack' });
  const feedback = h('p', { role: 'status' });
  const controls = h('fieldset', { class: 'stack', 'aria-label': '标签筛选设置' });
  const label = Input({ placeholder: '输入已有或新的标签' });
  const rows = h('div', { class: 'stack' });
  const available = h('div', { class: 'row row--wrap' });
  const drawer = openDrawer({ title: '管理标签筛选', body });
  const valid = () => drawer.el.open && owner === api.draftOwner() && route === location.hash;
  function add(value) {
    value = value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    if (!value) return;
    if (Array.from(value).length > 32 || chosen.length >= 50 && !chosen.includes(value)) {
      feedback.textContent = '每个标签最多 32 个字符，最多保留 50 个筛选入口。';
      return;
    }
    if (!chosen.includes(value)) chosen.push(value);
    label.value = '';
    feedback.textContent = '';
    paint();
  }
  function move(i, j) {
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
    paint();
  }
  function paint() {
    replace(rows, ...chosen.map((tag, i) => h('div', { class: 'row row--wrap' }, h('span', null, tag),
      Button({ label: '上移', ariaLabel: '上移 ' + tag, disabled: !i, onClick: () => move(i, i - 1) }),
      Button({ label: '下移', ariaLabel: '下移 ' + tag, disabled: i === chosen.length - 1, onClick: () => move(i, i + 1) }),
      Button({ label: '移除', ariaLabel: '移除 ' + tag, onClick: () => { chosen.splice(i, 1); paint(); } }))));
    replace(available, ...saved.tags.filter(tag => !chosen.includes(tag)).map(tag =>
      Button({ label: '添加 ' + tag, size: 'sm', onClick: () => add(tag) })));
  }
  async function save(filters) {
    if (!valid() || controls.disabled) return;
    controls.disabled = true;
    try {
      const result = await api.patch(path, { binding: saved.binding, version: saved.version, filters });
      if (valid()) { drawer.close(); onSaved(result); }
    } catch (error) {
      if (!valid()) return;
      if ([401, 403, 404].includes(error.status)) { drawer.close(); onInvalid(); return; }
      if (error.status === 409 || !error.status || error.status >= 500) {
        try {
          const latest = await api.get(path);
          if (!valid()) return;
          if (latest.binding !== saved.binding) { drawer.close(); onInvalid(); return; }
          saved = latest;
          chosen = [...(saved.filters ?? saved.tags)];
          feedback.textContent = '已重新读取服务器上的筛选设置，请核对后再修改。';
          onSaved(saved);
          paint();
        } catch (readError) {
          if (!valid()) return;
          if ([401, 403, 404].includes(readError.status)) { drawer.close(); onInvalid(); return; }
          feedback.textContent = '读取最新设置失败，请重新打开标签筛选后核对。';
          return;
        }
      } else feedback.textContent = error.message;
    } finally { controls.disabled = false; }
  }
  controls.append(Field({ label: '新筛选标签', control: label }),
    Button({ label: '添加筛选', onClick: () => add(label.value) }), available, rows,
    h('div', { class: 'row row--wrap' },
      Button({ label: '保存筛选顺序', onClick: () => save(chosen) }),
      Button({ label: '自动显示已使用标签', onClick: () => save(null) })));
  body.append(h('p', { class: 'muted small' }, '自定义时只显示选中的筛选入口。移除全部再保存可隐藏所有标签入口。'), controls, feedback);
  paint();
  return { close: drawer.close };
}

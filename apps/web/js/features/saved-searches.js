// 保存检索只在打开抽屉时读取。草稿和版本号均属于这一次打开时的凭据。
import { h, replace } from '../lib/dom.js';
import { Button, Field, Input } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

export function openSavedSearches({ api, store, isEnabled, initialQuery, onApply }) {
  if (!isEnabled()) return;
  const token = api.token();
  let doc;
  let draft = initialQuery === undefined ? null : { name: '', query: initialQuery };
  let busy = false;
  let needsRefresh = false;
  let message = '';
  let reviewed = false;
  let applied;
  const drawer = openDrawer({ title: '保存的检索', onClose() {
    unsubscribe();
    if (authorized() && applied !== undefined) onApply(applied);
  } });
  const authorized = () => token === api.token() && isEnabled();
  const unsubscribe = store.subscribe(() => { if (!authorized()) drawer.close(); });
  function current() {
    if (!authorized()) drawer.close();
    return drawer.el.open;
  }

  // GET 和 POST 串行。失败的写入必须由用户重试，避免覆盖另一窗口的改动。
  async function request(change) {
    if (busy || !current() || (change && needsRefresh)) return;
    busy = true;
    message = '';
    render();
    try {
      const next = change
        ? await api.post('/saved-searches', { ...change, revision: doc.revision })
        : await api.get('/saved-searches');
      if (!current()) return;
      reviewed = !change && needsRefresh && !!draft;
      doc = next;
      needsRefresh = false;
      if (change) draft = null;
    } catch (error) {
      if (!current()) return;
      if (error.status === 409) {
        message = error.message;
        needsRefresh = true;
      } else {
        message = error.message;
        if (change && (!error.status || error.status >= 500)) {
          message += '。请刷新列表，确认修改结果。';
          needsRefresh = true;
        }
      }
    } finally {
      busy = false;
      if (current()) render();
    }
  }

  function edit(item) {
    draft = item ? { ...item } : { name: '', query: '' };
    reviewed = false;
    message = '';
    render();
    drawer.body.querySelector('input')?.focus();
  }

  function editor() {
    const latest = draft.id && doc.searches.find(item => item.id === draft.id);
    const removed = draft.id && !latest;
    const name = Input({ value: draft.name, required: true, disabled: busy, oninput: e => { draft.name = e.target.value; } });
    const query = Input({ value: draft.query, required: true, disabled: busy, oninput: e => { draft.query = e.target.value; } });
    return h('form', { class: 'stack', onsubmit(event) {
      event.preventDefault();
      if (!draft.name.trim() || !draft.query.trim()) {
        message = '请填写名称和检索词。';
        render();
        return;
      }
      if (doc.searches.some(item => item.id !== latest?.id && item.name.toLowerCase() === draft.name.trim().toLowerCase())) {
        message = '已有同名检索，请更换名称。';
        render();
        return;
      }
      void request({ ...(latest ? { action: 'update', id: latest.id } : { action: 'add' }), name: draft.name.trim(), query: draft.query.trim() });
    } },
    Field({ label: '名称', control: name }), Field({ label: '检索词', control: query, hint: '筛选执行记录可输入 state:running 或 since:7d，也可用 machine:、project:、agent: 指定对象。' }),
    reviewed && h('p', { class: 'small', role: 'status' }, removed ? '此检索已被删除，可将草稿另存为新检索。' :
      latest ? '草稿已保留。当前保存的内容：' + latest.name + ' · ' + latest.query : '列表已刷新，草稿已保留。'),
    h('div', { class: 'saved-search-actions' },
      Button({ label: removed ? '另存为新检索' : '保存', kind: 'primary', type: 'submit', disabled: busy || needsRefresh }),
      Button({ label: '取消', disabled: busy, onClick() { draft = null; message = ''; render(); } })));
  }

  function list() {
    const disabled = busy || needsRefresh;
    return h('div', { class: 'stack' },
      h('div', { class: 'saved-search-actions' },
        Button({ label: '新增检索', disabled, onClick: () => edit() }),
        doc.canUndo && Button({ label: '撤销删除', disabled, onClick: () => request({ action: 'undo' }) })),
      !doc.searches.length && h('p', { class: 'muted' }, '还没有保存的检索。'),
      doc.searches.map((item, index, items) => {
        const action = (label, onClick, atEnd = false) => Button({ label, ariaLabel: label + ' ' + item.name,
          size: 'sm', disabled: disabled || atEnd, onClick });
        return h('section', { class: 'saved-search-row' },
          h('button', { class: 'saved-search-apply', type: 'button', 'aria-label': '套用 ' + item.name,
            disabled, onclick() { if (current()) { applied = item.query; drawer.close(); } } },
            h('strong', null, item.name), h('span', { class: 'muted small' }, item.query)),
          h('div', { class: 'saved-search-actions' },
            action('编辑', () => edit(item)),
            action('上移', () => request({ action: 'move', id: item.id, beforeId: items[index - 1].id }), index === 0),
            action('下移', () => request({ action: 'move', id: item.id, beforeId: items[index + 2]?.id }), index === items.length - 1),
            action('删除', () => request({ action: 'delete', id: item.id }))));
      }));
  }

  function render() {
    replace(drawer.body,
      message && h('p', { role: 'alert' }, message),
      (needsRefresh || (!doc && !busy)) && Button({ label: '刷新列表', disabled: busy, onClick: () => request() }),
      doc ? (draft ? editor() : list()) : busy && h('p', { role: 'status' }, '正在读取保存的检索…'));
  }

  void request();
}

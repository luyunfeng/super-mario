// 主对话和项目工作对话共享收藏标记。消息正文只保留在打开的抽屉中。
import { h, replace } from '../lib/dom.js';
import { Button, Field, Input } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const models = new WeakMap();
const fileLimit = 8 * 1024 * 1024;
const key = (projectId, messageId) => JSON.stringify([projectId || '', messageId]);
const speaker = role => role === 'user' ? '我' : '助手';
const fold = text => text.normalize('NFKC').toLocaleLowerCase();

function sharedModel(api, store) {
  if (models.has(api)) return models.get(api);
  let enabled = false, token, epoch = 0, revision = -1;
  const marks = new Map();
  function paint(button) {
    const marked = marks.has(button.dataset.favoriteMessage);
    button.hidden = !enabled;
    button.textContent = marked ? '已收藏' : '收藏消息';
    button.setAttribute('aria-pressed', String(marked));
  }
  function accept(doc) {
    if (doc.revision < revision) return;
    revision = doc.revision;
    marks.clear();
    for (const item of doc.items) {
      if (item.messageId) marks.set(key(item.projectId, item.messageId), item.id);
    }
    document.querySelectorAll('[data-favorite-message]').forEach(paint);
  }
  function update() {
    const active = !store.view.unauthorized && !!store.view.snapshot?.plugins?.some(p => p.id === 'message-favorites' && p.status === 'active');
    if (enabled === active && token === api.token()) return;
    enabled = active;
    token = api.token();
    const generation = ++epoch;
    revision = -1;
    marks.clear();
    document.querySelectorAll('[data-favorite-message]').forEach(paint);
    if (enabled) void api.post('/message-favorites', { action: 'marks' }).then(doc => {
      if (current(generation)) accept(doc);
    }).catch(() => { /* 打开收藏列表时会重新读取，并在抽屉中显示读取失败的原因。 */ });
  }
  function current(generation) { return enabled && epoch === generation && token === api.token(); }
  const model = { paint, accept, current, marks, get epoch() { return epoch; }, get revision() { return revision; }, get enabled() { return enabled; } };
  models.set(api, model);
  store.subscribe(update);
  update();
  return model;
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  h('a', { download: name, href: url }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createMessageFavorites({ api, store }) {
  const model = sharedModel(api, store);
  const post = body => api.post('/message-favorites', body);
  const button = Button({ label: '消息收藏', size: 'sm', onClick: open });
  const visibility = () => { button.hidden = !model.enabled; };
  store.subscribe(visibility);
  visibility();

  function mark(message, projectId) {
    if (!model.enabled || !['user', 'assistant'].includes(message.role) || !message.text?.trim() || message.status === 'pending') return null;
    const messageKey = key(projectId, message.id);
    const generation = model.epoch;
    const node = Button({ label: '收藏消息', kind: 'ghost', size: 'sm', dataset: { favoriteMessage: messageKey },
      onClick: async () => {
        if (!model.current(generation)) return;
        const id = model.marks.get(messageKey);
        try {
          const doc = await post(id ? { action: 'remove', id, revision: model.revision }
            : { action: 'add', messageId: message.id, projectId });
          if (model.current(generation)) model.accept(doc);
        } catch (error) {
          if (!model.current(generation)) return;
          if (error.status === 409) {
            const doc = await post({ action: 'marks' });
            if (!model.current(generation)) return;
            model.accept(doc);
            throw new Error('收藏列表已更新，请核对后重试。');
          }
          throw error;
        }
      } });
    model.paint(node);
    return node;
  }

  function open() {
    const generation = model.epoch;
    if (!model.current(generation)) return;
    let doc, backup, preview;
    let busy = false;
    const drawer = openDrawer({ title: '消息收藏', wide: true, onClose: () => unsubscribe() });
    const current = () => drawer.el.open && model.current(generation);
    const unsubscribe = store.subscribe(() => { if (!current()) drawer.close(); });
    const status = h('p', { role: 'status', class: 'small' });
    const search = Input({ type: 'search', placeholder: '搜索收藏', 'aria-label': '搜索收藏', oninput: renderRows });
    const file = Input({ type: 'file', accept: '.json,application/json', onchange: selectFile });
    const actions = h('fieldset', { class: 'stack' });
    const rows = h('div', { class: 'stack', 'aria-label': '收藏列表' });
    const review = h('div', { class: 'stack' });
    replace(actions, search, h('div', { class: 'row row--wrap' },
      Button({ label: '下载收藏备份', onClick: () => run(async () => {
        const data = await post({ action: 'backup' });
        if (current()) download('message-favorites.json', JSON.stringify(data, null, 2), 'application/json');
      }) }),
      Button({ label: '下载 Markdown', onClick: () => run(async () => {
        await load();
        if (!current()) return;
        const sections = doc.items.map(item => [
          '## ' + item.title, speaker(item.role) + ' · ' + item.createdAt + (item.messageId ? '' : ' · 恢复快照'), item.text,
          item.omitted ? '已省略 ' + item.omitted + ' 个字符' : '',
        ].filter(Boolean).join('\n\n'));
        download('message-favorites.md', ['# 消息收藏', ...sections].join('\n\n'), 'text/markdown;charset=utf-8');
      }) })),
      Field({ label: '导入收藏备份', control: file, hint: '选择不超过 8 MiB 的 JSON 文件。' }), review, rows);
    replace(drawer.body, status, actions);

    async function run(work) {
      if (busy || !current()) return;
      busy = true;
      actions.disabled = true;
      status.textContent = '';
      try { await work(); }
      catch (error) {
        if (current()) {
          status.textContent = error.message;
          if (error.status === 409) {
            preview = undefined;
            renderPreview();
            status.textContent = '收藏列表已更改，请核对最新列表后重试。';
            try { await load(); } catch (cause) { if (current()) status.textContent = cause.message; }
          }
        }
      } finally {
        busy = false;
        if (current()) actions.disabled = false;
      }
    }
    async function load() {
      const next = await post({ action: 'list' });
      if (current()) { doc = next; model.accept(next); renderRows(); }
    }
    function renderRows() {
      if (!doc) {
        replace(rows, Button({ label: '重新读取收藏', onClick: () => run(load) }));
        return;
      }
      const terms = fold(search.value.trim()).split(/\s+/).filter(Boolean);
      const found = doc.items.filter(item => {
        const text = fold([item.title, speaker(item.role), item.text].join('\n'));
        return terms.every(term => text.includes(term));
      });
      replace(rows, !found.length && h('p', { class: 'muted' }, terms.length ? '没有匹配的收藏。' : '还没有收藏的消息。'), found.map(item => {
        const original = h('div', { class: 'stack' });
        return h('article', { class: 'card' }, h('div', { class: 'card__body stack' },
          h('strong', null, item.title), h('p', { class: 'small muted' }, speaker(item.role), ' · ', item.createdAt, !item.messageId && ' · 恢复快照'),
          h('pre', { class: 'mailbox-content' }, item.text), item.omitted > 0 && h('p', { class: 'small muted' }, '已省略 ' + item.omitted + ' 个字符'),
          h('div', { class: 'row row--wrap' },
            item.messageId && Button({ label: '查看原文', size: 'sm', onClick: () => run(async () => {
              const source = await post({ action: 'source', id: item.id });
              if (current()) replace(original, h('strong', null, '消息原文'), h('pre', { class: 'mailbox-content' }, source.text));
            }) }),
            Button({ label: '复制正文', size: 'sm', onClick: () => run(async () => {
              if (!navigator.clipboard?.writeText) throw new Error('当前浏览器无法写入剪贴板，请选中收藏正文复制。');
              await navigator.clipboard.writeText(item.text);
              if (current()) status.textContent = '已复制正文。';
            }) }),
            Button({ label: '取消收藏', size: 'sm', onClick: () => run(async () => {
              const next = await post({ action: 'remove', id: item.id, revision: doc.revision });
              if (current()) { doc = next; model.accept(next); renderRows(); }
            }) })), original));
      }));
    }
    async function selectFile() {
      const selected = file.files?.[0];
      backup = undefined;
      preview = undefined;
      renderPreview();
      if (!selected) return;
      await run(async () => {
        if (selected.size > fileLimit) throw new Error('备份文件超过 8 MiB。');
        const content = await selected.text();
        if (!current()) return;
        try { backup = JSON.parse(content); }
        catch { throw new Error('文件不是有效的 JSON 备份。'); }
        await getPreview();
      });
    }
    async function getPreview() {
      const next = await post({ action: 'preview', backup });
      if (current()) { preview = next; renderPreview(); }
    }
    function renderPreview() {
      replace(review, preview && h('p', { role: 'status' }, '共 ' + preview.total + ' 条，待恢复 ' + preview.toAdd + ' 条，已收藏 ' + preview.alreadySaved + ' 条，剩余容量 ' + preview.available + ' 条。'),
        backup !== undefined && !preview && Button({ label: '重新预览', onClick: () => run(getPreview) }),
        preview && Button({ label: '确认恢复', kind: 'primary', disabled: !preview.toAdd || preview.toAdd > preview.available, onClick: () => run(async () => {
          const result = await post({ action: 'restore', backup, revision: preview.revision });
          if (!current()) return;
          backup = preview = undefined;
          file.value = '';
          renderPreview();
          status.textContent = '已恢复 ' + result.toAdd + ' 条收藏。';
          await load();
        }) }));
    }
    renderRows();
    void run(load);
  }
  return { button, mark, get epoch() { return model.epoch; } };
}

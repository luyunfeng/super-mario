// 主对话和项目工作对话共享收藏标记。消息正文只保留在打开的抽屉中。
import { h, keyedList, replace } from '../lib/dom.js';
import { Button, Field, Input } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const models = new WeakMap();
const fileLimit = 8 * 1024 * 1024;
const key = (projectId, messageId) => JSON.stringify([projectId || '', messageId]);
const nativeKey = (native, index, fingerprint) => JSON.stringify([
  native.machineId, native.executorId, native.nativeSessionId, native.cwd, index, fingerprint,
]);
const speaker = role => role === 'user' ? '我' : '助手';
function favoriteMetadata(item) {
  return [speaker(item.role), item.createdAt || '收藏于 ' + item.starredAt, !item.messageId && !item.native && '恢复快照'].filter(Boolean).join(' · ');
}
const fold = text => text.normalize('NFKC').toLocaleLowerCase();

const pageSize = 24;

function snapshotPreview(text) {
  const lines = text.split('\n', 7);
  const visible = lines.length > 6 ? lines.slice(0, 6).join('\n') : text;
  return Array.from(visible).slice(0, 420).join('');
}

function watchChanges(store, callback) {
  let revision = store.view.messageFavoritesRevision, connection = store.view.connection;
  return store.subscribe(view => {
    const reconnected = connection !== 'online' && view.connection === 'online';
    const changed = revision !== view.messageFavoritesRevision;
    revision = view.messageFavoritesRevision;
    connection = view.connection;
    if (changed || reconnected) callback(revision, reconnected);
  });
}

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
    if (doc.revision < revision || doc.revision < store.view.messageFavoritesRevision) return;
    revision = doc.revision;
    marks.clear();
    for (const item of doc.items) {
      if (item.native) marks.set(nativeKey(item.native, item.index, item.fingerprint), item.id);
      else if (item.messageId) marks.set(key(item.projectId, item.messageId), item.id);
    }
    document.querySelectorAll('[data-favorite-message]').forEach(paint);
  }
  function update() {
    const active = messageFavoritesActive(store);
    if (enabled === active && token === api.token()) return;
    enabled = active;
    token = api.token();
    ++epoch;
    revision = -1;
    marks.clear();
    document.querySelectorAll('[data-favorite-message]').forEach(paint);
    if (enabled) refreshMarks();
  }
  function refreshMarks() {
    const generation = epoch;
    void api.post('/message-favorites', { action: 'marks' }).then(doc => {
      if (current(generation)) accept(doc);
    }).catch(() => { /* 打开收藏列表时会重新读取，并在抽屉中显示读取失败的原因。 */ });
  }
  function current(generation) { return enabled && epoch === generation && token === api.token(); }
  const model = { paint, accept, current, marks, get epoch() { return epoch; }, get revision() { return revision; }, get enabled() { return enabled; } };
  models.set(api, model);
  store.subscribe(update);
  watchChanges(store, (next, reconnected) => {
    if (enabled && (reconnected || next > revision)) refreshMarks();
  });
  update();
  return model;
}

export function messageFavoritesActive(store) {
  return !store.view.unauthorized && !!store.view.snapshot?.plugins?.some(p => p.id === 'message-favorites' && p.status === 'active');
}

function favoriteButton(api, model, messageKey, addition, { isVisible = () => true, onError } = {}) {
  const generation = model.epoch;
  const current = () => model.current(generation) && isVisible();
  const post = body => api.post('/message-favorites', body);
  const node = Button({ label: '收藏消息', kind: 'ghost', size: 'sm', dataset: { favoriteMessage: messageKey },
    onClick: async () => {
      if (!current()) return;
      const id = model.marks.get(messageKey);
      try {
        const doc = await post(id ? { action: 'remove', id, revision: model.revision } : addition);
        if (model.current(generation)) model.accept(doc);
      } catch (error) {
        if (!current()) return;
        if (id && error.status === 409) {
          const doc = await post({ action: 'marks' });
          if (!current()) return;
          model.accept(doc);
          error = new Error('收藏列表已更新，请核对后重试。');
        }
        if (onError) onError(error.message);
        else throw error;
      }
    } });
  model.paint(node);
  return node;
}

export function openNativeMessages({ api, store, native, target, onClose }) {
  const model = sharedModel(api, store);
  const generation = model.epoch;
  if (!model.current(generation)) return;
  const pageSize = 25;
  const route = location.hash;
  let offset = target ? Math.floor(target.index / pageSize) * pageSize : 0;
  let sequence = 0;
  const drawer = openDrawer({ title: 'CLI 会话消息', subtitle: native.executorId + ' · ' + native.nativeSessionId,
    wide: true, onClose() { unsubscribe(); onClose?.(); } });
  const current = () => drawer.el.open && model.current(generation) && route === location.hash;

  function problem() {
    if (store.view.connection !== 'online') return '工作台连接不可用。';
    const machine = store.view.snapshot?.machines?.find(item => item.id === native.machineId);
    if (!machine?.online) return '来源电脑已离线。';
    if (!machine.capabilities?.includes('agents.transcript')) return '来源电脑不支持只读会话全文。';
    return '';
  }
  function showProblem(reason) {
    replace(drawer.body, h('p', { role: 'alert' }, reason),
      Button({ label: '重新读取本页', onClick: () => load(offset) }));
  }
  const unsubscribe = store.subscribe(() => {
    if (!current()) { drawer.close(); return; }
    const reason = problem();
    if (reason) { sequence++; showProblem(reason); }
  });

  async function load(nextOffset) {
    if (!current()) return;
    const order = ++sequence;
    offset = nextOffset;
    const valid = () => current() && order === sequence && !problem();
    const reason = problem();
    if (reason) { showProblem(reason); return; }
    replace(drawer.body, h('p', { role: 'status' }, '正在读取会话消息…'));
    try {
      const page = await api.post('/message-favorites', { action: 'nativePage', native, offset });
      if (!valid()) return;
      const locating = target && target.index >= offset && target.index < offset + pageSize;
      // 同位置的消息可能在日志轮换后改变。先核对指纹，再展示这一页或移动焦点。
      if (locating && !page.items.some(item => item.index === target.index && item.fingerprint === target.fingerprint)) {
        showProblem('原消息已变更，无法定位收藏的原文。');
        return;
      }
      const pager = h('div', { class: 'row row--wrap' },
        Button({ label: '上一页', size: 'sm', disabled: offset === 0, onClick: () => load(Math.max(0, offset - pageSize)) }),
        h('span', { class: 'small', role: 'status' }, '第 ' + (Math.floor(offset / pageSize) + 1) + ' 页 · 共 ' + page.total + ' 条'),
        Button({ label: '下一页', size: 'sm', disabled: offset + pageSize >= page.total, onClick: () => load(offset + pageSize) }));
      const rows = page.items.map(item => {
        const hit = locating && item.index === target.index;
        return h('article', { class: 'card', dataset: { nativeIndex: item.index }, tabIndex: -1,
          'aria-current': hit ? 'true' : undefined, style: hit ? { outline: '2px solid var(--brand)' } : undefined },
          h('div', { class: 'card__body stack' },
            h('strong', null, speaker(item.role), ' · 第 ' + (item.index + 1) + ' 条'),
            h('span', { class: 'small muted' }, item.createdAt ?? '消息时间未知'),
            h('pre', { class: 'mailbox-content' }, item.text),
            favoriteButton(api, model, nativeKey(native, item.index, item.fingerprint),
              { action: 'addNative', native, index: item.index, fingerprint: item.fingerprint },
              { isVisible: valid, onError: showProblem })));
      });
      replace(drawer.body, pager, !rows.length && h('p', null, '本页没有消息。'), rows);
      const hit = drawer.body.querySelector('[aria-current="true"]');
      hit?.focus({ preventScroll: true });
      hit?.scrollIntoView({ block: 'center' });
    } catch (error) { if (valid()) showProblem(error.message); }
  }

  void load(offset);
  return drawer;
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  h('a', { download: name, href: url }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createMessageFavorites({ api, store, router }) {
  const model = sharedModel(api, store);
  const post = body => api.post('/message-favorites', body);
  const button = Button({ label: '消息收藏', size: 'sm', onClick: open });
  const visibility = () => { button.hidden = !model.enabled; };
  store.subscribe(visibility);
  visibility();

  function mark(message, projectId) {
    if (!model.enabled || !['user', 'assistant'].includes(message.role) || !message.text?.trim() || message.status === 'pending') return null;
    return favoriteButton(api, model, key(projectId, message.id), { action: 'add', messageId: message.id, projectId });
  }

  function open() {
    const generation = model.epoch;
    if (!model.current(generation)) return;
    let doc, backup, preview;
    let busy = false, limit = pageSize, refreshOrder = 0;
    const drawer = openDrawer({ title: '消息收藏', wide: true, onClose() { unsubscribe(); unwatch(); } });
    const current = () => drawer.el.open && model.current(generation);
    const unsubscribe = store.subscribe(() => { if (!current()) drawer.close(); });
    const unwatch = watchChanges(store, (next, reconnected) => {
      if (current() && (reconnected || next > (doc?.revision ?? -1))) void refresh();
    });
    const status = h('p', { role: 'status', class: 'small' });
    const refreshError = h('div', { class: 'small' });
    async function refresh() {
      const order = ++refreshOrder;
      try { await load(); }
      catch (error) {
        if (current() && order === refreshOrder) replace(refreshError, error.message, Button({ label: '重新读取收藏', onClick: refresh }));
      }
    }
    const search = Input({ type: 'search', placeholder: '搜索收藏', 'aria-label': '搜索收藏', oninput() { limit = pageSize; renderRows(); } });
    const file = Input({ type: 'file', accept: '.json,application/json', onchange: selectFile });
    const actions = h('fieldset', { class: 'stack' });
    const rows = h('div', { class: 'stack', 'aria-label': '收藏列表' });
    const empty = h('p', { class: 'muted' });
    const more = Button({ label: '显示更多消息', size: 'sm', onClick() {
      const firstNew = limit;
      limit += pageSize;
      renderRows();
      rows.children[firstNew]?.focus();
    } });
    const review = h('div', { class: 'stack' });
    replace(actions, search, h('div', { class: 'row row--wrap' },
      Button({ label: '下载收藏备份', onClick: () => run(async () => {
        const data = await post({ action: 'backup' });
        if (current()) download('message-favorites.json', JSON.stringify(data, null, 2), 'application/json');
      }) }),
      Button({ label: '下载 Markdown', onClick: () => run(async () => {
        await load();
        if (!current()) return;
        if (!doc || doc.revision < store.view.messageFavoritesRevision) throw new Error('收藏列表已更改，请重新下载。');
        const sections = doc.items.map(item => [
          '## ' + item.title, favoriteMetadata(item), item.text,
          item.omitted ? '已省略 ' + item.omitted + ' 个字符' : '',
        ].filter(Boolean).join('\n\n'));
        download('message-favorites.md', ['# 消息收藏', ...sections].join('\n\n'), 'text/markdown;charset=utf-8');
      }) })),
      Field({ label: '导入收藏备份', control: file, hint: '选择不超过 8 MiB 的 JSON 文件。' }), review, refreshError, empty, rows, more);
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
      if (current()) acceptList(next);
    }
    function acceptList(next) {
      if (next.revision < (doc?.revision ?? -1) || next.revision < store.view.messageFavoritesRevision) return;
      refreshError.replaceChildren();
      doc = next;
      model.accept(next);
      renderRows();
    }
    function renderRows() {
      if (!doc) {
        empty.hidden = true;
        more.hidden = true;
        replace(refreshError, Button({ label: '重新读取收藏', onClick: refresh }));
        return;
      }
      const terms = fold(search.value.trim()).split(/\s+/).filter(Boolean);
      const found = doc.items.filter(item => {
        const text = fold([item.title, speaker(item.role), item.text].join('\n'));
        return terms.every(term => text.includes(term));
      });
      empty.hidden = found.length > 0;
      empty.textContent = terms.length ? '没有匹配的收藏。' : '还没有收藏的消息。';
      more.hidden = found.length <= limit;
      const focused = document.activeElement;
      const hadFocus = rows.contains(focused);
      keyedList(rows, found.slice(0, limit), item => item.id, renderItem);
      if (hadFocus && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    }
    function renderItem(item) {
      const excerpt = snapshotPreview(item.text);
      const content = h('pre', { class: 'mailbox-content' }, excerpt);
      const toggle = excerpt !== item.text && Button({ label: '显示已保存的全文', size: 'sm', onClick() {
        const expanded = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.textContent = expanded ? '收起' : '显示已保存的全文';
        content.textContent = expanded ? item.text : excerpt;
      } });
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
      const original = h('div', { class: 'stack' });
      return h('article', { class: 'card', tabIndex: -1 }, h('div', { class: 'card__body stack' },
        h('strong', null, item.title), h('p', { class: 'small muted' }, favoriteMetadata(item)),
        content, toggle, item.omitted > 0 && h('p', { class: 'small muted' }, '已省略 ' + item.omitted + ' 个字符'),
        h('div', { class: 'row row--wrap' },
          item.native && Button({ label: '查看原文', size: 'sm', onClick: () => {
            if (current()) openNativeMessages({ api, store, native: item.native, target: item,
              onClose: () => { if (current()) void run(load); } });
          } }),
          item.messageId && Button({ label: '查看原文', size: 'sm', onClick: () => run(async () => {
            const source = await post({ action: 'source', id: item.id });
            if (current()) replace(original, h('strong', null, '消息原文'), h('pre', { class: 'mailbox-content' }, source.text));
          }) }),
          item.messageId && Button({ label: '定位到原会话', size: 'sm', onClick: () => run(async () => {
            const source = await post({ action: 'locate', id: item.id });
            if (!current()) return;
            const route = source.projectId ? router.href('projects', source.projectId, 'workspace') + '?at=' : router.href('chat') + '?favorite=';
            drawer.close();
            router.go(route + encodeURIComponent(source.messageId));
          }) }),
          Button({ label: '复制正文', size: 'sm', onClick: () => run(async () => {
            if (!navigator.clipboard?.writeText) throw new Error('当前浏览器无法写入剪贴板，请选中收藏正文复制。');
            await navigator.clipboard.writeText(item.text);
            if (current()) status.textContent = '已复制正文。';
          }) }),
          Button({ label: '取消收藏', size: 'sm', onClick: () => run(async () => {
            const next = await post({ action: 'remove', id: item.id, revision: doc.revision });
            if (current()) {
              acceptList(next);
              requestAnimationFrame(() => {
                if (current() && [document.body, drawer.el].includes(document.activeElement)) search.focus();
              });
            }
          }) })), original));
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

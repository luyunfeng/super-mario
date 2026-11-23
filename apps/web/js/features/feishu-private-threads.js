import { messageFiles } from './message-files.js';
import { messageImages } from './message-images.js';
import { h, replace } from '../lib/dom.js';
import { conversationExportActive, openConversationExport } from './conversation-export.js';
import { editThreadOrder } from './feishu-thread-order.js';
import { editThreadTagFilters } from './feishu-tag-filters.js';
import { conversationModelPicker } from './model-drawer.js';
import { Button, Field, Input, Select, copyText } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

export function openPrivateThreads({ api, bot, store, onClose, target }) {
  const base = '/feishu/bots/' + encodeURIComponent(bot.id) + '/threads';
  const owner = api.draftOwner(), route = location.hash;
  const body = h('div', { class: 'stack', 'aria-live': 'polite' });
  let loadId = 0;
  let childEditor, closeReason;
  let exportButton;
  let knownTags = [];
  const valid = () => api.draftOwner() === owner && location.hash === route && !store.view.unauthorized &&
    store.view.snapshot?.plugins?.some(plugin => plugin.id === 'feishu' && plugin.status === 'active');
  const drawer = openDrawer({ title: '独立对话记录', subtitle: bot.name, body,
    onClose() { loadId++; childEditor?.close(); unsubscribe(); onClose(closeReason); } });
  let archived = false;
  let query = '';
  let selectedTag = '';
  // Keep loaded search pages when returning from a message. A write invalidates the cache.
  let searchPage;
  const hasSearch = () => store.view.snapshot?.plugins?.some(plugin => plugin.id === 'conversation-search' && plugin.status === 'active');
  let searchEnabled = hasSearch();
  let lastSnapshot = store.view.snapshot;
  let showingList = false;
  let openThreadId;
  let pendingDelete;
  let listNotice = '';
  let lastDeletion = store.view.deletedFeishuThread;
  let connection = store.view.connection;
  let bindingChange = store.view.feishuBotChange;
  function setSearchEnabled(enabled) {
    if (enabled === searchEnabled) return;
    searchEnabled = enabled;
    query = '';
    searchPage = undefined;
    if (showingList) void list();
    else if (!target) body.querySelector('mark')?.remove();
  }
  const unsubscribe = store.subscribe(() => {
    if (!valid()) {
      closeReason='当前身份、配对或插件已变化，请重新打开独立对话链接。';
      return drawer.close();
    }
    if(target && bindingChange!==store.view.feishuBotChange) {
      bindingChange=store.view.feishuBotChange;
      if(bindingChange?.botId===bot.id && bindingChange.bindingChanged) {
        closeReason='机器人配对或配置已变化，请重新打开链接核对。';
        return drawer.close();
      }
    }
    const nextConnection = store.view.connection;
    const reconnected = nextConnection === 'online' && connection !== 'online';
    connection = nextConnection;
    const change = store.view.deletedFeishuThread;
    if (change !== lastDeletion) {
      lastDeletion = change;
      if (change?.botId === bot.id) {
        searchPage = undefined;
        if (openThreadId === change.threadId && pendingDelete !== change.threadId) void deleted();
        else if (showingList) void list(listNotice);
      }
    }
    if (reconnected) {
      searchPage = undefined;
      if (showingList) void list(listNotice);
      else if (openThreadId && openThreadId !== pendingDelete) {
        if(target) void detail({threadId:openThreadId},'',undefined,target.messageId);
        else void verifyOpenThread(openThreadId);
      }
    }
    if (lastSnapshot !== store.view.snapshot) {
      lastSnapshot = store.view.snapshot;
      if (exportButton) exportButton.hidden = !conversationExportActive(store);
      setSearchEnabled(hasSearch());
    }
  });
  const current = id => id === loadId && drawer.el.open && valid();
  const back = () => target ? Button({label:'返回 Agent',onClick:drawer.close})
    : Button({ label: '返回列表', onClick: () => list() });
  function inaccessible(error) {
    if (![401, 403, 404].includes(error.status) && !(error.status === 503 && error.message.includes('飞书插件已停用'))) return false;
    closeReason='此独立对话链接在当前配对下不可用。';
    drawer.close();
    return true;
  }
  function deleted(notice = '该独立对话此前已被删除。') {
    searchPage = undefined;
    knownTags = [];
    childEditor?.close();
    if (target) {
      loadId++;openThreadId=undefined;
      replace(body,h('p',{role:'alert'},notice),back());
      return;
    }
    return list(notice);
  }
  async function verifyOpenThread(threadId) {
    const id = loadId;
    try {
      await api.get(base + '/' + encodeURIComponent(threadId));
      if (current(id)) body.querySelector('[data-recheck]')?.remove();
    }
    catch (error) {
      if (!current(id) || threadId === pendingDelete || inaccessible(error)) return;
      if (error.status === 410) void deleted();
      else if (!body.querySelector('[data-recheck]')) body.prepend(h('p', { role: 'alert', dataset: { recheck: '1' } },
        '重连后暂时无法核对这段对话。', Button({ label: '重新核对', onClick: () => verifyOpenThread(threadId) })));
    }
  }
  async function load(path, show, retry) {
    const id = ++loadId;
    replace(body, h('p', { role: 'status' }, '正在读取…'));
    try {
      const result = await api.get(path);
      if (current(id)) show(result, id);
    } catch (error) {
      if (!current(id) || inaccessible(error)) return;
      if (error.status === 410) return deleted();
      if (error.status === 409) searchPage = undefined;
      replace(body, h('p', { role: 'alert' }, error.message),
        Button({ label: '重试', onClick: retry }), back());
    }
  }
  function list(notice = '') {
    exportButton = undefined;
    showingList = true;
    openThreadId = undefined;
    listNotice = notice;
    const id = ++loadId;
    const input = Input({ value: query, type: 'text', maxLength: 500 });
    const results = h('div', { class: 'stack', 'aria-live': 'polite' });
    const search = (text, scope) => {
      query = text.trim();
      archived = scope;
      searchPage = undefined;
      return list();
    };
    const filter = value => Button({ label: value ? '已归档' : '未归档', disabled: value === archived,
      onClick: () => search(input.value, value) });
    const select = Select({ options: [['', '全部标签'], ...(selectedTag ? [[selectedTag, selectedTag]] : [])], value: selectedTag });
    select.addEventListener('change', () => {
      selectedTag = select.value;
      void search(input.value, archived);
    });
    const tagFilter = Field({ label: '筛选标签', control: select });
    let tagState;
    function useFilters(state) {
      tagState = state;
      knownTags = state.tags;
      const available = state.filters ?? state.tags;
      if (selectedTag && !available.includes(selectedTag)) {
        selectedTag = '';
        searchPage = undefined;
        void list(notice);
        return;
      }
      replace(select, h('option', { value: '' }, '全部标签'), available.map(tag => h('option', { value: tag }, tag)));
      select.value = selectedTag;
      manage.disabled = false;
    }
    const manage = Button({ label: '管理标签筛选', disabled: true, size: 'sm', onClick: () => {
      if (!current(id) || !tagState) return;
      childEditor = editThreadTagFilters({ api, path: base + '/tags', state: tagState,
        onSaved(state) {
          if (!drawer.el.open || !valid() || !showingList) return;
          if (!(state.filters ?? state.tags).includes(selectedTag)) selectedTag = '';
          searchPage = undefined;
          void list();
        }, onInvalid: () => drawer.close() });
    } });
    async function loadTags() {
      try {
        const state = await api.get(base + '/tags');
        if (current(id)) useFilters(state);
      } catch (error) {
        if (!current(id) || inaccessible(error)) return;
        tagFilter.append(h('span', { role: 'alert' }, '标签读取失败：' + error.message),
          Button({ label: '重试读取标签', onClick: () => list() }));
      }
    }
    const sort = Button({ label: '调整对话顺序', size: 'sm', onClick: () => {
      if (!current(id)) return;
      childEditor = editThreadOrder({ api, base, valid: () => drawer.el.open && valid(),
        onSaved() { searchPage = undefined; if (showingList) void list(); }, onInvalid: () => drawer.close() });
    } });
    void loadTags();
    replace(body, notice && h('p', { role: 'status' }, notice), h('div', { class: 'row' }, filter(false), filter(true), sort), tagFilter, manage,
      searchEnabled ? h('form', { class: 'stack', onsubmit: event => { event.preventDefault(); void search(input.value, archived); } },
        Field({ label: '搜索独立对话', control: input }),
        h('div', { class: 'row' }, Button({ label: '搜索', type: 'submit' }),
          query && Button({ label: '清除搜索', onClick: () => search('', archived) })))
        : h('p', { class: 'muted' }, '对话历史搜索插件已停用。'), results);
    const openThread = row => Button({ label: row.title + ' · ' + row.count + ' 条消息', onClick: () => detail(row) });
    function showResults() {
      const items = searchPage.items;
      replace(results, items.length ? items.map(row => h('div', { class: 'stack' }, openThread(row),
        row.titleMatch && h('span', { class: 'small muted' }, '标题匹配'),
        row.hits.map(hit => Button({ label: (hit.role === 'user' ? '用户' : '助手') + ' · ' + hit.excerpt,
          size: 'sm', onClick: () => detail(row, '', undefined, hit.id) }))))
        : h('p', { class: 'muted' }, '没有找到匹配的独立对话。'),
        searchPage.nextBefore && Button({ label: '加载更多结果', onClick: () => read(searchPage.nextBefore) }));
    }
    async function read(before) {
      if (!before) replace(results, h('p', { role: 'status' }, '正在读取…'));
      try {
        const params = new URLSearchParams();
        if (selectedTag) params.set('tag', selectedTag);
        if (!query) {
          if (archived) params.set('archived', '1');
          const rows = await api.get(base + (params.size ? '?' + params : ''));
          if (current(id)) replace(results, rows.length ? rows.map(openThread)
            : h('p', { class: 'muted' }, selectedTag ? '当前标签下暂无独立对话。' : archived ? '暂无已归档对话。' : '暂无独立对话。可在机器人私聊发送 /new 加第一条消息。'));
          return;
        }
        params.set('q', query);
        params.set('archived', archived ? '1' : '0');
        if (before) params.set('before', before);
        const page = await api.get(base + '/search?' + params);
        if (!current(id)) return;
        searchPage = { items: before ? [...searchPage.items, ...page.items] : page.items, nextBefore: page.nextBefore };
        showResults();
      } catch (error) {
        if (!current(id) || inaccessible(error)) return;
        if (query && error.status === 503 && error.message.includes('搜索插件已停用')) {
          setSearchEnabled(false);
          void store.refresh();
          return;
        }
        if (before && error.status !== 409) showResults();
        else { searchPage = undefined; replace(results, Button({ label: '重新读取', onClick: () => read() })); }
        results.append(h('p', { role: 'alert' }, error.message));
      }
    }
    if (query && searchPage) showResults();
    else return read();
  }
  function detail(row, notice = '', draft, around) {
    showingList = false;
    openThreadId = row.threadId;
    const path = base + '/' + encodeURIComponent(row.threadId);
    return load(path + (around ? '?around=' + encodeURIComponent(around) : ''), (page, id) => {
      if (target && (page.threadId!==row.threadId || (around && !page.messages.some(message=>message.id===around)))) {
        replace(body,h('p',{role:'alert'},'原消息位置已失效，请重新获取对话链接。'),back());
        return;
      }
      renderDetail(path, { ...row, ...page }, page.messages, page.nextBefore, page.nextAfter, notice, id, draft, around);
    }, () => detail(row, notice, draft, around));
  }
  function renderDetail(path, row, messages, nextBefore, nextAfter, notice, id, draft, around) {
    if (!query) archived = !!row.archived;
    const feedback = h('p', { role: 'status', class: 'small muted' }, notice);
    const selectionPanel = h('div', { class: 'stack', 'aria-label': '飞书私聊去向' });
    const selectionStatus = h('p', { role: 'status', class: 'small muted' });
    let selection = row.selection, selectionArchived = row.archived, selectionBusy = false;
    const selectionCurrent = () => current(id) && openThreadId === row.threadId;
    const selectButton = Button({ label: '在飞书继续聊', size: 'sm', onClick: selectThread });
    const refreshSelection = Button({ label: '核对当前去向', size: 'sm', kind: 'ghost', onClick: () => checkSelection() });
    function updateSelectionButtons() {
      selectButton.disabled = selectionBusy || selectionArchived || typeof selection?.version !== 'string' ||
        !selection.version || selection.selected !== false;
      refreshSelection.disabled = selectionBusy;
    }
    function paintSelection(note = '') {
      updateSelectionButtons();
      const verified = typeof selection?.version === 'string' && !!selection.version && typeof selection.selected === 'boolean';
      selectionStatus.textContent = [note, selectionArchived ? '对话已归档。' : !verified ? '当前去向待核对。'
        : selection.selected ? '当前已选为飞书私聊去向。' : '当前未选为飞书私聊去向。'].filter(Boolean).join(' ');
    }
    async function checkSelection(note = '') {
      if (!selectionCurrent() || selectionBusy) return;
      selectionBusy = true;
      paintSelection('正在核对…');
      try {
        const latest = await api.get(path);
        if (!selectionCurrent()) return;
        if (latest.threadId !== row.threadId) throw Error('对话身份已变化。');
        selection = row.selection = latest.selection;
        selectionArchived = latest.archived;
        paintSelection(note);
      } catch (error) {
        if (!selectionCurrent() || inaccessible(error)) return;
        if (error.status === 410) return deleted();
        selection = undefined;
        paintSelection('核对失败：' + error.message);
      } finally {
        selectionBusy = false;
        if (selectionCurrent()) updateSelectionButtons();
      }
    }
    async function selectThread() {
      if (!selectionCurrent() || selectButton.disabled || selectionBusy || selectionArchived || !selection?.version) return;
      selectionBusy = true;
      paintSelection('正在切换…');
      try {
        const next = await api.post(path + '/select', { version: selection.version });
        if (!selectionCurrent()) return;
        if (next?.selected !== true || !next.version || typeof next.version !== 'string') throw Error('未收到有效回执。');
        selection = row.selection = next;
        paintSelection();
      } catch (error) {
        if (!selectionCurrent() || inaccessible(error)) return;
        if (error.status === 410) return deleted();
        selection = undefined;
        if (error.status === 409) {
          selectionBusy = false;
          await checkSelection('去向已变化，已重新核对。');
        } else paintSelection('切换未确认，请核对当前去向。' + error.message);
      } finally {
        selectionBusy = false;
        if (selectionCurrent()) updateSelectionButtons();
      }
    }
    if (row.selection) {
      selectionPanel.append(h('p', { class: 'small' }, '切换后，你在飞书私聊中下一条未引用消息会进入这段对话。'),
        selectionStatus, h('div', { class: 'row row--wrap' }, selectButton, refreshSelection));
      paintSelection();
    }
    const title = Input({ value: draft?.title ?? row.title });
    const savedTags = row.tags ?? [];
    const tags = [...(draft?.tags ?? savedTags)];
    const suggestions = h('datalist', { id: 'thread-tags-' + id });
    const tagInput = Input({ value: draft?.tagInput ?? '', list: suggestions.id });
    const showSuggestions = tags => replace(suggestions, tags.map(tag => h('option', { value: tag })));
    showSuggestions(knownTags);
    void api.get(base + '/tags').then(state => {
      if (current(id)) { knownTags = state.tags; showSuggestions(knownTags); }
    }, error => { if (current(id) && !inaccessible(error)) feedback.textContent = '标签建议读取失败，请手动输入。'; });
    const edit = h('fieldset', { class: 'stack', 'aria-label': '对话管理' });
    async function save(change) {
      if (!current(id) || edit.disabled) return;
      if (change.title && Array.from(change.title).length > 80) {
        feedback.textContent = '对话标题最多 80 个字符。';
        return;
      }
      const pending = {
        title: title.value !== row.title ? title.value : undefined,
        tags: JSON.stringify(tags) !== JSON.stringify(savedTags) ? [...tags] : undefined,
        tagInput: tagInput.value,
      };
      edit.disabled = true;
      searchPage = undefined;
      try {
        const saved = await api.patch(path, { version: row.version, ...change });
        if (!current(id)) return;
        if ('title' in change) pending.title = undefined;
        if ('tags' in change) pending.tags = undefined;
        renderDetail(path, { ...row, ...saved }, messages, nextBefore, nextAfter,
          change.archived === true ? '已归档。收到新的用户消息后会自动恢复。' :
          change.archived === false ? '已恢复对话。' : change.tags ? '已保存标签。' : '已保存标题。', ++loadId, pending, around);
      } catch (error) {
        if (!current(id) || inaccessible(error)) return;
        if (error.status === 410) return deleted();
        if (error.status === 409 || !error.status || error.status >= 500) {
          searchPage = undefined;
          const conflict = error.status === 409;
          if (conflict && change.tags) pending.tags = [...change.tags];
          await detail(row, conflict ? '对话已在别处修改，已重新读取，请核对后再操作。' : '保存结果未知，已重新读取，请核对。',
            conflict ? pending : undefined, around);
        } else {
          feedback.textContent = error.message;
          edit.disabled = false;
        }
      }
    }
    function confirmDelete() {
      if (!current(id) || edit.disabled) return;
      const cancel = Button({ label: '取消', onClick: () => confirm.close() });
      const confirm = openDrawer({ title: '删除独立对话', body: [
        h('p', null, '删除「' + row.title + '」后，当前机器人的独立对话历史和搜索结果将移除这段对话。删除后无法恢复。'),
        h('div', { class: 'row' }, cancel, Button({ label: '确认删除', kind: 'danger', onClick: async () => {
          if (!confirm.el.open) return;
          confirm.close();
          if (!current(id)) { if (!valid()) drawer.close(); return; }
          const request = ++loadId;
          pendingDelete = row.threadId;
          searchPage = undefined;
          replace(body, h('p', { role: 'status' }, '正在删除独立对话…'));
          try {
            const result = await api.del(path, { version: row.version });
            if (!current(request)) return;
            if (result?.ok !== true || result.deleted !== true) throw new Error('服务端未确认删除');
            return deleted('已删除独立对话。');
          } catch (error) {
            if (!current(request)) return;
            if (error.status === 410) return deleted();
            if (error.status === 404) {
              replace(body, h('p', { role: 'alert' }, '未找到当前配对下的独立对话，无法确认删除。'), back());
              return;
            }
            if (inaccessible(error)) return;
            const message = error.status === 409 ? error.message + '。请重新核对对话后再操作。'
              : !error.status || error.status >= 500 ? '删除结果未知，请重新读取对话核对。'
              : '删除失败：' + error.message;
            replace(body, h('p', { role: 'alert' }, message),
              Button({ label: '重新读取对话', onClick: () => detail(row) }), back());
          } finally { pendingDelete = undefined; }
        } }))] });
      childEditor = confirm;
      cancel.focus();
    }
    edit.append(Field({ label: '对话标题', control: title }),
      h('div', { class: 'row row--wrap' }, Button({ label: '保存标题', size: 'sm', onClick: () => save({ title: title.value.trim() }) }),
        Button({ label: '还原默认标题', size: 'sm', onClick: () => save({ title: '' }) }),
        Button({ label: row.archived ? '恢复对话' : '归档对话', size: 'sm', onClick: () => save({ archived: !row.archived }) }),
        Button({ label: '删除对话', kind: 'danger', size: 'sm', onClick: confirmDelete })));
    const tagDraft = h('div', { class: 'row', style: { flexWrap: 'wrap' }, 'aria-label': '待保存标签' });
    const syncTags = () => replace(tagDraft, tags.map((tag, index) =>
      Button({ label: '移除 ' + tag, size: 'sm', onClick: () => { tags.splice(index, 1); syncTags(); } })));
    function addTag() {
      const tag = tagInput.value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
      if (!tag || Array.from(tag).length > 32) feedback.textContent = '每个标签须为 1 至 32 个字符。';
      else if (tags.includes(tag)) feedback.textContent = '该标签已添加。';
      else if (tags.length >= 10) feedback.textContent = '每个对话最多 10 个标签。';
      else {
        tags.push(tag);
        tagInput.value = '';
        feedback.textContent = '';
        syncTags();
      }
    }
    syncTags();
    edit.append(h('p', { class: 'muted small' }, '当前已保存标签：' + (savedTags.join('、') || '无')),
      tagDraft, Field({ label: '新标签', control: tagInput }), suggestions,
      h('div', { class: 'row' }, Button({ label: '添加标签', size: 'sm', onClick: addTag }),
        Button({ label: '保存标签', size: 'sm', onClick: () => {
          if (tagInput.value.trim()) { feedback.textContent = '请先添加输入的标签。'; return; }
          return save({ tags });
        } })));
    const picker = conversationModelPicker(api, path + '/model', row.title);
    const history = h('div', { class: 'stack' });
    const entries = items => items.map(message => h('section', { class: 'stack' },
      (query || target) && around && message.id === around && h('mark', { tabIndex: -1 }, '命中消息'),
      h('strong', null, (message.role === 'user' ? '用户' : '助手') + ' · ' + new Date(message.createdAt).toLocaleString()),
      h('p', { style: 'white-space: pre-wrap' }, message.text), messageImages(api,store,message),messageFiles(api,store,message,[])));
    history.append(...entries(messages));
    const more = older => Button({ label: older ? '加载更早消息' : '加载后续消息', onClick: async (_, button) => {
      try {
        const cursor = older ? nextBefore : nextAfter;
        const page = await api.get(path + (older ? '?before=' : '?after=') + encodeURIComponent(cursor));
        if (!current(id)) return;
        if (older) {
          messages = [...page.messages, ...messages];
          history.prepend(...entries(page.messages));
          nextBefore = page.nextBefore;
        } else {
          messages = [...messages, ...page.messages];
          history.append(...entries(page.messages));
          nextAfter = page.nextAfter;
        }
        button.hidden = !(older ? nextBefore : nextAfter);
      } catch (error) {
        if (!current(id) || inaccessible(error)) return;
        if (error.status === 410) return deleted();
        if (error.status === 409) await detail(row, '消息位置已变化，已重新读取最新消息。');
        else feedback.textContent = error.message;
      }
    } });
    exportButton = Button({ label: '导出对话', size: 'sm', onClick: () => {
      if (!current(id) || !conversationExportActive(store)) return;
      childEditor = openConversationExport({
        api, store, source: { botId: bot.id, threadId: row.threadId }, subtitle: row.title,
        isCurrent: () => current(id),
        onSourceError(error) {
          if (error.status === 410) { void deleted(); return true; }
          if (error.status === 503 && error.message.includes('对话导出插件已停用')) {
            exportButton.hidden = true;
            childEditor?.close();
            feedback.textContent = '对话导出插件已停用。';
            void store.refresh();
            return true;
          }
          return inaccessible(error);
        },
      });
    } });
    exportButton.hidden = !conversationExportActive(store);
    replace(body, back(), h('h3', null, row.title), row.selection && selectionPanel, exportButton, edit,
      Button({ label: '复制对话 ID', size: 'sm', onClick: async () => {
        try { await copyText(row.threadId); if (current(id)) feedback.textContent = '已复制对话 ID。'; }
        catch { if (current(id)) feedback.textContent = '复制失败，请检查剪贴板权限。'; }
      } }), feedback, ...picker.controls, nextBefore && more(true), history, nextAfter && more(false));
    history.querySelector('mark')?.focus();
  }
  if (target) void detail({threadId:target.threadId}, '', undefined, target.messageId);
  else void list();
  return {
    verify(bots) {
      if (!bots.some(current => current.enabled && current.paired && current.id === bot.id && current.appId === bot.appId && current.updatedAt === bot.updatedAt)) {
        closeReason='机器人配对或配置已变化，请重新获取对话链接。';
        drawer.close();
      }
    },
    close(reason) {closeReason=reason;drawer.close();},
  };
}

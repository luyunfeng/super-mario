// 工作决定独立于知识。这里只提交用户显式操作，来源由 host 记录。
import { h, replace } from '../lib/dom.js';
import { Button, Card, Field, TextArea } from '../ui/kit.js';
import { confirmDialog, openDrawer } from '../ui/overlay.js';

export function createWorkDecisions({ api, store, router, scope }) {
  let currentScope = scope.get(), sequence = 0, data = null, failure = '', loading = false;
  let snapshot = store.view.snapshot, timer, editor, scopeGeneration = 0;
  const drafts = new Map();
  const summary = h('p', { class: 'small muted', role: 'status' });
  const error = h('p', { class: 'small text-danger', role: 'alert' });
  const list = h('div', { class: 'stack' });
  const retry = Button({ label: '重试读取', size: 'sm', onClick: () => load() });
  retry.hidden = true;
  const active = () => router.current.page === 'memory';
  const scopeName = value => value.kind === 'global' ? '全局' : `${value.kind === 'task' ? '任务' : '项目'}：${store.view.snapshot?.projects?.find(p => p.id === value.projectId)?.name ?? value.projectId ?? ''}${value.todoId ? ` / ${value.todoId}` : ''}`;
  const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '未提供';
  const source = (label, value) => h('p', { class: 'small muted' }, `${label}：${value?.messageId ?? '未提供'} · ${time(value?.createdAt)}`);

  const el = Card({ id: 'work-decisions', title: '工作决定',
    sub: '记下你确认的工作约定，后续对话按最新版本继续。',
    tools: [Button({ label: '新增工作决定', size: 'sm', onClick: () => openEditor() })],
    body: h('div', { class: 'stack', style: { minWidth: '0', overflowWrap: 'anywhere' } }, summary, error, retry, list) });

  function paint() {
    summary.textContent = `${currentScope ? scopeName({ kind: 'project', projectId: currentScope }) : '全局范围'} · ${data ? `共 ${data.counts.total} 条，生效 ${data.counts.active}，已撤回 ${data.counts.withdrawn}${data.truncated ? ` · 仅显示前 ${data.limit} 条，结果已截断` : ''}` : '尚未读取'}${loading ? ' · 读取中…' : ''}`;
    error.textContent = failure; retry.hidden = !failure; retry.disabled = loading;
    replace(list, data ? (data.items.length ? data.items.map(item => h('article', { class: 'stack', dataset: { decisionId: item.id } },
      h('p', { style: { whiteSpace: 'pre-wrap' } }, item.text),
      h('p', { class: 'small' }, `${scopeName(item.scope)} · 版本 ${item.version} · ${item.status === 'active' ? '生效' : '已撤回'}`),
      h('p', { class: 'small muted' }, `创建：${time(item.createdAt)} · 更新：${time(item.updatedAt)}`),
      h('details', null, h('summary', { class: 'small muted' }, '查看来源'), source('当前版本来源', item.source), source('首次记录来源', item.recordSource)),
      item.status === 'active' && h('div', { class: 'row row--wrap' },
        Button({ label: '编辑决定', size: 'sm', onClick: () => openEditor(item) }),
        Button({ label: '撤回决定', size: 'sm', kind: 'danger', onClick: () => withdraw(item) })))) : h('p', { class: 'muted' }, '当前范围没有工作决定。')) : null);
  }

  async function load() {
    clearTimeout(timer);
    const stamp = ++sequence, projectId = currentScope;
    loading = true; paint();
    try {
      const result = await api.get(`/work-decisions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);
      if (stamp !== sequence || projectId !== scope.get()) return;
      data = result; failure = ''; return result;
    } catch (err) {
      if (stamp === sequence && projectId === scope.get()) failure = `工作决定读取失败：${err.message}。${data ? '保留上次读取的数据，当前状态未确认。' : '条数未知。'}`;
    } finally { if (stamp === sequence) { loading = false; paint(); } }
  }

  function openEditor(entry) {
    if (editor) return;
    const projectId = currentScope, generation = scopeGeneration;
    // 创建 key 和草稿按范围保存；只有收到创建成功才移除 key。
    const draftId = `${projectId}:${entry?.id ?? 'new'}`;
    if (!drafts.has(draftId)) drafts.set(draftId, { key: crypto.randomUUID(), text: entry?.text ?? '' });
    const draft = drafts.get(draftId);
    let version = entry?.version, conflict = false, busy = false, closed = false;
    const input = TextArea({ rows: 7, maxLength: 4000, value: draft.text, 'aria-label': '工作决定内容' });
    const note = h('p', { class: 'small text-danger', role: 'alert' });
    const count = h('p', { class: 'small muted' });
    const reference = entry && h('p', { class: 'small' }, `当前参考版本 ${version}：${entry.text}`);
    const update = () => { draft.text = input.value; count.textContent = `${input.value.length} / 4000 字`; save.disabled = busy || conflict || !input.value.trim() || input.value.length > 4000; };
    const refresh = Button({ label: '刷新当前版本', onClick: async () => {
      if (busy) return;
      busy = true; update();
      const result = await load();
      if (!closed && result) {
        const latest = result.items.find(item => item.id === entry.id);
        if (latest?.status === 'active') {
          version = latest.version; conflict = false;
          reference.textContent = `当前参考版本 ${version}：${latest.text}`;
          note.textContent = `已读取版本 ${version}，草稿已保留。请核对最新决定后再保存。`;
        }
        else note.textContent = '当前列表中没有可编辑版本（可能已撤回或被截断）。草稿已保留，请关闭后核对列表。';
      } else if (!closed) note.textContent = '当前版本读取失败，草稿已保留。请重试读取，核对后再保存。';
      busy = false; update();
    } });
    refresh.hidden = true;
    const save = Button({ label: '保存决定', kind: 'primary', onClick: async () => {
      update();
      if (save.disabled || closed || generation !== scopeGeneration) return;
      busy = true; input.disabled = true; update();
      try {
        if (entry) await api.patch(`/work-decisions/${encodeURIComponent(entry.id)}`, { version, text: input.value.trim() });
        else await api.post('/work-decisions', { key: draft.key, text: input.value.trim(), ...(projectId ? { projectId } : {}) });
        drafts.delete(draftId);
        if (!closed) drawer.close();
        if (generation === scopeGeneration) await load();
      } catch (err) {
        if (closed) return;
        conflict = err.status === 409;
        refresh.hidden = !(conflict && entry);
        note.textContent = conflict ? `版本冲突（409），草稿已保留。${entry ? '请刷新当前版本，再核对并编辑' : '请关闭后刷新工作决定，核对创建结果'}；没有自动重试写入。` : `保存未确认：${err.message}。草稿及创建标识已保留，请先刷新核对结果。`;
      } finally { busy = false; input.disabled = false; update(); }
    } });
    input.addEventListener('input', update);
    const drawer = openDrawer({ title: entry ? '编辑工作决定' : '新增工作决定',
      subtitle: `${entry ? scopeName(entry.scope) : projectId ? scopeName({ kind: 'project', projectId }) : '全局'}。保存后供主 Agent 跨对话引用，修改和撤回会让旧版本失效。`,
      body: h('div', { class: 'stack', style: { overflowWrap: 'anywhere' } }, Field({ label: '工作决定内容', control: input, required: true }), count,
        reference, note),
      footer: [refresh, Button({ label: '取消', onClick: () => drawer.close() }), save],
      onClose: () => { closed = true; if (editor === drawer) editor = undefined; } });
    // 范围标识和来源标识可能是无空格长串，抽屉标题区也需要自然换行。
    drawer.el.style.overflowWrap = 'anywhere';
    editor = drawer; update();
  }

  async function withdraw(entry) {
    const generation = scopeGeneration;
    if (!await confirmDialog({ title: '撤回这条工作决定？', message: `将撤回版本 ${entry.version}，保留来源与版本记录。不会写入知识或发送消息。`, confirmLabel: '确认撤回', danger: true })) return;
    if (generation !== scopeGeneration) return;
    try {
      await api.post(`/work-decisions/${encodeURIComponent(entry.id)}/withdraw`, { version: entry.version });
      if (generation === scopeGeneration) await load();
    } catch (err) {
      if (generation !== scopeGeneration) return;
      failure = err.status === 409 ? '撤回遇到版本冲突（409）。请刷新工作决定，核对当前版本后再操作；没有自动重试。' : `撤回结果未确认：${err.message}。请刷新核对，未自动重试。`;
      paint();
    }
  }

  window.addEventListener('workspace:project-purged', ({ detail }) => {
    for (const key of drafts.keys()) if (key.startsWith(detail.projectId + ':')) drafts.delete(key);
  });
  scope.subscribe(() => {
    currentScope = scope.get(); ++scopeGeneration; ++sequence; data = null; failure = ''; loading = false;
    clearTimeout(timer); editor?.close(); editor = undefined; paint();
    if (active()) void load();
  });
  // store 在服务端事件后刷新快照；连接状态变化和同一快照的重复通知不重复 GET。
  store.subscribe(view => {
    if (view.snapshot === snapshot) return;
    snapshot = view.snapshot;
    if (!active()) return;
    clearTimeout(timer); timer = setTimeout(() => void load(), 120);
  });
  paint();
  return { el, show: () => load() };
}

// 记忆条目：新增/编辑抽屉和列表行。记忆页和项目的“资料”标签共用。
import { h, replace } from '../lib/dom.js';
import { createConversationDrafts } from '../lib/conversation-drafts.js';
import { quoteDraftKey } from '../lib/message-quote.js';
import { layerNames, timeAgo } from '../lib/format.js';
import { Button, Field, Input, TextArea, Select, Pill } from '../ui/kit.js';
import { hintCopy } from '../ui/hint.js';
import { openDrawer, confirmDialog } from '../ui/overlay.js';

const LAYER_HINT = { personal: 'memory.personal', global: 'memory.global', project: 'memory.project' };

function revisionHistory(api, entry, loadDraft, selectedCommit) {
  const body = h('div', { class: 'stack' });
  const section = h('details', null, h('summary', null, '查看历史修订'), body);
  let request = 0;
  async function load(commit) {
    const stamp = ++request;
    const status = h('p', { role: 'status' }, '正在读取修订…');
    body.append(status);
    try {
      const { revision } = await api.get('/knowledge/' + encodeURIComponent(entry.id) + '/revision' +
        (commit ? '?commit=' + encodeURIComponent(commit) : ''));
      if (stamp !== request) return;
      if (!revision) { status.textContent = '没有可查看的修订。'; return; }
      status.replaceWith(h('article', { class: 'stack' },
        h('strong', null, revision.entry.title),
        h('small', null, revision.entry.updatedAt, ' · ', revision.commit.slice(0, 8)),
        h('span', { class: 'small' }, '标签：' + (revision.entry.tags?.join('、') || '无')),
        h('pre', { class: 'small', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, revision.entry.content),
        Button({ label: '将此版载入草稿', size: 'sm', onClick: () => loadDraft(revision.entry) })));
      if (revision.previous) {
        const earlier = Button({ label: '查看上一版', size: 'sm', onClick: () => { earlier.remove(); return load(revision.previous); } });
        body.append(earlier);
      }
    } catch (error) { if (stamp === request) status.textContent = error.message; }
  }
  section.addEventListener('toggle', () => {
    request++;
    replace(body);
    if (section.open) void load(selectedCommit);
  });
  if (selectedCommit) section.open = true;
  return section;
}

function originalSources(api, entry, selected, line, ask) {
  const path = '/knowledge/' + encodeURIComponent(entry.id) + '/sources';
  const body = h('div', { class: 'stack' });
  const section = h('details', { open: Boolean(selected) }, h('summary', null, '查看原始资料'), body);
  section.addEventListener('toggle', async () => {
    if (!section.open) return;
    body.textContent = '正在读取来源…';
    try {
      const { sources } = await api.get(path);
      replace(body, sources.length ? sources.map(source => {
        const text = h('pre', { class: 'small', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } });
        let original;
        const action = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', hidden: true,
          onclick: () => ask(source, original) }, '引用原文追问');
        const notice = h('span', { role: 'status', hidden: true }, '引用的行号超出原文范围。');
        const detail = h('details', { open: source.id === selected }, h('summary', null, source.title), notice, text, action);
        detail.addEventListener('toggle', async () => {
          if (!detail.open) return;
          action.hidden = true;
          text.textContent = '正在读取原文…';
          try {
            const { content } = await api.get(path + '/' + encodeURIComponent(source.id));
            text.textContent = content;
            original = content; action.hidden = !ask;
            if (selected !== source.id || !Number.isSafeInteger(line) || line < 1) return;
            const lines = content.split('\n');
            if (line > lines.length) { notice.hidden = false; return; }
            const mark = h('mark', null, lines[line - 1]);
            replace(text, lines.slice(0, line - 1).join('\n') + (line > 1 ? '\n' : ''), mark,
              (line < lines.length ? '\n' : '') + lines.slice(line).join('\n'));
            if (detail.open && section.open && mark.isConnected) mark.scrollIntoView({ block: 'center' });
          }
          catch (error) { text.textContent = error.message; }
        });
        return detail;
      }) : '这条记忆没有关联的整理来源。');
      if (selected && !sources.some(source => source.id === selected)) body.prepend(h('p', { role: 'status' }, '引用的来源已不可用。'));
    } catch (error) { body.textContent = error.message; }
  });
  return section;
}

export function openKnowledgeDrawer({ api, store, router, scope, entry, sourceId, line, selectedCommit, defaults = {}, onSaved }) {
  const projects = (store.view.snapshot?.projects ?? []).filter(item => !item.archivedAt);
  const layer = Select({ options: Object.entries(layerNames), value: entry?.layer ?? defaults.layer ?? 'personal', name: 'layer' });
  const project = Select({ options: [['', '请选择项目'], ...projects.map(item => [item.id, item.name])], value: entry?.projectId ?? defaults.projectId ?? '', name: 'projectId' });
  const title = Input({ name: 'title', value: entry?.title ?? '', required: true, placeholder: '一句话概括，例如“发布流程”' });
  const content = TextArea({ name: 'content', value: entry?.content ?? '', rows: 10, required: true, placeholder: '写下 Agent 工作时需要知道的内容' });
  const tags = TextArea({ name: 'tags', value: (entry?.tags ?? []).join('\n'), rows: 2, placeholder: '每行一个标签' });
  let expectedUpdatedAt = entry?.updatedAt;
  const conflict = h('div', { class: 'stack' });
  const note = h('p', { class: 'small text-danger', role: 'alert' });
  const layerHint = h('span', { class: 'field__hint' });
  const projectField = Field({ label: '所属项目', control: project, required: true });
  const sync = () => { projectField.hidden = layer.value !== 'project'; layerHint.textContent = hintCopy(LAYER_HINT[layer.value]).tag; };
  layer.addEventListener('change', sync);

  const owner = store.view.snapshotOwner;
  function mayQuote() {
    const view = store.view;
    return router && scope && !view.unauthorized && owner === api.draftOwner() && owner === view.snapshotOwner &&
      view.snapshot?.plugins?.some(p => p.id === 'conversation-quotes' && p.status === 'active') &&
      view.snapshot?.plugins?.some(p => p.id === 'knowledge-local' && p.status === 'active') &&
      view.snapshot.knowledge?.some(p => p.id === entry.id && p.layer === entry.layer && p.projectId === entry.projectId) &&
      (!entry.projectId || view.snapshot.projects?.some(p => p.id === entry.projectId && !p.archivedAt));
  }
  function ask(source, original) {
    if (!mayQuote()) { note.textContent = '当前无法引用，请检查插件和知识页状态。'; return; }
    if (title.value !== entry.title || content.value !== entry.content || layer.value !== entry.layer || project.value !== (entry.projectId ?? '')) {
      note.textContent = '请先保存记忆修改，再引用原文。'; return;
    }
    const drafts = createConversationDrafts({ api, store });
    const key = quoteDraftKey(JSON.stringify(entry.projectId ? ['project', entry.projectId] : ['main', '']));
    const field = h('textarea', { class: 'textarea', rows: 10, readOnly: true, value: original, 'aria-label': '选择要追问的原文' });
    const target = entry.projectId ? '项目工作对话' : '主对话';
    let previous = drafts.read(key);
    const apply = h('button', { class: 'btn btn--primary btn--sm', type: 'button', disabled: true, onclick() {
      if (!mayQuote()) { selection.close(); return; }
      if (drafts.read(key) !== previous) { previous = drafts.read(key); refresh(); return; }
      const passage = field.value.slice(field.selectionStart, field.selectionEnd);
      if (!passage.trim()) return;
      const line = field.value.slice(0, field.selectionStart).split('\n').length;
      const citation = `[查看原文](#memory?entry=${encodeURIComponent(entry.id)}&source=${encodeURIComponent(source.id)}&line=${line})`;
      drafts.write(key, JSON.stringify({ label: source.title, text: source.title + ' · 第 ' + line + ' 行 ' + citation + '\n' + passage }));
      selection.close();
      if (!entry.projectId) scope.set('');
      router.go(entry.projectId ? router.href('projects', entry.projectId, 'workspace') : router.href('chat'));
    } });
    function refresh() {
      apply.textContent = '引用到' + target + (previous ? '（替换已有引用）' : '');
      apply.disabled = !field.value.slice(field.selectionStart, field.selectionEnd).trim();
    }
    field.addEventListener('select', refresh);
    const selection = openDrawer({ title: '选择原文追问', body: field, footer: apply });
    refresh(); field.focus(); field.setSelectionRange(0, 0);
  }

  async function loadDraft(revision) {
    const revisionTags = (revision.tags ?? []).join('\n');
    if (title.value === revision.title && content.value === revision.content && tags.value === revisionTags) return;
    if (title.value !== entry.title || content.value !== entry.content || tags.value !== (entry.tags ?? []).join('\n')) {
      const replaceDraft = await confirmDialog({ title: '替换当前草稿？', message: '载入这次修订会替换编辑框中的标题、正文和标签。', confirmLabel: '载入修订' });
      if (!replaceDraft) return;
    }
    title.value = revision.title;
    content.value = revision.content;
    tags.value = revisionTags;
    content.focus();
  }

  const save = Button({
    label: entry ? '保存' : '记住', kind: 'primary',
    onClick: async () => {
      note.textContent = '';
      if (!title.value.trim() || !content.value.trim()) { note.textContent = '请填写标题和内容。'; return; }
      if (layer.value === 'project' && !project.value) { note.textContent = '请选择所属项目。'; return; }
      const body = { ...(entry ? { expectedUpdatedAt } : {}), tags: tags.value.split('\n').map(tag => tag.trim()).filter(Boolean), layer: layer.value, title: title.value.trim(), content: content.value.trim(), ...(layer.value === 'project' ? { projectId: project.value } : {}) };
      try { await (entry ? api.patch(`/knowledge/${encodeURIComponent(entry.id)}`, body) : api.post('/knowledge', body)); }
      catch (error) {
        note.textContent = `没有保存成功：${error.message}。草稿已保留。`;
        if (entry && error.status === 409) {
          replace(conflict);
          let latest;
          try { latest = (await api.get('/knowledge')).find(item => item.id === entry.id); }
          catch (readError) { conflict.textContent = '读取当前版本失败：' + readError.message; return; }
          if (!latest) { conflict.textContent = '该知识页已删除。'; return; }
          replace(conflict, h('strong', null, '当前已保存版本'),
            h('span', null, [layerNames[latest.layer], latest.projectId, latest.title].filter(Boolean).join(' · ')),
            h('span', { class: 'small' }, '标签：' + (latest.tags?.join('、') || '无')),
            h('pre', { class: 'small', style: { whiteSpace: 'pre-wrap' } }, latest.content),
            Button({ label: '已核对新版，继续编辑草稿', onClick() {
              expectedUpdatedAt = latest.updatedAt;
              replace(conflict); note.textContent = '已核对版本，编辑草稿后可再次保存。';
              content.focus();
            } }));
        }
        return;
      }
      drawer.close(); await onSaved?.(); store.refresh();
    },
  });
  const remove = entry && Button({
    label: '删除', kind: 'ghost', onClick: async () => {
      const ok = await confirmDialog({ title: '删除这条记忆？', message: `“${entry.title}”删除后，Agent 之后不会再参考它。`, confirmLabel: '删除', danger: true });
      if (!ok) return;
      await api.del(`/knowledge/${encodeURIComponent(entry.id)}`);
      drawer.close(); await onSaved?.(); store.refresh();
    },
  });
  const drawer = openDrawer({
    title: entry ? '编辑记忆' : '添加记忆', subtitle: entry ? `更新于 ${timeAgo(entry.updatedAt)}` : undefined,
    body: [Field({ label: '属于哪一层', control: layer, hint: undefined }), layerHint, projectField, Field({ label: '标题', control: title, required: true }), Field({ label: '内容', control: content, required: true }), Field({ label: '标签', control: tags }), entry && originalSources(api, entry, sourceId, line, mayQuote() ? ask : null), entry && revisionHistory(api, entry, loadDraft, selectedCommit), note, conflict],
    footer: [remove, h('span', { class: 'grow' }), Button({ label: '取消', onClick: () => drawer.close() }), save],
  });
  sync();
  return drawer;
}

export function knowledgeRow(entry, { projectName, onOpen, pattern }) {
  const summary = entry.content.replace(/\s+/g, ' ').slice(0, 100);
  const excerpts = [];
  let title = entry.title;
  if (pattern) {
    const hit = pattern.exec(title);
    if (hit) title = [title.slice(0, hit.index), h('mark', null, hit[0]), title.slice(hit.index + hit[0].length)];
    for (const line of entry.content.split('\n')) {
      const match = pattern.exec(line);
      if (!match) continue;
      const start = Math.max(0, match.index - 30);
      const after = match.index + match[0].length;
      excerpts.push([start ? '…' : '', line.slice(start, match.index), h('mark', null, match[0]),
        line.slice(after, after + 60), after + 60 < line.length ? '…' : '']);
      if (excerpts.length === 2) break;
    }
  }
  return h('div', { class: `item item--click knowledge-item knowledge-item--${entry.layer}`, tabindex: 0, role: 'button', dataset: { id: entry.id },
    onclick: () => onOpen(entry), onkeydown: (event) => { if (event.key === 'Enter') onOpen(entry); } },
  h('div', { class: 'item__main' },
    h('span', { class: 'item__title' }, title),
    Boolean(entry.tags?.length) && h('span', { class: 'item__meta' }, entry.tags.map(tag => '#' + tag).join(' · ')),
    (excerpts.length ? excerpts : [summary]).map(text => h('span', { class: 'item__meta truncate' }, text))),
  h('div', { class: 'item__end' },
    Pill(layerNames[entry.layer] + (entry.layer === 'project' && projectName ? ` · ${projectName}` : ''), entry.layer === 'global' ? 'info' : entry.layer === 'project' ? 'warn' : ''),
    h('span', { class: 'muted small' }, timeAgo(entry.updatedAt))));
}

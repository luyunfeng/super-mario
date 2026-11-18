// 记忆条目：新增/编辑抽屉和列表行。记忆页和项目的“资料”标签共用。
import { h } from '../lib/dom.js';
import { layerNames, timeAgo } from '../lib/format.js';
import { Button, Field, Input, TextArea, Select, Pill } from '../ui/kit.js';
import { hintCopy } from '../ui/hint.js';
import { openDrawer, confirmDialog } from '../ui/overlay.js';

const LAYER_HINT = { personal: 'memory.personal', global: 'memory.global', project: 'memory.project' };

export function openKnowledgeDrawer({ api, store, entry, defaults = {}, onSaved }) {
  const projects = (store.view.snapshot?.projects ?? []).filter(item => !item.archivedAt);
  const layer = Select({ options: Object.entries(layerNames), value: entry?.layer ?? defaults.layer ?? 'personal', name: 'layer' });
  const project = Select({ options: [['', '请选择项目'], ...projects.map(item => [item.id, item.name])], value: entry?.projectId ?? defaults.projectId ?? '', name: 'projectId' });
  const title = Input({ name: 'title', value: entry?.title ?? '', required: true, placeholder: '一句话概括，例如“发布流程”' });
  const content = TextArea({ name: 'content', value: entry?.content ?? '', rows: 10, required: true, placeholder: '写下 Agent 工作时需要知道的内容' });
  const note = h('p', { class: 'small text-danger', role: 'alert' });
  const layerHint = h('span', { class: 'field__hint' });
  const projectField = Field({ label: '所属项目', control: project, required: true });
  const sync = () => { projectField.hidden = layer.value !== 'project'; layerHint.textContent = hintCopy(LAYER_HINT[layer.value]).tag; };
  layer.addEventListener('change', sync);

  const save = Button({
    label: entry ? '保存' : '记住', kind: 'primary',
    onClick: async () => {
      note.textContent = '';
      if (!title.value.trim() || !content.value.trim()) { note.textContent = '请填写标题和内容。'; return; }
      if (layer.value === 'project' && !project.value) { note.textContent = '请选择所属项目。'; return; }
      const body = { layer: layer.value, title: title.value.trim(), content: content.value.trim(), ...(layer.value === 'project' ? { projectId: project.value } : {}) };
      try { await (entry ? api.patch(`/knowledge/${encodeURIComponent(entry.id)}`, body) : api.post('/knowledge', body)); }
      catch (error) { note.textContent = `没有保存成功：${error.message}。内容已保留。`; return; }
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
    body: [Field({ label: '属于哪一层', control: layer, hint: undefined }), layerHint, projectField, Field({ label: '标题', control: title, required: true }), Field({ label: '内容', control: content, required: true }), note],
    footer: [remove, h('span', { class: 'grow' }), Button({ label: '取消', onClick: () => drawer.close() }), save],
  });
  sync();
  return drawer;
}

export function knowledgeRow(entry, { projectName, onOpen }) {
  return h('div', { class: 'item item--click', tabindex: 0, role: 'button', dataset: { id: entry.id },
    onclick: () => onOpen(entry), onkeydown: (event) => { if (event.key === 'Enter') onOpen(entry); } },
  h('div', { class: 'item__main' },
    h('span', { class: 'item__title' }, entry.title),
    h('span', { class: 'item__meta truncate' }, entry.content.replace(/\s+/g, ' ').slice(0, 100))),
  h('div', { class: 'item__end' },
    Pill(layerNames[entry.layer] + (entry.layer === 'project' && projectName ? ` · ${projectName}` : ''), entry.layer === 'global' ? 'info' : ''),
    h('span', { class: 'muted small' }, timeAgo(entry.updatedAt))));
}

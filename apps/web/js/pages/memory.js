// 记忆：让 Agent 记住你。顶部一个输入框，写一句或粘贴链接；下面按层级浏览。
import { h, replace, keyedList } from '../lib/dom.js';
import { layerNames } from '../lib/format.js';
import { Button, Empty, Input, Select, Segmented, TextArea } from '../ui/kit.js';
import { Hint, hintCopy } from '../ui/hint.js';
import { toast } from '../ui/overlay.js';
import { knowledgeRow, openKnowledgeDrawer } from '../features/knowledge.js';
import { openCuratorDrawer, pendingJobs } from '../features/curator.js';
import { createWorkDecisions } from '../features/work-decisions.js';

const LAYERS = [['all', '全部'], ['personal', '个人'], ['global', '全局'], ['project', '项目']];
const LAYER_HINT = { personal: 'memory.personal', global: 'memory.global', project: 'memory.project' };
const isUrl = text => /^https?:\/\/\S+$/i.test(text);

export function createMemoryPage({ api, store, router, scope }) {
  let layer = 'all';
  let curator = null;
  const decisions = createWorkDecisions({ api, store, router, scope });

  // —— 快速添加 ——
  const input = TextArea({ rows: 2, placeholder: '告诉我一件事，或粘贴链接…', 'aria-label': '添加记忆', id: 'memory-input' });
  const target = Select({ options: Object.entries(layerNames), value: 'personal', 'aria-label': '记到哪一层' });
  const project = Select({ options: [['', '选择项目']], 'aria-label': '所属项目' });
  const note = h('p', { class: 'small', role: 'status' });
  const add = Button({
    label: '记住', icon: 'plus', kind: 'primary', onClick: async () => {
      const text = input.value.trim();
      if (!text) return;
      const body = { layer: target.value };
      if (target.value === 'project') { if (!project.value) { note.className = 'small text-danger'; note.textContent = '请先选择所属项目。'; return; } body.projectId = project.value; }
      try {
        if (isUrl(text)) {
          if (target.value === 'global') throw new Error('链接暂不支持直接记为全局记忆，请选择个人或项目，或用“详细添加”粘贴正文。');
          await api.post('/knowledge/sources', { ...body, url: text });
          note.className = 'small muted'; note.textContent = '已加入整理队列，整理完成后才会成为记忆。';
          loadCurator();
        } else {
          const first = text.split('\n')[0].trim();
          await api.post('/knowledge', { ...body, title: first.length > 40 ? `${first.slice(0, 40)}…` : first, content: text });
          note.className = 'small muted'; note.textContent = '已记住。';
        }
        input.value = '';
      } catch (error) { note.className = 'small text-danger'; note.textContent = `没有保存成功：${error.message}。内容已保留。`; }
      store.refresh();
    },
  });
  const detailed = Button({ label: '详细添加', size: 'sm', kind: 'ghost', onClick: () => openKnowledgeDrawer({ api, store, defaults: { layer: layer === 'all' ? 'personal' : layer, projectId: scope.get() } }) });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); add.click(); } });
  target.addEventListener('change', () => { project.hidden = target.value !== 'project'; });
  project.hidden = true;
  const quick = h('div', { class: 'card memory-add' }, h('div', { class: 'card__body' }, input,
    h('div', { class: 'row row--wrap' }, target, project, h('span', { class: 'grow' }), detailed, add), note));

  // —— 列表 ——
  const seg = Segmented({ options: LAYERS, value: layer, label: '记忆层级', onChange: (value) => { layer = value; paint(); } });
  const layerNote = h('p', { class: 'muted small', id: 'layer-note' });
  const search = Input({ type: 'search', placeholder: '搜索记忆', 'aria-label': '搜索记忆', style: { maxWidth: '220px' } });
  search.addEventListener('input', () => paint());
  const list = h('div', { class: 'list' });
  const curatorLine = h('div', { class: 'row row--between curator', id: 'curator-line' });

  const el = h('section', { class: 'page', id: 'memory' },
    h('div', { class: 'page__inner' },
      h('header', { class: 'page__head' },
        h('div', { class: 'page__title' }, h('h1', null, '记忆'), h('p', { class: 'page__sub' }, hintCopy('nav.memory').tag)),
        h('div', { class: 'page__actions' }, Hint('nav.memory'))),
      h('div', { class: 'stack stack--lg' }, quick,
        h('div', { class: 'stack' }, h('div', { class: 'row row--between row--wrap' }, seg.el, search), layerNote),
        list, curatorLine, decisions.el)));

  function paint() {
    const snapshot = store.view.snapshot;
    if (!snapshot) return;
    const query = search.value.trim().toLowerCase();
    const projects = (snapshot.projects ?? []).filter(item => !item.archivedAt);
    const names = new Map(projects.map(item => [item.id, item.name]));
    const signature = JSON.stringify(projects.map(item => [item.id, item.name]));
    if (project.dataset.sig !== signature) {
      project.dataset.sig = signature;
      replace(project, h('option', { value: '' }, '选择项目'), projects.map(item => h('option', { value: item.id }, item.name)));
    }
    layerNote.textContent = layer === 'all' ? '' : hintCopy(LAYER_HINT[layer]).detail;
    const rows = (snapshot.knowledge ?? [])
      .filter(item => layer === 'all' || item.layer === layer)
      // 选了项目范围时，别的项目的资料不显示；个人和全局记忆始终显示。
      .filter(item => !scope.get() || item.layer !== 'project' || item.projectId === scope.get())
      .filter(item => !query || `${item.title} ${item.content}`.toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!rows.length) {
      replace(list, Empty({ title: query ? '没有找到匹配的记忆' : '还没有记忆', text: query ? undefined : '在上面写一句话，Agent 之后工作时会参考它。' }));
      list._keyed = undefined;
    } else {
      if (!list._keyed) list.replaceChildren();
      keyedList(list, rows, item => item.id, item => knowledgeRow(item, { projectName: names.get(item.projectId), onOpen: entry => openKnowledgeDrawer({ api, store, router, scope, entry }) }),
        item => `${item.id}:${item.updatedAt}:${names.get(item.projectId)}`);
    }
    const pending = pendingJobs(curator).length;
    const enabled = curator?.settings?.enabled;
    replace(curatorLine,
      h('span', { class: 'small muted' }, `整理 Agent：${curator ? (enabled ? '已启用' : '已暂停') : '读取中…'}${pending ? ` · 待整理 ${pending}` : ''}`),
      Button({ label: '设置与队列', size: 'sm', kind: 'ghost', onClick: () => openCuratorDrawer({ api, store, onChanged: loadCurator }) }));
  }

  scope.subscribe(() => paint());

  let curatorSeq = 0;
  async function loadCurator() {
    const stamp = ++curatorSeq;
    try { const value = await api.get('/knowledge/curator'); if (stamp === curatorSeq) curator = value; } catch { /* 状态行显示读取中。 */ }
    paint();
  }

  let linkedEntry;
  function openLinkedEntry() {
    if (!linkedEntry || router.current.page !== 'memory' || !store.view.snapshot || store.view.unauthorized) return;
    const { id, sourceId, line } = linkedEntry;
    linkedEntry = undefined;
    const entry = store.view.snapshot.knowledge?.find(item => item.id === id);
    if (entry) openKnowledgeDrawer({ api, store, router, scope, entry, sourceId, line });
    else toast('引用的知识页已不可用。');
  }
  return {
    el,
    onShow(route) {
      decisions.show();
      loadCurator();
      if (route.query.get('curator')) openCuratorDrawer({ api, store, onChanged: loadCurator });
      const entry = route.query.get('entry');
      linkedEntry = entry && { id: entry, sourceId: route.query.get('source'), line: Number(route.query.get('line')) };
      openLinkedEntry();
      const part = route.parts[0];
      if (LAYERS.some(([key]) => key === part) && part !== layer) { layer = part; seg.set(part); }
      paint();
    },
    onState() { paint(); openLinkedEntry(); },
  };
}

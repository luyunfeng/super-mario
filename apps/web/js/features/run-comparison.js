import { h, replace } from '../lib/dom.js';
import { formatDate, runStatus, uuid } from '../lib/format.js';
import { confirmDialog, openDrawer } from '../ui/overlay.js';
import { renderDiffLines } from './code-sidebar.js';
import { Button, Field, Input, Pill, Select } from '../ui/kit.js';

function openRunDrawer({ item, api, store, router }, title, wide = false) {
  const token = api.token();
  const area = h('div', { class: 'stack' });
  const drawer = openDrawer({ title, subtitle: item.prompt, body: area, wide,
    onClose: () => { offStore(); offRoute(); } });
  const offRoute = router.subscribe(() => drawer.close());
  const offStore = store.subscribe(({ snapshot, unauthorized }) => {
    if (api.token() !== token || unauthorized || !snapshot?.plugins.some(p => p.id === 'run-comparison' && p.status === 'active')) drawer.close();
  });
  return { area, close: drawer.close, active: () => drawer.el.open && api.token() === token };
}

function openCommitDiff(options) {
  const { item, api } = options;
  const { area, active } = openRunDrawer(options, '已提交文件差异', true);
  area.textContent = '正在读取历史提交…';
  const endpoint = '/runs/' + encodeURIComponent(item.id) + '/commit-diff';
  let sequence = 0;
  async function load() {
    try {
      const { files, hidden } = await api.get(endpoint);
      if (!active()) return;
      const output = h('pre', { class: 'code-sidebar__text', tabindex: 0 });
      const picker = Select({ 'aria-label': '已提交文件', options: files.map(path => [path, path]), onChange: readFile });
      async function readFile() {
        const stamp = ++sequence;
        output.textContent = '正在读取文件差异…';
        try {
          const reply = await api.get(endpoint + '?' + new URLSearchParams({ path: picker.value }));
          if (active() && stamp === sequence) replace(output, renderDiffLines(reply.text));
        } catch (error) { if (active() && stamp === sequence) output.textContent = error.message; }
      }
      replace(area, hidden > 0 && h('p', { class: 'muted small' }, `已隐藏 ${hidden} 个受限文件。`),
        files.length ? [picker, output] : h('p', null, '没有可查看的文件差异。'));
      if (files.length) await readFile();
    } catch (error) { if (active()) replace(area, h('p', null, error.message), Button({ label: '重试', onClick: load })); }
  }
  void load();
}

export function renameWorktree(options) {
  const { item, api, store } = options;
  const { area, active, close } = openRunDrawer(options, '重命名工作树');
  const field = Input({ value: item.worktree.name ?? '', maxlength: 80, required: true, placeholder: item.worktree.branch });
  const error = h('p', { role: 'alert' });
  const save = Button({ label: '保存名称', type: 'submit', kind: 'primary' });
  const form = h('form', { class: 'stack', onSubmit: async event => {
    event.preventDefault();
    if (!active() || save.disabled) return;
    save.disabled = true;
    try {
      await api.patch('/runs/' + encodeURIComponent(item.id) + '/worktree-name', { name: field.value, previousName: item.worktree.name ?? '' });
      if (active()) close();
      store.refresh();
    } catch (reason) { if (active()) { error.textContent = reason.message; save.disabled = false; } }
  } }, Field({ label: '工作树名称', control: field }), error, save);
  replace(area, form);
  field.focus();
}

export function openRetainedBranch(options) {
  const { item, api } = options;
  const { area, active } = openRunDrawer(options, '保留分支');
  const endpoint = '/runs/' + encodeURIComponent(item.id) + '/retained-branch';
  async function load() {
    area.textContent = '正在核对分支…';
    try {
      const state = await api.get(endpoint);
      if (!active()) return;
      if (state.deleted) { area.textContent = '执行分支已删除。'; return; }
      replace(area, h('strong', null, state.branch), h('code', null, state.head),
        h('p', null, `有 ${state.unmerged} 个提交尚未进入来源目录当前 HEAD。`),
        state.checkedOut && h('p', null, '分支仍在工作树中使用。'),
        state.moved && h('p', null, '分支已偏离目录清理时的提交。'),
        Button({ label: '删除执行分支', kind: 'danger', disabled: state.checkedOut || state.moved,
          onClick: async () => {
            const ok = await confirmDialog({ title: '删除执行分支？', message:
              `将删除分支 ${state.branch}。其中有 ${state.unmerged} 个提交尚未进入来源目录当前 HEAD。历史执行差异会保留。`,
              confirmLabel: '确认删除分支', danger: true });
            if (!ok || !active()) return;
            area.textContent = '正在删除执行分支…';
            try {
              await api.post(endpoint, { confirmed: true, head: state.head, sourceHead: state.sourceHead, unmerged: state.unmerged, requestId: uuid() });
              if (active()) area.textContent = '执行分支已删除。';
              options.store.refresh();
            } catch (error) { if (active()) replace(area, h('p', null, error.message), Button({ label: '刷新状态', onClick: load })); }
          } }), Button({ label: '刷新状态', onClick: load }));
    } catch (error) { if (active()) replace(area, h('p', null, error.message), Button({ label: '重试', onClick: load })); }
  }
  void load();
}

export function openWorktreeStatus(options) {
  const { item, api } = options;
  const { area, active } = openRunDrawer(options, '工作树状态');
  const names = { M: '修改', T: '类型变化', A: '新增', D: '删除', U: '冲突' };
  function fileState(file) {
    if (file.index === '?') return '未跟踪';
    if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(file.index + file.worktree)) return '合并冲突';
    return [file.index !== ' ' && '暂存区：' + (names[file.index] ?? file.index),
      file.worktree !== ' ' && '工作区：' + (names[file.worktree] ?? file.worktree)].filter(Boolean).join(' · ');
  }
  async function load() {
    replace(area, h('p', { role: 'status' }, '正在读取工作树…'));
    try {
      const value = await api.get('/runs/' + encodeURIComponent(item.id) + '/worktree-status');
      if (!active()) return;
      replace(area, h('strong', null, value.branch ?? '分离的 HEAD'), h('code', null, value.cwd),
        h('p', null, '当前提交 ', h('code', null, value.head.slice(0, 10)), ' · 来源提交 ', h('code', null, value.sourceHead.slice(0, 10))),
        h('p', null, `有 ${value.unmerged} 个提交尚未进入来源目录当前 HEAD。`),
        h('strong', null, `未提交文件（含未跟踪）：${value.total}`),
        value.files.map(file => h('div', { class: 'stack' }, h('code', null, file.path),
          h('small', { class: 'muted' }, fileState(file)))),
        value.hidden > 0 && h('small', null, `已隐藏 ${value.hidden} 个受限文件。`),
        value.truncated && h('small', null, '仅显示前 250 个可见文件。'),
        ['completed', 'failed'].includes(item.status) && value.total > 0 && h('small', { class: 'muted' }, '清理前请先提交或移走本地改动。'),
        ['completed', 'failed'].includes(item.status) && options.store.view.snapshot?.machines?.some(m =>
          m.id === item.machineId && m.capabilities.includes('workspace.removeRunWorktree')) &&
          Button({ label: '清理工作树目录', kind: 'danger', disabled: value.total > 0 || value.branch !== item.worktree.branch,
            onClick: async () => {
              const ok = await confirmDialog({ title: '清理工作树目录？',
                message: `将移除 ${value.cwd}。分支 ${value.branch} 和提交 ${value.head.slice(0, 10)} 会保留。`,
                confirmLabel: '确认清理目录', danger: true });
              if (!ok || !active()) return;
              replace(area, h('p', { role: 'status' }, '正在核对并清理目录…'));
              try {
                await api.post('/runs/' + encodeURIComponent(item.id) + '/worktree-cleanup', { confirmed: true, head: value.head, requestId: uuid() });
                if (active()) replace(area, h('p', null, '工作树目录已清理，分支已保留。'));
                options.store.refresh();
              } catch (error) {
                if (active()) replace(area, h('p', null, error.message), Button({ label: '重新核对状态', onClick: load }));
              }
            } }),
        Button({ label: '刷新状态', size: 'sm', onClick: load }));
    } catch (error) { if (active()) replace(area, h('p', null, error.message), Button({ label: '重试', onClick: load })); }
  }
  void load();
}

export function compareRuns({ run, runs, projectId, router, executorName, api, store }) {
  const peers = runs.filter(item => item.id !== run.id && item.projectId === run.projectId)
    .sort((a, b) => Number(Boolean(run.todoId && b.todoId === run.todoId)) - Number(Boolean(run.todoId && a.todoId === run.todoId))
      || b.createdAt.localeCompare(a.createdAt));
  const selected = router.current.query.get('compare');
  const group = run.comparisonRunIds;
  if (!peers.length && !selected && !group) return null;
  const href = id => router.href('projects', projectId, 'runs', id);
  const pick = Select({
    'aria-label': '选择对比执行',
    options: [['', '选择对比执行'], ...(group ? [['group', '本次对比组']] : []), ...peers.map(item => [item.id, `${item.prompt} · ${formatDate(item.createdAt, true)} · ${item.id}`])],
    value: selected || '',
    onChange: event => router.go(href(run.id) + (event.target.value ? '?compare=' + encodeURIComponent(event.target.value) : '')),
  });
  function card(item, index) {
    const status = runStatus[item.status] ?? { text: item.status, tone: '' };
    return h('article', { class: 'card card__body stack' },
      h('h3', null, index === undefined ? item.prompt : `执行 ${index + 1} · ${item.prompt}`), Pill(status.text, status.tone),
      h('span', { class: 'small' }, executorName(item.executorId), ' · ', formatDate(item.createdAt, true)),
      h('div', null, item.usage
        ? `本次 Token：输入 ${item.usage.input.toLocaleString()} · 输出 ${item.usage.output.toLocaleString()}`
        : '本次 Token：未上报'),
      item.commitChanges ? h('div', { class: 'stack' },
        h('span', null, `目录内已提交差异：${item.commitChanges.files} 个文件 · +${item.commitChanges.added} / −${item.commitChanges.deleted} 行`),
        h('code', { class: 'small', title: item.commitChanges.base + ' → ' + item.commitChanges.head },
          item.commitChanges.base.slice(0, 10) + ' → ' + item.commitChanges.head.slice(0, 10)),
        item.commitChanges.files > 0 && Button({ label: '查看文件差异', size: 'sm', onClick: () => openCommitDiff({ item, api, store, router }) }))
        : h('span', { class: 'muted small' }, '目录内已提交差异：未上报'),
      item.worktree?.name && h('div', null, '工作树：', item.worktree.name),
      item.worktree?.base && h('div', { class: 'small' }, '工作树起点：', h('code', { title: item.worktree.base }, item.worktree.base.slice(0, 10))),
      item.cwd && h('div', null, '工作目录：', item.cwd),
      item.doneWhen && h('div', null, '完成标准：', item.doneWhen),
      h('pre', { class: 'output' }, item.output || '暂无输出'),
      item.error && h('pre', { class: 'output output--error' }, item.error),
      item.resultSource && h('span', { class: 'muted small' }, '结果来源：', item.resultSource),
      h('a', { href: href(item.id) }, '查看执行详情'));
  }
  const peer = peers.find(item => item.id === selected);
  return h('section', { class: 'stack', 'aria-label': '执行对比' }, pick,
    selected && h('a', { href: href(run.id) }, '关闭对比'),
    selected === 'group' && group ? h('div', { class: 'run-comparison' }, group.map((id, index) => {
      const item = id === run.id ? run : peers.find(candidate => candidate.id === id && candidate.comparisonRunIds?.[0] === group[0]);
      return item ? card(item, index) : h('p', { class: 'muted' }, `执行 ${index + 1} 的记录不可用。`);
    })) : peer ? h('div', { class: 'run-comparison' }, card(run), card(peer))
      : selected && h('p', { class: 'muted' }, '此记录无法与当前执行对比。'));
}

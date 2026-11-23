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

function openCommitDiff(options, commit, mode) {
  const { item, api } = options;
  const { area, active } = openRunDrawer(options, commit ? '提交详情' : '已提交文件差异', true);
  area.textContent = '正在读取历史提交…';
  const endpoint = '/runs/' + encodeURIComponent(item.id) + (commit ? '/worktree-history' : '/commit-diff');
  function url(path) {
    const query = new URLSearchParams({ ...(commit && { commit, mode }), ...(path !== undefined && { path }) });
    return endpoint + '?' + query;
  }
  let sequence = 0;
  async function load() {
    try {
      const { files, changes, hidden, author, authoredAt, message, merge } = await api.get(url());
      if (!active()) return;
      const output = h('pre', { class: 'code-sidebar__text', tabindex: 0 });
      const byPath = new Map((changes ?? []).map(change => [change.path, change]));
      const labels = { A: '新增', M: '修改', D: '删除', T: '类型变化', R: '重命名' };
      const picker = Select({ 'aria-label': '已提交文件', options: files.map(path => {
        const change = byPath.get(path);
        const displayPath = change?.previousPath ? change.previousPath + ' → ' + path : path;
        return [path, change ? `${displayPath} · ${labels[change.status] ?? change.status} · ${change.binary ? '二进制' : '+' + change.added + ' / −' + change.deleted}` : path];
      }), onChange: readFile });
      async function readFile() {
        const stamp = ++sequence;
        if (byPath.get(picker.value)?.binary) { output.textContent = '二进制文件没有文本补丁。'; return; }
        output.textContent = '正在读取文件差异…';
        try {
          const reply = await api.get(url(picker.value));
          if (active() && stamp === sequence) replace(output, renderDiffLines(reply.text));
        } catch (error) { if (active() && stamp === sequence) output.textContent = error.message; }
      }
      replace(area, commit && h('code', null, commit), author && h('p', { class: 'small muted' }, '提交作者：', author, authoredAt && ' · ' + formatDate(authoredAt, true)), message && h('pre', { class: 'output' }, message),
        merge && h('p', null, '以下差异相对第一父提交。'), hidden > 0 && h('p', { class: 'muted small' }, `已隐藏 ${hidden} 个受限文件。`),
        files.length ? [picker, output] : h('p', null, '没有可查看的文件差异。'));
      if (files.length) await readFile();
    } catch (error) { if (active()) replace(area, h('p', null, error.message), Button({ label: '重试', onClick: load })); }
  }
  void load();
}

export function openWorktreeHistory(options) {
  const { area, active } = openRunDrawer(options, '工作树提交历史');
  const rows = h('ol', { class: 'stack' });
  const footer = h('div');
  const picker = Select({ 'aria-label': '提交范围', options: [['unmerged', '尚未进入来源目录'], ['all', '全部历史']], onChange: () => load() });
  let sequence = 0;
  async function load(offset = 0, version) {
    const stamp = ++sequence;
    if (!offset) rows.replaceChildren();
    footer.textContent = '正在读取提交…';
    const query = new URLSearchParams({ mode: picker.value, offset: String(offset), ...(version && { version }) });
    try {
      const page = await options.api.get('/runs/' + encodeURIComponent(options.item.id) + '/worktree-history?' + query);
      if (!active() || stamp !== sequence) return;
      for (const commit of page.commits) rows.append(h('li', { class: 'stack' }, Button({ label: commit.subject || '无标题', onClick: () => openCommitDiff(options, commit.hash, picker.value) }),
        h('small', { class: 'muted' }, h('code', { title: commit.hash }, commit.hash.slice(0, 10)), ' · ', formatDate(commit.date, true))));
      replace(footer, !rows.childElementCount && h('p', null, '此范围没有提交。'),
        page.nextOffset !== null && Button({ label: '加载更早提交', onClick: () => load(page.nextOffset, page.version) }));
    } catch (error) {
      if (active() && stamp === sequence) replace(footer, h('p', null, error.message), Button({ label: '重新读取历史', onClick: () => load() }));
    }
  }
  replace(area, picker, rows, footer);
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
  const names = { M: '修改', T: '类型变化', A: '新增', D: '删除', R: '重命名', C: '复制', U: '冲突' };
  function fileState(file) {
    if (file.index === '?') return '未跟踪';
    if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(file.index + file.worktree)) return '合并冲突';
    return [file.index !== ' ' && '暂存区：' + (names[file.index] ?? file.index),
      file.worktree !== ' ' && '工作区：' + (names[file.worktree] ?? file.worktree)].filter(Boolean).join(' · ');
  }
  function fileRow(file) {
    const output = h('div');
    let sequence = 0;
    function action(area, label) {
      return Button({ label, size: 'sm', onClick: async () => {
        const stamp = ++sequence;
        output.textContent = '正在读取…';
        try {
          const reply = await api.get('/runs/' + encodeURIComponent(item.id) + '/worktree-change?' + new URLSearchParams({ path: file.path, area }));
          if (active() && stamp === sequence) replace(output, h('pre', { class: 'code-sidebar__text', tabindex: 0 },
            reply.kind === 'untracked' ? reply.text : reply.text ? renderDiffLines(reply.text) : '没有文本差异。'));
        } catch (error) { if (active() && stamp === sequence) output.textContent = error.message; }
      } });
    }
    return h('div', { class: 'stack' }, h('code', null, file.previousPath ? file.previousPath + ' → ' + file.path : file.path), h('small', { class: 'muted' }, fileState(file)),
      h('div', { class: 'row row--wrap' },
        file.index !== '?' && file.index !== ' ' && action('index', '查看暂存差异'),
        file.worktree !== ' ' && action('working', file.index === '?' ? '查看未跟踪文件' : '查看未暂存差异')), output);
  }
  async function load(offset = 0, version) {
    replace(area, h('p', { role: 'status' }, '正在读取工作树…'));
    try {
      const query = new URLSearchParams({ offset: String(offset), ...(version && { version }) });
      const value = await api.get('/runs/' + encodeURIComponent(item.id) + '/worktree-status?' + query);
      if (!active()) return;
      replace(area, h('strong', null, value.branch ?? '分离的 HEAD'), h('code', null, value.cwd),
        h('p', null, '当前提交 ', h('code', null, value.head.slice(0, 10)), ' · 来源提交 ', h('code', null, value.sourceHead.slice(0, 10))),
        h('p', null, `有 ${value.unmerged} 个提交尚未进入来源目录当前 HEAD。`),
        h('strong', null, `未提交文件（含未跟踪）：${value.total}`),
        value.files.map(fileRow),
        value.hidden > 0 && h('small', null, `已隐藏 ${value.hidden} 个受限文件。`),
        (offset > 0 || value.nextOffset > 0) && h('div', { class: 'row row--wrap' },
          offset > 0 && Button({ label: '上一页文件', onClick: () => load(Math.max(0, offset - 250), value.version) }),
          h('small', null, `可见文件 ${offset + 1}–${offset + value.files.length} / ${value.total - value.hidden}`),
          value.nextOffset > 0 && Button({ label: '下一页文件', onClick: () => load(value.nextOffset, value.version) })),
        value.truncated && value.nextOffset === undefined && h('small', null, '执行机仅返回前 250 个可见文件，升级代理可翻页。'),
        value.locked && h('p', null, 'Git 工作树已锁定，暂时无法清理目录。'),
        value.ignored > 0 && h('p', null, `有 ${value.ignored} 个 Git 忽略项，清理前请先移走需要保留的文件。`),
        value.blockedByRuns && h('section', { class: 'stack', 'aria-label': '阻止清理的执行' },
          h('strong', null, '以下执行尚未结束或结果未知，暂时无法清理目录。'),
          value.blockingRunIds.map(id => {
            const run = options.store.view.snapshot?.runs.find(candidate => candidate.id === id);
            return run ? h('a', { href: options.router.href('projects', run.projectId ?? 'all', 'runs', id) },
              run.prompt, ' · ', runStatus[run.status]?.text ?? run.status) : h('code', null, id);
          })),
        ['completed', 'failed'].includes(item.status) && value.total > 0 && h('small', { class: 'muted' }, '清理前请先提交或移走本地改动。'),
        ['completed', 'failed'].includes(item.status) && options.store.view.snapshot?.machines?.some(m =>
          m.id === item.machineId && m.capabilities.includes('workspace.removeRunWorktree')) &&
          Button({ label: '清理工作树目录', kind: 'danger', disabled: value.locked || value.ignored > 0 || value.blockedByRuns || value.total > 0 || value.branch !== item.worktree.branch,
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
                if (active()) replace(area, h('p', null, error.message), Button({ label: '重新核对状态', onClick: () => load() }));
              }
            } }),
        Button({ label: '刷新状态', size: 'sm', onClick: () => load() }));
    } catch (error) { if (active()) replace(area, h('p', null, error.message), Button({ label: '重试', onClick: () => load() })); }
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
      index !== undefined && h('p', {class:'small'}, item.id === run.id ? '当前执行（比较基准）' : usageDifference(item)),
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
  function usageDifference(peer) {
    if (!peer.usage || !run.usage) return '用量差额：有执行未上报 Token。';
    const signed = new Intl.NumberFormat('zh-CN', { signDisplay: 'exceptZero' });
    const input = peer.usage.input - run.usage.input;
    const output = peer.usage.output - run.usage.output;
    return `所选执行相对当前执行的 Token 差额：输入 ${signed.format(input)} · 输出 ${signed.format(output)}`;
  }
  return h('section', { class: 'stack', 'aria-label': '执行对比' }, pick,
    peer && h('p', { class: 'small' }, usageDifference(peer)),
    selected && h('a', { href: href(run.id) }, '关闭对比'),
    selected === 'group' && group ? h('div', { class: 'run-comparison' }, group.map((id, index) => {
      const item = id === run.id ? run : peers.find(candidate => candidate.id === id && candidate.comparisonRunIds?.[0] === group[0]);
      return item ? card(item, index) : h('p', { class: 'muted' }, `执行 ${index + 1} 的记录不可用。`);
    })) : peer ? h('div', { class: 'run-comparison' }, card(run), card(peer))
      : selected && h('p', { class: 'muted' }, '此记录无法与当前执行对比。'));
}

import { h, replace } from '../lib/dom.js';
import { makeFileDraggable } from './file-mention-drag.js';
import { Button } from '../ui/kit.js';
import { TextArea, Input, Field } from '../ui/kit.js';
import { confirmDialog } from '../ui/overlay.js';

function diffLineClass(line) {
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
    return 'diff-line diff-line--meta';
  }
  if (line.startsWith('@@')) return 'diff-line diff-line--hunk';
  if (line.startsWith('+')) return 'diff-line diff-line--add';
  if (line.startsWith('-')) return 'diff-line diff-line--del';
  return 'diff-line';
}

/** The line of the file a diff line is about, as the diff's own headers count them. */
export function diffLineNumbers(text) {
  const numbers = [];
  let line = 0;
  for (const row of text.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) { line = Number(hunk[1]); numbers.push(undefined); continue; }
    if (row.startsWith('+++') || row.startsWith('---') || row.startsWith('diff ') || row.startsWith('index ')) { numbers.push(undefined); continue; }
    if (row.startsWith('-')) { numbers.push(undefined); continue; }
    if (row.startsWith('+') || row.startsWith(' ')) { numbers.push(line++); continue; }
    numbers.push(undefined);
  }
  return numbers;
}

export function renderDiffLines(text) {
  const lines = text.split('\n');
  const nodes = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1 && lines[i] === '') break;
    nodes.push(h('span', { class: diffLineClass(lines[i]) }, lines[i]));
    if (i < lines.length - 1) nodes.push('\n');
  }
  return nodes;
}

/** Both conversations browse the saved computer binding through the same read-only API. */
export function createCodeSidebar({ api, store, compose }) {
  let projectId = '', selected = '', sequence = 0, binding = '', opened = false, mode = 'file';
  const body = h('div', { class: 'code-sidebar__body' });
  const crumbs = h('div', { class: 'code-sidebar__crumbs small muted' });
  const output = h('pre', { class: 'code-sidebar__text', tabindex: 0 });
  const status = h('p', { class: 'muted small', role: 'status' });
  const tree = h('nav', { 'aria-label': '项目目录' });
  // Editing a file: what was read, and the editor for it. A file can be saved only as it was read.
  const editor = h('div', { class: 'stack code-sidebar__edit', 'aria-label': '编辑文件', hidden: true });
  let editing = null;
  // The branch the project is on, as the Git panel last read it.
  let gitBranch = '';
  // The Git state of the project: what is staged, what is not, and a commit of what is staged.
  const gitPanel = h('section', { class: 'stack code-sidebar__git', 'aria-label': 'Git' });
  // Announced as it changes, as a status is, without taking the status role the file's own
  // reading line has: one status per panel keeps both readable.
  const gitStatus = h('p', { class: 'small muted', 'aria-live': 'polite' });
  const gitList = h('ul', { class: 'list', 'aria-label': '改动' });
  const gitMessage = TextArea({ 'aria-label': '提交说明', rows: 2, placeholder: '这次改了什么' });
  const gitCommit = Button({ label: '提交已暂存的改动', size: 'sm', kind: 'primary', onClick: () => commit() });
  const gitRefresh = Button({ label: '刷新 Git 状态', size: 'sm', onClick: () => readGit() });
  gitPanel.append(h('h3', null, 'Git'), h('div', { class: 'row' }, gitRefresh), gitStatus, gitList, gitMessage, gitCommit);
  // Opening a pull request: the branch is pushed and the pull request opened, after the owner
  // approves it in the approvals list. Nothing is pushed from here.
  const pullPanel = h('details', { class: 'fold code-sidebar__git', 'aria-label': '开出 PR' });
  const pullRepository = Input({ 'aria-label': '仓库', placeholder: '所有者/仓库名', maxlength: 140 });
  const pullBase = Input({ 'aria-label': '合并到哪个分支', placeholder: 'main', maxlength: 200 });
  const pullTitle = Input({ 'aria-label': 'PR 标题', maxlength: 256 });
  const pullBody = TextArea({ 'aria-label': 'PR 说明', rows: 3, maxlength: 65536 });
  const pullStatus = h('p', { class: 'small', 'aria-live': 'polite' });
  const pullOpen = Button({ label: '提交审批', size: 'sm', kind: 'primary', onClick: async (event, button) => {
    button.disabled = true; pullStatus.textContent = '';
    try {
      await api.post('/github/pulls', { projectId, repository: pullRepository.value.trim(), branch: gitBranch, base: pullBase.value.trim(),
        title: pullTitle.value.trim(), ...(pullBody.value.trim() ? { body: pullBody.value } : {}) });
      pullStatus.textContent = '已提交审批。到「等你处理」里核对仓库、分支和标题，同意后才会推送并开出 PR。';
    } catch (error) {
      pullStatus.textContent = `没有提交：${error.message}`;
      button.disabled = false;
    }
  } });
  pullOpen.disabled = true;
  pullPanel.append(h('summary', null, '开出 PR'),
    h('p', { class: 'small muted' }, '把当前分支推到 GitHub 并开出 PR。推送前会形成审批，同意后才推送。'),
    Field({ label: '仓库', control: pullRepository }), Field({ label: '合并到哪个分支', control: pullBase }),
    Field({ label: '标题', control: pullTitle }), Field({ label: '说明', control: pullBody }), pullOpen, pullStatus);
  // The preview: what a server on the bound computer is showing at a port. The server is started
  // in a terminal; this reads its page. Closing only puts the panel away and stops nothing.
  const previewPanel = h('section', { class: 'stack code-sidebar__preview', 'aria-label': '预览' });
  const previewPort = Input({ 'aria-label': '端口', type: 'number', min: 1, max: 65535, value: '3000', placeholder: '3000' });
  const previewPath = Input({ 'aria-label': '页面路径', value: '/', placeholder: '/' });
  const previewStatus = h('p', { class: 'small muted', 'aria-live': 'polite' });
  // A div and not a pre: the file's own content is the panel's one pre, and is found as that.
  const previewPage = h('div', { class: 'code-sidebar__text', tabindex: 0, hidden: true });
  let previewOpen = false;
  const previewClose = Button({ label: '关闭预览', size: 'sm', onClick: () => {
    previewOpen = false; previewPage.hidden = true; previewPage.textContent = '';
    previewStatus.textContent = '预览已关闭。服务没有停，要停请到终端里停。';
  } });
  const previewRead = Button({ label: '打开预览', size: 'sm', kind: 'primary', onClick: async (event, button) => {
    button.disabled = true; previewStatus.textContent = '正在读取这台电脑上的页面…';
    try {
      const value = await api.get(`/projects/${encodeURIComponent(projectId)}/preview?${new URLSearchParams({ port: previewPort.value, path: previewPath.value })}`);
      previewOpen = true;
      previewStatus.textContent = value.ok
        ? `HTTP ${value.status} · ${value.type || '未知类型'} · ${value.ms} 毫秒 · 读取于 ${new Date(value.at).toLocaleTimeString('zh-CN', { hour12: false })}`
        : `没有打开：${value.error || ('HTTP ' + value.status)}`;
      previewPage.textContent = value.text ?? '';
      previewPage.hidden = !value.text;
    } catch (error) {
      previewStatus.textContent = `没有打开：${error.message}`;
      previewPage.hidden = true;
    } finally { button.disabled = false; }
  } });
  previewPanel.append(h('h3', null, '预览'), h('p', { class: 'small muted' }, '读取这台电脑上某个端口正在运行的服务。先在终端里启动它。'),
    h('div', { class: 'form-row' }, Field({ label: '端口', control: previewPort }), Field({ label: '页面路径', control: previewPath })),
    h('div', { class: 'row' }, previewRead, previewClose), previewStatus, previewPage);
  const edit = Button({ label: '编辑', size: 'sm', onClick: () => { if (editing) showEditor(); } });
  const save = Button({ label: '保存到电脑', size: 'sm', kind: 'primary', onClick: () => saveFile() });
  const undo = Button({ label: '撤销上次保存', size: 'sm', onClick: () => undoFile() });
  edit.disabled = true; undo.disabled = true;
  const title = h('p', { class: 'small code-sidebar__binding' });
  const fileBtn = Button({ label: '文本', size: 'sm', onClick: () => selected && read('file', selected) });
  const diffBtn = Button({ label: 'Git diff', size: 'sm', onClick: () => selected && read('diff', selected) });
  function syncModeButtons() {
    fileBtn.classList.toggle('is-active', mode === 'file');
    diffBtn.classList.toggle('is-active', mode === 'diff');
  }
  function renderCrumbs(pathStr) {
    const parts = pathStr ? pathStr.split('/').filter(Boolean) : [];
    const nodes = [h('span', { class: 'code-sidebar__crumb' }, '根目录')];
    for (const part of parts) {
      nodes.push(h('span', { class: 'code-sidebar__sep', 'aria-hidden': 'true' }, ' / '), h('span', { class: 'code-sidebar__crumb' }, part));
    }
    replace(crumbs, nodes);
  }
  const el = h('aside', { class: 'code-sidebar', 'aria-label': '项目代码', hidden: true },
    h('div', { class: 'row row--between' }, h('h2', null, '项目代码'), Button({ label: '关闭代码', size: 'sm', onClick: () => { el.hidden = true; opened = false; } })), title, body);
  body.append(crumbs, tree, status, h('div', { class: 'row' }, fileBtn, diffBtn, edit), output, editor, gitPanel, pullPanel, previewPanel);
  const toggle = Button({ label: '查看代码', size: 'sm', onClick: () => { opened = !opened; el.hidden = !opened; if (opened) { void read('tree', ''); void readGit(); } } });
  syncModeButtons();
  function project() { return store.view.snapshot?.projects?.find(p => p.id === projectId); }
  function sync() {
    const p = project();
    title.textContent = p?.workspace ? `${p.name} · ${p.workspace.machineId}\n${p.workspace.cwd}` : '请先选择并绑定项目文件夹';
    toggle.disabled = !p?.workspace;
    const next = JSON.stringify([projectId, p?.workspace]);
    if (next !== binding) {
      binding = next; sequence++; selected = ''; mode = 'file'; syncModeButtons();
      replace(crumbs); replace(tree); output.textContent = ''; status.textContent = '';
      // Another project: the file being edited belongs to the one before.
      editing = null; edit.disabled = true; undo.disabled = true; editor.hidden = true;
      if (opened && p?.workspace) { void read('tree', ''); void readGit(); }
    }
  }
  async function read(kind, path) {
    if (!project()?.workspace) return;
    if (kind === 'tree') selected = '';
    else { mode = kind; syncModeButtons(); }
    const stamp = ++sequence;
    status.textContent = '正在读取绑定电脑…'; output.textContent = '';
    try {
      const value = await api.get(`/projects/${encodeURIComponent(projectId)}/code?${new URLSearchParams({ kind, path })}`);
      if (stamp !== sequence) return;
      renderCrumbs(path);
      status.textContent = value.truncated ? '目录条目达到上限，请进入子目录查看。' : value.note || '';
      if (kind === 'tree') {
        const parent = path.split('/').slice(0, -1).join('/');
        const parentBtn = path ? Button({ label: '上级目录', size: 'sm', onClick: () => read('tree', parent) }) : null;
        if (parentBtn) parentBtn.classList.add('code-tree__item', 'code-tree__item--dir');
        const entries = (value.entries ?? []).map((e) => {
          const btn = Button({
            label: `${e.directory ? '▸ ' : ''}${e.name}`,
            size: 'sm',
            onClick: () => {
              if (!e.directory) {
                selected = e.path;
                for (const item of tree.querySelectorAll('.code-tree__item--file')) item.classList.remove('is-active');
                btn.classList.add('is-active');
              }
              void read(e.directory ? 'tree' : 'file', e.path);
            },
          });
          makeFileDraggable(btn, { api, store, projectId, path: e.path, directory: e.directory });
          btn.classList.add('code-tree__item', e.directory ? 'code-tree__item--dir' : 'code-tree__item--file');
          if (!e.directory && selected === e.path) btn.classList.add('is-active');
          return btn;
        });
        replace(tree, parentBtn, entries);
      } else {
        status.textContent = `${path}${value.note ? ' · ' + value.note : ''}`;
        if (kind === 'diff' && value.text) replace(output, renderReviewDiff(value.text, path));
        else output.textContent = value.text || (kind === 'diff' ? '没有已跟踪文件差异。' : '');
        // A file as read can be edited: what was read is kept, with its hash, so that saving is
        // refused if the file changed on the computer in the meantime.
        if (kind === 'file') {
          editing = { path, text: value.text, hash: value.hash };
          edit.disabled = !value.hash;
        }
      }
    } catch (error) { if (stamp === sequence) status.textContent = `读取失败：${error.message}`; }
  }
  function openFile(path) {
    if (!project()?.workspace) return false;
    opened = true; el.hidden = false; selected = path;
    replace(tree, Button({ label: '所在目录', size: 'sm', onClick: () => read('tree', path.split('/').slice(0, -1).join('/')) }));
    void read('file', path);
    return true;
  }
  function showEditor() {
    if (!editing) return;
    const box = TextArea({ 'aria-label': '文件内容', rows: 14, spellcheck: false });
    box.value = editing.text;
    const feedback = h('p', { class: 'small', role: 'status' });
    replace(editor, h('strong', { class: 'small' }, '编辑 ' + editing.path), box, h('div', { class: 'row' }, save, undo), feedback);
    editor.hidden = false;
    editor._box = box; editor._feedback = feedback;
    box.addEventListener('input', () => { save.disabled = box.value === editing.text; });
    save.disabled = true;
  }
  async function saveFile() {
    if (!editing || !editor._box || !project()?.workspace) return;
    const box = editor._box, feedback = editor._feedback;
    save.disabled = true;
    try {
      const result = await api.put(`/projects/${encodeURIComponent(projectId)}/code/file`, { path: editing.path, text: box.value, expected: editing.hash });
      if (result?.written !== true) throw new Error('保存结果与这台电脑对不上');
      editing = { path: editing.path, text: box.value, hash: result.hash, undoId: result.undoId };
      undo.disabled = false;
      feedback.textContent = '已保存到电脑。';
      // What the page shows is what is on the computer now.
      output.textContent = box.value;
      save.disabled = true;
    } catch (error) {
      // The file changed on the computer: the owner is told to read it again, and nothing was written.
      feedback.textContent = error?.status === 409 ? `没有保存：${error.message}` : '保存失败或结果未知，请重新读取文件核对。';
      if (error?.status === 409) { edit.disabled = true; save.disabled = true; }
    }
  }
  async function undoFile() {
    if (!editing?.undoId || !project()?.workspace) return;
    const feedback = editor._feedback;
    if (!await confirmDialog({ title: '撤销上次保存？', message: '文件会恢复成保存前的内容。保存后文件又变过的话，不会撤销。', confirmLabel: '撤销' })) return;
    undo.disabled = true;
    try {
      await api.post(`/projects/${encodeURIComponent(projectId)}/code/file/undo`, { undoId: editing.undoId, expected: editing.hash });
      editing.undoId = undefined;
      await read('file', editing.path);
      showEditor();
      editor._feedback.textContent = '已撤销，文件恢复成保存前的内容。';
    } catch (error) {
      feedback.textContent = error?.status === 409 ? `没有撤销：${error.message}` : '撤销失败或结果未知，请重新读取文件核对。';
      undo.disabled = false;
    }
  }
  /** The diff as lines that can be pointed at: clicking one opens a comment on it, and the
   *  comment goes to the conversation as a quotation of that line, where the assistant reads it. */
  function renderReviewDiff(text, path) {
    const lines = text.split('\n'), numbers = diffLineNumbers(text), nodes = [];
    const comment = h('div', { class: 'stack code-sidebar__comment', role: 'group', 'aria-label': '对这一行评论', hidden: true });
    let chosen = -1;
    for (let i = 0; i < lines.length; i++) {
      if (i === lines.length - 1 && lines[i] === '') break;
      const number = numbers[i];
      // Only a line of the file as it is now can be commented on: a removed line is not there to point at.
      const target = number === undefined ? null : i;
      const row = h('span', { class: diffLineClass(lines[i]) + (target === null ? '' : ' diff-line--target'),
        ...(target === null ? {} : { role: 'button', tabindex: 0, 'aria-label': '评论第 ' + number + ' 行' }), dataset: target === null ? {} : { line: String(target) } },
        number === undefined ? lines[i] : h('span', { class: 'diff-line__no' }, String(number).padStart(4, ' ') + ' '), lines[i].slice(1));
      nodes.push(row);
      if (i < lines.length - 1) nodes.push('\n');
      if (target === null) continue;
      const open = () => {
        chosen = target;
        for (const other of output.querySelectorAll('.diff-line--active')) other.classList.remove('diff-line--active');
        row.classList.add('diff-line--active');
        const box = TextArea({ 'aria-label': '评论', rows: 3, placeholder: '对这一行有什么要改的' });
        const add = Button({ label: '加入对话', size: 'sm', kind: 'primary', onClick: () => {
          const words = box.value.trim();
          if (!words) { box.focus(); return; }
          // The quotation names the file and the line, and carries the line as it is, so that the
          // assistant reads the right place without being told where to look.
          compose?.('> ' + path + ':' + number + ' ' + (lines[chosen] ?? '').slice(1) + '\n\n' + words + '\n\n');
          comment.hidden = true; row.classList.remove('diff-line--active');
        } });
        replace(comment, h('strong', { class: 'small' }, path + ' 第 ' + number + ' 行'), box, h('div', { class: 'row' }, add,
          Button({ label: '取消', size: 'sm', onClick: () => { comment.hidden = true; row.classList.remove('diff-line--active'); } })));
        comment.hidden = false;
        row.after(comment);
        box.focus();
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    }
    return nodes;
  }
  async function readGit() {
    if (!project()?.workspace) return;
    const stamp = sequence;
    gitStatus.textContent = '正在读取 Git 状态…';
    try {
      const value = await api.get(`/projects/${encodeURIComponent(projectId)}/git`);
      if (stamp !== sequence) return;
      renderGit(value);
    } catch (error) {
      if (stamp === sequence) { gitStatus.textContent = `Git 状态读取失败：${error.message}`; replace(gitList); }
    }
  }
  function renderGit(value) {
    const staged = Array.isArray(value.staged) ? value.staged : [], unstaged = Array.isArray(value.unstaged) ? value.unstaged : [];
    gitBranch = typeof value.branch === 'string' ? value.branch : '';
    pullOpen.disabled = !gitBranch;
    gitStatus.textContent = value.branch ? `分支 ${value.branch} · 已暂存 ${staged.length} 个，未暂存 ${unstaged.length} 个` : '这个目录还没有提交，Git 状态未知。';
    const row = (change, isStaged) => h('li', { class: 'item' },
      h('div', { class: 'row row--between row--wrap' },
        h('code', { class: 'small', title: change.path }, change.path), h('span', { class: 'muted small' }, change.change),
        Button({ label: isStaged ? '取消暂存' : '暂存', size: 'sm', onClick: async (event, button) => {
          button.disabled = true;
          try { renderGit(await api.post(`/projects/${encodeURIComponent(projectId)}/git`, { op: isStaged ? 'unstage' : 'stage', path: change.path })); }
          catch (error) { gitStatus.textContent = `${isStaged ? '取消暂存' : '暂存'}失败：${error.message}`; button.disabled = false; }
        } })));
    replace(gitList, [...staged.map(change => row(change, true)), ...unstaged.filter(change => !staged.some(other => other.path === change.path)).map(change => row(change, false))]);
    gitCommit.disabled = staged.length === 0;
  }
  async function commit() {
    if (!project()?.workspace) return;
    const message = gitMessage.value.trim();
    if (!message) { gitMessage.focus(); return; }
    gitCommit.disabled = true;
    try {
      const value = await api.post(`/projects/${encodeURIComponent(projectId)}/git`, { op: 'commit', message });
      gitMessage.value = '';
      renderGit(value);
      gitStatus.textContent = `已提交：${value.summary}`;
    } catch (error) {
      gitStatus.textContent = `提交失败：${error.message}`;
      gitCommit.disabled = false;
    }
  }
  return { el, toggle, openFile, show(id) { projectId = id || ''; sync(); }, update: sync };
}

// 工作指令归属项目。草稿与版本只保存在本次打开的抽屉内。
import { h, replace } from '../lib/dom.js';
import { Button, Field, TextArea } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const maxCharacters = 4000;

export function createProjectInstructions({ api, store, getProjectId }) {
  const selected = () => store.view.snapshot?.projects?.find(project => project.id === getProjectId() && !project.archivedAt);
  const enabled = () => !store.view.unauthorized && !!selected() && store.view.snapshot?.plugins?.some(
    plugin => plugin.id === 'project-instructions' && plugin.status === 'active');
  let drawer;
  const button = Button({ label: '工作指令', size: 'sm', onClick: open });
  const update = () => { button.hidden = !enabled(); };
  store.subscribe(update);
  update();

  function open() {
    if (drawer?.el.open || !enabled()) return;
    const project = selected(), token = api.token(), route = location.hash;
    let base, latest, needsReview = false, busy = false, refreshing = false;
    const notes = TextArea({ rows: 8, oninput: () => { status.textContent = ''; sync(); } });
    const count = h('span', { class: 'small muted' });
    const status = h('p', { role: 'status' });
    const version = h('span', { class: 'small muted' });
    const remote = h('section', { hidden: true, class: 'stack', 'aria-label': '服务端当前版本' });
    const review = h('div', { class: 'stack' });
    const clear = Button({ label: '清空草稿', onClick: () => {
      if (!current()) return;
      notes.value = '';
      status.textContent = '草稿已清空。保存后清除本项目的工作指令。';
      sync();
      notes.focus();
    } });
    const save = Button({ label: '保存', kind: 'primary', onClick: () => write(base) });
    const editor = Field({ label: '项目所有者说明', control: notes });
    const opened = openDrawer({ title: '工作指令', subtitle: project.name, wide: true,
      body: [h('p', { class: 'small muted' }, '这里记录项目所有者对本项目的要求。下轮项目对话和新派发的普通项目任务会读取当前版本。已确认的审批任务与原生会话恢复沿用原文。'),
        h('div', { class: 'stack', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' } },
          h('div', { class: 'stack' }, editor, count, version), remote),
        status, review, h('div', { class: 'row row--wrap' }, clear, save)],
      onClose() {
        unsubscribe();
        base = latest = undefined;
        notes.value = '';
        opened.body.replaceChildren();
        if (drawer === opened) drawer = undefined;
      } });
    drawer = opened;
    const current = () => opened.el.open && token === api.token() && route === location.hash && getProjectId() === project.id && enabled();
    let observed = store.view.projectInstructionsChange, connection = store.view.connection;
    let pendingRevision = 0, reconnected = false;
    const unsubscribe = store.subscribe(view => {
      if (!current()) { opened.close(); return; }
      if (observed !== view.projectInstructionsChange) {
        observed = view.projectInstructionsChange;
        if (observed?.projectId === project.id) pendingRevision = Math.max(pendingRevision, observed.revision);
      }
      if (connection !== 'online' && view.connection === 'online') reconnected = true;
      connection = view.connection;
      checkUpdates();
    });

    function checkUpdates() {
      if (busy || !current() || (!pendingRevision && !reconnected)) return;
      const newer = pendingRevision > ((latest ?? base)?.revision ?? 0);
      pendingRevision = 0;
      const check = reconnected || newer;
      reconnected = false;
      if (!check || !base) return;
      if (!needsReview && notes.value === base.notes) { void read(true); return; }
      // Keep the draft and its selection until the user chooses to compare versions.
      if (newer && latest) { latest = undefined; sync(); }
      replace(review, Button({ label: '核对最新版本', onClick: () => { needsReview = true; void read(); } }));
      status.textContent = newer ? '此项目的工作指令已有新版本。你的草稿已保留。' : '连接已恢复，可核对最新的工作指令。';
    }

    function versionLabel(record) {
      return '版本 ' + record.revision + (record.updatedAt ? ' · 保存于 ' + record.updatedAt : ' · 保存时间未记录');
    }
    function sync() {
      version.textContent = base ? (base.revision ? '草稿基于' + versionLabel(base) : '尚无已保存的版本') : '';
      remote.hidden = !needsReview || !latest;
      if (remote.hidden) remote.replaceChildren();
      const length = Array.from(notes.value).length;
      count.textContent = length + ' / ' + maxCharacters + ' 个字符' + (length > maxCharacters ? '，请缩短草稿后保存。' : '');
      notes.setAttribute('aria-invalid', String(length > maxCharacters));
      notes.disabled = !base || (busy && !refreshing);
      clear.disabled = notes.disabled || !notes.value;
      save.hidden = needsReview;
      save.disabled = busy || notes.disabled || needsReview || length > maxCharacters || base?.notes === notes.value;
      const compare = review.querySelector('[data-save-draft]');
      if (compare) compare.disabled = busy || length > maxCharacters;
    }
    async function readDocument() {
      const result = await api.post('/project-instructions', { action: 'read', projectId: project.id });
      if (result.projectId !== project.id) throw new Error('返回的工作指令与当前项目不符。');
      return result;
    }
    function failedRead(cause) {
      if (!current()) return;
      status.textContent = cause.message;
      // 权限被撤销时立即丢弃之前读取的内容。
      if (cause.status === 401 || cause.status === 403 || cause.status === 404) {
        notes.value = ''; base = latest = undefined; needsReview = false;
      }
      replace(review, Button({ label: '重新读取工作指令', onClick: () => read() }));
    }
    async function read(background = false) {
      if (busy || !current()) return;
      busy = true;
      refreshing = background;
      status.textContent = '正在读取工作指令…';
      review.replaceChildren();
      sync();
      try {
        const result = await readDocument();
        if (!current()) return;
        if (base && notes.value !== base.notes && base.revision !== result.revision) needsReview = true;
        if (needsReview) showVersions(result);
        else if (base && notes.value !== base.notes) status.textContent = '';
        else { base = result; notes.value = result.notes; status.textContent = ''; }
      } catch (cause) { failedRead(cause); }
      finally { refreshing = false; busy = false; if (current()) { sync(); checkUpdates(); } }
    }
    function showVersions(result, explanation = '请核对服务端当前版本。') {
      latest = result;
      status.textContent = explanation + '你的草稿已保留。';
      replace(remote, h('strong', null, '服务端当前版本'),
        h('span', { class: 'small muted' }, versionLabel(latest)),
        h('pre', { class: 'mailbox-content' }, latest.notes || '（空）'));
      replace(review, h('div', { class: 'row row--wrap' },
          Button({ label: '采用服务端版本', onClick() {
            if (busy || !current()) return;
            base = latest; latest = undefined; needsReview = false;
            notes.value = base.notes;
            review.replaceChildren();
            status.textContent = '已采用服务端版本。';
            sync();
          } }),
          Button({ label: '保存我的草稿', kind: 'primary', dataset: { saveDraft: 'true' }, onClick: () => write(latest) })));
    }
    async function write(version) {
      if (busy || !current() || !version || Array.from(notes.value).length > maxCharacters) return;
      busy = true;
      sync();
      status.textContent = '正在保存工作指令…';
      try {
        const next = await api.post('/project-instructions', { action: 'save', projectId: project.id, notes: notes.value, revision: version.revision });
        if (!current()) return;
        if (next.projectId !== project.id) throw new Error('保存结果与当前项目不符。');
        base = next; latest = undefined; needsReview = false;
        notes.value = base.notes;
        review.replaceChildren();
        status.textContent = base.notes ? '工作指令已保存。' : '工作指令已清除。';
      } catch (cause) {
        if (!current()) return;
        if (cause.status === 409 || !cause.status || cause.status >= 500) {
          // 写入冲突或结果未知时，只读回最新记录，由用户决定下次写入。
          needsReview = true;
          latest = undefined;
          review.replaceChildren();
          try {
            const result = await readDocument();
            if (current()) showVersions(result, cause.status === 409 ? '服务端版本已更改。' : '保存结果未确认，请核对服务端当前版本。');
          } catch (readError) { failedRead(readError); }
        } else if ([401, 403, 404].includes(cause.status)) failedRead(cause);
        else status.textContent = cause.message;
      } finally { busy = false; if (current()) { sync(); checkUpdates(); } }
    }
    void read();
  }
  return { button, update, close: () => drawer?.close() };
}

// 项目经验：已验收的任务留下的做法，交给这个项目的新 Agent。主人可改正和删除。
import { h, keyedList, replace } from '../lib/dom.js';
import { Button, TextArea } from '../ui/kit.js';
import { confirmDialog, openDrawer } from '../ui/overlay.js';

const kinds = { repeated_mistake: '反复出错', missing_context: '缺少背景', wasted_step: '绕了弯路', improvement: '更好的做法' };
const maxLength = 600;

/** 一行一条经验。改正时在原位换成编辑框，取消或保存后恢复。 */
function renderItem(lesson, actions) {
  const row = h('article', { class: 'stack', dataset: { lesson: lesson.id } });
  const meta = [
    kinds[lesson.kind] ?? lesson.kind,
    lesson.edited ? '主人改过' : '模型记录',
    lesson.seen > 1 ? '出现 ' + lesson.seen + ' 次' : '',
    lesson.stale ? '九十天未再出现，已不再下发给新 Agent' : '',
  ].filter(Boolean).join(' · ');
  const show = () => replace(row,
    h('div', { class: 'row row--between row--wrap' },
      h('span', { class: 'small muted' }, meta),
      lesson.stale ? h('span', { class: 'pill' }, '已停用') : null,
      h('span', { class: 'row row--wrap' },
        Button({ label: '改正', size: 'sm', onClick: edit }),
        Button({ label: '删除', size: 'sm', onClick: () => actions.remove(lesson) }))),
    h('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 } }, lesson.text),
    lesson.sources.length ? h('details', null, h('summary', { class: 'small muted' }, '来自 ' + lesson.sources.length + ' 项已验收任务'),
      h('ul', { class: 'stack', style: { margin: 0 } }, lesson.sources.map(source => h('li', { class: 'small' },
        source.title ?? source.todoId, source.runId ? h('span', { class: 'muted' }, ' · 执行 ' + source.runId.slice(0, 8)) : null)))) : null);
  function edit() {
    const notes = TextArea({ rows: 3, value: lesson.text, maxLength: String(maxLength), 'aria-label': '经验正文' });
    const status = h('p', { role: 'status', class: 'small' });
    const count = h('span', { class: 'small muted' });
    let busy = false;
    const sync = () => {
      const length = Array.from(notes.value).length;
      count.textContent = length + ' / ' + maxLength;
      notes.setAttribute('aria-invalid', String(length > maxLength));
      save.disabled = busy || length > maxLength || length === 0 || notes.value.trim() === lesson.text;
    };
    const save = Button({ label: '保存', kind: 'primary', size: 'sm', onClick: async () => {
      busy = true; sync();
      try {
        await actions.edit(lesson, notes.value);
        if (!row.isConnected) return;
        show();
      } catch (error) {
        if (!row.isConnected) return;
        status.textContent = error.message;
        if (error.status === 409 || [401, 403, 404].includes(error.status)) {
          // The lesson changed elsewhere. Show the current list; the draft is left in place
          // for the owner to compare.
          await actions.reload();
        }
      } finally { busy = false; if (row.isConnected) sync(); }
    } });
    notes.addEventListener('input', sync);
    replace(row, h('label', { class: 'stack' }, h('span', { class: 'small muted' }, '改正这条经验'), notes, count),
      h('div', { class: 'row row--wrap' }, save, Button({ label: '取消', size: 'sm', onClick: show })), status);
    notes.focus();
    sync();
  }
  show();
  return row;
}

export function openProjectLessons(api, projectId, projectName) {
  const status = h('p', { role: 'status' }, '正在读取…');
  const list = h('div', { class: 'stack stack--lg', 'aria-label': '项目经验' });
  const error = h('div');
  let busy = false, timer, sequence = 0;
  const drawer = openDrawer({ title: '项目经验', subtitle: projectName, body: [
    h('p', { class: 'small muted' }, '你验收任务后，模型从这项任务里记下有证据的做法，交给这个项目之后的新 Agent。你可以改正措辞或删除。九十天没有再出现的经验不再下发。'),
    error, status, list,
  ], onClose: () => { clearTimeout(timer); sequence++; } });
  async function reload() {
    const stamp = ++sequence;
    try {
      const data = await api.get('/projects/' + encodeURIComponent(projectId) + '/lessons');
      if (stamp !== sequence || !drawer.el.open) return;
      error.replaceChildren();
      status.textContent = data.length ? '' : '还没有项目经验。验收这个项目的任务后会出现在这里。';
      keyedList(list, data, item => item.id, item => renderItem(item, actions));
    } catch (cause) {
      if (stamp !== sequence || !drawer.el.open) return;
      status.textContent = '';
      replace(error, h('p', { role: 'alert' }, '无法读取项目经验：' + cause.message),
        Button({ label: '重试', size: 'sm', onClick: () => { error.replaceChildren(); void reload(); } }));
    }
  }
  const actions = {
    async reload() { if (!busy) await reload(); },
    async edit(lesson, text) {
      await api.put('/projects/' + encodeURIComponent(projectId) + '/lessons', { id: lesson.id, text, version: lesson.version });
      await reload();
    },
    async remove(lesson) {
      const ok = await confirmDialog({ title: '删除这条经验？', message: lesson.text, confirmLabel: '删除', danger: true });
      if (!ok || !drawer.el.open) return;
      busy = true;
      try {
        await api.del('/projects/' + encodeURIComponent(projectId) + '/lessons', { id: lesson.id, version: lesson.version });
        if (drawer.el.open) await reload();
      } catch (cause) {
        if (drawer.el.open) status.textContent = '未能删除：' + cause.message;
        if ([404, 409].includes(cause.status) && drawer.el.open) await reload();
      } finally { busy = false; }
    },
  };
  void reload();
  // Lessons arrive after an acceptance, with no event of their own. Poll while open.
  timer = setInterval(() => { if (!busy && drawer.el.open && !list.querySelector('textarea')) void reload(); }, 4000);
  return drawer;
}

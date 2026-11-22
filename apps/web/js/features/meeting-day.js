import { h, replace } from '../lib/dom.js';
import { appendConversationQuestion } from '../lib/conversation-drafts.js';
import { Button, Field, Input, Select } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const partNames = { morning: '上午', afternoon: '下午', evening: '晚间' };
const statusNames = { queued: '等待整理', running: '整理中', awaiting_approval: '等待审批', completed: '已整理', failed: '整理失败', unknown: '结果未确认' };

export function editMeetingTitle(api, id, title, current, saved) {
  const input = Input({ value: title });
  const status = h('p', { role: 'status' });
  const save = Button({ label: '保存标题', kind: 'primary', onClick: async () => {
    if (!current()) { editor.close(); return; }
    save.disabled = true;
    try {
      const result = await api.put('/knowledge/sources/' + encodeURIComponent(id) + '/title',
        { title: input.value, expectedTitle: title });
      if (current()) saved(result.title);
      editor.close();
    } catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  } });
  const editor = openDrawer({ title: '修改会议标题', body: [Field({ label: '会议标题', control: input, hint: '留空恢复登记时的标题。' }), status], footer: save });
  return editor;
}

export function openMeetingDay({ api, store, scope, router }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const date = Input({ type: 'date', value: new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) });
  const zone = Input({ value: timezone });
  const projects = store.view.snapshot.projects.filter(row => !row.archivedAt);
  const project = Select({ options: [['', '全部可见来源'], ...projects.map(row => [row.id, row.name])], value: scope.get() || '' });
  const summary = h('p', { role: 'status' });
  const timeline = h('div', { class: 'stack' });
  let group, lastPart, displayed, titleEditor;
  let request = 0, nextOffset = null;
  const owner = api.draftOwner();
  const current = () => drawer.el.open && owner === api.draftOwner() && owner === store.view.snapshotOwner &&
    !store.view.unauthorized && store.view.snapshot?.plugins.some(p => p.id === 'knowledge-local' && p.status === 'active') &&
    (!project.value || store.view.snapshot.projects.some(p => p.id === project.value && !p.archivedAt));
  let question = '';
  const ask = Button({ label: '将回顾问题加入对话草稿', size: 'sm', onClick() {
    if (!question || !current()) return;
    try { appendConversationQuestion({ api, store, scope, router }, project.value, question); drawer.close(); }
    catch (error) { summary.textContent = error.message; }
  } });
  function reset() {
    ask.hidden = true; question = '';
    request++; nextOffset = null; more.hidden = true; replace(timeline); lastPart = null; displayed = 0; summary.textContent = '';
  }
  async function load(offset = 0) {
    if (!offset) reset();
    if (!current()) { drawer.close(); return; }
    const stamp = ++request;
    more.disabled = true;
    summary.textContent = '正在读取会议来源…';
    const params = new URLSearchParams({ date: date.value, timezone: zone.value.trim(), offset: String(offset) });
    if (project.value) params.set('projectId', project.value);
    try {
      const result = await api.get('/knowledge/meeting-day?' + params);
      if (stamp !== request || !current()) return;
      const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: result.timezone, hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset', hourCycle: 'h23' });
      for (const source of result.meetings) {
        if (source.dayPart !== lastPart) {
          lastPart = source.dayPart;
          const label = partNames[lastPart];
          group = h('ol', { class: 'stack', 'aria-label': label });
          timeline.append(h('section', null, h('h3', null, label), group));
        }
        displayed++;
        const heading = h('strong', null, source.title);
        group.append(h('li', { class: 'item' }, h('div', { class: 'item__main' },
          h('div', { class: 'row row--wrap' }, heading, Button({ label: '修改标题', size: 'sm', onClick: () => {
            titleEditor = editMeetingTitle(api, source.sourceId, source.title, () => current() && heading.isConnected,
              title => { source.title = title; heading.textContent = title; });
          } })),
          h('span', { class: 'item__meta' }, clock.format(new Date(source.startedAt)) + ' · ' + (statusNames[source.status] ?? '状态未知')),
          source.pages.map(page => h('a', { href: '#memory?' + new URLSearchParams({ entry: page.id, source: source.sourceId }) }, '查看原文 · ' + page.title)))));
      }
      summary.textContent = (result.total ? '已显示 ' + displayed + ' / ' + result.total + ' 份来源。' : '当天没有已登记日期的会议来源。') +
        (result.undated ? '另有 ' + result.undated + ' 份来源未注明会议日期。' : '');
      question = '请按 ' + result.timezone + ' 时区回顾 ' + result.date + (project.value ? ' 当前项目' : ' 全部可见范围') +
        '的会议。按时间梳理决定、行动项和未决问题，附上原文依据，并标明哪些会议资料尚待核实。';
      ask.hidden = !result.total;
      nextOffset = result.nextOffset;
      more.hidden = nextOffset === null;
    } catch (error) {
      if (stamp === request && current()) summary.textContent = '读取失败：' + error.message;
    } finally { if (stamp === request) more.disabled = false; }
  }
  const more = Button({ label: '查看更多来源', size: 'sm', onClick: () => { if (nextOffset !== null) void load(nextOffset); } });
  more.hidden = true;
  const form = h('form', { class: 'row row--wrap', onsubmit: e => { e.preventDefault(); void load(); } },
    Field({ label: '回顾日期', control: date }), Field({ label: '回顾时区', control: zone }), Field({ label: '项目', control: project }),
    h('button', { type: 'submit', class: 'btn btn--primary' }, '查询'));
  form.addEventListener('input', reset);
  const drawer = openDrawer({ title: '会议日回顾', body: [form, summary, ask, timeline, more], onClose: () => { request++; titleEditor?.close(); unsubscribe(); } });
  const unsubscribe = store.subscribe(() => { if (!current()) drawer.close(); });
  void load();
}

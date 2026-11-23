// 定时配置、到期动作与任务验收是三层事实；这里不从审批结果推断 Run 完成。
import { h, replace } from '../lib/dom.js';
import { Button, Card, Field, Input, Select, TextArea, Banner, Empty } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

import { approvalText } from '../lib/format.js';
function timeText(value, timeZone) {
  if (!value) return '未提供';
  if (Number.isNaN(Date.parse(value))) return value;
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Date(value).toLocaleString('zh-CN', { timeZone: zone }) + ' · ' + zone;
}
const chatLink = () => h('a', { href: '#chat' }, '去对话核对与确认');
const approvalLink = (id, close) => h('a', { href: '#chat?approval=' + encodeURIComponent(id), onClick: close }, '查看待处理审批');
const runStatus = status => ({ queued: '排队中', running: '执行中', completed: '执行已完成', failed: '执行失败', cancelled: '已取消', unknown: '执行结果未知' }[status] ?? '执行状态未知');
const line = text => h('p', { class: 'item__meta' }, text);
const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const weekOrder = [1, 2, 3, 4, 5, 6, 0];

function localInstant(value) {
  const date = new Date(value);
  const local = !Number.isNaN(date.getTime()) && `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (!value || local !== value) throw new Error('本地触发时间无效，请检查本机时区和夏令时。');
  return date.toISOString();
}

function timingText(s) {
  if (s.kind === 'once') return `一次 · ${timeText(s.at)}`;
  if (s.kind === 'interval') return `每 ${s.everySec / 60} 分钟${s.anchorAt ? ` · 起点 ${timeText(s.anchorAt)}` : ''}`;
  const fixed = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6](?:,[0-6])*)$/.exec(s.cron);
  if (!fixed) return `cron ${s.cron} · ${s.tz}`;
  const days = fixed[3] === '*' ? weekOrder : fixed[3] === '1-5' ? weekOrder.slice(0, 5) : fixed[3].split(',').map(Number);
  const names = weekOrder.filter(day => days.includes(day)).map(day => weekdayNames[day]);
  return `${names.length === 7 ? '每天' : names.join('、')} ${fixed[2].padStart(2, '0')}:${fixed[1].padStart(2, '0')} · ${s.tz}`;
}
function timingDelay(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '时钟差异，延迟未确认';
  if (ms < 5000) return '准时';
  if (ms < 120000) return `晚 ${Math.round(ms / 1000)} 秒`;
  if (ms < 7200000) return `晚 ${Math.floor(ms / 60000)} 分钟`;
  return `晚 ${Math.floor(ms / 3600000)} 小时`;
}

function configurationText(item) {
  if (item.status === 'active') return '已生效（仅配置生效）';
  if (item.status === 'cancelled') return '已取消计划';
  if (item.status !== 'pending') return '未确认';
  if (item.approvalStatus === 'pending') return '待创建确认';
  if (['rejected', 'failed'].includes(item.approvalStatus)) return '计划未生效';
  return '计划生效情况待核对';
}

function occurrenceText(o, timeZone) {
  if (o.status === 'unknown') return '动作结果未知，停止堆积；请核对原记录';
  if (o.status === 'claimed') return '已认领，动作结果尚未确认';
  if (o.endedAt) return '已到计划结束时间，停止触发';
  if (o.ownerSkipped) return '已按你的设置跳过';
  if (o.status === 'skipped' && o.blockedBy) return `本次已跳过 · ${o.blockedBy.reason}（关联计划时间：${timeText(o.blockedBy.scheduledFor, timeZone)}）`;
  if (o.status === 'skipped') return '本次已跳过，原因未记录';
  if (o.run) return `派发审批 · ${approvalText(o.approvalStatus)} · ${runStatus(o.run.status)}`;
  if (o.kind === 'dispatch' && o.approvalStatus === 'rejected') return '派发审批已拒绝，本次没有关联执行记录';
  if (o.kind === 'dispatch' && o.approvalStatus === 'failed') return '派发审批处理失败，本次没有关联执行记录';
  if (o.kind === 'dispatch') return `已生成派发审批 · ${approvalText(o.approvalStatus)}；任务最终完成情况未确认，请到对话查看执行记录`;
  if (o.kind === 'brief') return '事实简报已生成（仅程序汇总已接入事实，不调用模型、不外发）';
  return '已处理，原动作类型未确认';
}

export function createScheduledWorkCard({ api, store, scope, onUpcoming }) {
  const currentScope = () => scope?.get?.() ?? '';
  const currentToken = () => api.token?.() ?? '';
  const snapshot = () => store.view.snapshot ?? {};
  let identity = JSON.stringify([currentScope(), currentToken()]);
  let offset = 0;
  let generation = 0, items = [], result = null, error = '', loaded = false;
  let inFlight = null, queued = false, timer, editor = null, previousSnapshot;
  const notice = h('div', { role: 'status' });
  const list = h('div', { class: 'stack' });
  const add = Button({ label: '创建定时工作', size: 'sm', onClick: () => openCreate() });
  const repeat = Select({ 'aria-label': '筛选计划频率', options: [['', '全部频率'], ['repeating', '重复计划'], ['once', '一次性安排']] });
  repeat.addEventListener('change', () => turnPage(0));
  const el = Card({ title: '定时工作', id: 'agent-scheduled-work', sub: '按时间生成事实简报，或提交派发审批。', tools: [add, Button({ label: '从模板创建', size: 'sm', onClick: openTemplates })], body: [repeat, notice, list] });

  // 身份或顶栏范围改变即失效，旧读写响应不能回填新范围。
  function syncIdentity() {
    const next = JSON.stringify([currentScope(), currentToken()]);
    if (next === identity) return false;
    identity = next; generation += 1; offset = 0; items = []; result = null; loaded = false; error = '';
    editor?.close(); paint();
    return true;
  }
  function valid(stamp) { syncIdentity(); return stamp === generation; }
  function requestRead() {
    syncIdentity(); clearTimeout(timer);
    timer = setTimeout(() => { load(); }, 60);
  }
  async function load() {
    syncIdentity();
    if (inFlight?.stamp === generation) { queued = true; return; }
    const stamp = generation, projectId = currentScope();
    const flight = { stamp }; inFlight = flight;
    try {
      const query = new URLSearchParams();
      if (projectId) query.set('projectId', projectId);
      if (repeat.value) query.set('repeat', repeat.value);
      if (offset) query.set('offset', String(offset));
      const data = await api.get('/scheduled-work' + (query.size ? '?' + query : ''));
      if (!valid(stamp)) { queued = true; return; }
      if (!Array.isArray(data?.items)) throw new Error('返回数据格式无效');
      if (offset > 0 && !data.items.length && Number.isSafeInteger(data.total) && data.total >= 0 &&
          data.total <= offset && Number.isSafeInteger(data.limit) && data.limit > 0) {
        turnPage(Math.floor(Math.max(0, data.total - 1) / data.limit) * data.limit);
        return;
      }
      items = data.items; result = data; error = ''; loaded = true;
    } catch (cause) {
      if (!valid(stamp)) { queued = true; return; }
      error = cause.status === 404 ? '当前服务缺少定时工作 API 支持，请升级服务。' : `读取失败：${cause.message}`;
    } finally {
      if (inFlight === flight) inFlight = null;
      paint();
      if (queued) { queued = false; requestRead(); }
    }
  }
  function turnPage(next) {
    if (syncIdentity()) { requestRead(); return; }
    offset = next;
    generation++;
    items = []; result = null; loaded = false; error = '';
    paint();
    void load();
  }
  function paint() {
    onUpcoming?.(loaded && !error ? result?.upcoming : undefined, error);
    replace(notice, error ? Banner({ tone: 'warn', children: `${error} 列表状态未确认${loaded ? '，以下保留上次数据' : ''}。` }) : !loaded ? '正在读取定时工作…' : null,
      result && (offset || result.truncated) ? line(items.length ? `显示第 ${offset + 1} 至 ${offset + items.length} 项，共 ${result.total} 项。` : `本页没有记录，共 ${result.total} 项。`) : null,
      offset > 0 && Button({ label: '上一页定时工作', size: 'sm', onClick: () => turnPage(Math.max(0, offset - (result?.limit ?? 100))) }),
      Number.isSafeInteger(result?.nextOffset) && result.nextOffset > offset && Button({ label: '下一页定时工作', size: 'sm', onClick: () => turnPage(result.nextOffset) }),
      error && Button({ label: '重试读取定时工作', size: 'sm', onClick: requestRead }));
    const sections = [];
    for (const [once, heading] of [[false, '重复计划'], [true, '一次性安排']]) {
      const rows = items.filter(item => (item.schedule.kind === 'once') === once);
      if (rows.length) sections.push(h('section', { class: 'stack', 'aria-label': heading }, h('h3', null, heading), rows.map(renderItem)));
    }
    replace(list, sections, !offset && !items.length && loaded && !error
      ? Empty({ title: repeat.value ? '当前范围没有符合频率的计划' : '当前范围没有定时工作' }) : null);
  }
  function renderItem(item) {
    const project = snapshot().projects?.find(p => p.id === item.projectId);
    const todo = item.todoId && snapshot().todos?.find(t => t.id === item.todoId && t.projectId === item.projectId);
    const history = [...(item.occurrences ?? [])].sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor));
    const latest = history[0];
    const details = h('details', { class: 'fold', style: { minWidth: '0', overflowWrap: 'anywhere' } }, h('summary', null, '最近记录与来源'),
      h('div', { class: 'fold__body' },
        line(`来源消息：${item.source?.messageId ?? '未提供'} · ${timeText(item.source?.createdAt)}`),
        line(`创建审批：${item.approvalId} · ${approvalText(item.approvalStatus)}`),
        item.action.kind === 'dispatch' && line(`执行者：${item.action.executorId} · 工作目录：${item.action.cwd ?? '默认'}`),
        history.map(o => renderOccurrence(item, o)),
        item.occurrencesTruncated && line(`最近记录已截断：显示 ${history.length} 条，共 ${item.occurrenceTotal} 条。`),
        item.nextOccurrenceKey && Button({ label: '查看更早记录', size: 'sm', onClick: () => openHistory(item) })));
    return h('article', { class: 'stack', style: { minWidth: '0' }, dataset: { workId: item.id } },
      h('strong', { class: 'item__title' }, item.title),
      h('p', { class: 'item__meta' }, `范围：${item.projectId ? project?.name ?? item.projectId : '全局'}`,
        todo ? h('a', { href: '#projects/' + encodeURIComponent(item.projectId || 'all') + '/todos/detail/' + encodeURIComponent(todo.id) }, ' · 待办 ' + todo.title)
          : item.todoId && ' · 待办 ' + item.todoId),
      line(timingText(item.schedule)),
      item.schedule.until && line('结束时间：' + timeText(item.schedule.until, item.schedule.tz)),
      line(`配置状态：${configurationText(item)} · 创建审批 ${approvalText(item.approvalStatus)}`),
      line(item.scheduleStatus === 'done' && item.schedule.kind === 'once' ? '单次计划已触发' : `调度状态：${({ active: '等待触发', paused: '已暂停', done: '已结束', cancelled: '已取消' })[item.scheduleStatus] ?? '未确认'}`),
      item.skipToken && line('将跳过：' + timeText(item.nextAt, item.schedule.tz)),
      item.skipToken && item.nextActionAt === null && line('跳过本次后，计划截止前没有下一期。'),
      item.skipToken && item.nextActionAt && line('跳过后预计触发：' + timeText(item.nextActionAt, item.schedule.tz)),
      item.scheduleStatus === 'paused' && line('恢复前不会触发'),
      item.status === 'active' && item.scheduleStatus === 'active' && !item.skipToken && item.nextAt && line('下次触发：' + timeText(item.nextAt, item.schedule.tz)),
      line(`最新实际结果：${latest ? occurrenceText(latest, item.schedule.tz) : '尚无到期动作记录'}`),
      item.action.kind === 'brief' && line('事实简报仅程序汇总已接入事实，不自动调用模型或外发。'),
      line('上次动作结果未知或派发审批待批准时，暂停生成新动作。取消计划不会终止已派发的任务。'),
      h('div', { class: 'row row--wrap' }, item.approvalStatus === 'pending' && item.approvalId ? approvalLink(item.approvalId) : chatLink(),
        item.action.kind === 'dispatch' && Button({ label: '查看执行要求', size: 'sm', onClick: () => {
          if (syncIdentity()) { requestRead(); return; }
          const action = item.action;
          managedDrawer({ title: '执行要求', subtitle: item.title, body: h('div', { class: 'stack' },
            line(`执行者：${action.executorId} · 工作目录：${action.cwd ?? '默认'}`),
            line('预计时长：' + (Number.isFinite(action.expectMinutes) ? action.expectMinutes + ' 分钟' : '未记录')),
            h('strong', null, '执行提示词'), h('pre', { class: 'mailbox-content' }, action.prompt ?? '未记录'),
            h('strong', null, '完成标准'), h('pre', { class: 'mailbox-content' }, action.doneWhen ?? '未记录')) });
        } }),
        item.status === 'active' && item.scheduleStatus === 'active' && item.schedule.kind !== 'once' && Date.parse(item.nextAt) > Date.now() && Button({
          label: item.skipToken ? '撤销跳过' : '跳过下一次', size: 'sm', onClick: async () => {
            if (syncIdentity()) { requestRead(); return; }
            try {
              await api.post(`/scheduled-work/${encodeURIComponent(item.id)}/skip-next`, {
                version: item.version, scheduleVersion: item.scheduleVersion, at: item.nextAt, undoToken: item.skipToken,
              });
            } finally { requestRead(); }
          } }), item.status === 'active' && ['active', 'paused'].includes(item.scheduleStatus) && Number.isSafeInteger(item.scheduleVersion) && Button({
        label: item.scheduleStatus === 'paused' ? '恢复计划' : '暂停计划', size: 'sm', onClick: async () => {
          if (syncIdentity()) { requestRead(); return; }
          try {
            const operation = item.scheduleStatus === 'paused' ? 'resume' : 'pause';
            await api.post(`/scheduled-work/${encodeURIComponent(item.id)}/${operation}`, { version: item.version, scheduleVersion: item.scheduleVersion });
          } finally { requestRead(); }
        } }), item.status !== 'cancelled' && Button({ label: '取消计划', size: 'sm', onClick: () => openCancel(item) })), details);
  }

  function managedDrawer(options) {
    editor?.close();
    const stamp = generation;
    let closed = false;
    const drawer = openDrawer({ ...options, onClose: () => { closed = true; clearInterval(guard); if (editor === drawer) editor = null; } });
    // 仅抽屉存在时检查本地身份，不发网络请求；覆盖没有 store 通知的令牌替换。
    const guard = setInterval(() => { if (!valid(stamp)) { drawer.close(); requestRead(); } }, 250);
    drawer.active = () => !closed && drawer.el.open && valid(stamp);
    editor = drawer;
    return drawer;
  }
  function renderOccurrence(item, o) {
    return h('div', null, line(`${timeText(o.scheduledFor, item.schedule.tz)} · ${occurrenceText(o, item.schedule.tz)}`),
      o.workVersion && o.workVersion !== item.version && line(`计划版本 ${o.workVersion} · ${({ dispatch: '派发任务', brief: '生成简报' })[o.kind] ?? '原动作类型未确认'}`),
      o.handledAt && line(`开始处理：${timeText(o.handledAt, item.schedule.tz)} · ${timingDelay(o.delayMs)}`),
      !o.handledAt && !o.ownerSkipped && !o.endedAt && line('开始处理时间未记录'),
      o.approvalId && line(`派发审批：${o.approvalId} · ${approvalText(o.approvalStatus)}`),
      o.result?.messageId && line(`结果消息：${o.result.messageId}`),
      o.status === 'completed' && o.result?.messageId && Button({ label: '查看简报原文', size: 'sm', onClick: () => openBrief(item, o) }), o.error && line(o.error),
      o.approvalStatus === 'pending' && approvalLink(o.approvalId, () => editor?.close()),
      o.run && h('a', { href: `#projects/${encodeURIComponent(item.projectId || 'all')}/runs/${encodeURIComponent(o.run.id)}`, onClick: () => editor?.close() }, '查看实际执行记录'));
  }
  function openHistory(item) {
    if (syncIdentity()) { requestRead(); return; }
    const rows = h('div', { class: 'stack' }), controls = h('div', { role: 'status' });
    const drawer = managedDrawer({ title: '更早的触发记录', subtitle: item.title, body: h('div', { class: 'stack' }, rows, controls) });
    async function read(after) {
      replace(controls, line('正在读取触发记录…'));
      try {
        const page = await api.post('/scheduled-work/history', { workId: item.id, after, projectId: currentScope() || undefined });
        if (!drawer.active()) return;
        rows.append(...page.occurrences.map(o => renderOccurrence(item, o)));
        replace(controls, page.nextOccurrenceKey
          ? Button({ label: '继续查看更早记录', size: 'sm', onClick: () => read(page.nextOccurrenceKey) })
          : line('已到最早记录'));
      } catch (cause) {
        if (drawer.active()) replace(controls, Banner({ tone: 'warn', children: cause.message }),
          Button({ label: '重试读取记录', size: 'sm', onClick: () => read(after) }));
      }
    }
    void read(item.nextOccurrenceKey);
  }
  function openBrief(item, occurrence) {
    if (syncIdentity()) { requestRead(); return; }
    const content = h('div', { class: 'stack' });
    const drawer = managedDrawer({ title: '简报原文', subtitle: item.title, body: content });
    async function read() {
      replace(content, line('正在读取简报…'));
      try {
        const result = await api.post('/scheduled-work/brief', { workId: item.id, occurrenceKey: occurrence.key, projectId: currentScope() || undefined });
        if (drawer.active()) replace(content, line('计划时间：' + timeText(result.scheduledFor, item.schedule.tz)),
          line('生成时间：' + timeText(result.createdAt, item.schedule.tz)), h('pre', { class: 'mailbox-content' }, result.text));
      } catch (cause) {
        if (drawer.active()) replace(content, Banner({ tone: 'warn', children: cause.message }),
          Button({ label: '重新读取简报', size: 'sm', onClick: read }));
      }
    }
    void read();
  }
  function openCancel(item) {
    if (syncIdentity()) { requestRead(); return; }
    const message = h('div', { role: 'status' });
    let busy = false;
    const drawer = managedDrawer({ title: '取消定时工作', body: [
      h('p', { class: 'item__title' }, item.title), line(`确认取消当前版本 ${item.version}。只取消计划，不终止已派发的任务，也不自动批准任何事项。`), message],
      footer: Button({ label: `确认取消版本 ${item.version}`, kind: 'danger', onClick: async () => {
        if (busy || !drawer.active()) return;
        busy = true;
        try {
          await api.post(`/scheduled-work/${encodeURIComponent(item.id)}/cancel`, { version: item.version });
          if (!drawer.active()) return;
          replace(message, Banner({ children: '已取消计划；已派发的任务不受影响。' }));
          requestRead();
          // 成功后保留结果，按钮不可重复提交。
        } catch (cause) {
          if (!drawer.active()) return;
          replace(message, Banner({ tone: 'warn', children: cause.status === 409 ? '版本已变化，请核对最新列表后重新确认取消。未自动重试。' : `取消结果未确认：${cause.message}。请核对后再操作，未自动重试。` }));
          requestRead();
          // 失败后也锁住该版本，避免对不确定结果重复写。
        }
      } }) });
  }
  function openTemplates() {
    if (syncIdentity()) requestRead();
    const content = h('div', { class: 'stack' });
    const drawer = managedDrawer({ title: '定时工作模板', body: content });
    async function loadTemplates() {
      replace(content, line('正在读取模板…'));
      try {
        const { items } = await api.get('/scheduled-work/templates');
        if (!drawer.active()) return;
        const timezone = snapshot().workspaceTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
        replace(content, items.map(template => {
          const timing = template.everyMinutes ? '每 ' + template.everyMinutes + ' 分钟'
            : template.days.map(day => weekdayNames[day]).join('、') + ' ' + template.time + ' · ' + timezone;
          return h('section', { class: 'stack' }, Button({
            label: template.title, onClick: () => { if (drawer.active()) openCreate(template); },
          }), line(timing), line(template.doneWhen));
        }));
      } catch (cause) {
        if (drawer.active()) replace(content, line('读取模板失败：' + cause.message),
          Button({ label: '重新读取模板', onClick: loadTemplates }));
      }
    }
    void loadTemplates();
  }
  function openCreate(template) {
    if (syncIdentity()) requestRead();
    const key = crypto.randomUUID();
    const title = Input({ name: 'title', required: true });
    const projects = () => (snapshot().projects ?? []).filter(p => !p.archivedAt);
    const project = Select({ name: 'projectId', options: [['', '全局（不绑定项目）'], ...projects().map(p => [p.id, p.name])], value: currentScope() });
    const todo = Select({ name: 'todoId', options: [['', '不关联待办']] });
    const frequency = Select({ name: 'frequency', options: [['once', '一次'], ['daily', '每天'], ['weekly', '每周'], ['interval', '间隔'], ['cron', '高级 cron']] });
    const once = Input({ type: 'datetime-local', name: 'at' });
    const until = Input({ type: 'datetime-local', name: 'until' });
    const untilField = Field({ label: '结束时间（可选）', control: until, hint: '使用浏览器时区 ' + Intl.DateTimeFormat().resolvedOptions().timeZone + '。该时刻起停止触发。' });
    const daily = Input({ type: 'time', value: '09:00', name: 'dailyTime' });
    const minutes = Input({ type: 'number', min: 1 / 6, step: 'any', value: 60, name: 'minutes' });
    const cron = Input({ name: 'cron', placeholder: '0 9 * * *' });
    const zone = Input({ name: 'tz', value: snapshot().workspaceTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' });
    const action = Select({ name: 'action', options: [['brief', '事实简报'], ['dispatch', '派给执行者']] });
    const executors = snapshot().executors ?? [];
    const executor = Select({ name: 'executorId', options: [['', '请选择实际执行者'], ...executors.map(e => [e.id, `${e.name} · ${e.id} · ${e.available ? '可用' : e.reason ?? '离线或不可用'}`])] });
    const availability = h('p', { class: 'item__meta' });
    const prompt = TextArea({ name: 'prompt' });
    const doneWhen = TextArea({ name: 'doneWhen' });
    const estimate = Input({ type: 'number', min: 1, step: 1, value: 30, name: 'expectMinutes' });
    const cwd = Input({ name: 'cwd', placeholder: '可选，执行机上的工作目录' });
    const message = h('div', { role: 'status' });
    const preview = h('div', { class: 'item__meta', 'aria-label': '创建预览', style: { whiteSpace: 'pre-wrap' } });
    const onceField = Field({ label: '本地触发时间', control: once, hint: '使用浏览器当地时区；无效的夏令时时间会拒绝提交。' });
    const dailyField = Field({ label: '每天时间', control: daily });
    const weeklyTime = Input({ type: 'time', value: '09:00', name: 'weeklyTime' });
    const dayInputs = weekOrder.map(day => h('input', { type: 'checkbox', value: day, checked: day >= 1 && day <= 5 }));
    function pickDays(days) {
      for (const box of dayInputs) box.checked = days.includes(Number(box.value));
      sync();
    }
    const weeklyFields = h('div', { class: 'stack' }, Field({ label: '每周触发时间', control: weeklyTime }),
      h('fieldset', null, h('legend', null, '重复日期'), h('div', { class: 'row row--wrap' },
        dayInputs.map(box => h('label', null, box, weekdayNames[Number(box.value)]))),
      h('div', { class: 'row row--wrap' },
        Button({ label: '周一至周五', size: 'sm', onClick: () => pickDays([1, 2, 3, 4, 5]) }),
        Button({ label: '周末', size: 'sm', onClick: () => pickDays([6, 0]) }))));
    const intervalField = Field({ label: '间隔分钟', control: minutes, hint: '最少 10 秒（1/6 分钟）。' });
    const cronField = Field({ label: 'cron 表达式', control: cron, hint: '表达式交由服务端校验。' });
    const zoneField = Field({ label: 'IANA 时区', control: zone });
    const dispatchFields = h('div', { class: 'stack' }, Field({ label: '执行者', control: executor }), availability,
      Field({ label: '目标', control: prompt }), Field({ label: '完成标准', control: doneWhen }),
      Field({ label: '预计分钟', control: estimate }), Field({ label: '工作目录', control: cwd }));
    function updateTodos() {
      replace(todo, h('option', { value: '' }, '不关联待办'), (snapshot().todos ?? []).filter(t => (t.projectId ?? '') === project.value).map(t => h('option', { value: t.id }, t.title)));
    }
    project.addEventListener('change', updateTodos); updateTodos();
    function body() {
      if (!title.value.trim()) throw new Error('请填写标题。');
      if (project.value && !projects().some(p => p.id === project.value)) throw new Error('项目已不可用，请关闭后核对项目。');
      if (todo.value && !(snapshot().todos ?? []).some(t => t.id === todo.value && (t.projectId ?? '') === project.value)) throw new Error('关联待办已不属于所选项目，请重新选择。');
      const schedule = scheduleInput();
      let workAction = { kind: 'brief' };
      if (action.value === 'dispatch') {
        const selected = (snapshot().executors ?? []).find(e => e.id === executor.value);
        if (!selected?.available) throw new Error(`执行者不可用：${selected?.reason ?? '请选择在线、可用的实际执行者'}。`);
        if (!prompt.value.trim() || !doneWhen.value.trim()) throw new Error('请填写目标和完成标准。');
        const expectMinutes = Number(estimate.value);
        if (!Number.isInteger(expectMinutes) || expectMinutes < 1) throw new Error('预计分钟必须为正整数。');
        workAction = { kind: 'dispatch', executorId: selected.id, prompt: prompt.value.trim(), doneWhen: doneWhen.value.trim(), expectMinutes, ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}) };
      }
      return { key, title: title.value.trim(), schedule, action: workAction, ...(project.value ? { projectId: project.value } : {}), ...(todo.value ? { todoId: todo.value } : {}) };
    }
    function scheduleInput() {
      let schedule;
      if (frequency.value === 'once') {
        schedule = { kind: 'once', at: localInstant(once.value) };
      } else if (frequency.value === 'interval') {
        const everySec = Number(minutes.value) * 60;
        if (!Number.isFinite(everySec) || everySec < 10) throw new Error('间隔至少为 10 秒。');
        schedule = { kind: 'interval', everySec };
      } else {
        if (!zone.value.trim()) throw new Error('请填写 IANA 时区。');
        try { new Intl.DateTimeFormat('en', { timeZone: zone.value.trim() }); } catch { throw new Error('IANA 时区无效。'); }
        let expression = cron.value.trim();
        if (frequency.value !== 'cron') {
          const time = frequency.value === 'weekly' ? weeklyTime.value : daily.value;
          if (!/^\d{2}:\d{2}$/.test(time)) throw new Error('请填写触发时间。');
          const days = dayInputs.filter(box => box.checked).map(box => box.value);
          if (frequency.value === 'weekly' && !days.length) throw new Error('请至少选择一个重复日期。');
          const [hour, minute] = time.split(':').map(Number);
          expression = `${minute} ${hour} * * ${frequency.value === 'daily' || days.length === 7 ? '*' : days.join(',')}`;
        }
        if (!expression) throw new Error('请填写 cron 表达式。');
        schedule = { kind: 'cron', cron: expression, tz: zone.value.trim() };
      }
      if (schedule.kind !== 'once' && until.value) {
        schedule.until = localInstant(until.value);
        if (Date.parse(schedule.until) <= Date.now()) throw new Error('结束时间必须晚于当前时间。');
      }
      return schedule;
    }
    const nextTimes = h('div', { role: 'status', 'aria-label': '排期试算' });
    let previewKey, previewTimer, previewRevision = 0;
    function refreshTimes() {
      let schedule, problem;
      if (['daily', 'weekly', 'cron'].includes(frequency.value)) {
        try { schedule = scheduleInput(); } catch (cause) { problem = cause.message; }
      }
      const key = JSON.stringify(schedule ?? problem);
      if (previewKey === key) return;
      previewKey = key;
      const revision = ++previewRevision;
      clearTimeout(previewTimer);
      replace(nextTimes, problem && line(problem));
      if (!schedule) return;
      const { cron, tz } = schedule;
      const query = new URLSearchParams({ cron, tz });
      if (schedule.until) query.set('until', schedule.until);
      nextTimes.textContent = '正在试算排期…';
      previewTimer = setTimeout(async () => {
        if (!drawer.active()) return;
        try {
          const result = await api.get('/scheduled-work/cron-preview?' + query);
          if (revision !== previewRevision || !drawer.active()) return;
          const format = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
          replace(nextTimes, line((result.nextRuns.length ? `接下来${result.nextRuns.length}次` : '结束前没有触发') + ' · ' + tz), h('ul', null, result.nextRuns.map(at =>
            h('li', null, h('time', { datetime: at }, format.format(new Date(at)))))));
        } catch (cause) {
          if (revision === previewRevision && drawer.active()) replace(nextTimes, line('排期试算失败：' + cause.message),
            Button({ label: '重新试算', size: 'sm', onClick: () => { previewKey = undefined; refreshTimes(); } }));
        }
      }, 300);
    }
    function sync() {
      refreshTimes();
      untilField.hidden = frequency.value === 'once';
      onceField.hidden = frequency.value !== 'once'; dailyField.hidden = frequency.value !== 'daily'; weeklyFields.hidden = frequency.value !== 'weekly';
      intervalField.hidden = frequency.value !== 'interval'; cronField.hidden = frequency.value !== 'cron';
      zoneField.hidden = !['daily', 'weekly', 'cron'].includes(frequency.value); dispatchFields.hidden = action.value !== 'dispatch';
      const selected = (snapshot().executors ?? []).find(e => e.id === executor.value);
      availability.textContent = selected ? `${selected.name}：${selected.available ? '当前可用；到期仍需派发审批' : selected.reason ?? '离线或不可用'}` : '没有选择执行者；不会创建虚拟执行者。';
      try { preview.textContent = `提交预览（不会执行）：\n${JSON.stringify(body(), null, 2)}`; }
      catch (cause) { preview.textContent = `提交预览：${cause.message}`; }
    }
    let busy = false, submitted = false;
    const form = h('div', { class: 'stack' },
      Field({ label: '标题', control: title, required: true }), Field({ label: '项目', control: project, hint: '默认继承顶栏。切换顶栏范围会关闭此抽屉，避免误提交。' }),
      Field({ label: '关联待办', control: todo }), Field({ label: '频率', control: frequency }), onceField, dailyField, weeklyFields, intervalField, cronField, zoneField, untilField, nextTimes,
      Field({ label: '动作', control: action }), line('事实简报只程序汇总已接入事实，不自动调用模型或外发。派发每次到期仍会生成审批，审批生成不代表任务完成。'), dispatchFields, preview, message);
    form.addEventListener('input', sync); form.addEventListener('change', sync);
    const save = Button({ label: '提交创建审批', kind: 'primary', onClick: async () => {
      if (busy || submitted || !drawer.active()) return;
      let payload;
      try { payload = body(); } catch (cause) { replace(message, Banner({ tone: 'warn', children: cause.message })); return; }
      busy = true; save.disabled = true;
      try {
        const approval = await api.post('/scheduled-work', payload);
        if (!drawer.active()) return;
        submitted = true;
        replace(message, Banner({ children: h('div', null, `已提交创建审批 · ${approvalText(approval.status)} · ${approval.id}。`,
          approval.status === 'pending' && approval.id ? approvalLink(approval.id, () => drawer.close()) : chatLink()) }));
        for (const input of form.querySelectorAll('input, select, textarea, fieldset button')) input.disabled = true;
        requestRead();
      } catch (cause) {
        if (!drawer.active()) return;
        replace(message, Banner({ tone: 'warn', children: `${cause.status === 404 ? '当前服务缺少定时工作 API 支持。' : cause.status === 409 ? '创建冲突（409）。' : `提交失败或结果未知：${cause.message}。`} 草稿和请求标识已保留，请先到对话核对；不会自动重试。` }), h('a', { href: '#chat', target: '_blank', rel: 'noopener' }, '在新标签页核对对话'));
      } finally { busy = false; if (drawer.active()) save.disabled = submitted; }
    } });
    const drawer = managedDrawer({ title: '创建定时工作', subtitle: '提交只创建审批，需要你在现有对话中确认。', body: form, footer: save });
    if (template) {
      title.value = template.title;
      action.value = 'dispatch';
      prompt.value = template.prompt;
      doneWhen.value = template.doneWhen;
      if (template.everyMinutes) {
        frequency.value = 'interval';
        minutes.value = String(template.everyMinutes);
      } else {
        frequency.value = 'weekly';
        weeklyTime.value = template.time;
        for (const box of dayInputs) box.checked = template.days.includes(Number(box.value));
      }
    }
    sync();
  }
  scope?.subscribe?.(() => { syncIdentity(); requestRead(); });
  return { el, load: requestRead, onState() {
    const changed = syncIdentity();
    if (changed || previousSnapshot !== store.view.snapshot) { previousSnapshot = store.view.snapshot; requestRead(); }
  } };
}

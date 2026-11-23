// 设置只挂载一次；实时快照仅驱动只读状态与队列，避免覆盖尚未保存的草稿。
import { h, replace } from '../lib/dom.js';
import { timeAgo } from '../lib/format.js';
import { Button, Banner, Check, Field, Select, Pill } from '../ui/kit.js';
import { openDrawer, confirmDialog } from '../ui/overlay.js';
import { editMeetingTitle } from './meeting-day.js';
import { createKnowledgeReaderCard } from './knowledge-reader.js';

const WORKER = { disabled: '已暂停', idle: '空闲', running: '整理中', failed: '出错', unavailable: '不可用' };
const DONE = new Set(['done', 'completed', 'succeeded', 'applied']);
const ACTIVE = new Set(['queued', 'running', 'awaiting_approval']);
const STATUS = { queued: '等待整理', running: '整理中', awaiting_approval: '待主人确认', completed: '已整理', failed: '失败', unknown: '结果未确认' };
export const pendingJobs = (curator) => (curator?.jobs ?? []).filter(job => !DONE.has(job.status));
// 只在当前页面内保留 attempt，不将 token 或请求材料写入持久存储。
// 抽屉关闭不会取消已发出的写入；重新打开必须先读取队列，不能自动重放。
const retries = new WeakMap();
const wrap = { overflowWrap: 'anywhere', minWidth: '0' };
const failure = error => `${error.status ? `HTTP ${error.status}` : '网络或响应异常'}，请求结果未确认`;

export function openCuratorDrawer({ api, store, onChanged, jobId, projectId }) {
  const token = api.token?.();
  if (!retries.has(api)) retries.set(api, new Map());
  const identities = retries.get(api);
  if (!identities.has(token)) identities.set(token, new Map());
  const attempts = identities.get(token);
  const checked = new Set();
  let focusedJob = false;
  let closed = false;
  let invalidated = false;
  let reader, titleEditor;
  let readerListener;
  let unsubscribe;
  let timer;
  let generation = 0;
  let curator;
  let settingsMounted = false;
  let verified = false;
  let saving = false;
  let lastSnapshot = JSON.stringify(store.view.snapshot);
  let lastHealth = '';
  const status = h('div', { style: wrap, role: 'status' }, '正在读取…');
  const settings = h('div', { class: 'stack' });
  const jobsTitle = h('h3', null, '整理队列');
  const jobState = Select({ options: [['', '全部状态'], ...Object.entries(STATUS)], 'aria-label': '筛选整理状态', onchange: paintJobs });
  const jobScope = Select({ options: [['', '全部范围'], ['personal', '个人']], 'aria-label': '筛选整理范围', onchange: paintJobs });
  const filters = h('div', { class: 'row row--wrap', hidden: true }, jobScope, jobState);
  const jobRows = h('div', { class: 'stack' });
  const jobsRegion = h('section', { class: 'stack', 'aria-label': '整理队列', style: wrap }, jobsTitle, filters, jobRows);
  const body = h('div', { class: 'stack stack--lg' }, status, settings, jobsRegion);
  function dispose() {
    clearTimeout(timer); ++generation; unsubscribe?.(); reader?.destroy(); titleEditor?.close();
  }
  const isCurrent = () => {
    if (api.token?.() !== token && !invalidated) { invalidated = true; dispose(); }
    return !closed && !invalidated && drawer.el.open;
  };
  const drawer = openDrawer({ title: '记忆整理 Agent', subtitle: '独立常驻的 Agent，把链接整理成记忆。暂停后来源仍保留在队列里。', body, onClose: () => { closed = true; dispose(); } });
  // 共用抽屉的一次订阅，reader 仍自行维护草稿、独立保存和旧 API 降级。
  const readerStore = { ...store, subscribe(fn) { readerListener = fn; return () => { readerListener = undefined; }; } };
  reader = createKnowledgeReaderCard({ api, store: readerStore, isCurrent });
  drawer.body.append(reader.el);
  reader.el.addEventListener('reader-channel', () => drawer.close());

  function uncertain(reason) {
    verified = false; checked.clear();
    replace(status, Banner({ tone: 'danger', children: `整理状态未确认：${reason}。保留上次读取的数据和设置草稿。` }));
    paintJobs();
  }
  function mountSettings(value) {
    if (settingsMounted || !value?.settings) return;
    settingsMounted = true;
    const machines = (store.view.snapshot?.machines ?? []).filter(item => item.online && item.capabilities?.includes('executor.knowledge.start'));
    const enabled = Check({ label: '启用整理 Agent', checked: value.settings.enabled });
    const machine = Select({ options: [['', '尚未选择电脑'], ...machines.map(item => [item.id, item.name])], value: value.settings.machineId ?? '' });
    if (value.settings.machineId && machine.value !== value.settings.machineId) { machine.append(h('option', { value: value.settings.machineId }, '原电脑离线或不可用')); machine.value = value.settings.machineId; }
    const provider = Select({ options: [['codex', 'Codex'], ['claude-code', 'Claude Code'], ['pi', 'Pi CLI']], value: value.settings.provider });
    const message = h('div', { role: 'status', style: wrap });
    const save = Button({ label: '保存整理设置', kind: 'primary', onClick: async () => {
      if (!isCurrent() || saving) return;
      saving = true; save.disabled = true;
      try {
        await api.put('/knowledge/curator', { enabled: enabled.querySelector('input').checked, machineId: machine.value, provider: provider.value });
        if (!isCurrent()) return;
        replace(message, Banner({ children: '整理设置已保存。' }));
        await load();
        if (isCurrent()) await onChanged?.();
      } catch (error) {
        if (isCurrent()) replace(message, Banner({ tone: 'danger', children: `保存未确认：${failure(error)}。请核对后再保存。` }));
      } finally { saving = false; if (isCurrent()) save.disabled = false; }
    } });
    replace(settings, enabled, Field({ label: '在哪台电脑上整理', control: machine }), Field({ label: '用哪个执行者', control: provider }), h('div', null, save), message);
  }

  function successor(job) {
    const attempt = attempts.get(job.id);
    return curator.jobs.find(item => item.id !== job.id && (item.id === attempt?.newId || item.retryOf === job.id) && (ACTIVE.has(item.status) || DONE.has(item.status)))
      ?? curator.jobs.find(item => item.id === attempt?.newId);
  }
  function paintJobs() {
    if (!curator) return;
    const snapshot = store.view.snapshot;
    const pages = new Map((snapshot?.knowledge ?? []).map(page => [page.id, page]));
    const projects = new Set((snapshot?.projects ?? []).filter(project => !project.archivedAt).map(project => project.id));
    const options = (snapshot?.projects ?? []).map(project => ['project:' + project.id, project.name + (project.archivedAt ? '（已归档）' : '')]);
    const signature = JSON.stringify(options);
    if (jobScope.dataset.projects !== signature) {
      const selected = jobScope.dataset.projects === undefined && projectId && !jobId ? 'project:' + projectId : jobScope.value;
      replace(jobScope, [['', '全部范围'], ['personal', '个人'], ...options].map(([value, name]) => h('option', { value }, name)));
      if (selected && ![...jobScope.options].some(option => option.value === selected)) jobScope.append(h('option', { value: selected }, '所选项目'));
      jobScope.value = selected;
      jobScope.dataset.projects = signature;
    }
    filters.hidden = !curator.jobs.length;
    const jobs = curator.jobs.filter(job =>
      (!jobScope.value || jobScope.value === (job.layer === 'project' ? 'project:' + job.projectId : 'personal')) &&
      (!jobState.value || jobState.value === (DONE.has(job.status) ? 'completed' : job.status)));
    jobsTitle.textContent = '整理队列 ' + jobs.length;
    replace(jobRows, !verified && h('p', { class: 'muted small' }, '以下为上次读取的数据，当前进度未确认。'),
      jobs.length ? h('div', { class: 'list' }, jobs.map(job => {
        const attempt = attempts.get(job.id);
        const next = successor(job);
        const meeting = job.requestOrigin === 'meeting';
        const canRetry = job.status === 'failed' || job.status === 'unknown';
        return h('div', { class: job.id === jobId ? 'item is-search-hit' : 'item', tabindex: job.id === jobId ? -1 : undefined, dataset: { jobId: job.id }, style: wrap },
          h('div', { class: 'item__main', style: wrap },
            h('span', { class: 'item__title' }, (meeting && job.title) || job.url || job.title || job.text || job.id),
            meeting && h('span', { class: 'item__meta' }, '会议资料 · 个人记忆'),
            job.materialKind === 'meeting-transcript' && h('span', { class: 'item__meta' }, '会议转写 · ' + (job.layer === 'project' ? '项目记忆' : '个人记忆')),
            job.meetingStartedAt && h('span', { class: 'item__meta' }, '会议开始时间 · ' + job.meetingStartedAt),
            meeting && job.url?.startsWith('https://') && h('a', { class: 'small', href: job.url, target: '_blank', rel: 'noopener noreferrer' }, '查看原文档'),
            h('span', { class: 'item__meta' }, `${timeAgo(job.updatedAt ?? job.createdAt)}${job.error ? ` · ${job.error}` : ''}`),
            Array.from(new Set(job.knowledgeIds ?? []), id => {
              const page = pages.get(id);
              if (!page || page.layer !== job.layer || page.projectId !== job.projectId ||
                  (page.projectId && !projects.has(page.projectId))) return null;
              return h('a', { class: 'small', href: '#memory?entry=' + encodeURIComponent(id) + '&source=' + encodeURIComponent(job.id),
                onclick: () => drawer.close() }, '查看整理结果 · ' + page.title);
            }),
            next && h('p', { class: 'small' }, `新整理任务：${next.id}（${STATUS[next.status] ?? (DONE.has(next.status) ? '已整理' : '结果未确认')}）`),
            !next && attempt?.accepted && h('p', { class: 'small' }, `已提交新整理任务${attempt.newId ? `：${attempt.newId}` : '，旧服务未返回任务引用'}；进度以队列为准。`),
            attempt && h('p', { class: 'small' }, `${attempt.reason ?? '重试请求'} · 请求 key：${attempt.key}`)),
          Pill(STATUS[job.status] ?? (DONE.has(job.status) ? '已整理' : '结果未确认'), DONE.has(job.status) ? 'ok' : job.status === 'failed' ? 'danger' : ''),
          job.status === 'awaiting_approval' && h('a', { href: '#chat', class: 'small', onclick: () => drawer.close() }, '去确认来源读取'),
          (meeting || job.materialKind === 'meeting-transcript') && Button({ label: '修改标题', size: 'sm', disabled: !verified, onClick: () => {
            titleEditor = editMeetingTitle(api, job.id, job.title, () => isCurrent() && verified, load);
          } }),
          canRetry && !next && !attempt?.accepted && Button({
            label: job.status === 'unknown' ? '核对后重新整理' : '重试', size: 'sm',
            disabled: !verified || !!attempt?.busy || (!!attempt && !checked.has(job.id)), onClick: () => retry(job),
          }),
          canRetry && !next && !attempt?.accepted && (!verified || (attempt && !checked.has(job.id))) && Button({ label: '核对现有队列', size: 'sm', onClick: load }));
      })) : h('p', { class: 'muted small' }, curator.jobs.length ? '没有符合筛选条件的整理记录。' : '队列是空的。'));
  }

  async function retry(job) {
    if (!isCurrent() || !verified || successor(job)) return;
    let attempt = attempts.get(job.id);
    if (attempt?.busy || attempt?.accepted || (attempt && !checked.has(job.id))) return;
    if (!attempt) { attempt = { key: crypto.randomUUID() }; attempts.set(job.id, attempt); }
    // 锁跨 DOM 重绘和抽屉生命周期，确认框期间同样不能重复提交。
    attempt.busy = true; paintJobs();
    if (job.status === 'unknown') {
      const agreed = await confirmDialog({ title: '核对后重新整理', message: '原任务可能已经执行。继续会新建来源整理任务，不会自动覆盖人工编辑的内容。请先核对已有结果，再确认重新整理。', confirmLabel: '确认重新整理' });
      if (!agreed || !isCurrent()) { attempt.busy = false; if (isCurrent()) { checked.add(job.id); paintJobs(); } return; }
    }
    // 确认期间任务可能已由其他入口重试或推进。
    const latest = curator.jobs.find(item => item.id === job.id);
    if (!isCurrent() || !verified || successor(job) || !['failed', 'unknown'].includes(latest?.status)) { attempt.busy = false; if (isCurrent()) paintJobs(); return; }
    checked.delete(job.id);
    attempt.reason = '请求结果未确认，请先核对现有队列';
    try {
      const result = await api.post(`/knowledge/sources/${encodeURIComponent(job.id)}/retry`, { key: attempt.key });
      attempt.accepted = true; attempt.newId = result?.id;
      attempt.reason = '服务已接受新整理任务，尚不代表整理完成';
      if (!isCurrent()) return;
      await load();
      if (isCurrent()) await onChanged?.();
    } catch (error) {
      attempt.reason = `重试未确认：${failure(error)}；不会自动重试`;
    } finally { attempt.busy = false; if (isCurrent()) paintJobs(); }
  }

  async function load() {
    if (!isCurrent()) return;
    clearTimeout(timer);
    const stamp = ++generation;
    try {
      const result = await api.get('/knowledge/curator');
      if (!isCurrent() || stamp !== generation) return;
      if (!result || !Array.isArray(result.jobs)) throw new Error('invalid response');
      // 旧服务缺少 worker 时仍可使用整理设置和已读队列，但不能声称状态已确认。
      curator = { ...curator, ...result };
      mountSettings(curator);
      verified = !!result.worker && typeof result.worker.state === 'string';
      if (store.view.loadError || store.view.unauthorized || store.view.connection === 'offline') { uncertain('事件或状态读取失败'); return; }
      for (const [id, attempt] of attempts) if (!attempt.busy) checked.add(id);
      replace(status, Banner({ children: verified
        ? `${WORKER[curator.worker.state] ?? '状态未确认'}${curator.worker.reason ? `：${curator.worker.reason}` : ''}`
        : '整理状态未确认：旧 API 缺少 worker 状态，请升级服务端。' }));
      paintJobs();
      if (jobId && !focusedJob) {
        const row = jobsRegion.querySelector('[data-job-id="' + CSS.escape(jobId) + '"]');
        if (row) { row.focus(); row.scrollIntoView({ block: 'center' }); }
        else status.append(h('p', { role: 'status' }, '搜索命中的会议来源已不可用。'));
        focusedJob = true;
      }
    } catch (error) {
      if (isCurrent() && stamp === generation) uncertain(error.status === 404 ? '旧 API 不支持状态读取，请升级服务端' : failure(error));
    }
  }
  unsubscribe = store.subscribe?.((view = store.view) => {
    if (!isCurrent()) return;
    readerListener?.(view);
    const health = view.loadError || view.unauthorized || view.connection === 'offline' ? 'unknown' : 'online';
    if (health === 'unknown') {
      clearTimeout(timer); ++generation; lastHealth = health;
      uncertain('事件或状态读取失败'); return;
    }
    const snapshot = JSON.stringify(view.snapshot);
    if (snapshot === lastSnapshot && health === lastHealth) return;
    lastSnapshot = snapshot; lastHealth = health;
    // 新快照使之前的 GET 过期。连续事件只发一次请求，没有常驻轮询。
    ++generation; clearTimeout(timer); timer = setTimeout(load, 120);
  });
  lastHealth = store.view.loadError || store.view.unauthorized || store.view.connection === 'offline' ? 'unknown' : 'online';
  load();
  return drawer;
}

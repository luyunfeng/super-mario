// 项目的“执行”：列表、详情（时间线 / 结果 / 终端）、发起执行。
// “已结束”不等于“待办完成”；结果未知时只提示核对，不提供重复发起。
import { h, replace, keyedList } from '../lib/dom.js';
import { runStatus, isRunActive, isRunProblem, timeAgo, duration, formatDate, uuid } from '../lib/format.js';
import { icon } from '../ui/icons.js';
import { Button, Banner, Check, Empty, Field, Input, TextArea, Select, Pill, Segmented, Tabs, Fold } from '../ui/kit.js';
import { confirmDialog, openDrawer, toast } from '../ui/overlay.js';
import { systemText } from '../copy/terms.js';

import { openTaskClosure, refreshTaskClosure } from './task-closure.js';
import { compareRuns, openWorktreeHistory, renameWorktree, openRetainedBranch, openWorktreeStatus } from './run-comparison.js';
import { createLiveTerminals } from './live-terminals.js';

const PLAN_STATUS = { pending: ['待确认', 'warn'], running: ['启动中', 'info'], started: ['已启动', 'ok'], rejected: ['已拒绝', ''], partial: ['部分启动', 'warn'], unknown: ['结果未知', 'danger'] };
const PHASE_LABELS = { starting: '启动', thinking: '思考', tool: '调用工具', responding: '生成回复', waiting: '等待' };
const FILTERS = [['all', '全部'], ['active', '执行中'], ['problem', '失败 / 未知'], ['ended', '已结束']];

export function createRunsTab({ api, store, router, consoleDrawer, markRunSeen }) {
  const live = createLiveTerminals({ api, store, router });
  let projectId = 'all';
  let filter = 'all';
  let runId = '';
  let detailTab = 'timeline';
  let observations = null;
  let observationsError = '';
  let observationsSignature = '';
  let observationsSeq = 0;
  const isDetailVisible = () => router.current.page === 'projects'
    && router.current.parts?.[1] === 'runs' && router.current.parts?.[2] === runId && Boolean(runId);

  // 路由离开后立即作废在途读取；不能让同一执行重新打开时接收旧响应。
  router.subscribe(() => {
    if (!isDetailVisible()) {
      observationsSeq++; observationsSignature = ''; observations = null; observationsError = '';
    }
  });

  function progressView(run, progress = run.progress, detail = false) {
    const prefix = run.status === 'unknown' ? '最近观察，状态未确认'
      : isRunActive(run) ? '最近观察' : '最后观察';
    return h('div', { class: 'small muted', dataset: { runProgress: run.id }, style: { minWidth: '0', overflowWrap: 'anywhere' } },
      `${prefix}：${progress ? `${PHASE_LABELS[progress.phase] ?? '未知阶段'}${progress.toolName ? ` · ${progress.toolName}` : ''} · ${formatDate(progress.observedAt, true)}` : '未上报结构化进展'}`,
      detail && progress?.detail && h('div', null, progress.detail));
  }

  function waitingView() {
    return h('section', { class: 'stack', dataset: { runBlockers: runId }, style: { minWidth: '0', overflowWrap: 'anywhere' } },
      h('strong', null, '等待你'),
      observationsError ? h('p', { class: 'small muted', role: 'status' }, observationsError)
        : !observations ? h('p', { class: 'small muted' }, '正在读取阻塞项…')
          : observations.blockedBy.length ? h('ul', null, observations.blockedBy.map(item => h('li', null,
            h('a', { href: /^#chat\?(interaction|approval)=[A-Za-z0-9_-]+$/.test(item.href) ? item.href : '#chat' }, item.title),
            h('span', { class: 'small muted' }, ` · ${formatDate(item.createdAt, true)}`))))
            : h('p', { class: 'small muted' }, '没有待你处理的阻塞项。'));
  }

  async function loadObservations() {
    if (!isDetailVisible()) return;
    const snapshot = store.view.snapshot;
    const run = snapshot?.runs.find(item => item.id === runId && inScope(item));
    if (!run) return;
    // 只在相关状态变化时读取，不以无关消息或终端 idle 触发轮询。
    const signature = JSON.stringify([run, snapshot.approvals, snapshot.interactions, snapshot.plans,
      snapshot.reviews, store.view.attention, api.token?.(), store.view.connection]);
    if (signature === observationsSignature) return;
    observationsSignature = signature;
    const stamp = ++observationsSeq;
    const id = runId;
    const token = api.token?.();
    observations = null; observationsError = '';
    const current = () => stamp === observationsSeq && id === runId && isDetailVisible() && token === api.token?.();
    try {
      const value = await api.get(`/runs/${encodeURIComponent(id)}/observations`);
      if (!current()) return;
      if (value?.runId !== id || !Array.isArray(value.blockedBy)) throw new Error('观察数据格式无效');
      observations = value;
    } catch (error) {
      if (!current()) return;
      observationsError = `未能读取执行观察与阻塞项：${systemText(error.message)}。状态未确认。`;
    }
    if (current()) paintDetail();
  }

  const executorName = (id) => (store.view.snapshot?.executors ?? []).find(item => item.id === id)?.name ?? id;
  const inScope = (run) => projectId === 'all' || run.projectId === projectId;

  // —— 列表 ——
  const list = h('div', { class: 'list' });
  const plansBox = h('div', { id: 'plans-box' });
  let plans = [];
  let plansSeq = 0;
  let plansSignature = '';
  const seg = Segmented({ options: FILTERS, value: filter, label: '执行状态', onChange: (value) => { filter = value; paintList(); } });
  const listView = h('div', { class: 'stack stack--lg' },
    h('div', { class: 'row row--between row--wrap' }, seg.el,
      Button({ label: '发起执行', icon: 'plus', kind: 'primary', onClick: () => openLaunch() })),
    live.el, plansBox, list);

  function runRow(run) {
    const status = runStatus[run.status] ?? { text: run.status, tone: '' };
    return h('a', { class: 'item item--click run', href: router.href('projects', projectId, 'runs', run.id), dataset: { id: run.id } },
      Pill(status.text, status.tone),
      h('div', { class: 'item__main' }, h('span', { class: 'item__title truncate' }, run.prompt),
        run.worktree?.name && h('span', { class: 'item__meta' }, '工作树：', run.worktree.name),
        h('span', { class: 'item__meta' }, `${executorName(run.executorId)} · ${isRunActive(run) ? `已运行 ${duration(run.createdAt)}` : timeAgo(run.updatedAt)}`), progressView(run)),
      h('span', { class: 'muted' }, '›'));
  }

  function paintList() {
    const snapshot = store.view.snapshot;
    if (!snapshot) return;
    const rows = (snapshot.runs ?? []).filter(inScope).filter((run) => filter === 'all' || (filter === 'active' && isRunActive(run))
      || (filter === 'problem' && isRunProblem(run)) || (filter === 'ended' && !isRunActive(run) && !isRunProblem(run)))
      .sort((a, b) => Number(isRunProblem(b)) - Number(isRunProblem(a)) || b.createdAt.localeCompare(a.createdAt));
    if (!rows.length) {
      replace(list, Empty({ title: filter === 'all' ? '还没有工作台派发记录' : '没有符合条件的执行', text: filter === 'all' ? '独立启动的 CLI 在上方“项目现场终端”中查看。工作台派发或手动发起的任务会记录在这里。' : undefined }));
      list._keyed = undefined;
      return;
    }
    if (!list._keyed) list.replaceChildren();
    keyedList(list, rows, run => run.id, runRow, run => JSON.stringify([run.id, run.status, run.updatedAt, run.progress, run.worktree?.name]));
  }

  // —— 详情 ——
  const detailBody = h('div', { class: 'stack stack--lg' });
  const detailView = h('div', { class: 'stack stack--lg', hidden: true }, detailBody);
  const el = h('div', { id: 'panel-runs', role: 'tabpanel' }, listView, detailView);

  function paintDetail() {
    const snapshot = store.view.snapshot;
    const run = snapshot?.runs.find(item => item.id === runId && inScope(item));
    if (!run) {
      replace(detailBody, h('a', { class: 'btn btn--sm', href: router.href('projects', projectId, 'runs') }, '← 返回执行列表'), Empty({ title: '找不到这条执行', text: '它可能已被清理。' }));
      return;
    }
    markRunSeen(run.id);
    const status = runStatus[run.status] ?? { text: run.status, tone: '' };
    const todo = run.todoId && snapshot.todos.find(item => item.id === run.todoId);
    const comparisonEnabled = !store.view.unauthorized && snapshot.plugins?.some(p => p.id === 'run-comparison' && p.status === 'active');
    const comparison = comparisonEnabled && compareRuns({ run, runs: snapshot.runs, projectId, router, executorName, api, store });
    const worktreeRuns = comparisonEnabled && run.worktree?.branch
      ? snapshot.runs.filter(item => item.worktreeRunId === run.id && item.projectId === run.projectId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      : [];
    const tabs = Tabs({ items: [{ id: 'timeline', label: '时间线' }, { id: 'result', label: '结果' }, { id: 'terminal', label: '终端' }], active: detailTab, label: '执行详情', onSelect: (id) => { detailTab = id; paintDetail(); } });

    const timeline = [
      [run.createdAt, '已派发', `执行者：${executorName(run.executorId)}${run.cwd ? ` · 目录：${run.cwd}` : ''}`],
      isRunActive(run) ? [new Date().toISOString(), '正在执行', `已运行 ${duration(run.createdAt)}`] : [run.updatedAt, `${status.text}`, run.resultSource ? `来源：${run.resultSource}` : undefined],
    ];
    const panels = {
      timeline: h('div', { class: 'stack stack--lg' }, waitingView(), h('ol', { class: 'timeline' }, timeline.map(([time, title, text]) => h('li', null, h('div', { class: 'timeline__title' }, title, h('span', { class: 'muted small' }, ` ${formatDate(time, true)}`)), text && h('div', { class: 'muted small' }, text))))),
      result: h('div', { class: 'stack' },
        run.output ? h('pre', { class: 'output' }, run.output) : h('p', { class: 'muted' }, isRunActive(run) ? '还在执行，结果会出现在这里。' : '没有输出内容。'),
        run.error && h('pre', { class: 'output output--error' }, run.error),
        run.resultSource && h('p', { class: 'muted small' }, `结果来源：${run.resultSource}。`)),
      terminal: run.sessionId
        ? h('div', { class: 'stack' }, h('p', { class: 'muted' }, '终端只显示当前画面，不是完整日志。关闭只会断开观察，不会中断执行。'), h('div', null, Button({ label: '打开终端', icon: 'terminal', onClick: () => consoleDrawer.open(run) })))
        : h('p', { class: 'muted' }, '这次执行没有终端会话。'),
    };
    replace(detailBody,
      h('div', null, h('a', { class: 'btn btn--ghost btn--sm', href: router.href('projects', projectId, 'runs') }, icon('back'), '执行')),
      h('div', { class: 'row row--between row--wrap' },
        h('div', { class: 'stack' }, h('h2', { class: 'run__title' }, run.prompt), h('div', { class: 'row' }, Pill(status.text, status.tone), h('span', { class: 'muted small' }, `${executorName(run.executorId)} · ${timeAgo(run.createdAt)}`))),
        isRunActive(run) && Button({ label: '中断', kind: 'danger', size: 'sm', onClick: async () => {
          const ok = await confirmDialog({ title: '中断这次执行？', message: '会请求执行者停止；已经产生的修改不会自动撤销。', confirmLabel: '请求中断', danger: true });
          if (ok) { await api.post(`/runs/${encodeURIComponent(run.id)}/cancel`, {}); store.refresh(); }
        } })),
      run.worktree?.name && h('strong', null, '工作树：', run.worktree.name),
      comparisonEnabled && run.worktree?.branch && !run.worktree.removedAt && Button({ label: '重命名工作树', size: 'sm', onClick: () => renameWorktree({ item: run, api, store, router }) }),
      run.worktree && h('p', { class: 'muted small' }, run.worktree.branchDeletedAt ? '工作树目录已清理 · 执行分支已删除' : run.worktree.removedAt ? `工作树目录已清理 · 保留分支 ${run.worktree.branch}` : run.worktree.branch
        ? `独立工作树：${run.cwd} · ${run.worktree.branch} · 起点 ${run.worktree.base.slice(0, 10)}`
        : `独立工作树尚无创建回执 · 来源 ${run.worktree.source}`),
      comparisonEnabled && run.worktree?.branch && !run.worktree.removedAt && Button({ label: '在此工作树发起执行', size: 'sm', onClick: () => openLaunch(run) }),
      worktreeRuns.length > 0 && h('section', { class: 'stack', 'aria-label': '工作树关联执行' },
        h('h3', null, '工作树关联执行'), h('ul', { class: 'stack' }, worktreeRuns.map(item =>
          h('li', { class: 'row row--wrap' }, h('a', { href: router.href('projects', run.projectId, 'runs', item.id) }, item.prompt),
            Pill(runStatus[item.status]?.text ?? item.status, runStatus[item.status]?.tone ?? ''),
            h('small', { class: 'muted' }, executorName(item.executorId), ' · ', formatDate(item.createdAt, true)))))),
      run.worktreeRunId && h('a', { href: router.href('projects', run.projectId, 'runs', run.worktreeRunId) }, '查看原工作树'),
      comparisonEnabled && run.worktree?.branch && !run.worktree.branchDeletedAt && Button({ label: '查看提交历史', size: 'sm', onClick: () => openWorktreeHistory({ item: run, api, store, router }) }),
      comparisonEnabled && run.worktree?.removedAt && !run.worktree.branchDeletedAt && Button({ label: '查看保留分支', size: 'sm', onClick: () => openRetainedBranch({ item: run, api, store, router }) }),
      comparisonEnabled && run.worktree?.branch && !run.worktree.removedAt && Button({ label: '查看工作树状态', size: 'sm', onClick: () => openWorktreeStatus({ item: run, api, store, router }) }),
      run.status === 'unknown' && Banner({ tone: 'danger', children: '动作已发出，但没有收到确认。请先到电脑上核对，不要重复发起。' }),
      run.status === 'failed' && Banner({ tone: 'danger', children: run.error ? systemText(run.error) : '执行失败，请查看“结果”。' }),
      progressView(run, observations ? observations.progress : run.progress, true),
      comparison, tabs.el, panels[detailTab],
      h('div', { class: 'card card--tight accept' }, h('div', { class: 'card__body' },
        h('div', { class: 'stack' },
          h('strong', null, '验收'),
          run.doneWhen ? h('p', { class: 'small' }, `完成标准：${run.doneWhen}`) : h('p', { class: 'small muted' }, '这次执行没有设置完成标准。'),
          h('p', { class: 'small muted' }, '“已结束”只表示执行者停止了，是否真的完成由你确认。'),
          todo && (todo.completedAt ? h('p', { class: 'small' }, `关联待办“${todo.title}”已完成。`)
            : h('div', null, Button({ label: run.doneWhen ? '验收交付' : `标记待办已完成：${todo.title}`, kind: 'primary', size: 'sm', onClick: async () => { if (run.doneWhen) { openTaskClosure({ api, store, router, todo, runId: run.id, title: '验收交付' }); return; } await api.patch(`/todos/${encodeURIComponent(todo.id)}`, { completed: true }); store.refresh(); } })))))));
  }

  // —— 发起执行 ——
  function openLaunch(parentRun) {
    const snapshot = store.view.snapshot;
    const launchProjectId = parentRun?.projectId ?? projectId;
    const binding = snapshot.projects?.find(item => item.id === launchProjectId)?.workspace;
    const executors = (snapshot.executors ?? []).filter(item => item.available && (!binding || item.machineId === binding.machineId));
    const launchToken = api.token();
    const key = uuid();
    let uncertain = false;
    const prompt = TextArea({ rows: 4, placeholder: '例如：修复登录页的报错，并跑通现有测试', required: true });
    const executor = Select({ options: [...(!binding ? [['', '自动选择（推荐）']] : []), ...executors.map(item => [item.id, item.name])] });
    if (parentRun) executor.value = parentRun.executorId;
    const cwd = Input({ value: parentRun?.cwd ?? binding?.cwd ?? '', readOnly: Boolean(binding), placeholder: '留空使用这台电脑的默认目录' });
    const todos = (snapshot.todos ?? []).filter(todo => !todo.completedAt && (launchProjectId === 'all' || todo.projectId === launchProjectId));
    const todo = Select({ options: [['', '不关联'], ...todos.map(item => [item.id, item.title])] });
    const criteria = Input({ placeholder: '例如：npm test 通过，登录页无报错' });
    const minutes = Input({ type: 'number', min: 1, max: 10080, placeholder: '例如：15' });
    const mode = Select({ options: [['task', '任务：做完就结束'], ['interactive', '交互会话：可以持续对话']] });
    const canIsolate = !parentRun && binding && snapshot.plugins?.some(p => p.id === 'run-comparison' && p.status === 'active')
      && snapshot.machines?.some(m => m.id === binding.machineId && m.capabilities.includes('workspace.prepareRunWorktree'));
    let isolated = false;
    const canCompare = canIsolate && snapshot.machines.some(m => m.id === binding.machineId && m.capabilities.includes('workspace.worktreeBase'));
    const copies = Select({ options: [['1', '1 次'], ['2', '2 次'], ['3', '3 次'], ['4', '4 次']] });
    const copiesField = canCompare && Field({ label: '从同一提交并行执行', control: copies });
    const isolation = canIsolate && Check({ label: '从当前提交创建独立 Git 工作树', onChange: value => { isolated = value; sync(); } });
    const message = h('div', { role: 'alert' });
    const criteriaField = Field({ label: '怎样算完成', control: criteria });
    const minutesField = Field({ label: '预计用时（分钟）', control: minutes });
    const sync = () => {
      const chosen = executors.find(item => item.id === executor.value);
      mode.disabled = Boolean(chosen?.taskOnly);
      if (mode.disabled) mode.value = 'task';
      if (isolation) {
        isolation.hidden = mode.value !== 'task';
        if (isolation.hidden) { isolated = false; isolation.querySelector('input').checked = false; }
      }
      if (copiesField) copiesField.hidden = !isolated;
      const real = chosen ? chosen.mode === 'real' : snapshot.mode !== 'demo';
      const required = real && mode.value === 'task';
      for (const [field, control] of [[criteriaField, criteria], [minutesField, minutes]]) { control.required = required; field.querySelector('.field__req')?.remove(); if (required) field.querySelector('label').append(h('span', { class: 'field__req' }, '*')); }
    };
    for (const control of [executor, mode]) control.addEventListener('change', sync);
    const drawer = openDrawer({
      onClose: () => { offRoute(); offStore(); },
      title: '发起执行', subtitle: launchProjectId === 'all' ? '不归属于某个项目' : `归属项目：${(snapshot.projects ?? []).find(item => item.id === launchProjectId)?.name ?? ''}`,
      body: [!executors.length && Banner({ tone: 'warn', children: '现在没有可用的执行者。请先在 Agent 里连接一台电脑。', action: h('a', { class: 'btn btn--sm', href: router.href('agent') }, '去连接') }),
        Field({ label: '要做什么', control: prompt, required: true }), Field({ label: '谁来做', control: executor }),
        binding && h('p', { class: 'muted folder-path' }, parentRun ? `复用工作树：${parentRun.worktree.name ?? parentRun.worktree.branch} · ${parentRun.cwd}` : `继承项目文件夹：${binding.cwd}`), Field({ label: '关联待办', control: todo }), criteriaField, minutesField, isolation, copiesField,
        Fold({ title: '更多选项', body: [Field({ label: parentRun ? '原工作树目录' : binding ? '目录（继承项目）' : '目录', control: cwd }), Field({ label: '执行方式', control: mode })] }), message],
      footer: [Button({ label: '取消', onClick: () => drawer.close() }), Button({
        label: '开始执行', kind: 'primary',
        onClick: async (_event, button) => {
          if (uncertain || api.token() !== launchToken || !drawer.el.open) return;
          if (binding && !executors.some(item => item.id === executor.value)) { replace(message, Banner({ tone: 'warn', children: '绑定电脑没有可用执行者，不能改用其他电脑。' })); return; }
          if (!prompt.value.trim()) { replace(message, Banner({ tone: 'danger', children: '请写下要做什么。' })); return; }
          const body = { prompt: prompt.value.trim(), ...(parentRun && { worktreeRunId: parentRun.id }), ...(isolated && { isolatedWorktree: true, ...(canCompare && { copies: Number(copies.value) }) }), ...(executor.value ? { executorId: executor.value } : {}), ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}),
            ...(launchProjectId !== 'all' ? { projectId: launchProjectId } : {}), ...(todo.value ? { todoId: todo.value } : {}), ...(criteria.value.trim() ? { doneWhen: criteria.value.trim() } : {}),
            ...(minutes.value ? { expectMinutes: Number(minutes.value) } : {}), executionMode: mode.value };
          try { const run = await api.post('/runs', body, { 'Idempotency-Key': key }); drawer.close(); store.refresh(); router.go(router.href('projects', launchProjectId, 'runs', run.id) + (run.comparisonRunIds ? '?compare=group' : '')); }
          catch (error) { uncertain = !error.status || error.status >= 500 || /unknown/i.test(error.message); if (uncertain) button.disabled = true; replace(message, Banner({ tone: 'danger', children: uncertain ? '执行结果未知，请先核对执行记录和电脑，不要重复发起。' : `没有开始执行：${systemText(error.message)}` })); }
        },
      })],
    });
    const offRoute = router.subscribe(() => drawer.close());
    const offStore = store.subscribe(view => {
      if (view.unauthorized || api.token() !== launchToken || parentRun && !view.snapshot?.plugins?.some(p => p.id === 'run-comparison' && p.status === 'active')) drawer.close();
    });
    sync();
  }

  // 计划：主 Agent 一次拆出的几项任务。待确认的计划在对话里等你决定，这里保留全部历史。
  function paintPlans() {
    const rows = plans.filter(plan => projectId === 'all' || plan.tasks.some(task => task.projectId === projectId));
    if (!rows.length) { plansBox.replaceChildren(); return; }
    plansBox.replaceChildren(Fold({ title: `计划 ${rows.length}`, body: h('div', { class: 'stack' }, rows.map((plan) => {
      const [text, tone] = PLAN_STATUS[plan.status] ?? [plan.status, ''];
      return h('div', { class: 'plan', dataset: { plan: plan.id } },
        h('div', { class: 'row row--between' }, h('strong', null, plan.title), Pill(text, tone)),
        h('ol', { class: 'plan__tasks' }, plan.tasks.map(task => h('li', null,
          task.runId ? h('a', { href: router.href('projects', projectId, 'runs', task.runId) }, task.prompt) : task.prompt,
          task.error && h('span', { class: 'text-danger small' }, ` · ${task.error}`)))),
        plan.error && h('p', { class: 'text-danger small' }, plan.error));
    })) }));
  }
  async function loadPlans() {
    const stamp = ++plansSeq;
    try { const value = await api.get('/plans'); if (stamp !== plansSeq) return; plans = value; } catch { return; }
    paintPlans();
  }

  function apply() {
    const sig = JSON.stringify((store.view.snapshot?.runs ?? []).map(run => [run.id, run.status]));
    if (sig !== plansSignature) { plansSignature = sig; loadPlans(); }
    loadObservations();
    listView.hidden = Boolean(runId); detailView.hidden = !runId; if (runId) paintDetail(); else paintList();
  }

  return {
    el,
    show(id, nextRunId = '') { plansSignature = ''; projectId = id; live.show(id); if (nextRunId !== runId) { detailTab = 'timeline'; observationsSeq++; observationsSignature = ''; observations = null; observationsError = ''; } runId = nextRunId; apply(); },
    update() { live.update(); refreshTaskClosure(api); apply(); },
    launch: openLaunch,
    count(snapshot, id) {
      const runs = (snapshot.runs ?? []).filter(run => id === 'all' || run.projectId === id);
      return { active: runs.filter(isRunActive).length, problem: runs.filter(isRunProblem).length };
    },
  };
}

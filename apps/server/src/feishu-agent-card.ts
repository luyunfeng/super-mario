import type { Store } from '../../../packages/plugin-sdk/src/index.ts';
import type { Project, Run, Todo } from '../../../packages/protocol/src/index.ts';
import { executionProgress } from '../../../packages/core/src/execution-progress.ts';
import { readRunBlockers } from '../../../packages/core/src/run-blockers.ts';
import { publicText } from '../../../plugins/agent-progress-card.ts';
import { cardButtons, cardDocument, cardPlain, cardWebBase } from './feishu-cards.ts';
import type { SessionList } from './feishu-session-card.ts';

const states = {
  waiting: '等你决定',
  running: '执行中',
  queued: '排队中',
  review: '执行结束 · 待办未完成',
};
type AgentState = keyof typeof states;
const priority: Record<AgentState, number> = { waiting: 0, running: 1, queued: 2, review: 3 };
type AgentRow = {
  machineId: string; machine: string; agent: string; id: string; cwd: string; time: string; resumable: boolean;
  runId: string; sessionId?: string; projectId?: string; projectName?: string; todoId?: string; title: string; state: AgentState;
};
const line = (value: string | undefined, limit = 100) => publicText(value, limit).replace(/\s+/g, ' ');

export function agentCardSnapshot(discovery: SessionList, store: Pick<Store, 'list'>, query: string) {
  const projects = new Map(store.list<Project>('projects').map(item => [item.id, item]));
  const todos = new Map(store.list<Todo>('todos').map(item => [item.id, item]));
  const blockers = readRunBlockers(store, Date.now());
  const latest = new Map<string, Run>();
  const key = (machineId: string, executorId: string, sessionId: string) => JSON.stringify([machineId, executorId, sessionId]);
  for (const run of store.list<Run>('runs')) {
    const nativeId = run.nativeSessionId ?? run.nativeResume?.nativeSessionId;
    if (!run.machineId || !nativeId) continue;
    const id = key(run.machineId, run.executorId, nativeId);
    const previous = latest.get(id);
    // A late update to an earlier attempt must not replace the current attempt for this native thread.
    if (!previous || run.createdAt > previous.createdAt || (run.createdAt === previous.createdAt && run.updatedAt > previous.updatedAt)) latest.set(id, run);
  }
  const rows: AgentRow[] = [], warnings: string[] = [];
  const needle = query.trim().toLowerCase();
  let historyOnly = 0;
  for (const machine of discovery.machines) {
    const warning = machine.reason || (machine.online === false ? '电脑离线'
      : machine.online !== true || machine.available !== true ? '会话发现状态未核实'
      : machine.truncated || machine.warnings?.length ? '会话发现结果可能不完整' : '');
    if (warning) warnings.push(line(machine.machineName, 60) + '：' + line(warning));
    if (!machine.machineId || machine.online !== true || machine.available !== true) continue;
    for (const session of machine.sessions) {
      const run = latest.get(key(machine.machineId, machine.machineId + '/' + session.executorId, session.nativeSessionId));
      if (!run) { historyOnly++; continue; }
      const todo = run.todoId ? todos.get(run.todoId) : undefined;
      const project = run.projectId ? projects.get(run.projectId) : undefined;
      if ((run.projectId && (!project || project.archivedAt)) || (run.todoId && (!todo || todo.projectId !== run.projectId))
        || (run.cwd && run.cwd !== session.cwd) || run.status === 'unknown') continue;
      const state = blockers(run).length ? 'waiting'
        : run.status === 'running' || run.status === 'queued' ? run.status
        : run.status === 'completed' && todo && !todo.completedAt ? 'review' : undefined;
      if (!state) continue;
      const title = line(run.prompt || todo?.title || session.nativeSessionId, 100);
      if (needle && ![run.prompt, todo?.title, project?.name, machine.machineName, machine.machineId, session.cwd,
        session.nativeSessionId, session.executorId].some(value => value?.toLowerCase().includes(needle))) continue;
      rows.push({ machineId: machine.machineId, machine: line(machine.machineName, 60), agent: session.executorId, id: session.nativeSessionId,
        cwd: session.cwd, time: run.updatedAt, state, title, runId: run.id, projectId: run.projectId, projectName: project && line(project.name, 60), todoId: run.todoId,
        sessionId: run.executionMode === 'interactive' && run.status === 'running' && !todo?.completedAt ? run.sessionId : undefined, resumable: session.resumable && state === 'review' });
    }
  }
  rows.sort((a, b) => priority[a.state] - priority[b.state] || b.time.localeCompare(a.time) || a.runId.localeCompare(b.runId));
  return { rows: rows.slice(0, 100), total: rows.length, query: line(query, 100), capturedAt: discovery.capturedAt,
    warnings: warnings.slice(0, 5), historyOnly };
}
export type AgentCardSnapshot = ReturnType<typeof agentCardSnapshot>;

export function agentCard(data: AgentCardSnapshot, navigation: string, webBase?: string, requestedPage = 0) {
  const base = cardWebBase(webBase);
  const pages = Math.max(1, Math.ceil(data.rows.length / 5));
  const page = Math.min(Math.max(0, requestedPage), pages - 1);
  const elements: Record<string, unknown>[] = [], lines: string[] = [];
  function section(text: string) {
    lines.push(text);
    elements.push({ tag: 'div', text: cardPlain(text) });
  }
  if (data.query) section('筛选 · ' + data.query);
  for (const [offset, row] of data.rows.slice(page * 5, (page + 1) * 5).entries()) {
    section([states[row.state] + ' · ' + row.title, [row.projectName, row.machine, line(row.agent, 60)].filter(Boolean).join(' · '), line(row.cwd, 220), '执行更新 ' + row.time].join('\n'));
    elements.push(...cardButtons([
      ...(row.sessionId || row.resumable ? [{ label: row.resumable ? '申请恢复' : '选择会话', value: {
        kind: 'workbench.agentSelect', navigation, index: page * 5 + offset,
      } }] : []),
      { label: '查看执行', route: 'projects/' + encodeURIComponent(row.projectId || 'all') + '/runs/' + encodeURIComponent(row.runId) },
    ], base));
  }
  if (!data.total) section('当前范围内没有符合条件的执行会话。');
  if (data.historyOnly) section('仅有历史日志的会话未列入，可发送 /sessions 查看历史。');
  for (const warning of data.warnings) section(warning);
  section('第 ' + (page + 1) + ' / ' + pages + ' 页 · 共 ' + data.total + ' 条' + (data.total > data.rows.length ? '，仅展示前 ' + data.rows.length + ' 条' : '') + ' · 采集于 ' + data.capturedAt);
  const pageButton = (label: string, page: number) => ({ label, value: { kind: 'workbench.agents', navigation, page } });
  elements.push(...cardButtons([
    ...(page > 0 ? [pageButton('上一页', page - 1)] : []), ...(page + 1 < pages ? [pageButton('下一页', page + 1)] : []),
    { label: '发起执行', value: { kind: 'workbench.startForm', navigation } },
  ], base));
  return { card: cardDocument('执行会话', elements), text: ['执行会话', ...lines].join('\n\n') };
}

/** Render only the run the private owner selected. The same snapshot is used to check a queued delivery. */
export function selectedAgentStatus(store: Pick<Store, 'list'>, run: Run, webBase?: string) {
  const phases = { running: '运行中', queued: '排队中', completed: '执行结束', failed: '失败', cancelled: '已取消', unknown: '未知' };
  const observations = { starting: '启动', thinking: '分析', tool: '调用工具', responding: '输出', waiting: '等待后续事件' };
  const types: Record<string, string> = { question: '问题', permission: '权限', plan: '计划', review: '验收', approval: '审批' };
  const lines = ['执行会话 · ' + line(run.id, 120), '已登记执行状态 · ' + phases[run.status]];
  if (run.prompt) lines.push('登记目标 · ' + line(run.prompt, 220));
  if (run.doneWhen) lines.push('验收条件 · ' + line(run.doneWhen, 180));
  const progress = executionProgress(run.progress);
  if (progress) {
    lines.push('最近观察 · ' + [new Date(progress.observedAt).toISOString(), observations[progress.phase], line(progress.toolName), line(progress.detail, 180)].filter(Boolean).join(' · '));
  }
  const pending = readRunBlockers(store, Date.now())(run)
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || a.id.localeCompare(b.id));
  lines.push('待处理 · ' + pending.length + ' 项' + (pending.length > 5 ? '（仅显示最近 5 项）' : ''));
  for (const item of pending.slice(0, 5)) lines.push('• ' + (types[item.kind] ?? '决定') + ' · ' + line(item.title, 120));
  const text = lines.join('\n');
  const elements = [{ tag: 'div', text: cardPlain(text) }, ...cardButtons([
    { label: '查看执行', route: 'projects/' + encodeURIComponent(run.projectId || 'all') + '/runs/' + encodeURIComponent(run.id) },
  ], cardWebBase(webBase))];
  return { text, card: cardDocument('执行会话状态', elements) };
}

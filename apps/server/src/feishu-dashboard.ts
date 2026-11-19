import type { FeishuBotsApp } from './feishu-bots.ts';
import type { InboxItem, MachineInfo, Project, Run, Todo } from '../../../packages/protocol/src/index.ts';
import type { AttentionItem } from '../../../packages/core/src/attention.ts';
import { cardButtons, cardDocument, cardPlain, cardSection, cardWebBase } from './feishu-cards.ts';

type DashboardApp = Pick<FeishuBotsApp, 'store' | 'projectWorkspace'> & { attention?: () => AttentionItem[] };
export type DashboardView = 'home' | 'tasks' | 'inbox' | 'projects';
const label = (value: string, max = 100) => value.replace(/\s+/g, ' ').trim().slice(0, max);

/** Owner-only, read-only views. Callback buttons refresh this card; URL buttons navigate to Web. */
export function buildFeishuDashboard(app: DashboardApp, webBase?: string, options: {
  view?: DashboardView; page?: number; navigation?: string; now?: Date;
} = {}) {
  const elements: Record<string, unknown>[] = [], lines: string[] = [];
  const base = cardWebBase(webBase), view = options.view ?? 'home';
  const section = (title: string, text: string) => { elements.push(...cardSection(title, text)); lines.push(title + '\n' + text); };
  const buttons = (entries: Array<[string, string]>) => elements.push(...cardButtons(entries.map(([text, route]) => ({ label: text, route })), base));
  const projects = new Map(app.store.list<Project>('projects').map(p => [p.id, p.name]));
  const tasks = new Map(app.store.list<Todo>('todos').map(t => [t.id, t]));
  const machines = app.store.list<MachineInfo>('machines');
  const runs = app.store.list<Run>('runs').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const waiting = (app.attention?.() ?? []).filter(item => item.type !== 'inbox');
  const working = runs.filter(r => r.status === 'running' || r.status === 'queued');
  const review = runs.filter(r => r.status === 'completed' && r.todoId && tasks.has(r.todoId) && !tasks.get(r.todoId)?.completedAt);
  const issues = runs.filter(r => r.status === 'failed' || r.status === 'unknown');
  const inbox = app.store.list<InboxItem>('inbox').filter(item => {
    if (item.todoId || item.archivedAt || item.tier === 'noise') return false;
    if (item.origin?.connector === '飞书' || item.source.startsWith('feishu:')) {
      const origin = item.origin;
      return origin?.kind === 'direct' || (origin?.kind === 'group' && origin.personalGroupObserved === true && origin.personalGroupUserCount !== undefined && origin.personalGroupUserCount <= 50);
    }
    return true;
  });
  const action = inbox.filter(item => item.tier === 'action');
  const metrics = [
    ['进行中', String(working.length)], ['结束待验收', String(review.length)],
    ['需要处理', String(action.length)], ['知会即可', String(inbox.length - action.length)],
  ];
  elements.push({ tag: 'div', fields: metrics.map(([title, value]) => ({ is_short: true, text: { tag: 'lark_md', content: `${title}\n**${value}**` } })) });
  elements.push({ tag: 'hr' });
  let total = 0, page = 0;
  const pageSize = 5;
  if (view === 'home') {
    section('等你处理', waiting.length ? '等你拍板 · ' + waiting.length + ' 项\n' + waiting.slice(0, 3).map(a => '• ' + label(a.title)).join('\n') : '当前没有等你拍板的事。');
    if (waiting.length > 3) section('更多待决定', `还有 ${waiting.length - 3} 项，请打开主对话核对。`);
    section('此刻', `Agent 执行 · ${working.length} 项进行中 · ${review.length} 项执行结束待验收 · ${issues.length} 项失败或结果未知\n收件箱 · ${action.length} 条需处理 · ${inbox.length - action.length} 条知会\n电脑 · ${machines.filter(m => m.online).length} / ${machines.length} 台在线`);
    if (action.length) section('来信摘要', action.slice(0, 3).map(item => '• ' + label(item.title)).join('\n') + (action.length > 3 ? `\n还有 ${action.length - 3} 条，可在收件箱查看。` : ''));
    for (const run of working.slice(0, 2)) {
      section('正在推进', label(run.prompt));
      buttons([['查看执行', `projects/${encodeURIComponent(run.projectId && projects.has(run.projectId) ? run.projectId : 'all')}/runs/${encodeURIComponent(run.id)}`]]);
    }
  } else if (view === 'tasks') {
    const rows = [...working, ...issues, ...review]; total = rows.length;
    page = Math.min(Math.max(0, options.page ?? 0), Math.max(0, Math.ceil(total / pageSize) - 1));
    const labels = { running: '执行中', queued: '排队中', completed: '执行结束，待验收', failed: '失败', unknown: '结果未知', cancelled: '已取消' };
    if (!rows.length) section('任务进展', '没有进行中、待核对或待验收的执行。');
    for (const run of rows.slice(page * pageSize, (page + 1) * pageSize)) {
      const project = run.projectId && projects.has(run.projectId) ? run.projectId : '';
      const title = label((run.todoId && tasks.get(run.todoId)?.title) || run.prompt);
      const machine = machines.find(m => m.id === run.machineId);
      section(labels[run.status], [project ? projects.get(project) : '未归项目', machine?.name, title,
        run.progress?.detail && '最近进展：' + label(run.progress.detail, 200), run.error && '原因：' + label(run.error, 200)].filter(Boolean).join('\n'));
      buttons([['查看执行', 'projects/' + encodeURIComponent(project || 'all') + '/runs/' + encodeURIComponent(run.id)]]);
    }
  } else if (view === 'inbox') {
    const rows = [...action, ...inbox.filter(item => item.tier !== 'action')]; total = rows.length;
    page = Math.min(Math.max(0, options.page ?? 0), Math.max(0, Math.ceil(total / pageSize) - 1));
    if (!rows.length) section('收件箱', '当前没有未处理来信。');
    for (const item of rows.slice(page * pageSize, (page + 1) * pageSize))
      section(item.tier === 'action' ? '需要处理' : '知会即可', label(item.title) + '\n' + label(item.text ?? '', 200));
  }
  if ((view === 'home' || view === 'projects') && options.navigation && app.projectWorkspace) {
    const activeProjects = app.store.list<Project>('projects').filter(p => !p.archivedAt);
    if (view === 'projects') {
      total = activeProjects.length;
      page = Math.min(Math.max(0,options.page ?? 0), Math.max(0, Math.ceil(total / pageSize) - 1));
    }
    const rows = activeProjects.slice(page * pageSize, (page + 1) * pageSize);
    for (const project of rows) {
      section('项目 Agent', label(project.name));
      elements.push(...cardButtons([{ label: '在这里聊', value: { kind: 'workbench.chat', projectId: project.id, navigation: options.navigation } }]));
    }
    if (view === 'home' && activeProjects.length > pageSize) elements.push(...cardButtons([{ label:'全部项目',value:{kind:'workbench.navigate',navigation:options.navigation,view:'projects',page:0} }]));
    elements.push(...cardButtons([{ label: '切回主 Agent', value: { kind: 'workbench.chat', projectId: '', navigation: options.navigation } }]));
  }
  if (options.navigation) {
    const value = (target: DashboardView, targetPage = 0) => ({ kind: 'workbench.navigate', navigation: options.navigation, view: target, page: targetPage });
    if (view !== 'home' && total) {
      section('页码', `${page + 1} / ${Math.ceil(total / pageSize)} 页 · 共 ${total} 条`);
      elements.push(...cardButtons([
        ...(page > 0 ? [{ label: '上一页', value: value(view, page - 1) }] : []),
        ...(page + 1 < Math.ceil(total / pageSize) ? [{ label: '下一页', value: value(view, page + 1) }] : []),
        { label: '刷新当前页', value: value(view, page) },
      ]));
    }
    elements.push(...cardButtons([
      { label: '📋 任务进展', value: value('tasks') }, { label: '📥 收件箱', value: value('inbox') }, { label: '🏠 工作台', value: value('home'), primary: view !== 'home' },
    ]));
  } else {
    buttons([['📋 任务进展', 'projects/all/runs'], ['📥 收件箱', 'inbox'], ['🏠 工作台', 'home']]);
  }
  // Retain a direct Web route for confirmation and for applications without card callbacks configured.
  buttons([['主对话', 'chat'], ['执行列表', 'projects/all/runs'], ['发起执行', 'projects/all/runs/new']]);
  elements.push({ tag: 'note', elements: [cardPlain('仅供已配对的主人私聊查看。按钮导航不会批准、发件或验收；数据为卡片生成时的快照。')] });
  const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(options.now ?? new Date());
  const title = `${date} · ${view === 'home' ? '今日工作台' : view === 'tasks' ? '任务进展' : view === 'projects' ? '项目 Agent' : '收件箱'}`;
  return { text: lines.join('\n\n'), card: cardDocument(title, elements) };
}

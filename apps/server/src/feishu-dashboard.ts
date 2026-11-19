import type { FeishuBotsApp } from './feishu-bots.ts';
import type { InboxItem, MachineInfo, Project, Run, Todo } from '../../../packages/protocol/src/index.ts';
import type { AttentionItem } from '../../../packages/core/src/attention.ts';

type DashboardApp = Pick<FeishuBotsApp, 'store'> & { attention?: () => AttentionItem[] };
const label = (value: string, max = 72) => value.replace(/\s+/g, ' ').trim().slice(0, max);
const plain = (content: string) => ({ tag: 'plain_text', content });

/** Read-only projection for the paired owner's global bot. Links contain navigation only. */
export function buildFeishuDashboard(app: DashboardApp, webBase?: string) {
  const elements: Record<string, unknown>[] = [], lines: string[] = [];
  let base: string | undefined;
  if (webBase && URL.canParse(webBase)) {
    const url = new URL(webBase);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash)
      base = url.href;
  }
  function section(content: string) {
    elements.push({ tag: 'div', text: plain(content) });
    lines.push(content);
  }
  function buttons(entries: [string, string][]) {
    if (!base) return;
    elements.push({ tag: 'action', actions: entries.map(([text, route]) => ({
      tag: 'button', text: plain(text), type: 'default', url: base + '#' + route,
    })) });
  }

  section('当前私聊对象 · 主 Agent（全局）');
  const projects = new Map(app.store.list<Project>('projects').map(p => [p.id, p.name]));
  const tasks = new Map(app.store.list<Todo>('todos').map(t => [t.id, t]));
  const machines = app.store.list<MachineInfo>('machines');
  const runs = app.store.list<Run>('runs').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const waiting = (app.attention?.() ?? []).filter(item => item.type !== 'inbox');
  section(waiting.length ? '等你拍板 · ' + waiting.length + ' 项\n' + waiting.slice(0, 3).map(a => '· ' + label(a.title)).join('\n') : '当前没有等你拍板的事。');
  const working = runs.filter(r => r.status === 'running' || r.status === 'queued');
  const review = runs.filter(r => r.status === 'completed' && r.todoId && tasks.has(r.todoId) && !tasks.get(r.todoId)?.completedAt);
  const issues = runs.filter(r => r.status === 'failed' || r.status === 'unknown');
  section('Agent 执行 · ' + working.length + ' 项进行中 · ' + review.length + ' 项执行结束待验收 · ' + issues.length + ' 项失败或结果未知');
  const runLabels = { running: '执行中', queued: '排队中', completed: '待验收', failed: '失败', unknown: '结果未知', cancelled: '已取消' };
  for (const run of [...working, ...issues, ...review].slice(0, 3)) {
    const project = run.projectId && projects.has(run.projectId) ? run.projectId : '';
    const title = label((run.todoId && tasks.get(run.todoId)?.title) || run.prompt);
    const machine = machines.find(m => m.id === run.machineId);
    const progress = run.status === 'running' && run.progress?.detail ? '\n最近进展：' + label(run.progress.detail, 120) : '';
    section([project ? projects.get(project) : '未归项目', runLabels[run.status], machine?.name, title].filter(Boolean).join(' · ') + progress);
    buttons([['查看执行', 'projects/' + encodeURIComponent(project || 'all') + '/runs/' + encodeURIComponent(run.id)],
      ...(project ? [['进入项目对话', 'projects/' + encodeURIComponent(project) + '/workspace'] as [string,string]] : [])]);
  }
  const inbox = app.store.list<InboxItem>('inbox').filter(item => {
    if (item.todoId || item.archivedAt || item.tier === 'noise') return false;
    // Old personal group records have no proof that the conversation was observable.
    if (item.origin?.connector === '飞书' || item.source.startsWith('feishu:')) {
      const origin = item.origin;
      return origin?.kind === 'direct' || (origin?.kind === 'group' && origin.personalGroupObserved === true && origin.personalGroupUserCount !== undefined && origin.personalGroupUserCount <= 50);
    }
    return true;
  });
  const action = inbox.filter(item => item.tier === 'action');
  section('收件箱 · ' + action.length + ' 条需处理 · ' + (inbox.length - action.length) + ' 条知会' +
    action.slice(0, 2).map(item => '\n· ' + label(item.title)).join(''));
  section('电脑 · ' + machines.filter(m => m.online).length + ' / ' + machines.length + ' 台在线');
  buttons([['首页', 'home'], ['主对话', 'chat'], ['执行列表', 'projects/all/runs'], ['收件箱', 'inbox'], ['发起执行', 'projects/all/runs/new']]);
  return { text: lines.join('\n\n'), card: { config: { wide_screen_mode: true },
    header: { template: 'blue', title: plain('Super Mario 工作台') }, elements } };
}

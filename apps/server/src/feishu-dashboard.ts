import type { ConversationStatus } from '../../../plugins/conversation-status.ts';
import type { TodayBrief, TodaySection } from '../../../plugins/today-brief.ts';
import type { FeishuBotsApp } from './feishu-bots.ts';
import type { InboxItem, MachineInfo, Message, Project, QuestionResponse, Run, Todo } from '../../../packages/protocol/src/index.ts';
import { publicText } from '../../../plugins/agent-progress-card.ts';
import { cardAcceptsAnswer } from '../../../packages/core/src/question-deadline.ts';
import type { Card } from '../../../packages/core/src/interactions.ts';
import type { AttentionItem } from '../../../packages/core/src/attention.ts';
import { cardButtons, cardDocument, cardPlain, cardSection, cardWebBase } from './feishu-cards.ts';

type DashboardApp = Pick<FeishuBotsApp, 'store' | 'projectWorkspace' | 'agentSessions' | 'interactions'> & { inboxAssistant?:{list():import('../../../packages/protocol/src/inbox-conversations.ts').InboxConversation[]}; attention?: () => AttentionItem[] };
export type DashboardView = 'home' | 'tasks' | 'inbox' | 'projects' | 'questions';
const label = (value: string, max = 100) => value.replace(/\s+/g, ' ').trim().slice(0, max);

const dashboardAliases = new Map(Object.entries({
  dashboard: 'home', home: 'home', 工作台: 'home', 主页: 'home',
  tasks: 'tasks', 进展: 'tasks', 总览: 'tasks', inbox: 'inbox', 收件箱: 'inbox',
  main: 'main', 主对话: 'main', list: 'conversations', 对话: 'conversations',
  stop: 'stop', 停止: 'stop', 停: 'stop', modellist: 'modellist', status: 'status', 状态: 'status', today: 'today', 今日: 'today', 今天: 'today', help: 'help', 帮助: 'help',
} as const));

// Match the whole message so commands embedded in a question stay in the conversation.
export function dashboardCommand(text: string) {
  const value = text.trim().toLowerCase();
  if (value === '工作台') return 'home';
  if (/^[/／]/u.test(value)) return dashboardAliases.get(value.slice(1));
}

// These common words and CLI commands are legal input even if they resemble a workbench command.
const literalWords = new Set(['stats', 'star', 'stat', 'man', 'min', 'task', 'session', 'hoe', 'hep', 'lit', 'gent']);
const scopedCommands = [...dashboardAliases].filter(([, view]) => view === 'status' || view === 'stop' || view === 'help').map(([name]) => name);
const globalCommands = [...dashboardAliases.keys(), 'agent', 'agents', 'start', '开工', 'modelchange', 'new', '新对话'];

function isCommandSlip(typed: string, command: string) {
  // Only a missing letter or a single adjacent transposition qualifies. Check ASCII names only.
  if (!/^[a-z]+$/.test(command) || Math.abs(typed.length - command.length) > 1) return false;
  let i = 0;
  while (i < typed.length && typed[i] === command[i]) i++;
  if (typed.length === command.length - 1) return typed.slice(i) === command.slice(i + 1);
  return typed.length === command.length && i + 1 < typed.length && typed[i] === command[i + 1]
    && typed[i + 1] === command[i] && typed.slice(i + 2) === command.slice(i + 2);
}

export function privateCommandText(text: string, options: { global: boolean; sessions: boolean }): { text: string; suggestion?: string } {
  const match = /^(\s*)([/／])([/／]?)([^\s/／]+)(?=\s|$)/u.exec(text);
  if (!match) return { text };
  const word = match[4].toLowerCase();
  const commands = options.global ? (options.sessions ? [...globalCommands, 'sessions'] : globalCommands) : scopedCommands;
  const known = commands.includes(word);
  const slips = !known && !literalWords.has(word) ? commands.filter(name => isCommandSlip(word, name)) : [];
  const suggestion = slips.length === 1 ? '/' + slips[0] : undefined;
  if (match[3] && (known || suggestion)) return { text: match[1] + text.slice(match[1].length + 1) };
  if (!match[3] && suggestion && !text.slice(match[0].length).trim()) return { text, suggestion };
  return { text };
}

export function dashboardHelp(sessions: boolean, scoped = false) {
  const status = '/status 或 /状态：查看当前会话状态';
  const stop = '/stop 或 /停止、/停：请求中断当前轮次';
  const text = scoped ? [status, stop].join('\n') : ['/home 或「工作台」：打开工作台', '/tasks 或 /进展：查看任务进展', '/inbox 或 /收件箱：查看收件',
    '/agents [关键词] 或 /agent：查找执行会话', '/start [目标] 或 /开工：填写并提交执行表单', '群内 @ 本机器人发送 /ai 任务：建立待办，在主话题群或主人私聊承接', '在群里发送 /topics 登记话题群，/topics home 设主群，/topics off 退出', '引用任务回报预览发送 /noreply：取消向原群回报', '/list 或 /对话：列出可切换的对话', '/new 或 /新对话：开启独立对话，可在命令后直接写第一条消息', '/main 或 /主对话：切回主 Agent', '/modellist：查看当前对话的模型目录', '/modelchange <模型 ID>：切换当前对话模型', status, stop, '/today 或 /今日、/今天：查看今日简报', ...(sessions ? ['/sessions：查看 CLI 会话'] : []), '/help 或 /帮助：查看命令'].join('\n');
  const help = text + '\n在工作台对话中发送命令原文可再加一个斜杠，例如 //status。';
  return { text: help, card: cardDocument('工作台命令', cardSection('在此私聊中发送', help)) };
}

export function conversationListDashboard(app: DashboardApp, bot: { conversationId: string; id: string; appId: string; revision: number; chatId: string },
  navigation: string, webBase?: string, requestedPage = 0, history: { threadId: string; title: string; latestAt: string; tags?: string[] }[] = []) {
  type Row = { projectId: string; name: string; tags?: string[]; latest?: Message; conversationThreadId?: string; latestAt?: string };
  const main: Row = { projectId: '', name: '主对话' };
  const rows = new Map<string, Row>([[bot.conversationId, main]]);
  if (app.projectWorkspace) for (const project of app.store.list<Project>('projects')) {
    if (!project.archivedAt) rows.set('project:' + project.id + ':work', { projectId: project.id, name: project.name });
  }
  for (const message of app.store.list<Message>('messages')) {
    const row = rows.get(message.conversationId);
    if (!row || message.readOnly || message.todoId || (message.projectId && message.projectId !== row.projectId)
      || (message.origin && message.origin !== 'user') || !message.text.trim()
      || (message.role !== 'user' && !(message.role === 'assistant' && (message.status === 'done' || message.status === 'failed')))) continue;
    if (row === main) {
      // Bot conversations may also receive groups and relays. Only preview this owner's private thread.
      const input = message.role === 'user' ? message.id : message.replyTo;
      const route = input && app.store.get<{ botId: string; accountId: string; revision: number; target: string; group?: unknown; relay?: unknown }>('message.routes', input);
      if (!route || route.botId !== bot.id || route.accountId !== bot.appId || route.revision !== bot.revision
        || route.target !== bot.chatId || route.group || route.relay) continue;
    }
    if (!row.latest || message.createdAt >= row.latest.createdAt) row.latest = message;
  }
  const independent: Row[] = history.map(thread => ({ projectId: '', name: '独立对话 · ' + thread.title,
    conversationThreadId: thread.threadId, latestAt: thread.latestAt, tags: thread.tags }));
  const byTime = [...rows.values(), ...independent].sort((a, b) => (b.latest?.createdAt ?? b.latestAt ?? '').localeCompare(a.latest?.createdAt ?? a.latestAt ?? ''));
  // Keep main/project entries in their existing slots while applying the owner's independent conversation order.
  let independentIndex = 0;
  const entries = byTime.map(row => row.conversationThreadId ? independent[independentIndex++] : row);
  const pages = Math.ceil(entries.length / 5), page = Math.min(requestedPage, pages - 1);
  const elements: Record<string, unknown>[] = [], lines = ['最近对话'];
  const visible = entries.slice(page * 5, page * 5 + 5);
  for (const row of visible) {
    const latest = row.latest;
    const labels = row.tags?.length ? '标签：' + row.tags.map(tag => publicText(tag, 32)).join('、') : '';
    const detail = [publicText(row.name, 60), labels, latest?.createdAt ?? row.latestAt, latest && publicText(latest.text, 100).replace(/\s+/g, ' ')].filter(Boolean).join(' · ');
    lines.push(detail);
    elements.push({ tag: 'div', text: cardPlain(detail) }, ...cardButtons([
      { label: '在这里聊', value: { kind: 'workbench.chat', navigation, projectId: row.projectId, ...(row.conversationThreadId && { conversationThreadId: row.conversationThreadId }) } },
      ...(row.projectId ? [{ label: '打开网页版', route: 'projects/' + encodeURIComponent(row.projectId) + '/workspace' }] : []),
    ], cardWebBase(webBase)));
  }
  const pageButton = (label: string, page: number) => ({ label, value: { kind: 'workbench.navigate', navigation, view: 'conversations', page } });
  const position = `${page + 1} / ${pages} 页 · 共 ${entries.length} 个对话`;
  lines.push(position);
  elements.push({ tag: 'note', elements: [cardPlain(position)] }, ...cardButtons([
    ...(page > 0 ? [pageButton('上一页', page - 1)] : []),
    ...(page + 1 < pages ? [pageButton('下一页', page + 1)] : []), pageButton('刷新当前页', page),
  ]));
  return { text: lines.join('\n'), card: cardDocument('最近对话', elements), projectIds: visible.map(row => row.projectId).filter(Boolean), threadIds: visible.flatMap(row => row.conversationThreadId ? [row.conversationThreadId] : []) };
}

export function modelListDashboard(catalog: ReturnType<NonNullable<FeishuBotsApp['modelCatalog']>> | undefined, allowed: boolean, title = '主对话模型目录') {
  const lines: string[] = [];
  const safe = (value: string) => publicText(value, 256).replace(/\s+/g, ' ');
  if (!allowed) lines.push('请发送 /main 切回主对话，再直接发送 /modellist。');
  else if (!catalog) lines.push('模型目录服务不可用。');
  else {
    if (catalog.demo) lines.push('当前处于演示模式。');
    const sources: Record<string, string> = { builtin: '内置模型目录', configured: '当前配置', automatic: '运行时自动选择' };
    lines.push('提供方 · ' + (safe(catalog.provider) || '未配置'), '当前模型 · ' + (safe(catalog.current) || '未配置'),
      '目录来源 · ' + (Object.hasOwn(sources, catalog.source) ? sources[catalog.source] : '未知'), '候选模型');
    const custom = new Set(catalog.custom);
    const models = [...new Set(catalog.models)].filter(Boolean);
    const hint = '账号权限以提供方实际授权为准。';
    const truncated = '目录较长，请在 Web 的模型设置中查看完整目录。';
    // Reserve space for both footers so a Chinese catalog and the text fallback share one byte limit.
    let bytes = Buffer.byteLength([title, ...lines, truncated, hint].join('\n'));
    for (const model of models) {
      const line = '• ' + safe(model) + (custom.has(model) ? '（最近使用）' : '');
      bytes += Buffer.byteLength('\n' + line);
      if (bytes > 16000) { lines.push(truncated); break; }
      lines.push(line);
    }
    if (!models.length) lines.push('暂无候选模型。');
    lines.push(hint);
  }
  const text = lines.join('\n');
  return { text: title + '\n' + text, card: cardDocument(title, [{ tag: 'div', text: cardPlain(text) }]) };
}

export function statusDashboard(target: string, status: ConversationStatus | string) {
  const lines = [target];
  if (typeof status === 'string') lines.push(status);
  else {
    const phases = { no_records: '没有会话记录', idle: '空闲', working: '处理中', waiting: '等待处理', failed: '失败', unknown: '运行状态未知' };
    lines.push('状态 · ' + phases[status.phase]);
    if (status.goal) lines.push('目标 · ' + label(status.goal, 400));
    if (status.lastMessage) {
      const last = status.lastMessage;
      lines.push('最近消息 · ' + (last.role === 'user' ? '用户' : '助手') + ' · ' + last.at + '\n' + last.text + (last.truncated ? '…' : ''));
    }
    const pending = status.pending;
    const kinds = { question: '问题', permission: '权限', plan: '计划', review: '验收' };
    lines.push('待处理 · ' + pending.total + ' 项' + (pending.truncated ? '（仅显示部分）' : ''),
      ...pending.items.map(item => '• ' + kinds[item.kind] + ' · ' + label(item.title, 200)));
  }
  const text = lines.join('\n');
  return { text: '当前会话状态\n' + text, card: cardDocument('当前会话状态', [{ tag: 'div', text: cardPlain(text) }]) };
}

export function todayDashboard(brief: TodayBrief | string, navigation: string) {
  const elements: Record<string, unknown>[] = [], lines: string[] = [];
  function section(title: string, text: string) {
    elements.push(...cardSection(title, text));
    lines.push(title + '\n' + text);
  }
  if (typeof brief === 'string') section('今日简报', brief);
  else {
    const today = brief.date;
    section('今日简报', today + ' · ' + brief.timezone);
    const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: brief.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: brief.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    function time(iso?: string) {
      if (!iso || !Number.isFinite(Date.parse(iso))) return '';
      const date = new Date(iso), local = day.format(date);
      return (local === today ? '' : local + ' ') + clock.format(date);
    }
    const activity: Record<string, string> = { todo: '待办完成', completed: '执行结束', running: '正在执行', queued: '排队中' };
    function facts(title: string, source: TodaySection) {
      const count = (source.truncated ? '至少 ' : '') + source.total + ' 项';
      const rows = source.items.slice(0, 3).map(item => {
        const allDay = item.kind === 'calendar' && /^\d{4}-\d{2}-\d{2}$/.test(item.at);
        const start = time(item.at), end = time(item.endAt);
        const when = allDay ? '全天' : start && start + (end ? '–' + end : '');
        return '• ' + [when, activity[item.kind], label(item.title), item.reason && label(item.reason, 80)].filter(Boolean).join(' · ');
      });
      if (source.total > rows.length || source.truncated) rows.push('仅显示部分记录。');
      section(title, [count, ...rows].join('\n'));
    }
    facts('待你决定', brief.decisions);
    facts('收件箱', brief.inbox);
    facts('提及', brief.mentions);
    facts('今日完成与执行结束', brief.completed);
    facts('失败', brief.failed);
    facts('当前执行', brief.running);
    if (brief.calendar.available) facts('日历 · 已读取', brief.calendar);
    else section('日历', '来源不可用 · ' + label(brief.calendar.reason || '当前未接入日历'));
  }
  lines.push('发送 /home 返回工作台。');
  elements.push(...cardButtons([{ label: '返回工作台', value: { kind: 'workbench.navigate', navigation, view: 'home', page: 0 } }]));
  return { text: lines.join('\n\n'), card: cardDocument('今日简报', elements) };
}

/** Owner-only, read-only views. Callback buttons refresh this card; URL buttons navigate to Web. */
export function buildFeishuDashboard(app: DashboardApp, webBase?: string, options: {
  view?: DashboardView; page?: number; navigation?: string; now?: Date; canViewQuestion?: (card: Card) => boolean;
} = {}) {
  const elements: Record<string, unknown>[] = [], lines: string[] = [];
  const base = cardWebBase(webBase), view = options.view ?? 'home';
  const section = (title: string, text: string) => { elements.push(...cardSection(title, text)); lines.push(title + '\n' + text); };
  const buttons = (entries: Array<[string, string]>) => elements.push(...cardButtons(entries.map(([text, route]) => ({ label: text, route })), base));
  const projects = new Map(app.store.list<Project>('projects').map(p => [p.id, p.name]));
  const tasks = new Map(app.store.list<Todo>('todos').map(t => [t.id, t]));
  const machines = app.store.list<MachineInfo>('machines');
  const runs = app.store.list<Run>('runs').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const waiting = (app.attention?.() ?? []).filter(item => {
    if (item.type === 'inbox') return false;
    if (item.type !== 'interaction' || !options.canViewQuestion) return true;
    const card = app.store.get<Card>('interactions',item.id.slice('interaction:'.length));
    return !!card && options.canViewQuestion(card);
  });
  const working = runs.filter(r => r.status === 'running' || r.status === 'queued');
  const review = runs.filter(r => r.status === 'completed' && r.todoId && tasks.has(r.todoId) && !tasks.get(r.todoId)?.completedAt);
  const issues = runs.filter(r => r.status === 'failed' || r.status === 'unknown');
  const rawInbox = app.store.list<InboxItem>('inbox').filter(item => {
    if (item.todoId || item.archivedAt || item.tier === 'noise') return false;
    if (item.origin?.connector === '飞书' || item.source.startsWith('feishu:')) {
      const origin = item.origin;
      return origin?.kind === 'direct' || (origin?.kind === 'group' && origin.personalGroupObserved === true && origin.personalGroupUserCount !== undefined && origin.personalGroupUserCount <= 50);
    }
    return true;
  });
  const people=app.inboxAssistant?.list();
  const covered=new Set((people??[]).flatMap(p=>p.messageIds));
  const inbox: Array<Pick<InboxItem,'title'|'text'|'tier'>>=[
    ...(people??[]).filter(p=>p.pendingCount&&p.status!=='quiet').map(p=>({title:p.title,text:[p.summary,p.question].filter(Boolean).join('\n')||'主 Agent 正在后台整理',tier:(p.status==='waiting_user'?'action':'fyi') as InboxItem['tier']})),
    ...rawInbox.filter(item=>!covered.has(item.id)),
  ];
  const action = inbox.filter(item => item.tier === 'action');
  const metrics = [
    ['进行中', String(working.length)], ['结束待验收', String(review.length)],
    [people?'待你回复':'需要处理', String(action.length)], [people?'后台跟进':'知会即可', String(inbox.length - action.length)],
  ];
  elements.push({ tag: 'div', fields: metrics.map(([title, value]) => ({ is_short: true, text: { tag: 'lark_md', content: `${title}\n**${value}**` } })) });
  elements.push({ tag: 'hr' });
  let total = 0, page = 0;
  const pageSize = 5;
  const questions = app.interactions && options.navigation ? app.store.list<Card>('interactions').filter(card =>
    card.kind === 'question' && card.status === 'open' && card.handler === 'user' && (!options.canViewQuestion || options.canViewQuestion(card)) &&
    cardAcceptsAnswer(card,options.now?.getTime() ?? Date.now())).sort((a,b) => a.createdAt.localeCompare(b.createdAt)) : [];
  if (view === 'home') {
    section('等你处理', waiting.length ? '等你拍板 · ' + waiting.length + ' 项\n' + waiting.slice(0, 3).map(a => '• ' + label(a.title)).join('\n') : '当前没有等你拍板的事。');
    if (options.navigation) elements.push(...cardButtons([{ label: '今日简报', value: { kind: 'workbench.today', navigation: options.navigation } }]));
    if (questions.length) elements.push(...cardButtons([{label:'待回答的问题（' + questions.length + '）',
      value:{kind:'workbench.navigate',navigation:options.navigation,view:'questions',page:0}}]));
    if (waiting.length > 3) section('更多待决定', `还有 ${waiting.length - 3} 项，请打开主对话核对。`);
    if (app.agentSessions && options.navigation) elements.push(...cardButtons([{label:'查看 CLI 会话',value:{kind:'workbench.readSessions',navigation:options.navigation}}]));
    section('此刻', `Agent 执行 · ${working.length} 项进行中 · ${review.length} 项执行结束待验收 · ${issues.length} 项失败或结果未知\n收件箱 · ${action.length} 条需处理 · ${inbox.length - action.length} 条知会\n电脑 · ${machines.filter(m => m.online).length} / ${machines.length} 台在线`);
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
  } else if (view === 'questions') {
    total = questions.length;
    page = Math.min(Math.max(0, options.page ?? 0), Math.max(0, Math.ceil(total / pageSize) - 1));
    if (!total) section('待回答的问题','目前没有需要你回答的问题。');
    for (const question of questions.slice(page * pageSize, (page + 1) * pageSize)) {
      section(question.wait === false ? '可稍后回答' : '待回答',label(question.title) + '\n' + label(question.body,200));
      elements.push(...cardButtons([{label:'回答这个问题',value:{kind:'workbench.questionForm',navigation:options.navigation,id:question.id,version:question.version}}]));
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
    const latest = new Map<string, Message>();
    const conversations = new Set(activeProjects.map(p => `project:${p.id}:work`));
    for (const message of app.store.list<Message>('messages')) {
      if (!conversations.has(message.conversationId) || message.role !== 'assistant' || message.readOnly ||
          message.origin === 'notification' || !['done','failed'].includes(message.status ?? '') || !message.text.trim()) continue;
      const previous = latest.get(message.conversationId);
      if (!previous || previous.createdAt <= message.createdAt) latest.set(message.conversationId,message);
    }
    const activity = (project: Project) => latest.get(`project:${project.id}:work`)?.createdAt ?? '';
    activeProjects.sort((a,b) => activity(b).localeCompare(activity(a)));
    if (view === 'projects') {
      total = activeProjects.length;
      page = Math.min(Math.max(0,options.page ?? 0), Math.max(0, Math.ceil(total / pageSize) - 1));
    }
    const limit = view === 'home' ? 3 : pageSize;
    const rows = activeProjects.slice(page * pageSize, page * pageSize + limit);
    for (const project of rows) {
      const reply = latest.get(`project:${project.id}:work`);
      const machine = machines.find(m => m.id === project.workspace?.machineId);
      const summary = reply ? publicText(reply.text,140).replace(/\s+/g,' ') : '';
      const detail = [label(project.name), machine?.name && label(machine.name,64),
        summary && (reply?.status === 'failed' ? '上次回复失败 · ' : '') + summary].filter(Boolean).join('\n');
      section('项目 Agent', detail);
      elements.push(...cardButtons([{ label: '在这里聊', value: { kind: 'workbench.chat', projectId: project.id, navigation: options.navigation } }]));
    }
    if (view === 'home' && activeProjects.length > limit) elements.push(...cardButtons([{ label:'全部项目',value:{kind:'workbench.navigate',navigation:options.navigation,view:'projects',page:0} }]));
    elements.push(...cardButtons([{ label: '切回主 Agent', value: { kind: 'workbench.chat', projectId: '', navigation: options.navigation } }]));
  }
  if (view === 'home') {
    if (action.length) section('来信摘要', action.slice(0, 3).map(item => '• ' + label(item.title)).join('\n') + (action.length > 3 ? `\n还有 ${action.length - 3} 条，可在收件箱查看。` : ''));
    for (const run of working.slice(0, 2)) {
      section('正在推进', label(run.prompt));
      buttons([['查看执行', `projects/${encodeURIComponent(run.projectId && projects.has(run.projectId) ? run.projectId : 'all')}/runs/${encodeURIComponent(run.id)}`]]);
    }
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
  const title = `${date} · ${view === 'home' ? '今日工作台' : view === 'tasks' ? '任务进展' : view === 'projects' ? '项目 Agent' : view === 'questions' ? '待回答的问题' : '收件箱'}`;
  return { text: lines.join('\n\n'), card: cardDocument(title, elements),
    ...(view === 'questions' && { questionRows:questions.slice(page * pageSize, (page + 1) * pageSize).map(q => ({id:q.id,version:q.version})) }) };
}

export function deadlineInfo(question: Pick<Card,'decisionDeadlineAt'|'reversible'|'deadlineRemindedAt'|'wait'|'contextRequestedAt'>) {
  const deadline = new Date(question.decisionDeadlineAt!);
  if (!Number.isFinite(deadline.getTime())) return '';
  const time = deadline.toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) + '（北京时间）';
  if (question.contextRequestedAt) return '原决定截止时间 ' + time + '。已暂停到期默认选择，请阅读背景后亲自回答。';
  if (question.deadlineRemindedAt) return '已过决定截止时间 ' + time + '，仍需你亲自回答。';
  if (question.wait === false) return '决定截止时间 ' + time + '。若期间在原对话另发消息，到期将关闭提问。' + (question.reversible ? '若未另发消息或答卡，到期将采用每题的推荐选项。' : '若未另发消息或答卡，到期只提醒一次，仍需你亲自决定。');
  return '决定截止时间 ' + time + (question.reversible ? '，届时未回答将采用每题的推荐选项。' : '，届时未回答只提醒一次，仍需你亲自决定。');
}
const compactQuestion = (question: Card) => question.questions?.length === 1 && !question.questions[0].multiSelect && question.questions[0].options.length <= 4
  && question.questions[0].options.every(option => [...option.label].length <= 30);
export function questionForm(question: Card, navigation: string, webBase?: string, allowContext = false) {
  const later = '这道题可稍后回答。你可以继续在原对话聊天；要回答这张卡时，请通过表单提交。';
  const deadline = question.decisionDeadlineAt && deadlineInfo(question);
  const submit = {kind:'workbench.answerQuestion',navigation,id:question.id,version:question.version};
  const callback = (value: Record<string, unknown>) => [{type:'callback',value}];
  const back = {tag:'button',text:cardPlain('返回问题列表'),behaviors:callback({kind:'workbench.navigate',navigation,view:'questions',page:0})};
  const close = {tag:'button',text:cardPlain('关闭提问'),behaviors:callback({...submit,kind:'workbench.closeQuestion'})};
  const build = (elements: Record<string, unknown>[]) => ({schema:'2.0',header:{template:'orange',title:cardPlain(question.wait === false ? '可稍后回答的问题' : '回答 Agent 的问题')},body:{elements:[...(deadline ? [{tag:'div',text:cardPlain(deadline)}] : []), ...elements, ...(question.wait === false ? [close] : []), back]}});
  const web = () => {
    const base = cardWebBase(webBase);
    const tip = '问题内容超过飞书表单容量。请打开 Web 工作台，在主对话的「等你处理」找到这道题并回答。';
    return {acceptsAnswer:false, card:build([{tag:'div',text:cardPlain([...question.title].slice(0,200).join(''))},{tag:'div',text:cardPlain(tip)}, ...(base ? [{tag:'button',text:cardPlain('打开 Web 主对话'),behaviors:[{type:'open_url',default_url:base+'#chat?interaction='+encodeURIComponent(question.id)}]}] : [])])};
  };
  if ((question.questions?.length ?? 0) > 6 || question.questions?.some(q => q.options.length > 20)) return web();
  const elements: Record<string, unknown>[] = [question.title, question.body].filter(Boolean).map(text => ({tag:'div',text:cardPlain(text)}));
  if (question.wait === false) elements.push({tag:'div',text:cardPlain(later)});
  if (question.contextRequestedAt && question.decisionExplanation)
    elements.push({tag:'div',text:cardPlain(publicText(question.decisionExplanation,2400))});
  else if (allowContext && question.runId && question.decisionDeadlineAt && !question.contextRequestedAt)
    elements.push({tag:'button',text:cardPlain('先告诉我背景'),behaviors:callback({...submit,kind:'workbench.questionContext'})});
  const fields: Record<string, unknown>[] = [];
  const input = (name: string, hint: string) => ({tag:'input',name,width:'fill',input_type:'multiline_text',rows:2,max_length:1000,placeholder:cardPlain(hint)});
  const compact = compactQuestion(question);
  if (!question.questions) fields.push({...input('answer','输入你的回答'),required:true});
  else for (const [i,q] of question.questions.entries()) {
    const shortLabel = (label:string) => [...label].length + 4 <= (compact ? 30 : 60);
    const recommendation = q.recommend && (!compact || !shortLabel(q.recommend)) && '推荐选项：' + q.recommend;
    const heading = [q.header, q.question, recommendation, ...q.options.filter(o=>o.description).map(o => o.label + '：' + o.description)].filter(Boolean).join('\n');
    const prompt = {tag:'div',text:cardPlain(heading)};
    const optionLabel = (label: string) => label === q.recommend && shortLabel(label) ? label + '（推荐）' : label;
    if (compact) {
      elements.push(prompt, ...q.options.map((o,j) => ({tag:'button',text:cardPlain(optionLabel(o.label)),behaviors:callback({...submit,pick:String(j)})})));
    } else {
      fields.push(prompt);
      if (q.options.length) fields.push({tag:q.multiSelect?'multi_select_static':'select_static',name:'q'+i,width:'fill',
        placeholder:cardPlain(q.multiSelect?'可选择多项':'选择一项'),options:q.options.map((o,j)=>({text:cardPlain(optionLabel(o.label)),value:String(j)}))});
    }
    fields.push(input('t'+i, q.options.length?'也可填写自己的回答':'填写回答'));
  }
  fields.push({tag:'button',name:'submit_answer',form_action_type:'submit',type:'primary',text:cardPlain('发送回答'),behaviors:callback(submit)});
  elements.push({tag:'form',name:'answer_question',elements:fields});
  const card = build(elements);
  return Buffer.byteLength(JSON.stringify(card)) <= 24000 ? {card, acceptsAnswer:true} : web();
}

// Callback values are only indexes. Labels and question order always come from the versioned stored card.
export function parseQuestionForm(question: Card, fields: Record<string, unknown>, pick?: unknown): string | QuestionResponse[] {
  if (!question.questions) {
    const answer = fields.answer;
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 1000) throw new Error('请填写回答，最多 1000 字。');
    return answer.trim();
  }
  if (pick !== undefined && !compactQuestion(question)) throw new Error('问题选项不匹配。');
  const names = new Set(question.questions.flatMap((_,i) => ['q'+i, 't'+i]));
  if (Object.keys(fields).some(k => !names.has(k))) throw new Error('表单字段已变化，请重新打开问题。');
  return question.questions.map((q,i) => {
    const raw = pick === undefined ? fields['q'+i] : pick;
    const tokens = raw === undefined || raw === null || raw === '' ? [] : Array.isArray(raw) ? raw : [raw];
    if (tokens.length > q.options.length || (!q.multiSelect && tokens.length > 1) || new Set(tokens).size !== tokens.length)
      throw new Error('请核对所选选项。');
    const selected = tokens.map(token => {
      if (typeof token !== 'string' || !/^(0|[1-9][0-9]*)$/.test(token) || !q.options[Number(token)]) throw new Error('选项已变化，请重新打开问题。');
      return q.options[Number(token)].label;
    });
    const text = fields['t'+i] ?? '';
    if (typeof text !== 'string' || [...text].length > 1000) throw new Error('每题自填回答最多 1000 字。');
    if (!selected.length && !text.trim()) throw new Error('请回答每一道题后再提交。');
    return {selected,...(text.trim() && {text:text.trim()})};
  });
}

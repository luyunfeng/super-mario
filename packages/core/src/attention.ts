import type { ChannelContribution } from '../../plugin-sdk/src/index.ts';
import type { InboxConversation } from '../../protocol/src/inbox-conversations.ts';
import { excludesPersonalGroupFromBrief } from '../../protocol/src/inbox-origin.ts';
import type { Approval, QuestionItem, InboxItem, InboxOrigin, JsonObject, MailboxEntry, Project, FeishuBot } from '../../protocol/src/index.ts';
import { ownerReviewLink } from './todo-link.ts';
import type { PendingOwnerReview } from './run-review.ts';
import type { Plan } from './plans.ts';

/** Read-only projection; action bodies are versioned descriptions, never executed here. */
export interface AttentionAction {
  label: string;
  path: string;
  method: 'POST';
  body: JsonObject;
  requiresText?: boolean;
  highRisk?: boolean;
}
export interface AttentionItem {
  origin?: InboxOrigin;
  questions?: QuestionItem[];
  wait?: boolean;
  delegationError?:string;
  delegationRequestedAt?: string; decisionAssumption?: string; ownerConfirmation?: string;
  runId?: string; contextRequestedAt?: string; decisionExplanation?: string;
  decisionDeadlineAt?: string; reversible?: boolean; deadlineRemindedAt?: string;
  id: string;
  type: 'approval' | 'interaction' | 'inbox' | 'plan' | 'review';
  evidenceVersion?:string;
  version: number;
  title: string;
  context: string;
  detail: string;
  source: string;
  createdAt: string;
  projectId?: string;
  projectName?: string;
  todoId?: string;
  highRisk?: boolean;
  editable?: boolean;
  route?: { href: string; label: string };
  actions: AttentionAction[];
}
// Structural input avoids coupling this projection to interaction service internals.
interface InteractionInput {
  error?:string;
  questions?: QuestionItem[];
  wait?: boolean;
  delegationRequestedAt?: string; decisionAssumption?: string; ownerConfirmation?: string;
  runId?: string; contextRequestedAt?: string; decisionExplanation?: string;
  decisionDeadlineAt?: string; reversible?: boolean; deadlineRemindedAt?: string;
  id: string; version: number; title: string; body: string; status: string;
  handler?: string; kind?: string; createdAt: string; projectId?: string;
  route?: AttentionItem['route']; suggestion?: string; userNotifiedAt?: string; todoId?: string;
}
interface AttentionInput {
  reviews?: readonly PendingOwnerReview[];
  inboxConversations?: readonly InboxConversation[];
  approvals?: readonly Approval[];
  interactions?: readonly InteractionInput[];
  inbox?: readonly InboxItem[];
  plans?: readonly Pick<Plan, 'id' | 'title' | 'version' | 'status' | 'tasks' | 'createdAt'>[];
  mailboxes?: readonly MailboxEntry[];
  projects?: readonly Project[];
  bots?: readonly Pick<FeishuBot, 'id' | 'name'>[];
  channels?: readonly ChannelContribution[];
}

export function* actionableInbox({ inbox = [], inboxConversations = [], mailboxes = [], channels }: AttentionInput) {
  const covered = new Set(inboxConversations.flatMap(group => group.messageIds));
  const mailboxByResultId = new Map<string, MailboxEntry>();
  for (const entry of mailboxes) {
    if (entry.direction === 'inbox' && entry.resultId && !mailboxByResultId.has(entry.resultId)) {
      mailboxByResultId.set(entry.resultId, entry);
    }
  }
  for (const item of inbox) {
    if (covered.has(item.id) || item.tier !== 'action' || item.archivedAt || excludesPersonalGroupFromBrief(item)) continue;
    const matchedChannel = channels?.find(channel => item.source.startsWith(channel.sourcePrefix ?? `${channel.id}:`));
    const allowedSource = item.source.startsWith('plugin:')
      || (channels !== undefined
        ? Boolean(matchedChannel)
        : /^[a-z0-9][a-z0-9_-]*:/i.test(item.source) && !/^demo:/i.test(item.source));
    if (!allowedSource) continue;
    // Mailbox records only enrich source context. They are not another copy of the
    // same message and do not create unsupported mailbox-to-todo actions.
    const linked = mailboxByResultId.get(item.id);
    const projectId = item.projectId ?? (linked && 'projectId' in linked.scope ? linked.scope.projectId : undefined);
    yield { item, matchedChannel, projectId };
  }
}

export function collectAttention({ reviews = [], inboxConversations = [], approvals = [], interactions = [], inbox = [], mailboxes = [], projects = [], bots = [], plans = [], channels }: AttentionInput = {}): AttentionItem[] {
  const rows: AttentionItem[] = [];
  const projectNames = new Map(projects.map(project => [project.id, project.name]));
  const project = (projectId?: string) => projectId ? { projectId, projectName: projectNames.get(projectId) } : {};
  const action = (collection: string, id: string, operation: string, version: number, label: string): AttentionAction => ({
    label, path: `/${collection}/${encodeURIComponent(id)}/${operation}`, method: 'POST', body: { version },
  });
  for (const item of reviews) {
    const {todoId,runId,version,evidenceVersion}=item;
    rows.push({id:'review:'+todoId,type:'review',todoId,runId,version,evidenceVersion,title:item.title,context:'交付待你验收',
      detail:'完成标准：'+item.doneWhen+'\n证据来源：'+item.resultSource,source:'执行交付',createdAt:item.createdAt,...project(item.projectId),
      route:ownerReviewLink(item),actions:[]});
  }
  for (const item of approvals) {
    if (item.status !== 'pending') continue;
    // Plugin actions have unknown side effects. Explicit risk metadata and destructive
    // commands also require confirmation; ordinary task dispatch remains one click.
    const command = [item.title, item.details, item.params.command, item.params.prompt, item.params.text].filter(value => typeof value === 'string').join('\n');
    const highRisk = item.params.highRisk === true || item.params.risk === 'high' || item.kind.startsWith('plugin:')
      || /\brm\s+-[a-z]*[rf]|\bdrop\s+(table|database)\b|\bgit\s+(reset\s+--hard|push\s+.*--force)|删除|清空|放宽权限|免审批/i.test(command);
    rows.push({ id: `approval:${item.id}`, type: 'approval', version: item.version,
      title: item.title, context: '等待你批准这次操作',
      ...(item.kind === 'input' && item.params.fixedInput === true && { editable: false }),
      // Show the actual user-facing payload, not just a proposal's description.
      // Internal relation keys are intentionally not copied into visible details.
      detail: [item.details, item.kind === 'dispatch' && typeof item.params.model === 'string' && item.params.model && '指定模型：' + item.params.model, ...(['prompt', 'text', 'command', 'cwd', 'doneWhen'] as const).flatMap(key => {
        const value = item.params[key];
        const labels = { prompt: '执行目标', text: '发送内容', command: '执行命令', cwd: '工作目录', doneWhen: '完成标准' };
        return typeof value === 'string' && value ? [`${labels[key]}：${value}`] : [];
      })].filter(Boolean).join('\n\n'), source: 'Agent', createdAt: item.createdAt,
      ...project(typeof item.params.projectId === 'string' ? item.params.projectId : undefined), highRisk,
      actions: [{ ...action('approvals', item.id, 'approve', item.version, '批准'), highRisk }, action('approvals', item.id, 'reject', item.version, '拒绝')] });
  }
  for (const item of interactions) {
    // Notification history does not change the current owner. An automatic stage
    // must finish/escalate before its question counts as requiring a human.
    if (item.status !== 'open' || (item.handler !== undefined && item.handler !== 'user')) continue;
    const highRisk = item.kind === 'permission';
    const canAnswerLater = item.kind === 'question' && item.wait === false;
    const runQuestion = item.kind === 'question' && !!item.runId && !!item.decisionDeadlineAt;
    const confirm = (accept:boolean,label:string) => ({...action('interactions',item.id,'confirm-delegation',item.version,label), body:{version:item.version,accept}});
    rows.push({ id: `interaction:${item.id}`, type: 'interaction', version: item.version, ...(item.questions && { questions: item.questions }), ...(canAnswerLater && { wait: false }),
      ...(item.runId && {runId:item.runId}),
      ...(item.delegationRequestedAt && {delegationRequestedAt:item.delegationRequestedAt,decisionAssumption:item.decisionAssumption,ownerConfirmation:item.ownerConfirmation,
        ...(item.error && {delegationError:'督办尚无可核实的选择，请在原卡作答。'})}),
      ...(item.contextRequestedAt && {contextRequestedAt:item.contextRequestedAt,decisionExplanation:item.decisionExplanation}),
      ...(item.decisionDeadlineAt && {decisionDeadlineAt:item.decisionDeadlineAt,reversible:item.reversible,
        ...(item.deadlineRemindedAt && {deadlineRemindedAt:item.deadlineRemindedAt})}),
      ...(item.todoId && { todoId: item.todoId }), ...(item.route && { route: item.route }), title: item.title, context: canAnswerLater ? '可继续聊天，稍后回到这张卡回答。' : '等待你的回答', detail: [item.body, item.suggestion ? `建议回答：${item.suggestion}` : ''].filter(Boolean).join('\n\n'),
      source: 'Agent', createdAt: item.createdAt, ...project(item.projectId), highRisk,
      actions: [{ ...action('interactions', item.id, 'answer', item.version, '回答'), requiresText: true, highRisk },
        ...(runQuestion && !item.delegationRequestedAt ? [action('interactions', item.id, 'delegate', item.version, '你来定')] : []),
        ...(runQuestion && item.ownerConfirmation ? [confirm(true,'是，采用列出的推荐'),confirm(false,'否，我自己选')] : []),
        ...(runQuestion && !item.contextRequestedAt ?
          [action('interactions', item.id, 'context', item.version, '先告诉我背景')] : []),
        ...(runQuestion ?
          [action('interactions', item.id, 'mismatch', item.version, '这不是我要的')] : []),
        ...(canAnswerLater ? [action('interactions', item.id, 'withdraw', item.version, '关闭提问')] : [])] });
  }
  // A proposed plan starts real work only after the owner confirms it; starting is the explicit decision.
  const estimateLabels = {default:'默认估时',learned:'历史估时',override:'显式指定'};
  for (const item of plans) {
    if (item.status !== 'pending') continue;
    const taskProject = item.tasks.find(task => task.projectId)?.projectId;
    rows.push({ id: `plan:${item.id}`, type: 'plan', version: item.version, title: item.title,
      context: `等待你确认开始，共 ${item.tasks.length} 项任务`,
      detail: item.tasks.map((task, index) => `${index + 1}. ${task.prompt}\n   完成标准：${task.doneWhen}；预计 ${task.expectMinutes} 分钟${task.estimateSource ? '（'+estimateLabels[task.estimateSource]+'）' : ''}${task.estimateSource === 'learned' && task.estimateEvidence ? '，依据 '+task.estimateEvidence.sampleCount+' 个已验收样本' : ''}${task.model ? `；指定模型：${task.model}` : ''}${task.cwd ? `；目录：${task.cwd}` : ''}`).join('\n'),
      source: 'Agent', createdAt: item.createdAt, ...project(taskProject),
      actions: [action('plans', item.id, 'start', item.version, '开始执行'), action('plans', item.id, 'reject', item.version, '拒绝')] });
  }
  for (const group of inboxConversations) if(group.status==='waiting_user'&&group.question)rows.push({
    id:`conversation:${group.id}`,type:'inbox',version:group.version,title:group.title,context:'主 Agent 已合并上下文，需要你回复',
    detail:[group.summary,group.question].filter(Boolean).join('\n\n'),source:'主 Agent · 收件整理',createdAt:group.latestAt,...project(group.projectId),
    actions:[],route:{href:`#inbox?conversation=${encodeURIComponent(group.id)}`,label:'查看合并会话并回复'},
  });
  for (const { item, matchedChannel, projectId } of actionableInbox({ inbox, inboxConversations, mailboxes, channels })) {
    rows.push({ id: `inbox:${item.id}`, type: 'inbox', version: item.version, title: item.title,
      context: item.todoId ? '这条消息已关联待办，可忽略更新' : '把这条消息转成待办，或忽略',
      detail: [item.text, item.reason].filter(Boolean).join('\n\n'), source: item.origin?.connector || matchedChannel?.name || (item.source.startsWith('plugin:') ? '插件消息' : '外部渠道'), origin: item.origin, createdAt: item.receivedAt || item.updatedAt,
      ...project(projectId), actions: [...(item.todoId ? [] : [action('inbox', item.id, 'confirm', item.version, '转成待办')]), action('inbox', item.id, 'archive', item.version, '忽略')] });
  }
  // Robot event mail is another channel source, not a fourth user-facing entity.
  // Unmarked input must be classified before confirmation; no implicit global route.
  const mailboxChannelName = channels?.[0]?.name || '飞书';
  const inboxIds = new Set(inbox.map(entry => entry.id));
  const botById = new Map(bots.map(bot => [bot.id, bot]));
  for (const item of mailboxes) {
    if (item.status !== 'pending' || !item.requiresConfirmation || (item.resultId && inboxIds.has(item.resultId))) continue;
    const unmarked = item.scope.kind === 'unmarked';
    const projectId = 'projectId' in item.scope ? item.scope.projectId : undefined;
    const bot = botById.get(item.botId);
    const outgoing = item.direction === 'outbox';
    rows.push({ id: `mailbox:${item.id}`, type: outgoing ? 'approval' : 'inbox', version: item.version, title: item.title,
      context: unmarked ? '先选择全局、项目或待办范围，再确认处理。' : outgoing ? '确认后由机器人发送，不以你的个人身份代发。' : '确认后交给 Agent 处理，不代表任务已完成。',
      detail: item.text, source: bot ? `${mailboxChannelName} · ${bot.name}` : `${mailboxChannelName}机器人`, origin: item.origin, createdAt: item.createdAt, ...project(projectId),
      ...(unmarked ? { route: { href: '#channels/advanced', label: '去归类' } } : {}),
      actions: [...(unmarked ? [] : [action('mailboxes', item.id, 'confirm', item.version, outgoing ? '确认发送' : '交给 Agent')]), action('mailboxes', item.id, 'reject', item.version, '拒绝')] });
  }
  // Stable, deterministic output without mutating any service-owned list.
  return [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

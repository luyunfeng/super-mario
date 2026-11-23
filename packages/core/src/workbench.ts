import { createFeishuWebConfig } from './feishu-web-config.ts';
import { createInboxAssistant, type InboxAnalysis } from './inbox-assistant.ts';
import { excludesPersonalGroupFromBrief } from '../../protocol/src/inbox-origin.ts';
import { createCommandProjectRouter } from './agent-runtime/command-project-router.ts';
import { createInboxClassifier } from './agent-runtime/inbox-classifier.ts';
import { createInboxHandlingRuntime } from './agent-runtime/inbox-handling.ts';
import { createInboxHandling, inboxHandlingApprovalKind } from './inbox-handling.ts';
import { createInboxHandlingSources } from './inbox-handling-source.ts';
import type { InboxHandlingSource, InboxHandlingAction } from '../../protocol/src/inbox-handling.ts';
import { enqueueMeetingMemory, meetingMemorySources } from './meeting-memory.ts';
import { createKnowledgeSourceApproval, knowledgeSourceApprovalKind } from './knowledge-source-approval.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createScheduledWorkService } from './scheduled-work-service.ts';
import { scheduledWorkApprovalKind } from './scheduled-work.ts';
import { authorizeWorkDecisionSource } from './work-decision-access.ts';
import { buildWorkContext } from './work-context.ts';
import { createKnowledgeSourceSettings } from './knowledge-source-settings.ts';
import { createReplyTracking } from './reply-tracking.ts';
import { createWorkDecisionService } from './work-decision-service.ts';
import { createAgentSessions, nativeResumeSpec, nativeResultSources } from './agent-sessions.ts';
import { executionProgress } from './execution-progress.ts';
import { createTodoDecisions } from './todo-decisions.ts';
import { createTodoReporting } from './todo-reporting.ts';
import { readRunBlockers } from './run-blockers.ts';
import { actionTodoLink } from './todo-link.ts';
import { readTodoHistory } from './todo-history.ts';
import { createRunReview } from './run-review.ts';
import { createProjectFollowUp } from './project-follow-up.ts';
import { applyPolicyPreset } from './policy-presets.ts';
import { createProjectFolders } from './project-folders.ts';
import { createWebPresence } from './web-presence.ts';
import { createBriefingSettings } from './briefing.ts';
import { createAgentFollowups } from './followups.ts';
import { createAutoTakeover } from './auto-takeover.ts';
import { todoDelegationPrompt, formatProjectInstructions, INBOX_ASSISTANT_SYSTEM_PROMPT, SUPERVISOR_SYSTEM_PROMPT } from './prompts.ts';
import { reminderReference, reminderSourceId, wireWorkbenchBackground } from './workbench-background.ts';
import { createAwayNotifications } from './away-notifications.ts';
import { collectAttention } from './attention.ts';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { PluginCallError } from './plugin-invocations.ts';
import { createProjectWorkspace } from './project-workspace.ts';
import { createProjects } from './projects.ts';
import { createKnowledgeCurator } from './knowledge-curator.ts';
import { translateReply } from './agent-runtime/reply-translation.ts';
import { createModelConfig } from './model-config.ts';
import { createPlans } from './plans.ts';
import { createPolicies, validatePolicyPatch, type PolicyConfig } from './policies.ts';
import { createInteractions } from './interactions.ts';
import { createSupervisorAgent } from './supervisor-agent.ts';
import { createEffects } from './effects.ts';
import { createRunMonitor } from './run-monitor.ts';
import { createApprovalService } from './approvals.ts';
import { createSupervision } from './supervision.ts';
import { loadExtensions } from './extension-loader.ts';
import { createInboxService, inboxItemId, ruleTriage } from './inbox.ts';
import { createStore } from './store.ts';
import { createEventBus } from './events.ts';
import { createBackground } from './background.ts';
import { createEventMailboxes } from './event-mailboxes.ts';
import { validateBotScope } from './bot-scopes.ts';
import { botConversationId, botForConversation, pinBotExecutor, relaySender } from './bot-agent-routing.ts';
import { canRelayBotScope } from './bot-group-policy.ts';
import { createScopedAgents } from './scoped-agents.ts';
import { createContributions, PluginHost } from './plugin-host.ts';
import { createAgentRuntime } from './agent-runtime/index.ts';
import { currentAgentInput } from './agent-input.ts';
import { exportNativeConversation, readNativeFavoritePage } from './native-conversation-export.ts';
import { createFeishuWebExtension, createFeishuWebLogin, createFeishuWebSource, tokenStatistics, todoCalendar, createReplyTranslation, conversationEdit, createRunComparison, shortcutSettings, readingFonts, replyReadAloud, voiceInput, conversationQuotes, conversationDrafts, conversationSearch, officeWorkerGuide, officeDocuments, createAssistantSkills, assistantProfile, projectInstructions, savedPrompts, createMessageFavorites, createConversationExport, createSystemExtensions, fetchCalendarAgenda, workspaceSplash, createStartPage, readStartPage, createKnowledgeSourceReader, createKnowledgeSourceReaderService, isProtectedKnowledgeURL } from '../../../plugins/index.ts';
import { commitChanges, executionUsage } from '../../protocol/src/index.ts';
import type { AppConfig, Approval, BotScope, ExecutionResult, InboxItem, InboxThing, Json, JsonObject, KnowledgeEntry, Message, MessageRoute, Project, Run, Snapshot, Todo } from '../../protocol/src/index.ts';
import type { Executor, MachineClient, KnowledgeBackend } from '../../plugin-sdk/src/index.ts';

export class InputError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new InputError(`${name}不能为空`);
  return value.trim();
}
export function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new InputError(`${name}必须是文本`);
  return value.trim() || undefined;
}
function dueDate(value: unknown): string | undefined {
  const text = optionalText(value, '截止日期');
  if (text && Number.isNaN(Date.parse(text))) throw new InputError('截止日期格式无效');
  return text;
}
/** Owns application services. HTTP and future channels call the same methods. */
export async function createWorkbench(config: AppConfig) {
  config = { ...config };
  const webConfig = createFeishuWebConfig(config.dataDir, config.feishuWeb);
  let closing = false;
  const modelConfig = createModelConfig(config);
  let modelRevision = randomUUID();
  const store = createStore(join(config.dataDir, 'workbench.sqlite'));
  const events = createEventBus(store);
  const mailboxes = createEventMailboxes({ store, events });
  const projects = createProjects({ store, events });
  const waitingReplies = createReplyTracking({ store, events });
  const effects = createEffects({ store, events });
  const contributions = createContributions();
  const knowledgeReaderSettings = createKnowledgeSourceSettings(store, events);
  const protectedReaderContext = new AsyncLocalStorage<{ source: string; current: () => boolean; credentialAuthorized?:boolean }>();
  let knowledgeAccount: () => {profile:string;appId:string;openId:string} | undefined = () => undefined;
  let knowledgeAccountReady = () => false;
  let mailboxHandlingAccess: Parameters<typeof createInboxHandlingSources>[0]['mailboxAccess'] = () => ({ active: false, replyAvailable: false, reason: '机器人处理入口尚未连接' });
  let replyToInboxSource: ((source: InboxHandlingSource, text: string, key: string) => Promise<Json>) | undefined;
  const background = createBackground({ store, events, effects, propose: input => approvals.propose(input) });
  const briefing = createBriefingSettings(store, background.schedules);
  const plugins = new PluginHost({ store, events, contributions, dataDir: config.dataDir, background: background.host });
  let machines: MachineClient | undefined;
  const projectFolders = createProjectFolders(() => machines);
  let replyToFeishu: ((chatId: string, text: string, key: string) => Promise<void>) | undefined;
  let channelStatus = () => ({ connected: false, reason: '请在 Web 配置飞书' });
  let botsStatus: () => Json = () => [];
  let notificationBots: () => import('../../protocol/src/index.ts').FeishuBot[] = () => botsStatus() as unknown as import('../../protocol/src/index.ts').FeishuBot[];
  const presence = createWebPresence();
  let notificationChannel: (bot: import('../../protocol/src/index.ts').FeishuBot) => string = () => { throw new InputError('通知渠道尚未连接', 503); };
  let mailboxProposer: ((input: Record<string, unknown>) => Json) | undefined;
  let botRelay: ((input: { sourceBotId: string; targetBotId: string; text: string; key: string; parentEntryId?: string; chatId?: string; sourceMessageId?: string }) => Promise<import('../../protocol/src/bots.ts').MailboxEntry>) | undefined;
  const configuredBots = () => botsStatus() as unknown as import('../../protocol/src/bots.ts').FeishuBot[];
  const agentSessions = createAgentSessions({ store, machines: () => machines, executors: executorInfo, propose: input => approvals.propose(input), pinExecutor: (source, id) => pinBotExecutor(configuredBots(), source, id) });
  let channelBindingsReady = false;
  let botScopeAccess: (scope: BotScope, botId: string, input?: Message) => boolean = () => true;
  const workDecisions = createWorkDecisionService({ store, events, currentInput: () => currentAgentInput() ?? agent.currentInput(), assertCurrentInput: input => {
    if (input.conversationId.startsWith('bot:') && !configuredBots().some(bot => input.conversationId.startsWith(`bot:${bot.id}:`))) throw new InputError('机器人来源已失效', 403);
    assertBotInput(input);
  } });
  const todoDecisions = createTodoDecisions(store, workDecisions);
  function renameRunWorktree(id: string, input: Record<string, unknown>) {
    if (!plugins.list().some(p => p.id === 'run-comparison' && p.status === 'active')) throw new InputError('执行对比插件已停用', 503);
    const run = store.get<Run>('runs', id);
    if (!run?.worktree?.branch) throw new InputError('执行缺少工作树创建回执', 404);
    if (run.worktree.removedAt) throw new InputError('工作树目录已清理', 410);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\x00-\x1f\x7f]/.test(input.name))
      throw new InputError('请输入 1 至 80 个字符的单行名称');
    const name = input.name.trim();
    if (run.worktree.name === name) return { name };
    if (input.previousName !== (run.worktree.name ?? '')) throw new InputError('工作树名称已变化，请重新打开后核对', 409);
    store.put('runs', id, { ...run, worktree: { ...run.worktree, name } });
    changed('runs.changed', { id });
    return { name };
  }
  function worktreeBlockingRuns(machineId: string, directory: string) {
    return store.list<Run>('runs').filter(other => other.machineId === machineId && other.cwd
      && (join(other.cwd) === directory || join(other.cwd).startsWith(directory + '/'))
      && ['queued', 'running', 'unknown'].includes(other.status));
  }
  async function runWorktreeStatus(id: string, includeCleanup = false, offset = 0, version?: string): Promise<Json> {
    if (!plugins.list().some(p => p.id === 'run-comparison' && p.status === 'active')) throw new InputError('执行对比插件已停用', 503);
    const run = store.get<Run>('runs', id);
    if (!run?.worktree?.branch || !run.machineId) throw new InputError('执行缺少工作树创建回执', 404);
    if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && !version)) throw new InputError('工作树文件分页参数无效');
    if (includeCleanup && run.worktree.removedAt && !offset && !version) {
      const { branch, removedAt, branchDeletedAt } = run.worktree;
      // A deletion receipt is historical evidence even if the machine is now offline.
      if (branchDeletedAt) return { branch, removedAt, branchDeletedAt };
      try {
        const retainedBranch = await retainedRunBranch(id);
        return { branch, removedAt, retainedBranch };
      } catch (error) {
        return { branch, removedAt, branchStatusUnavailable: error instanceof Error ? error.message : '执行机未返回分支状态' };
      }
    }
    const machine = machines?.list().find(item => item.id === run.machineId);
    if (!machines || !machine?.online) throw new InputError('执行机离线', 503);
    if (!machine.capabilities.includes('workspace.inspectRunWorktree')) throw new InputError('请升级执行机代理以查看工作树状态', 409);
    if (run.worktree.removedAt) throw new InputError(run.worktree.branchDeletedAt ? '工作树目录和执行分支已清理' : '工作树目录已清理，分支已保留', 410);
    const state = await machines.call(machine.id, 'workspace.inspectRunWorktree', { id, source: run.worktree.source, offset, ...(version && { version }) });
    if (!state || typeof state !== 'object' || Array.isArray(state) || !run.cwd || state.cwd !== run.cwd)
      throw new InputError('工作树状态回执与执行目录不符', 502);
    if (version && (state.version !== version || state.offset !== offset)) throw new InputError('执行机未确认当前文件页，请刷新或升级代理', 409);
    const blockingRunIds = worktreeBlockingRuns(machine.id, run.cwd).map(other => other.id);
    return { ...state, blockingRunIds, blockedByRuns: blockingRunIds.length > 0 };
  }
  async function readRunWorktreeChange(id: string, path: string, area: string): Promise<Json> {
    if (!plugins.list().some(p => p.id === 'run-comparison' && p.status === 'active')) throw new InputError('执行对比插件已停用', 503);
    if (!path || (area !== 'index' && area !== 'working')) throw new InputError('请选择文件和差异区域');
    const run = store.get<Run>('runs', id);
    if (!run?.worktree?.branch || !run.machineId) throw new InputError('执行缺少工作树创建回执', 404);
    if (run.worktree.removedAt) throw new InputError('工作树目录已清理', 410);
    const machine = machines?.list().find(m => m.id === run.machineId);
    if (!machines || !machine?.online) throw new InputError('执行机离线', 503);
    if (!machine.capabilities.includes('workspace.readWorktreeChange')) throw new InputError('请升级执行机代理以查看工作树文件差异', 409);
    return machines.call(machine.id, 'workspace.readWorktreeChange', { id, source: run.worktree.source, path, area });
  }
  async function runWorktreeHistory(id: string, mode: string, offset: number, version?: string, commit?: string, path?: string): Promise<Json> {
    if (!plugins.list().some(p => p.id === 'run-comparison' && p.status === 'active')) throw new InputError('执行对比插件已停用', 503);
    if (!['all', 'unmerged'].includes(mode) || !Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && !version)) throw new InputError('提交历史范围或分页参数无效');
    const run = store.get<Run>('runs', id);
    if (!run?.worktree?.branch || !run.machineId) throw new InputError('执行缺少工作树创建回执', 404);
    if (run.worktree.branchDeletedAt) throw new InputError('执行分支已删除', 410);
    const machine = machines?.list().find(m => m.id === run.machineId);
    if (!machines || !machine?.online) throw new InputError('执行机离线', 503);
    if (commit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || path !== undefined && !commit) throw new InputError('请从历史中选择提交');
    const method = commit ? 'workspace.worktreeCommit' : 'workspace.worktreeHistory';
    if (!machine.capabilities.includes(method)) throw new InputError('请升级执行机代理以查看提交历史', 409);
    return machines.call(machine.id, method, { id, source: run.worktree.source, retained: Boolean(run.worktree.removedAt),
      mode, offset, ...(commit && { commit }), ...(path !== undefined && { path }), ...(version !== undefined && { version }) });
  }
  const cleaningWorktrees = new Map<string, { machineId: string; cwd: string }>();
  async function cleanupRunWorktree(id: string, input: Record<string, unknown>): Promise<Json> {
    if (input.confirmed !== true || typeof input.head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.head)
      || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.requestId)
      || Object.keys(input).some(field => !['confirmed', 'head', 'requestId'].includes(field))) throw new InputError('请确认当前提交和待清理的执行目录');
    if (!plugins.list().some(p => p.id === 'run-comparison' && p.status === 'active')) throw new InputError('执行对比插件已停用', 503);
    const run = store.get<Run>('runs', id);
    if (!run?.worktree?.branch || !run.machineId || !run.cwd) throw new InputError('执行缺少工作树创建回执', 404);
    if (run.worktree.removedAt) return { removed: true, branch: run.worktree.branch };
    const directory = run.cwd, client = machines, machineId = run.machineId;
    if (!['completed', 'failed'].includes(run.status) || worktreeBlockingRuns(machineId, directory).length) throw new InputError('工作树仍有关联执行未结束或结果未知', 409);
    const machine = client?.list().find(m => m.id === machineId);
    if (!client || !machine?.online) throw new InputError('执行机离线', 503);
    if (!machine.capabilities.includes('workspace.removeRunWorktree')) throw new InputError('请升级执行机代理以清理工作树', 409);
    const params = { id, source: run.worktree.source, head: input.head };
    if (cleaningWorktrees.has(id)) throw new InputError('工作树清理正在进行', 409);
    cleaningWorktrees.set(id, { machineId, cwd: directory });
    try {
      const result = await effects.perform({ key: 'worktree-cleanup:' + id + ':' + input.requestId, kind: 'workspace.removeRunWorktree',
        target: machineId, summary: '清理已确认的工作树目录，保留分支', content: params,
        run: () => client.call(machineId, 'workspace.removeRunWorktree', params) });
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new InputError('清理结果未知，请核对执行机', 502);
      if (result.removed === false) throw new InputError(String(result.reason), 409);
      if (result.removed !== true || result.head !== input.head || result.branch !== run.worktree.branch)
        throw new InputError('清理回执不匹配，请核对执行机', 502);
      const latest = store.get<Run>('runs', id)!;
      store.put('runs', id, { ...latest, worktree: { ...latest.worktree!, removedAt: new Date().toISOString() } });
      changed('runs.changed', { id });
      return result;
    } finally { cleaningWorktrees.delete(id); }
  }
  async function retainedRunBranch(id: string, confirmation?: Record<string, unknown>): Promise<Json> {
    if (!plugins.list().some(p => p.id === 'run-comparison' && p.status === 'active')) throw new InputError('执行对比插件已停用', 503);
    const run = store.get<Run>('runs', id);
    if (!run?.worktree?.removedAt || run.worktree.branch !== 'super-mario/' + id || !run.machineId)
      throw new InputError('请先确认清理独立工作树目录', 409);
    if (run.worktree.branchDeletedAt) return { deleted: true, branch: run.worktree.branch };
    const machine = machines?.list().find(m => m.id === run.machineId), client = machines;
    const method = confirmation ? 'workspace.deleteRetainedBranch' : 'workspace.retainedBranchStatus';
    if (!client || !machine?.online) throw new InputError('执行机离线', 503);
    if (!machine.capabilities.includes(method)) throw new InputError('请升级执行机代理以管理保留分支', 409);
    const receipt = effects.list().filter(e => e.kind === 'workspace.removeRunWorktree' && e.target === machine.id
      && e.status === 'confirmed' && e.key.startsWith('worktree-cleanup:' + id + ':')).map(e => e.result)
      .find(r => r && typeof r === 'object' && !Array.isArray(r) && r.removed === true && r.branch === run.worktree!.branch);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || typeof receipt.head !== 'string')
      throw new InputError('缺少原目录清理回执', 409);
    const params = { id, source: run.worktree.source };
    if (!confirmation) {
      const state = await client.call(machine.id, method, params);
      if (!state || typeof state !== 'object' || Array.isArray(state) || state.branch !== run.worktree.branch
        || typeof state.head !== 'string' || typeof state.sourceHead !== 'string' || typeof state.checkedOut !== 'boolean'
        || typeof state.unmerged !== 'number' || !Number.isSafeInteger(state.unmerged) || state.unmerged < 0)
        throw new InputError('分支状态回执不完整', 502);
      return { branch: state.branch, head: state.head, sourceHead: state.sourceHead, checkedOut: state.checkedOut,
        unmerged: state.unmerged, moved: state.head !== receipt.head };
    }
    const { confirmed, head, sourceHead, unmerged, requestId } = confirmation;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId) || confirmed !== true || head !== receipt.head || typeof sourceHead !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceHead)
      || typeof unmerged !== 'number' || !Number.isSafeInteger(unmerged) || unmerged < 0) throw new InputError('请确认清理时的分支提交和未合并数量', 409);
    const content = { ...params, head, sourceHead, unmerged, range: run.commitChanges ? { ...run.commitChanges } : null };
    const prefix = 'branch-delete:' + id + ':';
    if (effects.list().some(effect => effect.key.startsWith(prefix) && effect.key !== prefix + requestId
      && ['unknown', 'sent'].includes(effect.status))) throw new InputError('已有删除请求待核实，请核对执行机', 409);
    const result = await effects.perform({ key: prefix + requestId, kind: method,
      target: machine.id, summary: '删除单独确认的执行分支', content, run: () => client.call(machine.id, method, content) });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new InputError('分支删除结果未知', 502);
    if (result.deleted === false) throw new InputError(String(result.reason), 409);
    if (result.deleted !== true || result.branch !== run.worktree.branch || result.head !== head) throw new InputError('分支删除回执不匹配', 502);
    const latest = store.get<Run>('runs', id)!;
    store.put('runs', id, { ...latest, worktree: { ...run.worktree, branchDeletedAt: new Date().toISOString() } });
    changed('runs.changed', { id });
    return result;
  }
  async function readRunCommitDiff(id: string, path?: string): Promise<Json> {
    if (!plugins.list().some(p => p.id === 'run-comparison' && p.status === 'active')) throw new InputError('执行对比插件已停用', 503);
    const run = store.get<Run>('runs', id);
    if (!run?.commitChanges || !run.machineId || !run.cwd) throw new InputError('执行缺少历史提交记录', 404);
    const machine = machines?.list().find(item => item.id === run.machineId);
    if (!machines || !machine?.online) throw new InputError('执行机离线', 503);
    if (!machine.capabilities.includes('workspace.commitDiff')) throw new InputError('请升级执行机代理以查看历史差异', 409);
    return machines.call(machine.id, 'workspace.commitDiff', {
      cwd: run.worktree?.source ?? (run.worktreeRunId && store.get<Run>('runs', run.worktreeRunId)?.worktree?.source) ?? run.cwd, range: run.commitChanges, ...(path !== undefined && { path }),
    });
  }
  async function readWorkspaceCode(input: { projectId?: string; kind: 'tree' | 'file' | 'diff'; path?: string }): Promise<Json> {
    const projectId = requiredText(input.projectId, 'projectId');
    const project = projects.list().find(p => p.id === projectId);
    if (!project || project.archivedAt) throw new InputError('项目不存在或已归档', 404);
    if (!project.workspace) throw new InputError('项目尚未绑定电脑目录', 409);
    if (!machines) throw new InputError('执行机网关尚未就绪', 503);
    const machine = machines.list().find(m => m.id === project.workspace!.machineId);
    if (!machine?.online) throw new InputError('绑定电脑已离线', 503);
    if (!machine.capabilities.includes('workspace.code')) throw new InputError('绑定电脑代理不支持代码只读浏览', 409);
    const raw = await machines.call(machine.id, 'workspace.code', { cwd: project.workspace.cwd, kind: input.kind, path: input.path ?? '' }) as Record<string, unknown>;
    if (typeof raw?.text === 'string' && raw.text.length > 32000) {
      return { ...raw, text: raw.text.slice(0, 32000), truncated: true } as unknown as Json;
    }
    if (typeof raw?.diff === 'string' && raw.diff.length > 32000) {
      return { ...raw, diff: raw.diff.slice(0, 32000), truncated: true } as unknown as Json;
    }
    return raw as unknown as Json;
  }
  for (const extension of createSystemExtensions({ demo: config.demo, actions: { triageAgent: { status: () => inboxClassifier.status(), ask: (text, context) => inboxClassifier.ask(text, context) }, ruleTriage, scheduledWorkCronPreview: input => scheduledWork.previewCron(input), scheduledWorkHistory: input => scheduledWork.readHistory(input) as unknown as Json, scheduledWorkBrief: input => scheduledWork.readBrief(input), scheduledWorkList: input => scheduledWork.list(input) as unknown as Json, scheduledWorkPropose: input => scheduledWork.propose(input,true) as unknown as Json, scheduledWorkSkipNext: input => scheduledWork.skipNext(input,true), scheduledWorkSetPaused: input => scheduledWork.changeTiming(input,true) as unknown as Json, scheduledWorkCancel: input => scheduledWork.cancel(input,true) as unknown as Json, followupCreate: input => followups.create(input) as unknown as Json, followupList: input => followups.list(input) as unknown as Json, followupCancel: id => followups.cancel(id) as unknown as Json, notifyUser: input => followups.notifyUser(input), calendarAgenda: (input, signal) => fetchCalendarAgenda({ profile: knowledgeAccount()?.profile, ...input, signal }), workspaceCode: readWorkspaceCode, knowledgeReaderService: () => protectedReaderService(), workDecisionsList: input => workDecisions.list(input) as unknown as Json, workDecisionRecord: input => workDecisions.recordFromAgent(input) as unknown as Json, workDecisionCorrect: input => workDecisions.changeFromAgent(input) as unknown as Json, workDecisionWithdraw: input => workDecisions.changeFromAgent(input, true) as unknown as Json, workDecisionReference: input => workDecisions.referenceFromAgent(input) as unknown as Json, inboxList: readInbox, inboxHandlingRead: readInboxHandlingFromAgent, inboxAssignProject: assignInboxProject, agentSessions: async input => await agentSessions.discover(input) as unknown as Json, resumeSession: async input => { const source = currentAgentInput() ?? agent.currentInput(); return await agentSessions.proposeResume({ ...input, key: source ? `${source.id}:${requiredText(input.key, '恢复请求标识')}` : input.key }, source) as unknown as Json; }, botsList: () => botsStatus(), botRelay: relayFromAgent, mailboxesList: input => mailboxes.list(input as Parameters<typeof mailboxes.list>[0]) as unknown as Json, mailboxPropose: input => { if (!mailboxProposer) throw new InputError('机器人信箱尚未连接', 503); return mailboxProposer(input); }, projectsList: () => projects.list() as unknown as Json, projectCreate: async input => await createProject(input) as unknown as Json, projectsDiscover: discoverProjects, knowledgeSource: input => {
    const source=currentAgentInput()??agent.currentInput();if(!source||source.role!=='user'||source.readOnly||source.origin&&source.origin!=='user')throw new InputError('来源投放需要当前用户输入',403);
    validateSourceActor(source,input.layer??'personal',typeof input.projectId==='string'?input.projectId:undefined);
    return knowledgeCurator.addSource(input,{requestOrigin:'agent',sourceMessageId:source.id}) as unknown as Json;
  }, lookupKnowledgeSource: async (url, view, projectId, offset) => {
    const project = currentAgentInput()?.projectId ?? projectId;
    return view === 'attempts' ? knowledgeCurator.sourceAttemptsFromUrl(url, project, offset) : knowledgeCurator.pagesFromUrl(url, project, offset);
  },
  confirmKnowledgeTodo, knowledgeActionStatus: (args) => knowledgeActionStatus(args, currentAgentInput()?.projectId ?? optionalText(args.projectId, '项目')), editConfirmedFacts: args => changeKnowledgeMetadata('facts', args), changeKnowledgeAlias: args => changeKnowledgeMetadata('alias', args), changeKnowledgeTag: args => changeKnowledgeMetadata('tag', args), setKnowledgeRelevance: args => changeKnowledgeMetadata('relevance', args), setKnowledgeImportance: args => changeKnowledgeMetadata('importance', args), knowledgeRevision: (id, commit, projectId) => knowledgeRevision(id, commit, projectId ?? currentAgentInput()?.projectId), knowledgeOriginal: (pageId, sourceId, projectId, handoffExcerpt) => knowledgeCurator.pageSources(pageId, sourceId, projectId ?? currentAgentInput()?.projectId, handoffExcerpt), searchMeetings: (query, projectId, offset) => knowledgeCurator.searchMeetings(query, currentAgentInput()?.projectId ?? projectId, offset), meetingDay: (date, timezone, projectId, offset) => knowledgeCurator.meetingDay(date, timezone ?? briefing.settings().timezone, currentAgentInput()?.projectId ?? projectId, offset),
    knowledgeJobs: input => {
      const bound = currentAgentInput()?.projectId, requested = optionalText(input.projectId, '项目');
      if (bound && requested && requested !== bound) throw new InputError('跨作用域 projectId', 403);
      const project = bound ?? requested;
      if (project || input.status !== undefined || input.offset !== undefined)
        return knowledgeCurator.queueJobs(project, input.status, input.offset);
      return knowledgeCurator.status() as unknown as Json;
    }, dispatch: input => { const source = currentAgentInput() ?? agent.currentInput(); return dispatch({ ...input, conversationId: source?.conversationId, sourceMessageId: source?.id, projectId: input.projectId ?? source?.projectId, todoId: input.todoId ?? source?.todoId }) as unknown as Json; }, createTodo: registerChatTodo, listExecutors: () => executorInfo() as unknown as Json, status: id => hostStatus(id), todoDetail, todoHistory: args => todoHistory(requiredText(args.todoId, '待办标识'), optionalText(args.before, '历史位置')) as unknown as Json, readRun: id => readRun(id), inputRun: (id, text) => inputRun(id, text), cancelRun: id => cancel(id), propose: input => approvals.propose(input as Parameters<typeof approvals.propose>[0]) as unknown as Json, brief: () => supervision.brief(), updateTodo: (id, patch) => updateTodo(id, patch) as unknown as Json, taskPlan: input => proposePlan(input, true) as unknown as Json, interactionOpen: input => interactions.open(input as Parameters<typeof interactions.open>[0], currentAgentInput() ?? agent.currentInput()) as unknown as Json, interactionsList: () => interactions.list() as unknown as Json, answerQuestion: (id, version, text) => answerQuestion(id, version, text), supervisorRead: () => ({ status: supervisorRuntime.status(), reviews: supervisorAgent.reviews() }) as unknown as Json } })) plugins.register(extension);
  function makeWebSource() {
    const options = webConfig.read();
    return createFeishuWebSource({
      ...options, pollIntervalMs: config.feishuWeb?.pollIntervalMs,
      onInbox: async (items, account) => {
        if (!account?.accountKey?.trim()) throw new Error('网页版网关未提供已核验的账号');
        const key = createHash('sha256').update(JSON.stringify([options.baseUrl, account.accountKey])).digest('hex');
        await inbox.ingest('feishu:web:' + key, items);
      },
    });
  }
  let webSource = makeWebSource();
  let webLogin = createFeishuWebLogin(webConfig.read());
  let webQueue = Promise.resolve();
  function serializeWeb<T>(action: () => T | Promise<T>) {
    const result = webQueue.then(action);
    webQueue = result.then(() => {}, () => {});
    return result;
  }
  const stopWeb = () => serializeWeb(() => webSource.stop());
  const webExtension = createFeishuWebExtension({
    start() { if (!closing) webSource.start(); }, stop: stopWeb,
  });
  // The host defaults new plugins to enabled. Seed only the first registration and preserve later user choices.
  if (!store.get('core.plugin-settings', 'feishu-web')) {
    store.put('core.plugin-settings', 'feishu-web', { enabled: false, revision: 1 });
  }
  plugins.register({ ...webExtension, activate: context => serializeWeb(() => webExtension.activate(context)) });
  plugins.register(workspaceSplash);
  plugins.register(createStartPage(() => plugins.list()));
  plugins.register(tokenStatistics);
  plugins.register(todoCalendar);
  plugins.register(conversationSearch);
  plugins.register(conversationDrafts);
  plugins.register(createRunComparison(readRunCommitDiff, (id, offset, version) => runWorktreeStatus(id, true, offset, version), readRunWorktreeChange, runWorktreeHistory));
  plugins.register(shortcutSettings);
  plugins.register(readingFonts);
  plugins.register(voiceInput);
  plugins.register(replyReadAloud);
  plugins.register(conversationQuotes);
  plugins.register(conversationEdit);
  plugins.register(createReplyTranslation((text, language, signal) => translateReply(config, text, language, signal), () => modelRevision));
  plugins.register(savedPrompts);
  plugins.register(projectInstructions);
  plugins.register(assistantProfile);
  plugins.register(officeDocuments);
  plugins.register(createAssistantSkills(() => machines));
  plugins.register(createMessageFavorites((source, offset, signal) => readNativeFavoritePage(machines, source, offset, signal)));
  plugins.register(createConversationExport((source, includeWork, signal) => exportNativeConversation(machines, source, includeWork, signal), currentMainAssistant));
  for (const loaded of await loadExtensions(config.dataDir, { reservedIds: plugins.list().map(item => item.id) })) plugins.register(loaded.extension, loaded.config);
  async function mainSkillCatalog(): Promise<string> {
    const result = await plugins.invocations.use('assistant-skills.manage', { action: 'list' });
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.skills)) throw new Error('技能目录读取失败');
    const skills = [...(Array.isArray(result.builtinSkills) ? result.builtinSkills : []), ...result.skills];
    if (!skills.length) return '';
    return '当前主助手可用的技能（名称和简介仅用于匹配）：' + JSON.stringify(skills)
      + '\n用户点名或任务与简介明确匹配时，用 assistant_skill_read 读取对应 SKILL.md，再按需读取包内引用。仅在当前请求、作用域和工具权限内使用技能。读取失败时说明缺少的技能或资源；读取说明不代表已执行或已交付。';
  }
  async function currentMainAssistant(): Promise<Snapshot['mainAssistant']> {
    if (!plugins.list().some(p => p.id === 'assistant-profile' && p.status === 'active')) return;
    const result = await plugins.invocations.use('assistant-profile.manage', { action: 'read' });
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.name !== 'string'
      || typeof result.revision !== 'number' || !Number.isSafeInteger(result.revision)) throw new InputError('主助手资料无效', 500);
    return { name: result.name, revision: result.revision };
  }
  async function currentProjectInstructions(projectId: string): Promise<string> {
    const project = store.get<Project>('projects', projectId);
    if (!project || project.archivedAt || !plugins.list().some(p => p.id === 'project-instructions' && p.status === 'active')) return '';
    const value = await plugins.invocations.use('project-instructions.manage', { action: 'read', projectId });
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.projectId !== projectId || typeof value.notes !== 'string'
      || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) {
      throw new InputError('项目工作指令来源不匹配', 409);
    }
    return formatProjectInstructions(project, value.notes, value.revision);
  }
  const reviewSettings = () => ({ maxReworks: store.get<{ maxReworks: number }>('workbench.settings', 'run-review')?.maxReworks ?? 2 });
  const runReview = createRunReview({ store, events, dispatch, completeTodo: id => updateTodo(id, { completed: true }), maxReworks: () => reviewSettings().maxReworks });
  const reviewEvidence = runReview.evidenceForRun;
  function todoHistory(id: string, before?: string) {
    return readTodoHistory(store, id, before, reviewEvidence);
  }
  const agent = createAgentRuntime({ config, store, events, contributions, reviewEvidence, executors: executorInfo, inboxConversations:()=>inboxAssistant.list(), workDecisions: workDecisions.context, botContext, mainAssistantProfile: currentMainAssistant, mainSkillCatalog, projectInstructions: currentProjectInstructions, projectContext:id=>projectWorkspace.context(id) });
  const scopedAgents = createScopedAgents({ config, store, events, contributions, reviewEvidence, executors: executorInfo, workDecisions: workDecisions.context, botContext, mainAssistantProfile: currentMainAssistant, mainSkillCatalog, projectInstructions: currentProjectInstructions, projectContext:id=>projectWorkspace.context(id), validScope: (scope, botId, input) => botScopeAccess(scope, botId, input) });
  const supervisorRuntime = createAgentRuntime({ config, store, events, contributions, conversationId: 'supervisor',
    allowedTools: ['knowledge_list', 'executors_list', 'todos_list', 'runs_list', 'work_read', 'brief_read', 'projects_list', 'workspace_code_list', 'workspace_code_read', 'workspace_git_diff'],
    systemPrompt: SUPERVISOR_SYSTEM_PROMPT });
  const inboxClassifier = createInboxClassifier({config,store,events,contributions,ready:()=>agent.status().available});
  const inboxAssistantWorkspace = join(config.dataDir, 'pi', 'workspace');
  const inboxAssistantRuntime = createInboxClassifier({config,store,events,contributions,ready:()=>agent.status().available,
    workspaceDir:inboxAssistantWorkspace, systemPrompt: INBOX_ASSISTANT_SYSTEM_PROMPT});
  const inboxHandlingRuntime = createInboxHandlingRuntime({config,store,events,contributions,ready:()=>agent.status().available,
    allowedTools: ['knowledge_list', 'todos_list', 'runs_list', 'work_read', 'projects_list', 'inbox_list', 'workspace_code_list', 'workspace_code_read', 'workspace_git_diff', 'calendar_agenda']});
  const inbox = createInboxService({ store, events, createTodo: input => createTodo(input, false),
    triage: async thing => {
      if (thing.origin?.meetingMinutes) return { tier: 'fyi', reason: '会议来源消息：可查看原文和纪要链接' };
      if (thing.thread.startsWith('feishu:message:')) return { ...ruleTriage(thing), reason: '原文已入箱，由主 Agent 按联系人合并整理' };
      if (!config.demo) {
        const active = contributions.list('inbox_triage')[0]?.value;
        if (active) {
          try {
            const value = await plugins.invocations.use(active.service, thing as unknown as Json);
            if (value && typeof value === 'object' && !Array.isArray(value) && ['action', 'fyi', 'noise'].includes(String((value as Record<string, unknown>).tier)) && typeof (value as Record<string, unknown>).reason === 'string') {
              return value as { tier: 'action' | 'fyi' | 'noise'; reason: string };
            }
          } catch { /* Fall back to deterministic local rules when service or model fails. */ }
        }
      }
      const result = ruleTriage(thing);
      return { tier: result.tier, reason: `规则回退：${result.reason}` };
    } });
  try { await plugins.start(); } catch (error) { store.close(); throw error; }
  const inboxAssistant = createInboxAssistant({store,events,workspace:inboxAssistantWorkspace,
    isMeetingMaterial: item => meetingMemorySources(item, knowledgeReaderSettings.read().trustedHosts).length > 0,
    context:id=>id?projectWorkspace.context(id):{scope:'personal'},
    enabled: () => {
      const active = plugins.list().filter(plugin => plugin.status === 'active').map(plugin => plugin.id);
      return active.includes('inbox-triage') && (active.includes('feishu') || active.includes('feishu-web'));
    },
    available:()=>{const status=inboxAssistantRuntime.status();return status.available?status:{available:false,reason:'主模型尚未就绪，原消息已保存，等待后台整理。'};},createTodo:input=>createTodo(input,false),updateTodo:(id,input)=>updateTodo(id,input),archive:(id,version)=>inbox.archive(id,version),
    async analyze(input){
      if(config.demo)return {summary:'【演示】已合并本会话消息，未调用真实模型。',disposition:'watching',tasks:[]};
      const payload={...input,contextTruncated:false};
      if(JSON.stringify(payload).length>26000){payload.context={omitted:true,note:'上下文较长，原始记录仍保留'};payload.previousSummary=input.previousSummary?.slice(0,1000);payload.messages=input.messages.slice(-10);payload.todos=input.todos.map(t=>({...t,notes:t.notes.slice(-100)}));payload.contextTruncated=true;}
      if(JSON.stringify(payload).length>30000){payload.messages=payload.messages.slice(-3).map(m=>({...m,text:m.text.slice(0,200),truncated:true}));payload.todos=[];}
      if(JSON.stringify(payload).length>31000)throw Error('收件上下文超出本轮容量，原消息已保留');
      const timeout=setTimeout(()=>{void inboxAssistantRuntime.abortCurrent();},120000);timeout.unref();
      try {
      const answer=await inboxAssistantRuntime.ask([
        ...(input.meetingMinutes ? ['这是特别关注的会议资料。结合本轮提供的项目、已有待办、执行记录和历次会议摘要，分析已确认决定、进展变化、负责人、期限与未决问题。只归纳有原文依据的事项，区分讨论建议与承诺；仅有纪要链接时保留链接并说明内容待核实。'] : []),
        '默认在后台处理，不要因为私聊、@或一句感叹就要求主人决策。根据提供的会话上下文判断实际事项；存在省略时保留不确定，零散发言合并为一件工作，延续已有事项时引用existingTodoId。不要虚构完成。',
        '只有缺少关键事实且必须由主人回答时使用waiting_user并提出具体question；知会用watching，无意义闲聊用quiet，有明确工作才用work并给tasks。任务最多20项，按实际目标合并，不能每条消息都建事项；已明确回复解决的讨论不要再建待办。任务key跨轮保持稳定，保持已有事项的标题和人工备注。',
        '只返回JSON：{"summary":"简明会话结论","disposition":"watching|quiet|waiting_user|work","question":"仅需要主人回答时填写","tasks":[{"key":"稳定事项标识","title":"实际工作标题","notes":"目标与现有证据","existingTodoId":"延续已有事项才填写"}]}。没有工作时tasks为空。注意truncated=true表示原文有省略，不据此编造事实。',
        JSON.stringify(payload)
      ].join('\n'),{readOnly:true});
      if(answer.status!=='done')throw Error('后台整理未完成');
      return JSON.parse(answer.text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')) as InboxAnalysis;
      } finally {clearTimeout(timeout);}
    }});
  const knowledgeCurator = createKnowledgeCurator({ store, events, dataDir: config.dataDir, knowledge, machines: () => machines, enabled: () => contributions.list('knowledge_backends').length > 0, validProject: id => projects.list().some(p => p.id === id && !p.archivedAt), readSource: readProtectedKnowledgeSource, allowedProviders: () => [...new Set(['codex', 'claude-code', ...contributions.list('executors').filter(e => e.value.mode === 'real' && e.value.knowledgeWorker !== false).map(e => e.value.kind || e.id)])] });
  // Reconcile already collected minutes once per account on its first successful batch.
  // Later batches also inspect replayed items so a crash before checkpoint commit loses no source.
  const reconciledMeetingAccounts = new Set<string>();
  function collectMeetingMemory(source: string, batch: InboxThing[]) {
    const account = knowledgeAccount();
    if (!account || source !== `feishu:${account.appId}:${account.openId}`) return;
    const items = reconciledMeetingAccounts.has(source)
      ? batch.filter(thing => thing.origin?.meetingMinutes)
          .map(thing => store.get<InboxItem>('inbox', inboxItemId(source, thing.thread)))
          .filter((item): item is InboxItem => !!item)
      : inbox.list().filter(item => item.source === source && item.origin?.meetingMinutes);
    enqueueMeetingMemory(items, knowledgeCurator.addSource, knowledgeReaderSettings.read().trustedHosts);
    reconciledMeetingAccounts.add(source);
  }
  const projectWorkspace=createProjectWorkspace({store,events,demo:config.demo,knowledge,reviewEvidence,projectDecisions:id=>workDecisions.context({kind:"project",projectId:id}),onMemorySaved:()=>knowledgeCurator.rebuildIndex(),bots:()=>botsStatus() as unknown as import('../../protocol/src/index.ts').FeishuBot[],available:()=>agent.status().available,agentStatus:id=>scopedAgents.projectStatus(id),post:(id,text,requestId,todoId)=>scopedAgents.postProject(id,text,requestId,todoId),summarize:(id,text)=>scopedAgents.askMemory(id,text)});
  const controllers = new Map<string, AbortController>();
  const jobs = new Set<Promise<void>>();
  const commandRouter = createCommandProjectRouter(config, () => !closing && inboxClassifier.status().available);
  const approvals = createApprovalService({ store, events, execute: executeApproved, publish: background.publish, allowedKinds: () => contributions.list('channels').flatMap(entry => entry.value.approvalKinds ?? []) });
  const inboxHandlingSources = createInboxHandlingSources({store,personalAccount:()=>knowledgeAccount(),mailboxAccess:entry=>mailboxHandlingAccess(entry)});
  const inboxHandling = createInboxHandling({store,events,
    readSource(ref) {
      let source = inboxHandlingSources(ref);
      if(!contributions.list('channels').length)source={...source,replyAvailable:false,replyReason:'请先启用飞书插件'};
      return contributions.list('inbox_triage').length ? source : {...source,active:false,reason:'请先启用收件箱整理插件'};
    },
    available:()=>inboxHandlingRuntime.status(),
    think: (...args) => inboxHandlingRuntime.ask(...args),
    proposeApproval:input=>approvals.propose(input),rejectApproval:(id,version)=>{approvals.reject(id,version);},execute:executeInboxHandling,
  });
  const scheduledWork = createScheduledWorkService({store,events,schedules:background.schedules,approvals,currentInput:()=>currentAgentInput()??agent.currentInput(),
    ready:()=>channelBindingsReady,enabled:()=>plugins.list().some(p=>p.id==='daily-brief'&&p.status==='active'),
    facts:scope=>buildWorkContext(store,scope,undefined,{reviewEvidence,executors:executorInfo(),inboxConversations:inboxAssistant.list()}) as unknown as Json,
    authorize(scope,source){
      const target=validateBotScope(store,scope.todoId?{kind:'task',todoId:scope.todoId,...(scope.projectId?{projectId:scope.projectId}:{})}:scope.projectId?{kind:'project',projectId:scope.projectId}:{kind:'global'});
      authorizeWorkDecisionSource(store,target,source);
      if(channelBindingsReady){
        if(source.conversationId.startsWith('bot:')&&!configuredBots().some(b=>source.conversationId.startsWith(`bot:${b.id}:`)))throw new InputError('机器人来源已失效',403);
        assertBotInput(source);
        if(scope.action.kind==='dispatch')pinBotExecutor(configuredBots(),source,scope.action.executorId);
      }
    }});
  const offScheduledWork=background.eventbox.subscribe('core',{name:'scheduled-work',types:[{type:'schedule.due',version:1}],effects:'none',handler:event=>scheduledWork.handle(event)});
  const followups = createAgentFollowups({
    store, events, schedules: background.schedules, outbox: background.outbox, agent, demo: config.demo,
    enabled: () => plugins.list().some(p => p.id === 'daily-brief' && p.status === 'active'),
    resolveChannel(projectId, todoId) {
      const candidates = notificationBots()
        .filter(b => b.enabled && b.configured && b.connected && b.paired && b.replyTarget)
        .sort((a, b) => a.id.localeCompare(b.id));
      const bot = (todoId ? candidates.find(b => b.scope.kind === 'task' && b.scope.todoId === todoId) : undefined)
        ?? (projectId ? candidates.find(b => b.scope.kind === 'project' && b.scope.projectId === projectId) : undefined)
        ?? candidates.find(b => b.scope.kind === 'global');
      return bot ? notificationChannel(bot) : 'feishu.bot';
    },
  });
  const offFollowups = background.eventbox.subscribe('core', {
    name: 'agent-followups', types: [{ type: 'schedule.due', version: 1 }], effects: 'none', timeoutMs: 120000,
    handler: event => followups.handle(event),
  });
  const autoTakeover = createAutoTakeover({
    store, events, machines: () => machines,
    openCard: input => interactions.open(input),
    withdrawCard: id => { try { const card = store.get<{ version: number; status: string }>('interactions', id); if (card?.status === 'open') interactions.withdraw(id, card.version); } catch {} },
  });
  if (!config.demo) autoTakeover.start();
  const knowledgeSourceApproval = createKnowledgeSourceApproval({store,events,proposeApproval:input=>approvals.propose(input),rejectApproval:(id,version)=>{approvals.reject(id,version);},
    readerIdentity(){const settings=knowledgeReaderSettings.read(),account=knowledgeAccount();return {enabled:settings.enabled,configured:!!(settings.profile||account?.profile),key:digestReaderIdentity(settings,account),ready:!!settings.profile||knowledgeAccountReady()};},
    validateJob(job){
      if (job.requestOrigin === 'meeting') {
        const item = job.sourceMessageId && store.get<InboxItem>('inbox', job.sourceMessageId);
        const account = knowledgeAccount(), settings = knowledgeReaderSettings.read();
        if (!item || !account || item.source !== `feishu:${account.appId}:${account.openId}` ||
            (settings.profile && settings.profile !== account.profile) ||
            !meetingMemorySources(item, settings.trustedHosts).some(source => source.input.url === job.url && source.provenance.sourceKey === job.sourceKey))
          throw new InputError('会议来源或个人读取账号已变化', 409);
      }
      if(job.requestOrigin==='agent'){const source=job.sourceMessageId?store.get<Message>('messages',job.sourceMessageId):undefined;if(!source)throw new InputError('原来源请求不存在',409);validateSourceActor(source,job.layer,job.projectId);}},
    onApproved:id=>knowledgeCurator.sourceApproved(id),onRejected:(id,reason)=>knowledgeCurator.sourceRejected(id,reason)});
  const offKnowledgeApprovals=events.subscribe(event=>{if(['knowledge.reader.changed','projects.changed','todos.changed','plugins.changed','approvals.changed','bots.changed','feishu.bots.changed'].includes(event.type))knowledgeSourceApproval.sync();});
  const reporting = createTodoReporting({ store, events });
  const supervision = createSupervision({ store, events, conversations:()=>inboxAssistant.list(), publish: input => {
    const data = input.data as {todoId?:string;reminderAt?:string};
    // Only the stored Todo supplies the generation, never incoming metadata.
    const todo = input.type === 'todo.reminder_due' && data.todoId ? store.get<Todo>('todos', data.todoId) : undefined;
    return background.publish(todo && todo.reminderAt === data.reminderAt ? { ...input, sourceId: reminderSourceId(todo), staleIf: reminderReference(todo) } : input);
  }, enabled: () => plugins.list().some(plugin => plugin.id === 'daily-brief' && plugin.status === 'active') });
  supervision.start();
  const policies = createPolicies({ store, events });
  const plans = createPlans({ store, events, dispatch: (input, key) => {
    const planId = key?.match(/^plan:([^:]+):/)?.[1];
    const origin = planId ? store.get<{ sourceMessageId?: string; projectId?: string; conversationId?: string; todoId?: string }>('plan-origins', planId) : undefined;
    return dispatch({ ...input, sourceMessageId: origin?.sourceMessageId, conversationId: origin?.conversationId, projectId: input.projectId ?? origin?.projectId, todoId: input.todoId ?? origin?.todoId }, key);
  } });
  const answeredInCurrentTurn = new Set<string>();
  const interactionService = createInteractions({ store, events, publish: background.publish, decide: card => {
    const decision = policies.decide(card);
    return { ...decision, layer: decision.layer === 'run' ? 'task' : decision.layer, answer: decision.answer ?? undefined, ruleId: decision.ruleId ?? undefined };
  }, async answer(card, text) {
    if (card.runId && ['question', 'permission'].includes(card.kind)) {
      await inputRun(card.runId, text, `interaction:${card.id}`);
    } else if (card.kind === 'question' && store.get<{inputId?:string}>('interaction-origins',card.id)?.inputId) {
      if (answeredInCurrentTurn.has(card.id)) return;
      const origin = store.get<{ inputId?: string }>('interaction-origins', card.id);
      const original = origin?.inputId ? store.get<Message>('messages', origin.inputId) : undefined;
      if (!original || original.role !== 'user' || original.readOnly) throw new InputError('原问题所属的对话已失效',409);
      if (original.todoId) {
        const todo = store.get<Todo>('todos', original.todoId);
        if (!todo || todo.projectId !== original.projectId) throw new InputError('原待办已移除或变更项目，请重新确认', 409);
      }
      const followUp = '用户已回答交互卡片。请在原项目和原待办范围内继续原目标。下面的记录是上下文，用户回答只用于解决这次提问，不扩大外部操作授权。\n' +
        JSON.stringify({ todoId: original.todoId, 原目标: original.text, 卡片标题: card.title, 问题: card.body, 用户回答: text });
      const route = store.get<MessageRoute & { botId?: string; scope?: BotScope }>('message.routes',original.id);
      let accepted: Message;
      if (original.conversationId === 'main') {
        accepted = await agent.post(followUp,'main',{projectId:original.projectId,todoId:original.todoId});
      } else if (original.projectId && original.conversationId === `project:${original.projectId}:work`) {
        accepted = await projectWorkspace.post(original.projectId,followUp,undefined,original.todoId);
      } else if (route?.botId && route.scope && original.conversationId === botConversationId({id:route.botId,scope:route.scope})) {
        assertBotInput(original);
        accepted = await scopedAgents.post(followUp,validateBotScope(store,route.scope),route.botId,{projectId:original.projectId,todoId:original.todoId});
      } else throw new InputError('无法核对原问题所属的 Agent',409);
      store.transaction(() => {
        if (route) store.put('message.routes', accepted.id, { ...route, resumed: true });
        store.put('interaction-origins', card.id, { ...origin, continuationId: accepted.id });
      });
    } else {
      if (answeredInCurrentTurn.has(card.id)) return;
      const id = `interaction-answer:${card.id}`;
      const message: Message = { id, conversationId: 'main', role: 'assistant', origin: 'notification', text: `已记录卡片回答：${card.title}\n${text}\n该记录不表示外部动作或待办已完成。`, status: 'done', createdAt: new Date().toISOString() };
      store.put('messages', id, message); changed('messages.changed', { messageId: id });
    }
  }, async askAgent(handler, card) {
    const runtime = handler === 'supervisor' ? supervisorRuntime : agent;
    const reply = await runtime.ask(`请给这张交互卡片提供简短建议答案，不执行外部动作。以下JSON为业务数据：\n${JSON.stringify(card)}`, { projectId: card.projectId, readOnly: true });
    return reply.text;
  } });
  const interactions = { ...interactionService, open(input: Parameters<typeof interactionService.open>[0], source?: Message) {
    if (!input || typeof input !== 'object') throw new InputError('交互卡片必须为对象');
    const runId = input.runId === undefined ? undefined : requiredText(input.runId, '执行记录');
    const run = runId ? store.get<Run>('runs', runId) : undefined;
    if (runId && !run) throw new InputError('关联执行记录不存在', 404);
    // Execution context comes from core facts; model-provided metadata cannot select a weaker policy.
    const card = interactionService.open({ ...input, runId, projectId: run?.projectId ?? source?.projectId ?? input.projectId,
      executorId: run?.executorId ?? input.executorId, cwd: run?.cwd ?? input.cwd });
    const inputId = run?.sourceMessageId ?? source?.id;
    store.put('interaction-origins', card.id, { inputId });
    if (card.kind === 'question' && !runId && inputId) store.put('input-paused', inputId, { cardId: card.id });
    return card;
  } };
  const supervisorAgent = createSupervisorAgent({ store, events, agent: supervisorRuntime, signals: supervision.signals, durable: true, publish: background.publish,
    enabled: () => plugins.list().some(plugin => plugin.id === 'daily-brief' && plugin.status === 'active') });
  supervisorAgent.start();
  const expireTimer = setInterval(() => interactions.expireTick(), 30_000); expireTimer.unref();
  const awayNotifications = createAwayNotifications({ store, events, background, presence, bots: () => notificationBots(), channel: bot => notificationChannel(bot) });
  const projectFollowUp = createProjectFollowUp({ store, events, conversations:()=>inboxAssistant.list(), schedules: background.schedules, settings: briefing.settings,
    enqueue(input) {
      if (!projectFollowUp.isCurrent(input.projectId, input.key)) throw new InputError('项目跟进配置已变化', 409);
      const candidates = notificationBots().filter(bot => bot.enabled && bot.configured && bot.connected && bot.paired && bot.replyTarget).sort((a, b) => a.id.localeCompare(b.id));
      const bot = candidates.find(bot => bot.scope.kind === 'project' && bot.scope.projectId === input.projectId)
        ?? candidates.find(bot => bot.scope.kind === 'global');
      // No bot means a held, visible outbound intent, never an inferred recipient.
      // Its schedule revision is checked again by outbox immediately before send.
      return background.outbox.enqueueNotice('daily-brief', { dedupKey: `project-brief:${input.key}`, channel: bot ? notificationChannel(bot) : 'feishu.bot', target: 'owner',
        content: { text: input.text }, relatedTo: { kind: 'project', id: input.projectId }, ...(input.staleIf ? { staleIf: input.staleIf } : {}) });
    },
  });
  const wiredBackground = wireWorkbenchBackground({
    demo: config.demo,
    consumePendingBriefNotices: () => followups.consumePendingBriefNotices(),
    store, events, background, plugins, contributions, briefing, supervision, supervisorAgent, supervisorRuntime, conversations:()=>inboxAssistant.list(),
    agent, inbox, waitingReplies, approvals, interactions, presence, projectFollowUp, proposePlan,
    notificationBots: () => notificationBots(), notificationChannel: bot => notificationChannel(bot),
    changed, isClosing: () => closing, createInputError: (message, status) => new InputError(message, status), requiredText,
  });
  const monitor = createRunMonitor({ store, events, machines: () => machines, onResult: finishRun, legacyTrustedSources: () => {
    const sources = new Set<string>(['codex-json', 'claude-result', 'claude-stream-json']);
    for (const item of executorInfo()) for (const src of item.nativeResultSources ?? []) sources.add(src);
    return sources;
  } });
  function proposePlan(input: Record<string, unknown>, fromAgent = false) {
    const source = fromAgent ? currentAgentInput() ?? agent.currentInput() : undefined;
    if (Array.isArray(input.tasks) && input.tasks.some(task => task && typeof task === 'object' && 'nativeResume' in task)) throw new InputError('原生线程恢复须通过单独恢复审批，不能作为新任务静默派发', 403);
    const normalized = source && Array.isArray(input.tasks) ? { ...input, tasks: input.tasks.map(task => {
      if (!task || typeof task !== 'object' || Array.isArray(task)) return task;
      const args = task as Record<string, unknown>;
      return { ...args, executorId: pinBotExecutor(configuredBots(), source, args.executorId) };
    }) } : input;
    const plan = plans.propose(normalized as unknown as Parameters<typeof plans.propose>[0]);
    store.put('plan-origins', plan.id, { sourceMessageId: source?.id, projectId: source?.projectId, conversationId: source?.conversationId, todoId: source?.todoId });
    // A model cannot approve the policy changes it just proposed.
    if (source && plan.tasks.some(task => task.policy !== undefined)) store.put('input-paused', source.id, { planId: plan.id });
    // Explicit start from the main Agent follows a current user request. Other plans await the Web action.
    return input.start === true && source && !plan.tasks.some(task => task.policy !== undefined) ? plans.start(plan.id, plan.version) : plan;
  }
  async function answerQuestion(id: string, version: number, text: string): Promise<Json> {
    const source = agent.currentInput();
    const card = store.get<import('./interactions.ts').Card>('interactions', id);
    if (!source || !card) throw new InputError('没有当前用户输入或交互卡不存在', 404);
    if (card.kind !== 'question') throw new InputError('权限、计划和验收卡需要用户直接确认，主 Agent 不能代批', 403);
    const origin = store.get<{ inputId?: string }>('interaction-origins', id);
    if (origin?.inputId === source.id) throw new InputError('不能自行回答当前轮次刚提出的问题', 403);
    answeredInCurrentTurn.add(id);
    try { return await interactions.answer(id, version, text, 'user_chat') as unknown as Json; }
    finally { answeredInCurrentTurn.delete(id); }
  }
  async function executeApproved(approval: Approval): Promise<Json> {
    if (approval.todoId && !store.get<Todo>('todos', approval.todoId)) throw new InputError('关联待办不存在', 404);
    // A persisted binding wins over a mutated kind/params: never fall through to
    // another handler or the generic plugin acknowledgement for an edited approval.
    if (approval.kind === inboxHandlingApprovalKind || store.get('inbox-handling.approvals',approval.id)) return inboxHandling.executeApproved(approval);
    if (approval.params.outboxId) return await background.outbox.approve(approval) as unknown as Json;
    if (approval.kind === knowledgeSourceApprovalKind) { knowledgeSourceApproval.approve(approval); return {jobId:approval.params.jobId,queued:true}; }
    if (approval.kind === scheduledWorkApprovalKind) return scheduledWork.approveCreation(approval);
    if (approval.kind.startsWith('plugin:')) return {accepted:true,kind:approval.kind};
    if (approval.kind === 'dispatch') {
      const params: JsonObject = { ...approval.params, ...(approval.todoId ? { todoId: approval.todoId } : {}) };
      if (params.nativeResume !== undefined) await agentSessions.validateExecution(params);
      scheduledWork.assertDispatchCurrent(approval);
      const run = dispatch(params, `approval:${approval.id}:${approval.version}`, true);
      return { accepted: true, runId: run.id };
    }
    if (approval.kind === 'input') return inputRun(requiredText(approval.params.id, '执行记录'), requiredText(approval.params.text, '输入'), `approval:${approval.id}:${approval.version}`);
    if (!replyToFeishu) throw new InputError('飞书连接不可用', 503);
    await replyToFeishu(requiredText(approval.params.chatId, '目标会话'), requiredText(approval.params.text, '回复内容'), `approval:${approval.id}:${approval.version}`);
    return { accepted: true, identity: 'bot', todoCompleted: false };
  }
  function finishRun(run: Run, result: ExecutionResult) {
    const messageId = `run-result:${run.id}`;
    if (store.get('messages', messageId)) return;
    const now = new Date().toISOString();
    const progress = run.nativeResultSources?.includes(result.source) ? executionProgress(result.progress) : undefined;
    const usage = run.nativeResultSources?.includes(result.source) && executionUsage(result.usage?.input, result.usage?.output);
    const changes = run.nativeResultSources?.includes(result.source) && commitChanges(result.commitChanges);
    const next: Run = { ...run, ...(changes ? { commitChanges: changes } : {}), ...(usage ? { usage } : {}), ...(progress ? { progress } : {}), ...(typeof result.nativeSessionId === 'string' ? { nativeSessionId: result.nativeSessionId } : {}), status: result.state === 'completed' ? 'completed' : 'failed', output: result.text, resultSource: result.source, updatedAt: now };
    const message: Message = { id: messageId, conversationId: run.conversationId, role: 'assistant', origin: 'result', replyTo: run.sourceMessageId, projectId: run.projectId, todoId: run.todoId,
      text: `执行${next.status === 'completed' ? '完成' : '失败'}：${run.prompt}\n${result.text || '执行端没有返回文字结果'}\n结果来源：${result.source}；关联待办需你验收后再完成。`, status: 'done', createdAt: now };
    store.transaction(() => { store.put('runs', run.id, next); store.put('messages', messageId, message); store.put('notifications.source-presence',`run:${run.id}`,{present:presence.status().present}); background.publish({type:'run.finished',typeVersion:1,sourceId:`run:${run.id}:finished`,data:{runId:run.id,messageId,status:next.status},subject:{kind:'run',id:run.id}}); });
    changed('runs.changed', { id: run.id }); changed('messages.changed', { messageId }); changed('runs.result', { runId: run.id, messageId });
  }
  // A crash does not tell us whether an external action ran. Never replay it on startup.
  for (const run of store.list<Run>('runs')) {
    if (run.status === 'running' || run.status === 'queued') {
      store.put('runs', run.id, { ...run, status: 'unknown', error: '服务重启，执行结果尚未确认', updatedAt: new Date().toISOString() });
    }
  }
  function changed(type: string, data: unknown) { events.publish(type, data as Json); }
  function knowledge(): KnowledgeBackend {
    const backend = contributions.list('knowledge_backends')[0]?.value;
    if (!backend) throw new InputError('请启用本地知识库插件', 503);
    return {
      ...(backend.revision ? { revision: backend.revision.bind(backend) } : {}),
      list: query => backend.list(query), remove: id => backend.remove(id),
      async put(input, expectedUpdatedAt, editSource) {
        const payload = { ...(input.aliases === undefined ? {} : { aliases: input.aliases }), ...(input.contentLocked === undefined ? {} : { contentLocked: input.contentLocked }), ...(input.confirmedFacts === undefined ? {} : { confirmedFacts: input.confirmedFacts }), ...(input.relevance === undefined ? {} : { relevance: input.relevance }), ...(input.importance === undefined ? {} : { importance: input.importance }), ...(input.tags === undefined ? {} : { tags: input.tags }), layer: input.layer, title: input.title, content: input.content, ...(input.id === undefined ? {} : { id: input.id }), ...(input.projectId === undefined ? {} : { projectId: input.projectId }) };
        const value = await plugins.invocations.invoke('knowledge.put', payload, async changed => {
          if (!changed || typeof changed !== 'object' || Array.isArray(changed)) throw new PluginCallError('知识钩子必须返回对象');
          for (const field of ['id', 'layer', 'projectId'] as const) if (changed[field] !== payload[field]) throw new PluginCallError('知识钩子不能改变归属或标识');
          return await backend.put(changed as unknown as Parameters<KnowledgeBackend['put']>[0], expectedUpdatedAt, editSource) as unknown as Json;
        });
        return value as unknown as KnowledgeEntry;
      },
    };
  }
  async function confirmKnowledgeTodo(args: Record<string, unknown>): Promise<Json> {
    const actor = currentAgentInput() ?? agent.currentInput();
    if (!actor || actor.role !== 'user' || actor.readOnly || actor.todoId || (actor.origin && actor.origin !== 'user'))
      throw new InputError('确认行动项需要当前用户在工作台或项目对话中提出', 403);
    assertBotInput(actor);
    const projectId = actor.projectId ?? optionalText(args.projectId, '项目');
    const results = await confirmKnowledgeActions(args, projectId);
    return (args.actions === undefined ? results[0] : { results }) as unknown as Json;
  }
  async function prepareKnowledgeActions(args: Record<string, unknown>, projectId?: string) {
    if (!plugins.list().some(p => p.id === 'builtin-tools' && p.status === 'active')) throw new InputError('请先启用基础工具插件', 409);
    const id = requiredText(args.id, '知识页标识');
    const page = (await knowledge().list()).find(item => item.id === id);
    if (!page || (projectId && (page.layer !== 'project' || page.projectId !== projectId)) ||
        (page.projectId && !projects.list().some(p => p.id === page.projectId && !p.archivedAt))) throw new InputError('知识页不可用', 404);
    if (page.updatedAt !== requiredText(args.updatedAt, '已读版本')) throw new InputError('会议资料已有新版本，请重新核对行动项', 409);
    const batch = args.actions !== undefined;
    if (batch && (args.actionLine !== undefined || args.dueAt !== undefined)) throw new InputError('批量确认须逐项填写原文和期限');
    const selected = batch ? args.actions : [args];
    if (!Array.isArray(selected) || !selected.length) throw new InputError('请选择行动项');
    const counts = new Map<string, number>();
    for (const raw of page.content.split(/\r\n|[\r\n]/)) {
      const line = raw.trim();
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    const seen = new Set<string>();
    const items = selected.map((item: unknown) => {
      if (!item || typeof item !== 'object' || !('actionLine' in item)) throw new InputError('缺少行动项原文');
      const line = requiredText(item.actionLine, '行动项原文');
      if (counts.get(line) !== 1) throw new InputError('行动项须唯一匹配已读正文中的完整一行');
      if (seen.has(line)) throw new InputError('同一批中行动项不能重复');
      seen.add(line);
      const dueAt = dueDate('dueAt' in item ? item.dueAt : undefined);
      if (dueAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(dueAt)) throw new InputError('行动项期限需要带时区的 ISO 时间');
      const key = createHash('sha256').update(JSON.stringify([id, page.layer, page.projectId, line])).digest('hex');
      return { line, dueAt, key };
    });
    return { page, items };
  }
  // A run or its originating message identifies the task. Titles and project membership alone are ambiguous.
  function pendingUserCards() {
    return interactions.list().filter(card => card.status === 'open' && card.handler === 'user').map(card => {
      const inputId = !card.runId && store.get<{ inputId?: string }>('interaction-origins', card.id)?.inputId;
      const source = card.runId ? store.get<Run>('runs', card.runId) : inputId ? store.get<Message>('messages', inputId) : undefined;
      const todoId = source?.projectId === card.projectId ? source?.todoId : undefined;
      return { ...card, todoId };
    });
  }
  function readReminderDeliveries(todo: Todo) {
    const reference = todo.reminderAt ? reminderReference(todo) : undefined;
    return reference ? background.outbox.list().filter(item =>
      item.owner === 'reminders' && item.channel === 'feishu.bot' && item.relatedTo?.kind === 'todo' && item.relatedTo.id === todo.id &&
      item.staleIf?.ref === reference.ref && item.staleIf.version === reference.version
    ).map(({ status, updatedAt }) => ({ status, updatedAt })) : [];
  }
  function todoDetail(args: Record<string, unknown>): Json {
    const id = requiredText(args.todoId, '待办标识');
    const todo = store.get<Todo>('todos', id);
    if (!todo) throw new InputError('待办不存在', 404);
    const replyTracking = waitingReplies.summary(id);
    const pendingRequests = pendingUserCards().filter(card => card.todoId === id && card.projectId === todo.projectId)
      .map(({ kind, title, body, suggestion }) => ({ kind, title, body, suggestion }));
    const reminderDeliveries = readReminderDeliveries(todo);
    return { todo, pendingRequests, replyTracking, reminderDeliveries, decisions: todoDecisions.list(id), ...actionTodoLink(todo) } as unknown as Json;
  }
  async function knowledgeActionStatus(args: Record<string, unknown>, projectId?: string) {
    const { page, items } = await prepareKnowledgeActions(args, projectId);
    return { results: items.map(({ line, key }) => {
      const linkedId = store.get<string>('knowledge.action-todos', key);
      if (!linkedId) return { actionLine: line, status: 'unlinked' };
      const todo = store.get<Todo>('todos', linkedId);
      if (!todo || todo.projectId !== page.projectId) return { actionLine: line, status: 'unavailable' };
      return { actionLine: line, status: todo.completedAt ? 'completed' : 'open', todoId: todo.id, title: todo.title, ...actionTodoLink(todo),
        ...(todo.completedAt ? { completedAt: todo.completedAt } : {}), ...(todo.dueAt ? { dueAt: todo.dueAt } : {}) };
    }) };
  }
  async function confirmKnowledgeActions(args: Record<string, unknown>, projectId?: string) {
    const { page, items } = await prepareKnowledgeActions(args, projectId);
    // All selected actions share a transaction and source revision, including repeated confirmations.
    const results = store.transaction(() => items.map(({ line, dueAt, key }) => {
      const existing = store.get<string>('knowledge.action-todos', key);
      if (existing) {
        const todo = store.get<Todo>('todos', existing);
        if (!todo || todo.projectId !== page.projectId) throw new InputError('先前确认的待办已删除或移动，请人工核对', 409);
        return { created: false, todo, ...actionTodoLink(todo) };
      }
      const todo = createTodo({ title: line, projectId: page.projectId, dueAt,
        notes: '来源：' + page.title + '\n知识页：' + page.id + '\n来源版本：' + page.updatedAt + '\n行动项原文：' + line }, false);
      store.put('knowledge.action-todos', key, todo.id);
      return { created: true, todo, ...actionTodoLink(todo) };
    }));
    for (const result of results) if (result.created) changed('todos.changed', { id: result.todo.id });
    return results;
  }

  async function changeKnowledgeMetadata(field: 'facts' | 'alias' | 'tag' | 'importance' | 'relevance', args: Record<string, unknown>): Promise<Json> {
    const id = requiredText(args.id, '知识页标识');
    const version = requiredText(args.updatedAt, '已读版本');
    const actor = currentAgentInput() ?? agent.currentInput();
    if (!actor || actor.role !== 'user' || actor.readOnly || (actor.origin && actor.origin !== 'user'))
      throw new InputError('修改知识页需要当前用户输入', 403);
    assertBotInput(actor);
    const projectId = actor.projectId ?? optionalText(args.projectId, '项目');
    const backend = knowledge();
    const page = (await backend.list()).find(item => item.id === id);
    if (!page || (projectId && (page.layer !== 'project' || page.projectId !== projectId)) ||
        (page.projectId && !projects.list().some(p => p.id === page.projectId && !p.archivedAt))) throw new InputError('知识页不可用', 404);
    if (page.updatedAt !== version) throw new InputError('知识页已有新版本，请重新核对', 409);
    let update: Pick<Parameters<KnowledgeBackend['put']>[0], 'importance' | 'aliases' | 'tags' | 'relevance' | 'confirmedFacts'>;
    if (field === 'facts') {
      const before = args.previousText, after = args.text, current = page.confirmedFacts ?? '';
      if (typeof after !== 'string' || (before !== undefined && (typeof before !== 'string' || !before)))
        throw new InputError('请提供确认文本，更正时须提供原文片段');
      let next;
      if (before === undefined) {
        if (!after.trim()) throw new InputError('新增确认事实不能为空');
        if (('\n' + current + '\n').includes('\n' + after + '\n')) return { id, changed: false, updatedAt: version };
        next = current ? current + '\n' + after : after;
      } else {
        const at = current.indexOf(before);
        if (at < 0 || current.indexOf(before, at + 1) >= 0) throw new InputError('原文片段未唯一匹配，请核对已确认事实');
        next = current.slice(0, at) + after + current.slice(at + before.length);
      }
      if (!next.trim()) next = '';
      if (next === current) return { id, changed: false, updatedAt: version };
      update = { confirmedFacts: next };
    } else if (field === 'relevance') {
      const score = args.relevance;
      if (score !== null && (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 100)) throw new InputError('请指定 0 至 100 的整数，或传 null 清除相关度');
      if ((page.relevance ?? null) === score) return { changed: false, id, relevance: score, updatedAt: version };
      update = { relevance: score };
    } else if (field === 'importance') {
      const level = args.importance;
      if (level !== null && level !== 'P0' && level !== 'P1' && level !== 'P2' && level !== 'P3') throw new InputError('请指定 P0 至 P3，或传 null 清除重要级');
      if ((page.importance ?? null) === level) return { changed: false, id, importance: level, updatedAt: version };
      update = { importance: level };
    } else {
      const key = field === 'alias' ? 'aliases' : 'tags';
      const label = field === 'alias' ? '别名' : '标签';
      const name = requiredText(args[field], label);
      if (name.length > 100 || /[\r\n]/.test(name) || (args.action !== 'add' && args.action !== 'remove')) throw new InputError(label + '或操作无效');
      const names = page[key] ?? [];
      const add = args.action === 'add';
      if (names.includes(name) === add) return { changed: false, id, [key]: names, updatedAt: version };
      update = { [key]: add ? [...names, name] : names.filter(value => value !== name) };
    }
    const route = store.get<MessageRoute>('message.routes', actor.id);
    const saved = await backend.put({ ...page, ...update }, version, route?.channel === 'feishu' ? 'feishu' : 'conversation');
    const receipt = { changed: true, id, aliases: saved.aliases ?? [], tags: saved.tags ?? [], importance: saved.importance ?? null, relevance: saved.relevance ?? null, updatedAt: saved.updatedAt };
    try { await knowledgeCurator.rebuildIndex(); }
    catch { return { ...receipt, warning: '知识页已保存，知识索引刷新失败' }; }
    finally { changed('knowledge.changed', { id }); }
    return receipt;
  }
  async function knowledgeRevision(id: string, commit?: string, projectId?: string) {
    const backend = knowledge();
    const current = (await backend.list()).find(page => page.id === id);
    const visible = (entry: KnowledgeEntry) =>
      (projectId === undefined || (entry.layer === 'project' && entry.projectId === projectId)) &&
      (!entry.projectId || projects.list().some(p => p.id === entry.projectId && !p.archivedAt));
    if (!current || !visible(current)) throw new InputError('知识页不可用', 404);
    if (!backend.revision) throw new InputError('当前知识插件不支持版本记录', 503);
    const result = await backend.revision(id, commit);
    return result && result.entry.id === id && result.entry.layer === current.layer &&
      result.entry.projectId === current.projectId && visible(result.entry) ? result : null;
  }
  function todos(): Todo[] {
    return store.list<Todo>('todos').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  function readInbox(input: Record<string, unknown>): Json {
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new InputError('收件箱分页参数无效');
    const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
    const items = inbox.list().filter(item => !excludesPersonalGroupFromBrief(item) && (!input.projectId || item.projectId === input.projectId) && (!input.todoId || item.todoId === input.todoId)
      && (!input.kind || (item.origin?.kind ?? 'unknown') === input.kind) && (input.mentionedMe !== true || (item.origin?.kind === 'group' && item.origin.mentionedMe === true))
      && (input.meetingMinutes !== true || item.origin?.meetingMinutes === true)
      && (!query || [item.title, item.text, item.origin?.chatName, item.origin?.senderName].some(text => text?.toLowerCase().includes(query))));
    return { items: items.slice(offset as number, (offset as number) + (limit as number)), total: items.length, offset, hasMore: (offset as number) + (limit as number) < items.length } as unknown as Json;
  }
  function readInboxHandlingFromAgent(input: Record<string,unknown>):Json {
    if(!['personal','mailbox'].includes(String(input.kind)))throw new InputError('请选择收件来源');
    const actor=currentAgentInput()??agent.currentInput();
    if(!actor)throw new InputError('缺少当前会话范围',403);
    assertBotInput(actor);
    if(configuredBots().some(bot=>actor.conversationId.startsWith(`bot:${bot.id}:`)&&bot.scope.kind==='unmarked'&&!actor.projectId&&!actor.todoId))throw new InputError('未归类身份不能读取收件处理记录',403);
    const own:BotScope=actor.todoId?{kind:'task',todoId:actor.todoId,...(actor.projectId?{projectId:actor.projectId}:{})}:actor.projectId?{kind:'project',projectId:actor.projectId}:{kind:'global'};
    const ref={kind:input.kind as 'personal'|'mailbox',id:requiredText(input.id,'收件标识')};
    const source=inboxHandlingSources(ref);
    const target:BotScope=source.todoId?{kind:'task',todoId:source.todoId,...(source.projectId?{projectId:source.projectId}:{})}:source.projectId?{kind:'project',projectId:source.projectId}:{kind:'global'};
    if(!canRelayBotScope(own,target))throw new InputError('不能读取其他范围的收件处理记录',403);
    const view=inboxHandling.read(ref);
    // Web belongs to the authenticated owner. A scoped model gets only this
    // revision, so reassignment never imports another project's old discussion.
    return (own.kind==='global'?view:{...view,messages:view.messages.filter(message=>message.conversationId===view.conversationId),suggestions:view.suggestions.filter(item=>item.conversationId===view.conversationId)}) as unknown as Json;
  }
  function assignInboxProject(input: Record<string, unknown>): Json {
    const source = currentAgentInput() ?? agent.currentInput();
    if (!source || source.role !== 'user' || source.readOnly) throw new InputError('归入项目需要当前用户输入，不能依据只读回报执行', 403);
    assertBotInput(source);
    if (source.conversationId !== 'main' && botForConversation(configuredBots(), source.conversationId)?.scope.kind !== 'global') throw new InputError('只有主对话或全局机器人能调整收件箱项目归属', 403);
    return inbox.assignProject(requiredText(input.id, '收件消息'), input.version as number, optionalText(input.projectId, '项目')) as unknown as Json;
  }
  function todoPriority(value: unknown): NonNullable<Todo['priority']> {
    if (value === undefined) return 'normal';
    if (value === 'high' || value === 'normal' || value === 'low') return value;
    throw new InputError('待办优先级须为 high、normal 或 low');
  }
  function parentFor(value: unknown, projectId: string | undefined, childId?: string) {
    const parentId = optionalText(value, '上级待办');
    const seen = new Set([childId]);
    let id = parentId;
    while (id) {
      if (seen.has(id)) throw new InputError('待办层级不能形成循环', 409);
      seen.add(id);
      const parent = store.get<Todo>('todos', id);
      if (!parent || parent.projectId !== projectId) throw new InputError('上级待办不属于当前项目', 409);
      id = parent.parentTodoId;
    }
    return parentId;
  }
  function dependenciesFor(value: unknown, parentId: string | undefined, projectId: string | undefined, childId?: string) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new InputError('前置子项须为标识数组');
    const ids = [...new Set(value.map(id => requiredText(id, '前置子项')))];
    if (!ids.length) return undefined;
    if (!parentId) throw new InputError('只有同一上级下的子项可以设置前置依赖', 409);
    const pending = [...ids], visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === childId) throw new InputError('子项依赖不能形成循环', 409);
      if (visited.has(id)) continue;
      visited.add(id);
      const item = store.get<Todo>('todos', id);
      if (!item || item.projectId !== projectId || item.parentTodoId !== parentId) throw new InputError('前置子项须属于同一上级', 409);
      pending.push(...(item.afterTodoIds ?? []));
    }
    return ids;
  }
  function newTodo(input: Record<string, unknown>): Todo {
    const now = new Date().toISOString();
    const projectId = optionalText(input.projectId, '项目');
    const parentTodoId = parentFor(input.parentTodoId, projectId);
    return { id: randomUUID(), afterTodoIds: dependenciesFor(input.afterTodoIds, parentTodoId, projectId), parentTodoId, priority: todoPriority(input.priority), responsiblePerson: optionalText(input.responsiblePerson, '负责人'), title: requiredText(input.title, '标题'), notes: optionalText(input.notes, '备注') ?? '', projectId, dueAt: dueDate(input.dueAt), reminderAt: dueDate(input.reminderAt), reminderVersion: 1, waitingOn: optionalText(input.waitingOn, '等待对象'), createdAt: now, updatedAt: now };
  }
  function registerChatTodo(input: Record<string, unknown>): Json {
    const requested = newTodo(input);
    const title = requested.title.normalize('NFC');
    const due = requested.dueAt ? Date.parse(requested.dueAt) : undefined;
    return store.transaction(() => {
      const matches = store.list<Todo>('todos').filter(todo =>
        !todo.completedAt && todo.projectId === requested.projectId && todo.parentTodoId === requested.parentTodoId && todo.title.normalize('NFC') === title &&
        (todo.dueAt ? Date.parse(todo.dueAt) : undefined) === due);
      if (matches.length > 1) throw new InputError('已有多个同名同期限待办，请查询并选定具体事项', 409);
      const existing = matches[0];
      if (existing) return { ...existing, created: false } as unknown as Json;
      store.put('todos', requested.id, requested);
      changed('todos.changed', { id: requested.id });
      return { ...requested, created: true } as unknown as Json;
    });
  }
  function createTodo(input: Record<string, unknown>, notify = true): Todo {
    const todo = newTodo(input);
    store.put('todos', todo.id, todo); if (notify) changed('todos.changed', { id: todo.id });
    return todo;
  }
  function updateTodo(id: string, patch: Record<string, unknown>): Todo {
    const todo = store.get<Todo>('todos', id);
    if (!todo) throw new InputError('待办不存在', 404);
    if (patch.expectedAfterTodoIds !== undefined) {
      const expected = patch.expectedAfterTodoIds;
      if (!Array.isArray(expected) || expected.some(id => typeof id !== 'string') || new Set(expected).size !== expected.length)
        throw new InputError('原前置子项须为不重复的标识数组');
      const current = todo.afterTodoIds ?? [];
      if (expected.length !== current.length || current.some(id => !expected.includes(id)))
        throw new InputError('前置依赖已被修改，请重新打开详情核对后再保存', 409);
    }
    if (patch.expectedTitle !== undefined && patch.expectedTitle !== todo.title) {
      throw new InputError('标题已被修改，请核对最新标题', 409);
    }
    if (patch.expectedNotes !== undefined && patch.expectedNotes !== (todo.notes ?? '')) {
      throw new InputError('备注已被修改，请核对最新备注', 409);
    }
    if (patch.expectedReminderVersion !== undefined) {
      const version = patch.expectedReminderVersion;
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)
        throw new InputError('提醒版本必须为正整数');
      if (version !== (todo.reminderVersion ?? 1)) throw new InputError('提醒已变更，请核对当前提醒后再保存', 409);
    }
    if (patch.expectedDueAt !== undefined && dueDate(patch.expectedDueAt) !== todo.dueAt) {
      throw new InputError('截止时间已被修改，请核对最新时间后重新改期', 409);
    }
    if (patch.completed !== undefined && typeof patch.completed !== 'boolean') throw new InputError('completed必须为布尔值');
    const next = { ...todo, updatedAt: new Date().toISOString() };
    if (patch.priority !== undefined) next.priority = todoPriority(patch.priority);
    if (patch.title !== undefined) next.title = requiredText(patch.title, '标题');
    if (patch.notes !== undefined) next.notes = optionalText(patch.notes, '备注') ?? '';
    if (patch.projectId !== undefined) next.projectId = optionalText(patch.projectId, '项目');
    if (patch.dueAt !== undefined) next.dueAt = dueDate(patch.dueAt);
    if (next.projectId !== todo.projectId) {
      delete next.responsibleSession;
      delete next.parentTodoId;
    }
    if (patch.parentTodoId !== undefined) next.parentTodoId = parentFor(patch.parentTodoId, next.projectId, id);
    const moved = next.projectId !== todo.projectId || next.parentTodoId !== todo.parentTodoId;
    if (moved) delete next.afterTodoIds;
    if (patch.afterTodoIds !== undefined) next.afterTodoIds = dependenciesFor(patch.afterTodoIds, next.parentTodoId, next.projectId, id);
    if (patch.responsiblePerson !== undefined) {
      next.responsiblePerson = optionalText(patch.responsiblePerson, '负责人');
      if (next.responsiblePerson) delete next.responsibleSession;
    }
    if (patch.responsibleRunId !== undefined) {
      const runId = optionalText(patch.responsibleRunId, '负责会话的执行记录');
      if (!runId) delete next.responsibleSession;
      else {
        if (patch.responsiblePerson && next.responsiblePerson) throw new InputError('请选择一种负责方');
        const run = store.get<Run>('runs', runId);
        if (!run || run.projectId !== next.projectId || !run.machineId || !run.sessionId)
          throw new InputError('执行记录没有当前项目可登记的会话', 409);
        next.responsibleSession = { runId, machineId: run.machineId, sessionId: run.sessionId };
        delete next.responsiblePerson;
      }
    }
    if (patch.waitingOn !== undefined) next.waitingOn = optionalText(patch.waitingOn, '等待对象');
    if (patch.reminderAt !== undefined) next.reminderAt = dueDate(patch.reminderAt);
    if (patch.completed !== undefined) next.completedAt = patch.completed ? new Date().toISOString() : undefined;
    const cycleChanged = next.waitingOn !== todo.waitingOn || next.reminderAt !== todo.reminderAt
      || next.projectId !== todo.projectId || !!next.completedAt !== !!todo.completedAt;
    if (cycleChanged) { next.reminderVersion = (todo.reminderVersion ?? 1) + 1; next.remindedAt = undefined; }
    store.transaction(() => {
      if (moved) {
        for (const child of store.list<Todo>('todos')) {
          const losesParent = child.parentTodoId === id && next.projectId !== todo.projectId;
          if (!losesParent && !child.afterTodoIds?.includes(id)) continue;
          const detached = { ...child, updatedAt: next.updatedAt };
          if (losesParent) {
            delete detached.parentTodoId;
            delete detached.afterTodoIds;
          } else detached.afterTodoIds = child.afterTodoIds?.filter(prerequisite => prerequisite !== id);
          store.put('todos', child.id, detached);
          changed('todos.changed', { id: child.id });
        }
      }
      store.put('todos', id, next);
      // Check the final ownership, including a combined project/completion PATCH.
      if (patch.completed === true) { reporting.assertCanComplete(id); runReview.assertCanComplete(id); }
      if (todo.completedAt && patch.completed === false) { reporting.onReopen(id); runReview.onReopen(id); }
      if (cycleChanged) waitingReplies.invalidate(id);
      changed('todos.changed', { id });
    });
    return next;
  }
  function delegateTodo(id: string): Promise<Message>;
  function delegateTodo(id: string, executorId: string, doneWhen?: unknown, expectMinutes?: unknown): Promise<Run>;
  function delegateTodo(id: string, executorId?: unknown, doneWhen?: unknown, expectMinutes?: unknown): Promise<Message | Run>;
  async function delegateTodo(id: string, executorId?: unknown, doneWhen?: unknown, expectMinutes?: unknown): Promise<Message | Run> {
    const todo = store.get<Todo>('todos', id);
    if (!todo) throw new InputError('待办不存在', 404);
    if (todo.completedAt) throw new InputError('该待办已完成', 409);
    const scope = { projectId: todo.projectId, todoId: id };
    if (executorId !== undefined) {
      const selected = requiredText(executorId, '执行者');
      const criterion = optionalText(doneWhen, '验收标准');
      const prompt = todoDelegationPrompt(todo, 'executor', criterion);
      return dispatch({ ...scope, executorId: selected, prompt, doneWhen: criterion, expectMinutes });
    }
    return agent.post(todoDelegationPrompt(todo, 'main'), 'main', scope);
  }
  function executors(): Executor[] {
    const local = contributions.list('executors').map(entry => entry.value);
    const remote: Executor[] = [];
    for (const machine of machines?.list() ?? []) {
      for (const info of machine.executors ?? []) {
        if (!contributions.list('terminal_hosts').length) continue;
        if (!contributions.list('executors').some(entry => entry.id === info.id)) continue;
        remote.push({ ...info, machineId: machine.id, id: `${machine.id}/${info.id}`, name: `${info.name} · ${machine.name}`,
          available: machine.online && info.available,
          reason: machine.online ? info.reason : '执行机离线',
          async execute({ prompt, cwd, executionMode = 'task', nativeResume, signal }) {
            signal.throwIfAborted();
            // Only this RPC adapter requires a remote working directory.
            if (!cwd?.trim()) throw Object.assign(new InputError('远端工作目录不能为空'), { delivery: 'no' });
            if (nativeResume && (nativeResume.executorId !== info.id || !machine.capabilities.includes('executor.resume'))) throw Object.assign(new InputError('执行机不支持此原生线程恢复，请升级代理', 409), { delivery: 'no' });
            const session = await machines!.call(machine.id, nativeResume ? 'executor.resume' : 'executor.start', { executorId: info.id, prompt, cwd: cwd.trim(), mode: executionMode, ...(nativeResume ? { nativeSessionId: nativeResume.nativeSessionId } : {}) });
            if (!session || typeof session !== 'object' || Array.isArray(session) || typeof session.sessionId !== 'string') throw new Error('执行机未返回有效会话');
            return { text: '已启动外部 CLI，会自动采集原生结果。', pending: true, sessionId: session.sessionId };
          },
        });
      }
    }
    return [...local.filter(entry => entry.mode === 'demo' || !remote.some(other => other.id.endsWith(`/${entry.id}`))), ...remote];
  }
  function hostStatus(id: string): Json {
    if (id === 'feishu') return channelStatus();
    if (id === 'inbox-triage') return { available: true, method: !config.demo && inboxClassifier.status().available ? 'isolated-model-with-rule-fallback' : 'local-rules', count: inbox.list().length };
    return { available: executors().some(entry => entry.mode === 'real' && entry.available), machines: machines?.list().map(machine => ({ id: machine.id, online: machine.online })) ?? [] };
  }
  function executorInfo() { return executors().map(({ execute: _, ...info }) => info); }
  function dispatch(input: Record<string, unknown>, key?: string, nativeApproved = false, executionGuard?:()=>void): Run {
    if (closing) throw new InputError('服务正在关闭', 503);
    const prompt = requiredText(input.prompt, '工作内容');
    if (input.isolatedWorktree !== undefined && typeof input.isolatedWorktree !== 'boolean') throw new InputError('独立工作树选项无效');
    const isolated = input.isolatedWorktree === true;
    const worktreeRunId = input.worktreeRunId === undefined ? undefined : requiredText(input.worktreeRunId, '工作树所属执行');
    const copies = input.copies === undefined ? 1 : input.copies;
    if (typeof copies !== 'number' || !Number.isInteger(copies) || copies < 1 || copies > 4 || copies > 1 && !isolated)
      throw new InputError('对比执行需要 2 至 4 个独立工作树');
    let requestedExecutor = optionalText(input.executorId, '执行者');
    const todoId = optionalText(input.todoId, '待办');
    const todo = todoId ? store.get<Todo>('todos', todoId) : undefined;
    const requestedProject = optionalText(input.projectId, '项目');
    const projectId = requestedProject ?? todo?.projectId;
    const conversationId = optionalText(input.conversationId, '对话') ?? 'main';
    if (conversationId !== 'main') {
      const source = typeof input.sourceMessageId === 'string' ? store.get<Message>('messages', input.sourceMessageId) : undefined;
      const allowed = conversationId.startsWith('bot:') || (projectId && conversationId === `project:${projectId}:work`);
      if (!allowed || !source || source.role !== 'user' || source.conversationId !== conversationId || source.projectId !== projectId) throw new InputError('执行对话与来源消息不匹配');
    }
    // A durable run wins over changed defaults and offline machines. Replaying a
    // key only reads its original result, including unknown; it never launches again.
    if (key) {
      const previous = store.get<string>('dispatch-keys', key);
      const run = previous && store.get<Run>('runs', previous);
      if (run) {
        const requestHash = store.get<string>('dispatch-prompt-hashes', key);
        const samePrompt = requestHash ? createHash('sha256').update(prompt).digest('hex') === requestHash : run.prompt === prompt;
        if (!samePrompt || (requestedExecutor !== undefined && run.executorId !== requestedExecutor)
          || run.projectId !== projectId || run.conversationId !== conversationId
          || run.worktreeRunId !== worktreeRunId || (run.comparisonRunIds?.length ?? 1) !== copies || Boolean(run.worktree) !== isolated || (input.cwd !== undefined && (run.worktree?.source ?? run.cwd) !== input.cwd)
          || run.todoId !== todoId || run.sourceMessageId !== optionalText(input.sourceMessageId, '来源消息')
          || (input.executionMode !== undefined && run.executionMode !== input.executionMode)
          || (input.doneWhen !== undefined && run.doneWhen !== input.doneWhen)
          || (input.expectMinutes !== undefined && run.expectMinutes !== input.expectMinutes) || JSON.stringify(run.nativeResume) !== JSON.stringify(input.nativeResume)) throw new InputError('同一派发标识不能用于不同工作', 409);
        return run;
      }
    }
    const nativeResume = input.nativeResume === undefined ? undefined : nativeResumeSpec(input.nativeResume);
    if (nativeResume && !nativeApproved) throw new InputError('原生恢复必须先通过明确的恢复审批，不能直接派发', 403);
    // A robot's optional executor binding is enforced here, not only in its prompt.
    // Durable idempotent results above remain readable after a later rebind.
    const inputMessage = typeof input.sourceMessageId === 'string' ? store.get<Message>('messages', input.sourceMessageId) : undefined;
    assertBotInput(inputMessage);
    requestedExecutor = optionalText(pinBotExecutor(configuredBots(), inputMessage, requestedExecutor), '执行者');
    const project = projectId ? store.get<Project>('projects', projectId) : undefined;
    if (projectId && !project) throw new InputError('项目不存在', 404);
    if (project?.archivedAt) throw new InputError('项目已归档，不能派发工作', 409);
    const workspace = project?.workspace;
    const entries = executors();
    const explicitExecutor = entries.find(entry => entry.id === requestedExecutor);
    if (workspace && requestedExecutor && explicitExecutor && explicitExecutor.machineId !== workspace.machineId) throw new InputError('执行者不在项目绑定的电脑上', 409);
    if (workspace) {
      // Persisted computer metadata is not evidence of a live connection.
      const computer = machines?.list().find(machine => machine.id === workspace.machineId);
      if (!computer?.online) throw new InputError('项目绑定的电脑离线或尚未连接', 503);
    }
    const choices = entries.filter(entry => entry.available && (!workspace || (entry.machineId === workspace.machineId && entry.mode === 'real')));
    const executorId = requestedExecutor ?? (config.demo ? choices.find(entry => entry.mode === 'demo')?.id : undefined) ?? choices.find(entry => /codex/i.test(entry.id))?.id ?? choices[0]?.id;
    if (!executorId) throw new InputError(workspace ? '项目绑定的电脑没有可用执行者' : '没有可用执行者，请连接执行机', 503);
    const executor = entries.find(entry => entry.id === executorId);
    if (workspace && executor && (executor.machineId !== workspace.machineId || executor.mode !== 'real')) throw new InputError('执行者不在项目绑定的电脑上或不支持真实执行', 409);
    // Explicit approved parameters retain priority over project defaults.
    const parentRun = worktreeRunId ? store.get<Run>('runs', worktreeRunId) : undefined;
    if (worktreeRunId) {
      if (!plugins.list().some(p => p.id === 'run-comparison' && p.status === 'active')) throw new InputError('执行对比插件已停用', 503);
      if (!workspace || !parentRun?.worktree?.branch || parentRun.projectId !== projectId || parentRun.machineId !== workspace.machineId
        || parentRun.worktree.source !== workspace.cwd || parentRun.worktree.removedAt || !parentRun.cwd)
        throw new InputError('原执行工作树不可用或项目绑定已变化', 409);
      if (isolated || nativeResume || !requestedExecutor || input.cwd !== undefined && input.cwd !== parentRun.cwd)
        throw new InputError('复用工作树需要指定执行者并使用原执行目录');
      if (!machines?.list().some(m => m.id === workspace.machineId && m.capabilities.includes('workspace.inspectRunWorktree')))
        throw new InputError('请升级执行机代理以核对原工作树', 409);
    }
    const cwd = optionalText(input.cwd, '工作目录') ?? parentRun?.cwd ?? workspace?.cwd ?? executor?.defaultCwd;
    if (cwd && [...cleaningWorktrees.values()].some(tree => tree.machineId === executor?.machineId &&
      (join(cwd) === tree.cwd || join(cwd).startsWith(tree.cwd + '/')))) throw new InputError('执行目录正在清理', 409);
    const executionMode = input.executionMode ?? 'task';
    if (isolated) {
      if (!plugins.list().some(p => p.id === 'run-comparison' && p.status === 'active')) throw new InputError('执行对比插件已停用', 503);
      if (!workspace || cwd !== workspace.cwd || !requestedExecutor || executionMode !== 'task' || nativeResume)
        throw new InputError('独立工作树需要绑定项目根目录、指定执行者和新任务模式');
      if (!machines?.list().some(m => m.id === workspace.machineId && m.capabilities.includes('workspace.prepareRunWorktree') && (copies === 1 || m.capabilities.includes('workspace.worktreeBase'))))
        throw new InputError('请升级执行机代理以创建独立工作树', 409);
    }
    if (executor?.taskOnly && executionMode !== 'task') throw new InputError('此执行器仅支持任务模式');
    if (!['task', 'interactive'].includes(String(executionMode))) throw new InputError('executionMode必须为task或interactive');
    const doneWhen = optionalText(input.doneWhen, '验收标准');
    const expectMinutes = input.expectMinutes;
    if (expectMinutes !== undefined && (typeof expectMinutes !== 'number' || !Number.isFinite(expectMinutes) || expectMinutes <= 0 || expectMinutes > 10080)) throw new InputError('预计时长必须为1周内的正数分钟');
    if (executor?.mode === 'real' && executionMode === 'task' && (!doneWhen || !expectMinutes)) throw new InputError('真实任务需要验收标准 doneWhen 和预计时长 expectMinutes');
    const taskPolicy = input.policy as Partial<PolicyConfig> | undefined;
    if (taskPolicy !== undefined) {
      try { validatePolicyPatch(taskPolicy); } catch (error) { throw new InputError(error instanceof Error ? error.message : '无效任务策略'); }
    }
    if (todoId && !todo) throw new InputError('关联待办不存在', 404);
    if (todo && todo.projectId !== projectId) throw new InputError('待办与派单项目不匹配', 409);
    if (todo && ((inputMessage?.todoId && inputMessage.todoId !== todoId) ||
      (inputMessage?.projectId && inputMessage.projectId !== projectId))) throw new InputError('待办与来源消息的范围不匹配', 403);
    if (!executor?.available) throw new InputError(executor?.reason ?? '执行者不可用', 503);
    const now = new Date().toISOString();
    const proofSources = nativeResultSources(executor);
    const ids = Array.from({ length: copies }, () => randomUUID());
    const runs = ids.map((id): Run => ({
      id, executorId, conversationId, prompt, projectId, todoId, doneWhen,
      ...(copies > 1 && { comparisonRunIds: ids }),
      ...(worktreeRunId && { worktreeRunId }),
      ...(isolated && workspace && { worktree: { source: workspace.cwd } }),
      ...(nativeResume && { nativeResume }),
      ...(proofSources.length && { nativeResultSources: proofSources }),
      ...(executor.mode === 'real' && { machineId: executor.machineId }),
      cwd: isolated && workspace ? join(workspace.cwd + '-worktrees', id) : cwd,
      executionMode: executionMode as Run['executionMode'], sourceMessageId: optionalText(input.sourceMessageId, '来源消息'),
      expectMinutes: expectMinutes as number | undefined, status: 'queued', output: '', createdAt: now, updatedAt: now,
    }));
    store.transaction(() => {
      for (const run of runs) {
        store.put('runs', run.id, run);
        if (taskPolicy) policies.write({ runId: run.id, ...(run.projectId ? { projectId: run.projectId } : {}) }, taskPolicy, { notify: false });
      }
      if (key) store.put('dispatch-keys', key, runs[0]!.id);
    });
    if (taskPolicy) changed('policies.changed', {});
    // Git checkout is serialized within the group. Once a checkout finishes its executor can run alongside the others.
    let commonBase: Promise<Json> | undefined;
    let previousCheckout = Promise.resolve();
    for (const run of runs) {
      const destination = run.cwd;
      const controller = new AbortController(); controllers.set(run.id, controller);
      changed('runs.changed', { id: run.id });
      // Launch asynchronously so a long-running executor never holds the HTTP request open.
      const job = Promise.resolve().then(async () => {
        const update = (patch: Partial<Run>) => {
          const next = { ...store.get<Run>('runs', run.id)!, ...patch, updatedAt: new Date().toISOString() };
          store.put('runs', run.id, next); changed('runs.changed', { id: run.id });
        };
        update({ status: 'running' });
        try {
          const original = JSON.parse(JSON.stringify(run)) as JsonObject;
          const prepared = await plugins.invocations.hooks('work.dispatch', 'before', original);
          if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) throw new PluginCallError('派活钩子必须返回对象');
          for (const field of Object.keys(original)) if (field !== 'prompt' && JSON.stringify(prepared[field]) !== JSON.stringify(original[field])) throw new PluginCallError('派活钩子只能改写 prompt，不能改变执行者、模式或工作范围');
          const effectivePrompt = requiredText(prepared.prompt, '钩子改写后的任务');
          if (executionGuard && effectivePrompt !== prompt) throw Object.assign(new InputError('已确认的收件任务内容不能被钩子改写', 409), { delivery: 'no' });
          if (effectivePrompt !== prompt) {
            if (key) store.put('dispatch-prompt-hashes', key, createHash('sha256').update(prompt).digest('hex'));
            update({ prompt: effectivePrompt });
          }
          // Keep the run's task separate: review/rework reuses it and resolves current decisions again.
          const currentDecisions = () => {
            if (!todoId) return '';
            const current = store.get<Todo>('todos', todoId);
            if (!current || current.projectId !== projectId) {
              throw Object.assign(new InputError('待办归属已变更，请核对后重新派单', 409), { delivery: 'no' });
            }
            return todoDecisions.context(todoId);
          };
          // Exact approved payloads and existing native threads retain their original terms.
          const guidance = projectId && !nativeApproved && !executionGuard ? await currentProjectInstructions(projectId) : '';
          const decisions = currentDecisions();
          const includeOfficeGuide = executor.mode === 'real' && executionMode === 'task' && !nativeApproved && !executionGuard
            && plugins.list().some(plugin => plugin.id === 'office-documents' && plugin.status === 'active')
            && machines?.list().some(machine => machine.id === executor.machineId && machine.online && machine.capabilities.includes('office.guide'));
          const checkWorktreeBinding = () => {
            if ((!isolated && !worktreeRunId) || !workspace) return;
            const currentProject = store.get<Project>('projects', projectId!);
            if (!plugins.list().some(p => p.id === 'run-comparison' && p.status === 'active') || currentProject?.archivedAt
              || currentProject?.workspace?.cwd !== workspace.cwd || currentProject.workspace.machineId !== workspace.machineId)
              throw Object.assign(new InputError('项目绑定或执行对比插件已变更，请重新核对', 409), { delivery: 'no' });
          };
          if (isolated && workspace) {
            executionGuard?.();
            assertBotInput(inputMessage);
            controller.signal.throwIfAborted();
            checkWorktreeBinding();
            let base: string | undefined;
            if (copies > 1) {
              commonBase ??= machines!.call(workspace.machineId, 'workspace.worktreeBase', { cwd: workspace.cwd });
              const value = await commonBase;
              if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('工作树起点回执无效');
              base = value;
              update({ worktree: { source: workspace.cwd, base } });
            }
            const params = { cwd: workspace.cwd, id: run.id, ...(base && { base }) };
            const checkout = previousCheckout.then(() => {
              controller.signal.throwIfAborted();
              checkWorktreeBinding();
              assertBotInput(inputMessage);
              return effects.perform({ key: `run:${run.id}:worktree`, kind: 'workspace.prepareRunWorktree',
                target: workspace.machineId, summary: '为本次任务创建独立工作树', content: params,
                run: () => machines!.call(workspace.machineId, 'workspace.prepareRunWorktree', params, { timeoutMs: 90000 }) });
            });
            previousCheckout = checkout.then(() => {}, () => {});
            const receipt = await checkout;
            if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.cwd !== destination
              || (base !== undefined && receipt.base !== base) || receipt.branch !== 'super-mario/' + run.id || typeof receipt.base !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt.base))
              throw Object.assign(new Error('工作树回执无效，请核对执行机'), { delivery: 'unknown' });
            update({ worktree: { source: workspace.cwd, branch: receipt.branch, base: receipt.base } });
          }
          const isolationGuide = worktreeRunId ? '本次在原执行工作树中开始新任务。先核对现有文件和未提交修改，保留已有工作。仅报告本次产生的结果和验证证据。' : isolated ? '本次使用独立 Git 工作树。所有项目改动在当前工作目录中完成，记录改动文件、提交和测试证据；合并和清理工作树由用户决定。' : '';
          const acceptance = executionMode === 'task' && doneWhen && !nativeApproved && !executionGuard
            ? '本次任务的验收标准：' + JSON.stringify(doneWhen) + '\n交付时逐项给出实际核验结果和证据。未能验证的条件请说明原因。'
            : '';
          const finalPrompt = [effectivePrompt, acceptance, decisions, guidance, isolationGuide, includeOfficeGuide ? officeWorkerGuide : ''].filter(Boolean).join('\n\n');
          const execute = async () => {
            controller.signal.throwIfAborted();
            if (worktreeRunId) {
              const state = await runWorktreeStatus(worktreeRunId).catch(error => {
                // Only the read was sent. The executor has not been invoked.
                throw Object.assign(new Error(error instanceof Error ? error.message : '原工作树状态未核实'), { delivery: 'no' });
              });
              if (!state || typeof state !== 'object' || Array.isArray(state) || state.cwd !== destination || state.branch !== parentRun?.worktree?.branch)
                throw Object.assign(new InputError('工作树目录或分支已变化，执行未启动', 409), { delivery: 'no' });
              controller.signal.throwIfAborted();
            }
            checkWorktreeBinding();
            executionGuard?.();
            assertBotInput(inputMessage);
            if (currentDecisions() !== decisions) {
              throw Object.assign(new InputError('待办决定已变更，请核对后重新派单', 409), { delivery: 'no' });
            }
            const result = await executor.execute({ prompt: finalPrompt, cwd: destination, executionMode: run.executionMode, ...(nativeResume ? { nativeResume } : {}), signal: controller.signal, onOutput: text => update({ output: (store.get<Run>('runs', run.id)?.output ?? '') + text }) });
            if (result.sessionId) update({ sessionId: result.sessionId });
            const metadata = JSON.parse(JSON.stringify(result)) as JsonObject;
            const evidenceSnapshot = JSON.stringify(metadata.nativeResult);
            const decorated = await plugins.invocations.hooks('work.dispatch', 'after', metadata);
            if (!decorated || typeof decorated !== 'object' || Array.isArray(decorated) || typeof decorated.text !== 'string' || decorated.sessionId !== metadata.sessionId || decorated.pending !== metadata.pending || JSON.stringify(decorated.nativeResult) !== evidenceSnapshot) throw new PluginCallError('结果钩子只能改写展示正文，不能伪造原生会话或完成状态', true);
            const { nativeResult: _rawProof, ...display } = result;
            return { ...display, text: decorated.text, ...(evidenceSnapshot === undefined ? {} : { nativeResult: JSON.parse(evidenceSnapshot) as ExecutionResult }) };
          };
          const result = executor.mode === 'real'
            ? await effects.perform({ key: `run:${run.id}:start`, kind: nativeResume ? 'executor.resume' : 'executor.start', target: executor.machineId, summary: prompt, content: { executorId, prompt: finalPrompt, ...(nativeResume ? { nativeResume: { ...nativeResume } } : {}), ...(destination === undefined ? {} : { cwd: destination }), executionMode: String(executionMode) }, run: execute })
            : await execute();
          if (nativeResume && !result.pending && !controller.signal.aborted) {
            const proof = result.nativeResult;
            if (!proof || !['completed', 'failed'].includes(proof.state) || typeof proof.text !== 'string'
              || proof.nativeSessionId !== nativeResume.nativeSessionId || !run.nativeResultSources?.includes(proof.source)) {
              update({ status: 'unknown', sessionId: result.sessionId, output: result.text, error: '原生恢复同步结果缺少匹配的线程证据；不会自动重试' });
            } else finishRun({ ...store.get<Run>('runs', run.id)!, ...(result.sessionId ? { sessionId: result.sessionId } : {}) }, proof);
          } else {
            update({ status: controller.signal.aborted ? (executor.mode === 'demo' ? 'cancelled' : 'unknown') : (result.pending ? 'running' : 'completed'), sessionId: result.sessionId, output: result.text });
            if (!result.pending && !controller.signal.aborted) finishRun(store.get<Run>('runs', run.id)!, { state: 'completed', text: result.text, source: executor.mode });
          }
        } catch (error) {
          update({ status: controller.signal.aborted ? (executor.mode === 'demo' ? 'cancelled' : 'unknown') : ((error as { delivery?: string }).delivery === 'unknown' ? 'unknown' : 'failed'), error: error instanceof Error ? error.message : String(error) });
        } finally { controllers.delete(run.id); }
      });
      jobs.add(job); void job.then(() => jobs.delete(job), error => { jobs.delete(job); console.error('执行记录保存失败：', error instanceof Error ? error.message : String(error)); });
    }
    return runs[0]!;
  }
  function remoteRun(id: string) {
    const run = store.get<Run>('runs', id);
    if (!run) throw new InputError('执行记录不存在', 404);
    if (!run.machineId || !run.sessionId || !machines) throw new InputError('该执行没有远程会话', 409);
    if (!executors().some(entry => entry.id === run.executorId && entry.available)) throw new InputError('执行者不可用或插件已停用', 503);
    return run as Run & { machineId: string; sessionId: string };
  }
  async function readRun(id: string): Promise<Json> {
    const run = remoteRun(id);
    return machines!.call(run.machineId, 'executor.read', { sessionId: run.sessionId });
  }
  function runObservations(id: string) {
    const run = store.get<Run>('runs', id);
    if (!run) throw new InputError('执行记录不存在', 404);
    return { runId: id, status: run.status, progress: executionProgress(run.progress) ?? null,
      blockedBy: readRunBlockers(store)(run) };
  }
  async function inputRun(id: string, text: string, key: string = randomUUID()): Promise<Json> {
    if (closing) throw new InputError('服务正在关闭', 503);
    const run = remoteRun(id);
    if (run.executionMode === 'task') throw new InputError('任务模式不接受交互输入；请新建任务或选择交互模式', 409);
    return effects.perform({ key, kind: 'executor.input', target: run.id, summary: '发送会话输入', content: { text }, run: () => machines!.call(run.machineId, 'executor.input', { sessionId: run.sessionId, text: requiredText(text, '输入') }) });
  }
  async function cancel(id: string) {
    const run = store.get<Run>('runs', id);
    if (!run) throw new InputError('执行记录不存在', 404);
    const controller = controllers.get(id);
    if (!controller && run.machineId && run.sessionId && ['running', 'unknown'].includes(run.status)) {
      remoteRun(id);
      if (!machines) throw new InputError('执行机尚未连接', 503);
      await effects.perform({ key: `interrupt:${run.id}:${randomUUID()}`, kind: 'executor.interrupt', target: run.id, summary: '请求中断', run: () => machines!.call(run.machineId!, 'executor.interrupt', { sessionId: run.sessionId! }) });
      return { accepted: true };
    }
    if (!controller) throw new InputError('该执行当前无法取消', 409);
    controller.abort(); return { accepted: true };
  }
  // Read models derive from facts; opening a page never approves or dispatches work.
  function digestReaderIdentity(settings:ReturnType<typeof knowledgeReaderSettings.read>,account:ReturnType<typeof knowledgeAccount>) {
    return createHash('sha256').update(JSON.stringify([settings.revision,settings.profile||account?.profile,settings.profile?null:account])).digest('hex');
  }
  async function executeInboxHandling(source: InboxHandlingSource, action: InboxHandlingAction, key: string): Promise<Json> {
    // An approval is for one concrete inbox revision. Never accept a new project
    // or destination from the model while translating it to existing operations.
    const current = inboxHandlingSources({kind:source.kind,id:source.id});
    if (!current.active || current.version !== source.version || current.binding !== source.binding) throw Object.assign(new InputError('原收件内容或授权已变化',409),{delivery:'no'});
    if (action.kind === 'reply') {
      if (!replyToInboxSource || !current.replyAvailable) throw Object.assign(new InputError('当前来源没有可用回复连接',409),{delivery:'no'});
      const receipt=await replyToInboxSource(current,action.text,key);
      const handled=store.transaction(()=>{
        const latest=inboxHandlingSources({kind:source.kind,id:source.id});
        // A new message or reclassification during I/O is a new decision. Keep
        // its inbox row open even though the old approved reply was delivered.
        if(!latest.active||latest.version!==source.version||latest.binding!==source.binding)return false;
        if(source.kind==='personal')inbox.archive(source.id,source.version);
        else mailboxes.resolve(source.id,source.version,key);
        return true;
      });
      return {...(receipt as JsonObject),inboxHandled:handled,todoCompleted:false};
    }
    if (action.kind === 'dispatch') {
      if (source.kind === 'mailbox') {
        const entry=mailboxes.get(source.id), bot=configuredBots().find(bot=>bot.id===entry.botId);
        if (!bot || bot.executorId && bot.executorId!==action.executorId) throw Object.assign(new InputError('建议执行者与机器人当前绑定不符',409),{delivery:'no'});
      }
      const {kind:_,...params}=action;
      const run=dispatch({...params,...(source.projectId?{projectId:source.projectId}:{}),...(source.todoId?{todoId:source.todoId}:{})},key,true,()=>{
        const latest=inboxHandlingSources({kind:source.kind,id:source.id});
        if(!latest.active||latest.version!==source.version||latest.binding!==source.binding||!contributions.list('inbox_triage').length)throw Object.assign(new InputError('收件派发前来源或插件授权已变化',409),{delivery:'no'});
      });
      return {runId:run.id,todoCompleted:false};
    }
    return store.transaction(()=>{
      if (action.kind === 'todo') {
        if (source.kind === 'personal') {
          const result=inbox.confirm(source.id,source.version,{title:action.title,notes:action.notes});
          changed('todos.changed',{id:result.todoId});return result;
        }
        const todo=source.todoId?store.get<Todo>('todos',source.todoId):createTodo({title:action.title,notes:action.notes,...(source.projectId?{projectId:source.projectId}:{})},false);
        if(!todo)throw new InputError('关联待办不存在',409);
        mailboxes.resolve(source.id,source.version,todo.id);changed('todos.changed',{id:todo.id});return{todoId:todo.id};
      }
      if(source.kind==='personal')inbox.archive(source.id,source.version);
      else mailboxes.resolve(source.id,source.version,`conclusion:${key}`);
      return {recorded:true,text:action.text,todoCompleted:false};
    });
  }
  function validateSourceActor(source:Message,layer:unknown,projectId?:string) {
    if(source.role!=='user'||source.readOnly||source.origin&&source.origin!=='user')throw new InputError('来源请求不是可写用户指令',403);
    const own=source.todoId?{kind:'task' as const,todoId:source.todoId,...(source.projectId?{projectId:source.projectId}:{})}:source.projectId?{kind:'project' as const,projectId:source.projectId}:{kind:'global' as const};
    authorizeWorkDecisionSource(store,own,source);assertBotInput(source);
    if(source.conversationId!=='main'&&(own.kind==='project'||own.kind==='task')&&(!source.projectId||layer!=='project'||projectId!==source.projectId))throw new InputError('来源不能写入当前范围以外的知识',403);
  }
  function knowledgeReaderView() {
    knowledgeSourceApproval.sync();
    const settings = knowledgeReaderSettings.read(), account = knowledgeAccount();
    return { ...settings, connection: settings.profile ? 'explicit-profile' : account ? 'personal-feishu' : 'missing', authorization: 'unchecked' };
  }
  function protectedReaderService() {
    return { name: 'knowledge-local.source.read', version: 1 as const, async handler(input: Json, signal: AbortSignal) {
      const bound = protectedReaderContext.getStore();
      if(currentAgentInput()&&!bound?.credentialAuthorized)throw Object.assign(new InputError('模型读取受保护来源须先投放并由主人确认',403),{code:'AWAITING_APPROVAL'});
      if (bound) {
        let requested: URL;
        try { requested = new URL((input as { url: string }).url); } catch { throw Object.assign(new Error('来源链接无效'), { code: 'INVALID_URL' }); }
        if (`${requested.origin}${requested.pathname}` !== bound.source) throw Object.assign(new Error('来源与原链接不匹配'), { code: 'CROSS_ORIGIN' });
        if (!bound.current()) throw Object.assign(new Error('来源服务已变化'), { code: 'CONNECTION_CHANGED' });
      }
      const settings = knowledgeReaderSettings.read(), account = knowledgeAccount();
      if (!settings.enabled) throw Object.assign(new InputError('请在记忆整理设置中开启受保护来源读取', 409), { code: 'READER_DISABLED' });
      const profile = settings.profile || account?.profile;
      const identity = JSON.stringify([settings.revision, settings.profile ? null : account]);
      const reader = createKnowledgeSourceReader({ profile, trustedHosts: settings.trustedHosts });
      const result = await createKnowledgeSourceReaderService(reader).handler(input, signal);
      if (bound && !bound.current()) throw Object.assign(new Error('来源服务已变化'), { code: 'CONNECTION_CHANGED' });
      if (identity !== JSON.stringify([knowledgeReaderSettings.read().revision, settings.profile ? null : knowledgeAccount()])) throw Object.assign(new InputError('读取期间连接或设置已变化，请重新投放来源', 409), { code: 'CONNECTION_CHANGED' });
      return result;
    } };
  }
  async function readProtectedKnowledgeSource(url: string, signal?: AbortSignal, job?: import('./knowledge-curator.ts').Job) {
    const settings = knowledgeReaderSettings.read();
    if (!isProtectedKnowledgeURL(url, settings.trustedHosts)) return undefined;
    if (!plugins.list().some(p => p.id === 'knowledge-local' && p.status === 'active')) throw new InputError('请先启用本地知识插件', 409);
    if (job?.requestOrigin === 'meeting' && !knowledgeAccountReady())
      throw Object.assign(new Error('正在核验采集账号'), { code: 'SOURCE_READER_NOT_READY' });
    if(job)knowledgeSourceApproval.check(job);
    const service = contributions.list('services').find(entry => entry.value.name === 'knowledge-local.source.read');
    if (!service) throw new InputError('受保护来源读取服务不可用', 503);
    // Bind before wrappers run. AsyncLocalStorage isolates overlapping requests;
    // contribution identity detects disable/re-enable even when status is active again.
    const requested = new URL(url);
    const identity = JSON.stringify([settings.revision, settings.profile ? null : knowledgeAccount()]);
    const current = () => contributions.list('services').some(entry => entry.value === service.value)
      && identity === JSON.stringify([knowledgeReaderSettings.read().revision, settings.profile ? null : knowledgeAccount()]);
    const result = await protectedReaderContext.run({ source: `${requested.origin}${requested.pathname}`, current,credentialAuthorized:!!job },
      () => plugins.invocations.use('knowledge-local.source.read', { url }, { timeoutMs: 30000, signal }));
    if (!current()) throw Object.assign(new Error('来源服务已变化'), { code: 'CONNECTION_CHANGED' });
    if(job)knowledgeSourceApproval.check(job);
    return result as unknown as import('../../protocol/src/index.ts').KnowledgeSourceResult;
  }
  function attention() { return collectAttention({ inboxConversations: inboxAssistant.list(), plans: plans.list(), approvals: approvals.list(), interactions: pendingUserCards(), inbox: inbox.list(), mailboxes: mailboxes.list(), projects: projects.list(), bots: botsStatus() as unknown as import('../../protocol/src/index.ts').FeishuBot[], channels: contributions.list('channels').map(entry => entry.value) }); }
  function skipChannel() {
    store.put('settings', 'setup.channel-skipped', { skipped: true });
    events.publish('setup.changed', {});
    return { skipped: true };
  }
  async function snapshot(): Promise<Snapshot> {
    let entries: KnowledgeEntry[] = [];
    if (contributions.list('knowledge_backends').length) entries = await knowledge().list();
    const agentState = agent.status();
    const computers = machines?.list() ?? store.list<import('../../protocol/src/index.ts').MachineInfo>('machines');
    const channel = channelStatus();
    const registeredBots = botsStatus() as unknown as Array<{ name: string; enabled: boolean; connected: boolean; reason?: string }>;
    const connected = channel.connected || registeredBots.some(bot => bot.enabled && bot.connected);
    const problems: NonNullable<Snapshot['problems']> = [];
    if (!agentState.available) problems.push({ area: 'agent', message: '主 Agent 尚未就绪', fix: '打开模型配置，核对接入方式与凭证。' });
    if (!computers.length) problems.push({ area: 'agent', message: '还没有连接电脑', fix: '在 Agent 中查看电脑接入说明。' });
    for (const computer of computers.filter(item => !item.online)) problems.push({ area: 'agent', message: `电脑“${computer.name}”已离线`, fix: '请检查该电脑上的工作台代理是否在运行。' });
    for (const plugin of plugins.list().filter(item => item.status === 'failed')) problems.push({ area: plugin.id === 'feishu' ? 'channel' : 'agent', message: `插件“${plugin.name}”不可用`, fix: '在 Agent 高级设置中查看诊断信息。' });
    if (supervisorAgent.settings().canResume) problems.push({ area: 'agent', message: '自动跟进已暂停', fix: '核对模型配置后，在自动跟进卡片中恢复。' });
    let mainAssistant: Snapshot['mainAssistant'];
    try { mainAssistant = await currentMainAssistant(); }
    catch { problems.push({ area: 'agent', message: '主助手资料读取失败', fix: '请检查主助手资料插件的状态后重试。' }); }
    const publicReason = (reason: string) => reason.replace(/WebSocket|Herdr|SSH|hook/gi, '连接服务').replace(/\bID\b/g, '标识');
    if (!connected) problems.push({ area: 'channel', message: `飞书尚未连接${channel.reason ? `：${publicReason(channel.reason)}` : ''}`, fix: '进入渠道，按向导连接机器人；暂时不用也可以先跳过。' });
    for(const bot of registeredBots.filter(bot => bot.enabled && !bot.connected)) problems.push({ area: 'channel', message: `机器人“${bot.name}”未连接${bot.reason ? `：${publicReason(bot.reason)}` : ''}`, fix: '在渠道高级设置中核对应用权限与连接状态。' });
    return { ...(plugins.list().some(p => p.id === 'start-page' && p.status === 'active') && { startPage: readStartPage(store) }),
      ...(mainAssistant && { mainAssistant }), attentionCount: attention().length, problems,
      setup: { agent: agentState.available && computers.some(item => item.online), project: projects.list().some(item => !item.archivedAt), memory: entries.length > 0, channel: connected ? 'done' : store.get<{ skipped: boolean }>('settings', 'setup.channel-skipped')?.skipped ? 'skipped' : 'todo' },
      agentTurns: store.list<Message>('messages').filter(message => message.role === 'user').map(({ id, todoId, conversationId, role, status, createdAt }) => ({ id, todoId, conversationId, role, status, createdAt })), background: background.summary(), webExtensions: contributions.list('web_extensions'), projects: projects.list(), version: '0.1.0', mode: config.demo ? 'demo' : 'live', agent: agent.status(), modelRevision, plugins: plugins.list(), executors: executorInfo(), machines: machines?.list() ?? store.list('machines'), inbox: inbox.list(), inboxHandling:inboxHandling.states(), inboxConversations:inboxAssistant.list(), inboxAssistant:inboxAssistant.status(), approvals: approvals.list(), signals: supervision.signals(), todos: todos(), knowledge: entries, messages: store.list<Message>('messages').filter(message => message.conversationId === 'main'), runs: store.list<Run>('runs').sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }
  async function createProject(input: Record<string, unknown>) {
    const prepared = await projectFolders.prepare(input);
    return projects.create(prepared as unknown as Parameters<typeof projects.create>[0]);
  }
  function updateProject(id: string, input: Record<string, unknown>): Project {
    const previous = projects.list().find(project => project.id === id);
    if (!previous || previous.archivedAt) throw new InputError('项目不存在或已归档', 404);
    const { confirmed, expectedUpdatedAt, ...patch } = input;
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== previous.updatedAt) throw new InputError('项目设置已变化，请刷新后重试', 409);
    if (confirmed !== undefined && typeof confirmed !== 'boolean') throw new InputError('confirmed必须为布尔值');
    // Moving a trusted workspace never carries its old directory authority along.
    const moved = patch.workspace !== undefined && JSON.stringify(patch.workspace) !== JSON.stringify(previous.workspace);
    if (moved && patch.followUp === undefined && previous.followUp?.automation === 'quiet') patch.followUp = { ...previous.followUp, automation: 'conservative' };
    const next = store.transaction(() => {
      const project = projects.update(id, patch as Parameters<typeof projects.update>[1]);
      if (patch.followUp !== undefined) {
        const mode = project.followUp!.automation, scope = { projectId: id };
        if (mode === 'inherit') policies.reset(scope, { notify: false });
        else {
          if (mode === 'quiet' && !project.workspace) throw new InputError('少打扰需要先绑定项目工作区目录', 409);
          let config;
          try { config = applyPolicyPreset(policies.read(scope), mode === 'quiet' ? 'low-interruption' : mode,
            { confirmed: confirmed === true, trustedDirectories: mode === 'quiet' ? [project.workspace!.cwd] : [] }); }
          catch (error) { throw new InputError(error instanceof Error ? error.message : '项目自动处理设置无效'); }
          policies.write(scope, config, { notify: false });
        }
      }
      return project;
    });
    if (patch.followUp !== undefined) changed('policies.changed', {});
    return next;
  }
  async function discoverProjects(input: Record<string, unknown>): Promise<Json> {
    const id = optionalText(input.machineId, '电脑');
    if (input.roots !== undefined && (!Array.isArray(input.roots) || !input.roots.every(root => typeof root === 'string'))) throw new InputError('扫描根目录必须为文本列表');
    const computers = machines?.list() ?? [];
    const targets = id ? computers.filter(computer => computer.id === id) : computers.filter(computer => computer.online && computer.capabilities.includes('workspace.projects'));
    if (!targets.length) throw new InputError('没有提供项目文件夹发现的电脑，请连接或升级电脑代理', 503);
    return await Promise.all(targets.map(async computer => {
      try { const folders = await projectFolders.discover(computer.id, input.roots as string[] | undefined); return { machineId: computer.id, machineName: computer.name, available: true, ...folders }; }
      catch (error) { return { machineId: computer.id, machineName: computer.name, available: false, error: error instanceof Error ? error.message : '无法读取项目文件夹' }; }
    })) as unknown as Json;
  }
  function assertBotInput(input: Message | undefined) {
    if (!input) return;
    const bots = configuredBots(), configured = bots.find(bot => input.conversationId.startsWith(`bot:${bot.id}:`));
    if (!configured && input.conversationId.startsWith('bot:')) throw new InputError('来源机器人已移除，请重新确认当前工作', 409);
    if (!configured) return;
    let scope = configured.scope;
    if (scope.kind === 'unmarked') {
      scope = input.todoId ? { kind: 'task', todoId: input.todoId, ...(input.projectId ? { projectId: input.projectId } : {}) }
        : input.projectId ? { kind: 'project', projectId: input.projectId }
        : input.conversationId === botConversationId({ id: configured.id, scope: { kind: 'global' } }) ? { kind: 'global' } : scope;
    }
    botForConversation(bots, input.conversationId, scope);
    if (!botScopeAccess(scope, configured.id, input)) throw new InputError('机器人输入授权或绑定范围已失效，请重新确认当前工作', 409);
  }
  function botContext(conversationId: string, scope?: BotScope): Json {
    const bots = configuredBots(), own = botForConversation(bots, conversationId, scope);
    const summarize = (bot: typeof bots[number]) => ({ id: bot.id, name: bot.name, scope: bot.scope, executorId: bot.executorId ?? null, groupChats: bot.groupChats?.map(group => group.chatId) ?? [] });
    if (!own) return conversationId === 'main' ? { mainIdentities: bots.filter(bot => bot.enabled && bot.paired && bot.scope.kind === 'global').map(summarize) } : {};
    const peers = bots.filter(peer => own.scope.kind !== 'unmarked' && peer.enabled && peer.paired && own.collaboration?.peerBotIds.includes(peer.id)
      && peer.collaboration?.peerBotIds.includes(own.id) && canRelayBotScope(own.scope, peer.scope));
    return { self: { ...summarize(own), scope: scope ?? own.scope }, peers: peers.map(summarize), instructions: '机器人是可选渠道身份。绑定执行者时直接派发须使用该执行者，其他协作使用 bot_handoff；范围和确认仍由服务端核验。' } as unknown as Json;
  }
  async function relayFromAgent(input: Record<string, unknown>): Promise<Json> {
    if (!botRelay) throw new InputError('机器人协作路由尚未连接', 503);
    const source = currentAgentInput() ?? agent.currentInput();
    const sender = relaySender(configuredBots(), source, input.sourceBotId);
    const parent = source && mailboxes.list().find(entry => entry.direction === 'inbox' && entry.botId === sender.id
      && entry.resultId === source.id);
    if (input.parentEntryId !== undefined && input.parentEntryId !== parent?.id) throw new InputError('协作父信件必须来自当前输入', 403);
    const target = configuredBots().find(bot => bot.id === input.targetBotId);
    const inheritedChat = parent?.target && sender.groupChats?.some(group => group.chatId === parent.target)
      && target?.groupChats?.some(group => group.chatId === parent.target) ? parent.target : undefined;
    const chatId = input.chatId === undefined ? inheritedChat : requiredText(input.chatId, '群会话');
    const key = `${source!.id}:${requiredText(input.key, '协作请求标识')}`;
    return await botRelay({ sourceBotId: sender.id, targetBotId: requiredText(input.targetBotId, '目标机器人'),
      text: requiredText(input.text, '协作请求'), key, sourceMessageId: source!.id, ...(parent ? { parentEntryId: parent.id } : {}),
      ...(chatId === undefined ? {} : { chatId }) }) as unknown as Json;
  }
  function modelStatus() {
    return { ...modelConfig.public(), demo: config.demo, runtime: { main: agent.status(), supervisor: supervisorRuntime.status() } };
  }
  return {
    collectMeetingMemory, routeCommandProject: commandRouter.route, modelStatus, agentSessions, readRunCommitDiff, cleanupRunWorktree, retainedRunBranch, renameRunWorktree, runWorktreeStatus, readRunWorktreeChange, runWorktreeHistory, runObservations, scheduledWork, followups, autoTakeover, knowledgeSources: { status: knowledgeReaderView, configure: knowledgeReaderSettings.configure }, setKnowledgeSourceAccount(read: typeof knowledgeAccount, ready=()=>true) { knowledgeAccount = read; knowledgeAccountReady = ready; }, attention, skipChannel, createProject, updateProject, discoverProjects, projects, projectWorkspace, knowledgeCurator, mailboxes, scopedAgents, background, presence, awayNotifications,
    briefing: { ...briefing, configure(input: Parameters<typeof briefing.configure>[0]) { const result = briefing.configure(input); projectFollowUp.sync(); return result; } },
    projectFollowUp,
    taskClosure: {
      history: todoHistory,
      reminderDeliveries(id: string) {
        const todo = store.get<Todo>('todos', id);
        if (!todo) throw new InputError('待办不存在', 404);
        return { projectId: todo.projectId, reminderAt: todo.reminderAt, version: todo.reminderVersion ?? 1, records: readReminderDeliveries(todo) };
      },
      reporting, review: runReview, settings: reviewSettings,
      state(id: string) {
        const state = reporting.get(id), todo = store.get<Todo>('todos', id)!;
        // Return only assistant evidence explicitly associated with this Todo,
        // including robot conversations; never merge their raw user histories.
        const messages = store.list<Message>('messages').filter(message => message.role === 'assistant' && message.status === 'done' && message.todoId === id && message.projectId === todo.projectId);
        const ids = new Set(messages.map(message => message.id));
        const outbox = background.outbox.list().filter(item => item.relatedTo?.kind === 'todo' && item.relatedTo.id === id || item.relatedTo?.kind === 'message' && ids.has(item.relatedTo.id));
        return { reporting: state, review: store.get('run-reviews', id) ? runReview.get(id) : null, sources: { messages, outbox } };
      },
      configureSettings(input: Record<string, unknown>) {
        if (Object.keys(input).some(key => key !== 'maxReworks') || !Number.isSafeInteger(input.maxReworks) || (input.maxReworks as number) < 0 || (input.maxReworks as number) > 10) throw new InputError('返工上限必须为0到10的整数');
        store.put('workbench.settings', 'run-review', { maxReworks: input.maxReworks });
        changed('task-closure.settings', {}); return reviewSettings();
      },
    },
    setNotificationChannel(channel: typeof notificationChannel) { notificationChannel = channel; },
    setNotificationBots(source: typeof notificationBots) { notificationBots = source; },
    postScoped(text: string, scope: BotScope, botId: string) {
      return scopedAgents.post(text, validateBotScope(store, scope), botId);
    },
    async postScopedResult(input: { text: string; scope: BotScope; botId: string; sourceMessageId?: string }) {
      const scope = validateBotScope(store, input.scope);
      const source = input.sourceMessageId ? store.get<Message>('messages', input.sourceMessageId) : undefined;
      if (input.sourceMessageId && (!source || source.role !== 'user')) throw new InputError('协作回报的来源消息不存在', 409);
      // A result is data, never a new grant to dispatch, write knowledge or relay again.
      const context = { readOnly: true, origin: 'result' as const, ...(source ? { replyTo: source.id } : {}) };
      if (source?.conversationId === 'main') {
        if (scope.kind !== 'global') throw new InputError('项目机器人不能回报到无关主会话', 403);
        return agent.post(requiredText(input.text, '协作回报'), 'main', { ...context, projectId: source.projectId, todoId: source.todoId });
      }
      if (source && source.conversationId !== botConversationId({ id: input.botId, scope })) throw new InputError('协作回报不属于发起机器人', 403);
      return scopedAgents.post(requiredText(input.text, '协作回报'), scope, input.botId, context);
    },
    setBotsStatus(status: () => Json) { botsStatus = status; },
    setBotRelay(relay: NonNullable<typeof botRelay>) { botRelay = relay; },
    setBotScopeAccess(validate: typeof botScopeAccess) { botScopeAccess = validate; channelBindingsReady = true; scheduledWork.sync(); },
    setMailboxProposer(propose: (input: Record<string, unknown>) => Json) { mailboxProposer = propose; },
    async configureModel(input: Record<string, unknown>) {
      if (agent.configurationBusy() || supervisorRuntime.configurationBusy()) throw new InputError('Agent 正在处理对话，请稍后保存模型配置', 409);
      if (!scopedAgents.tryLockConfiguration()) throw new InputError('项目或事项 Agent 正在处理对话，请稍后保存模型配置', 409);
      agent.lockConfiguration(); supervisorRuntime.lockConfiguration(); inboxClassifier.lockConfiguration(); inboxAssistantRuntime.lockConfiguration(); inboxHandlingRuntime.lockConfiguration();
      try {
        commandRouter.cancel();
        await Promise.all([inboxClassifier.abortCurrent(),inboxAssistantRuntime.abortCurrent(),inboxHandlingRuntime.abortCurrent()]);
        modelConfig.write(input);
        modelRevision = randomUUID();
        await Promise.all([agent.reloadConfiguration(), supervisorRuntime.reloadConfiguration(), scopedAgents.reloadConfiguration()]);
        changed('model.changed', {});
        return modelStatus();
      } finally { agent.unlockConfiguration(); supervisorRuntime.unlockConfiguration(); scopedAgents.unlockConfiguration(); inboxClassifier.unlockConfiguration(); inboxAssistantRuntime.unlockConfiguration(); inboxHandlingRuntime.unlockConfiguration(); }
    },
    feishuWebStatus() {
      const status = webSource.status();
      const error = webConfig.error();
      return error ? { ...status, connected: false, error } : status;
    },
    startFeishuWebLogin: () => serializeWeb(() => {
      if (closing) throw new InputError('工作台正在关闭', 409);
      return webLogin.start();
    }),
    pollFeishuWebLogin: () => serializeWeb(() => {
      if (closing) throw new InputError('工作台正在关闭', 409);
      return webLogin.poll();
    }),
    feishuWebSettings: webConfig.public,
    configureFeishuWeb(input: Record<string, unknown>) {
      return serializeWeb(async () => {
        if (closing) throw new InputError('工作台正在关闭', 409);
        if (webConfig.save(input)) {
          const enabled = webSource.status().enabled;
          await webSource.stop();
          webSource = makeWebSource();
          webLogin = createFeishuWebLogin(webConfig.read());
          if (enabled && !closing) webSource.start();
        }
        return webConfig.public();
      });
    },
    config, store, events, effects, plugins, contributions, workDecisions, todoDecisions, waitingReplies, inboxAssistant, inboxClassifier, inboxHandling, inboxHandlingRuntime, agent, supervisorRuntime, supervisorAgent, policies, plans, proposePlan, interactions, inbox, approvals, supervision, monitor,
    setInboxReplyHost(access: typeof mailboxHandlingAccess, reply: NonNullable<typeof replyToInboxSource>) { mailboxHandlingAccess=access;replyToInboxSource=reply; },
    readInboxHandlingSource: inboxHandlingSources,
    setFeishuSender(send: typeof replyToFeishu, ownerTarget?: () => string | undefined, accountId?: () => string | undefined, sendFromOutbox?: typeof replyToFeishu) {
      if(!send)background.outbox.registerChannel('feishu.bot',async()=>{throw Object.assign(new Error('渠道未配置'),{delivery:'no'});},()=>undefined);
      if(send) background.outbox.registerChannel('feishu.bot',async(target,text,key)=>{if(!replyToFeishu)throw Object.assign(new Error('飞书未连接'),{delivery:'no'});if(sendFromOutbox)await plugins.invocations.invoke('channel.send',{chatId:target,text,key},async input=>{if(!input||typeof input!=='object'||Array.isArray(input)||input.chatId!==target||input.key!==key)throw new PluginCallError('渠道钩子不能改变发送目标或标识');await sendFromOutbox(target,requiredText(input.text,'发送内容'),key);return null;});else await replyToFeishu(target,text,key);},ownerTarget || (()=>store.get<{chatId:string}>('settings',`feishu.owner.${config.feishu?.appId||''}`)?.chatId),accountId);
      replyToFeishu = send ? async (chatId, text, key) => {
        await plugins.invocations.invoke('channel.send', { chatId, text, key }, async input => {
          if (!input || typeof input !== 'object' || Array.isArray(input) || input.chatId !== chatId || input.key !== key) throw new PluginCallError('渠道钩子不能改变发送目标或动作标识');
          await send(chatId, requiredText(input.text, '发送内容'), key); return null;
        });
      } : undefined;
    },
    delegateTodo, setFeishuStatus(read: typeof channelStatus) { channelStatus = read; }, setMachineClient(client: MachineClient) { machines = client; }, listExecutors: executorInfo, snapshot, knowledgeRevision, confirmKnowledgeActions, knowledgeActionStatus, todos, createTodo, updateTodo, dispatch, cancel, knowledge,
    async close() {
      if (closing) return;
      closing = true;
      await stopWeb();
      commandRouter.cancel();
      await wiredBackground.close(); projectFollowUp.close();
      supervision.close(); plans.close(); clearInterval(expireTimer); await awayNotifications.close();
      await knowledgeCurator.close();
      await monitor.close();
      await approvals.close();
      for (const controller of controllers.values()) controller.abort();
      try {
        const stopped = await Promise.allSettled([inboxAssistant.close(), inboxAssistantRuntime.close(), inboxClassifier.close(), inboxHandlingRuntime.close(), projectWorkspace.close(), background.close(), interactions.close(), supervisorAgent.close(), agent.close({ abort: true }), supervisorRuntime.close({ abort: true }), scopedAgents.close({ abort: true })]);
        const failures = stopped.filter(item => item.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(item => item.status === 'rejected' ? item.reason : undefined), 'Agent 运行时关闭失败');
      }
      finally {
        await Promise.allSettled([...jobs]);
        await inboxHandling.close();
        await effects.close();
        scheduledWork.close(); followups.close(); autoTakeover.close(); offScheduledWork(); offFollowups(); offKnowledgeApprovals();
        waitingReplies.close();
        await inbox.close();
        await mailboxes.close();
        try { await plugins.close(); } finally { store.close(); }
      }
    },
  };
}

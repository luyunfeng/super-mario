import type { CommitChanges } from './commit-changes.ts';
export { commitChanges, type CommitChanges } from './commit-changes.ts';
import type { ExecutionUsage } from './execution-usage.ts';
export { executionUsage, type ExecutionUsage } from './execution-usage.ts';
export type { PersonalAiMessage } from "./personal-ai.ts";
export type { InboxConversation, InboxMatter, InboxFallbackInput, InboxFallbackPlan } from './inbox-conversations.ts';
export type { TodoHistory, TodoExecutionRound } from './todo-history.ts';
export type { ScheduledWorkInput, ScheduledWorkTiming, ScheduledWorkAction, ScheduledWorkScope, ScheduledWorkRecord, ScheduledWorkOccurrence } from './scheduled-work.ts';
export { CODEX_MODEL_CONFIG, codexModelConfig, codexConfigArgs, codexTextItem } from './codex-model-policy.ts';
export type { InboxHandlingRef, InboxHandlingSource, InboxHandlingAction, InboxHandlingView, InboxHandlingRequest, InboxHandlingState, InboxSuggestion } from './inbox-handling.ts';
export { hasKnowledgeSourceHTML } from './knowledge-source-reader.ts';
export type { KnowledgeSourceResult, KnowledgeSourceReader, KnowledgeSourceReaderOptions, KnowledgeSourceErrorCode, KnowledgeSourceRunCLI } from './knowledge-source-reader.ts';
export type { AgentDiagnostics, DiagnosticErrorCode, DiagnosticExecutorId } from './agent-diagnostics.ts';
export type { TerminalHostInstance, TerminalRecoveryBinding, TerminalRecoveryCheck, TerminalRecoveryTarget, TerminalRecoveryPane, TerminalRecoveryWriteResult, RecoveredTerminalAction } from './terminal-recovery.ts';
export type { NormalizedReplyEvidence, CollectedReplyEvidence, ArmWaitingReply, WaitingReplySnapshot, ConsumeWaitingReplyResult } from './waiting-replies.ts';
export type { WorkDecision, WorkDecisionSource } from './work-decisions.ts';
export type { ExecutionProgress, RunBlocker } from './execution-progress.ts';
import type { ExecutionProgress } from './execution-progress.ts';
export type { NativeExportSource, NativeFavoriteMessage, NativeExecutorId, NativeResumeSpec, ObservedAgentSession, AgentSessionDiscovery } from './agent-sessions.ts';
export { excludesPersonalGroupFromBrief } from './inbox-origin.ts';
export type { InboxOrigin } from './inbox-origin.ts';
import type { InboxOrigin } from './inbox-origin.ts';
import type { NativeResumeSpec } from './agent-sessions.ts';
/** Wire values stay JSON-compatible so the web and execution node share one contract. */
export type { BotScope, BotGroupAccess, BotCollaboration, GroupReadPage, GroupReadRecord, FeishuBotInput, FeishuBot, MailboxEntry } from './bots.ts';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type KnowledgeLayer = 'personal' | 'global' | 'project';
export type KnowledgeImportance = 'P0' | 'P1' | 'P2' | 'P3';
export type KnowledgeEditSource = 'workbench' | 'conversation' | 'feishu';
export interface KnowledgeEntry { contentLocked?: boolean; factsEdit?: { source: KnowledgeEditSource; at: string }; confirmedFacts?: string; relevance?: number; importance?: KnowledgeImportance; aliases?: string[]; tags?: string[]; id: string; layer: KnowledgeLayer; title: string; content: string; projectId?: string; updatedAt: string }
export interface QuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  /** Exact option label suggested by the asker. A suggestion is not a selection. */
  recommend?: string;
  options: { label: string; description?: string }[];
}
/** Responses follow the question order. Selected values are stored option labels. */
export interface QuestionResponse { selected: string[]; text?: string }
export interface Todo {
  /** Set by the host when an unanswered assistant question expires. */
  deferredQuestion?: { cardId: string; askedAt: string; title?: string; body?: string; questions?: QuestionItem[] };
  /** Explicit predecessor of this work phase, independent of hierarchy and dependencies. */
  continuesTodoId?: string; continuationReason?: string; continuationRootId?: string;
 groupTask?: true; groupTaskOutcome?: string; afterTodoIds?: string[]; parentTodoId?: string; responsibleSession?: { runId: string; machineId: string; sessionId: string }; responsiblePerson?: string; priority?: 'high' | 'normal' | 'low'; id: string; title: string; notes: string; projectId?: string; dueAt?: string; /** Calendar date for an all-day deadline. dueAt retains the original local end of day as an instant. */ dueDay?: string; waitingOn?: string; reminderAt?: string; /** Host-owned waiting/reminder generation; legacy records default to 1. */ reminderVersion?: number; remindedAt?: string; completedAt?: string; createdAt: string; updatedAt: string }
/** Transport carries image bytes once. Message lists and receipts carry only references. */
export interface ChatFilePreview {
  thumbnail?: {mime:'image/png'|'image/jpeg';data:string};
  text?:string;
  truncated?:boolean;
  note?:string;
}
export interface ChatFileInput { uploadId:string }
export interface ChatFileRef { officeDocumentId?:string; name:string; mime:string; bytes:number; sha256:string }
export const chatImageLimits = { count: 20, bytesPerImage: 3_750_000, totalBase64Bytes: 32 * 1024 * 1024 } as const;
export interface ChatImageInput { mime:string; data:string }
export interface ChatImageRef { mime:string; bytes:number; sha256:string }
export interface Message { queueState?:'queued'|'running'|'cancelled'|'withdrawn'; retryOf?:string; retryable?:true; files?:ChatFileRef[]; images?:ChatImageRef[]; runResult?: { runId: string; status: 'completed' | 'failed'; source: string }; directWebInput?: true; stoppedByUser?: true; requestId?: string; progress?: ExecutionProgress; id: string; conversationId: string; role: 'user' | 'assistant'; replyTo?: string; projectId?: string; todoId?: string; readOnly?: boolean; origin?: 'user' | 'result' | 'notification'; text: string; createdAt: string; status?: 'pending' | 'done' | 'failed' }
export interface PlanEstimateDispatch { planId: string; taskIndex: number; source: 'default' | 'override' | 'learned' }
export interface Run { planEstimate?: PlanEstimateDispatch; worktreeRunId?: string; comparisonRunIds?: string[]; worktree?: { source: string; name?: string; base?: string; branch?: string; removedAt?: string; branchDeletedAt?: string }; commitChanges?: CommitChanges; usage?: ExecutionUsage; progress?: ExecutionProgress; nativeResume?: NativeResumeSpec; nativeResultSources?: string[]; nativeSessionId?: string; id: string; executorId: string; conversationId: string; prompt: string; cwd?: string; projectId?: string; todoId?: string; sourceMessageId?: string; doneWhen?: string; expectMinutes?: number; executionMode?: 'task' | 'interactive'; resultSource?: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'; output: string; error?: string; machineId?: string; sessionId?: string; createdAt: string; updatedAt: string }
export interface ExecutorInfo { taskOnly?: boolean; nativeResultSources?: string[]; id: string; name: string; kind: string; machineId: string; available: boolean; mode: 'demo' | 'real'; description: string; reason?: string; defaultCwd?: string }
export interface PluginNavigationItem { id: string; label: string; route: string }
export interface PluginInfo { navigation?: PluginNavigationItem[]; id: string; name: string; enabled: boolean; status: 'active' | 'disabled' | 'waiting' | 'failed'; error?: string; capabilities: string[] }
/** Declarative browser contribution. The browser owns rendering and cleanup; no server-supplied script executes. */
export interface WebExtension { slot: 'startup'; renderer: 'brand-splash'; title: string; subtitle: string; durationMs?: number }
export interface AppEvent { id: number; type: string; data: Json; createdAt: string }
export interface MachineInfo { agentInstanceId?: string; id: string; name: string; online: boolean; platform: string; connectedAt: string; capabilities: string[]; executors?: ExecutorInfo[] }
export interface ModelConfig { provider: string; model: string; baseUrl?: string; apiKey?: string; cliCommand?: string; cliConfigDir?: string }
export interface AppConfig { host: string; port: number; dataDir: string; token?: string; demo: boolean; model?: ModelConfig; feishuWeb?: { baseUrl: string; token?: string; pollIntervalMs?: number }; feishu?: { appId: string; appSecret: string; profile?: string; collectEnabled?: boolean; pollMs?: number } }
/** A project is a durable workspace on one connected machine, not an execution attempt. */
export interface ProjectWorkspaceBinding { machineId: string; cwd: string }
export interface WebPresenceInput { tabId: string; visible: boolean; focused: boolean; sequence?: number }
export interface BriefingSettings { decisionQuietHours: { enabled: boolean; start: string; end: string }; timezone: string; morning: string; evening: string; intervalHours: number; intervalEnabled: boolean; activeStart: string; activeEnd: string; awayNotifications: boolean }
export type CodeBrowseKind = 'tree' | 'file' | 'diff';
export interface AwayNotification { id: string; text: string; todoId?: string; projectId?: string; cardId?: string; decision?: {kind:'approval'|'plan';id:string;version:number}; status: 'pending' | 'queued' | 'skipped'; reason?: string; outboxId?: string }
export interface DiscoveredProject { name: string; cwd: string; sources: string[]; exists: boolean; lastUsedAt?: string }
export interface ProjectDiscovery { homeDir?: string; projects: DiscoveredProject[]; roots: string[]; warnings: string[]; truncated: boolean }
export interface Project { workspace?: ProjectWorkspaceBinding; id: string; name: string; description: string; memoryEnabled?: boolean; followUp?: { briefingEnabled?: boolean; briefingTime: string; overdueReminders: boolean; automation: 'inherit' | 'conservative' | 'balanced' | 'quiet' }; createdAt: string; updatedAt: string; archivedAt?: string }
export type MainAssistantProfile = { name: string; revision: number };
export interface StartPagePreference { key: string; revision: number }
export interface Snapshot { startPage?: StartPagePreference; modelRevision?: string; mainAssistant?: MainAssistantProfile; inboxConversations?: import('./inbox-conversations.ts').InboxConversation[]; inboxAssistant?: {enabled:boolean;available:boolean;reason?:string;workspace:string}; inboxHandling?: import('./inbox-handling.ts').InboxHandlingState[]; attentionCount?: number; problems?: Array<{ area: 'agent' | 'channel'; message: string; fix: string }>; setup?: { agent: boolean; project: boolean; memory: boolean; channel: 'done' | 'skipped' | 'todo' }; agentTurns?: Array<Pick<Message, 'id' | 'todoId' | 'conversationId' | 'role' | 'status' | 'createdAt'>>; background?: {failed:number;unknown:number;outboxFailed:number;outboxUnknown:number}; webExtensions?: Array<{ id: string; value: WebExtension }>; projects?: Project[]; mode: 'demo' | 'live'; agent: { available: boolean; reason?: string }; plugins: PluginInfo[]; executors: ExecutorInfo[]; machines: MachineInfo[]; todos: Todo[]; knowledge: KnowledgeEntry[]; messages: Message[]; runs: Run[]; inbox?: InboxItem[]; approvals?: Approval[]; signals?: SupervisionSignal[]; version: string }
/** Agent nodes identify themselves before issuing any RPC messages. No command execution is implied. */
export type NodeMessage =
  | { type: 'hello'; agentInstanceId?: string; machineId: string; name: string; platform: string; capabilities: string[]; executors?: ExecutorInfo[] }
  | { type: 'event'; event: string; data: Json }
  | { type: 'heartbeat' }
  | { type: 'result'; id: string; result?: Json; error?: string };
export type ServerMessage =
  | { type: 'welcome'; machineId: string }
  | { type: 'call'; id: string; method: string; params: JsonObject };

export interface InboxThing { origin?: InboxOrigin; thread: string; last: string; title: string; text: string; sender?: string; receivedAt?: string }
// Set by the subscription delivery route. Incoming message data cannot set classification policy.
export interface InboxSubscriptionPolicy { triageRules?:string; fallbackTier?:'auto'|'wait'|'action'|'fyi'; due?:boolean }
export interface SubscriptionFailureNotice {
  subscriptionId:string; name:string; since:string; reason:string; state:'open'|'recovered'|'paused'|'deleted';
}
export type SubscriptionMove = {kind:'thread'|'source'|'digest';count:number};
export type InboxSubscriptionDelivery = InboxSubscriptionPolicy & {move?:SubscriptionMove};
export type InboxTriageInput = InboxThing & {sourceKind?:'subscription';subscriptionPolicy?:InboxSubscriptionPolicy};
export interface InboxItem extends InboxThing {
  parentInboxId?: string;
  /** Legacy links with no provenance were explicitly selected by the owner. */
  parentInboxBy?: 'user' | 'connector';
  subscriptionFailure?:Pick<SubscriptionFailureNotice,'since'|'state'>; subscriptionMove?:SubscriptionMove; projectId?: string; id: string; source: string; version: number; tier: 'action' | 'fyi' | 'noise' | 'pending'; reason: string; archivedAt?: string; todoId?: string; updatedAt: string }
export interface PaneInfo { id: string; title: string; cwd: string }
export interface TerminalFrame { epoch: string; seq: number; full: boolean; width: number; height: number; data: string }
export interface SessionBinding { machineId?: string; agentInstanceId?: string; hostKind?: string; hostInstanceId?: string; terminalId?: string; nativeResume?: NativeResumeSpec; nativeSessionId?: string; sessionId: string; paneId: string; executorId: string; cwd: string; createdAt: string }

/** A finished CLI turn is distinct from completion of its associated todo. */
export interface ExecutionResult { commitChanges?: CommitChanges; usage?: ExecutionUsage; progress?: ExecutionProgress; state: 'running' | 'completed' | 'failed' | 'unknown'; text: string; source: string; exitCode?: number; nativeSessionId?: string }
export interface Approval { id: string; version: number; title: string; details: string; kind: 'dispatch' | 'input' | 'channel-reply' | 'feishu-reply' | `plugin:${string}.${string}`; params: JsonObject; todoId?: string; status: 'pending' | 'running' | 'completed' | 'rejected' | 'failed' | 'unknown'; result?: Json; error?: string; createdAt: string; updatedAt: string }
export interface AutomationSettings { tickSeconds: number; stalledMinutes: number; stalledFactorOfEstimate?: number; needsYouMinutes: number; remindersEnabled: boolean }
export interface SupervisionSignal { questionCardId?: string; questionVersion?: number; id: string; kind: 'review' | 'estimate_due' | 'stalled' | 'orphaned' | 'reminder' | 'waiting' | 'needs_you' | 'owner_mismatch'; text: string; runId?: string; todoId?: string; createdAt: string; resolvedAt?: string }

/** Channel-specific credentials remain in the adapter; core copies only reply destinations. */
export interface MessageRoute { channel: string; accountId: string; target: string; resumed?: boolean }

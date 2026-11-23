import type { InboxOrigin } from './inbox-origin.ts';
/** Routing scope and confirmation are independent: unmarked is never implicitly global. */
export type BotScope = { kind: 'global' } | { kind: 'unmarked' } | { kind: 'project'; projectId: string } | { kind: 'task'; todoId: string; projectId?: string };
/** Explicit opt-in. An empty member list admits only the privately verified owner. */
export interface BotGroupAccess { chatId: string; mentionOnly: boolean; allowedSenderIds: string[] }
/** A robot is an optional channel identity for an existing executor, not a new Agent entity. */
export interface BotCollaboration { peerBotIds: string[] }
export interface FeishuBotInput { name: string; appId: string; appSecret?: string; enabled?: boolean; scope: BotScope; ownerDirectReply?: boolean; readGroup?: boolean; groupTaskReportDelayMinutes?: number; decisionNudgeMinutes?: number; requireConfirmation?: boolean; profile?: string; executorId?: string; groupChats?: BotGroupAccess[]; collaboration?: BotCollaboration }
export interface FeishuBot { id: string; name: string; appId: string; enabled: boolean; configured: boolean; scope: BotScope; ownerDirectReply?: boolean; readGroup?: boolean; groupTaskReportDelayMinutes?: number; decisionNudgeMinutes?: number; requireConfirmation: boolean; profile?: string; executorId?: string; groupChats?: BotGroupAccess[]; collaboration?: BotCollaboration; connected: boolean; paired: boolean; pairingCode?: string; replyTarget?: string; reason?: string; createdAt: string; updatedAt: string }
/** Only text confirmed by a platform receipt can appear in a group-read answer. */
export type GroupReadRecord = {
  id: string; createdAt: string; task: string; answer: string;
  status: 'working' | 'completed' | 'failed' | 'unknown' | 'recalled';
  confirmedParts: number; totalParts: number | null;
};
export type GroupReadPage = { items: GroupReadRecord[]; nextBefore: string | null };

export interface MailboxEntry { origin?: InboxOrigin; id: string; version: number; direction: 'inbox' | 'outbox'; scope: BotScope; botId: string; eventKey: string; title: string; text: string; target?: string; sourceMessageId?: string; replyTo?: string; requiresConfirmation: boolean; status: 'pending' | 'ready' | 'processing' | 'completed' | 'rejected' | 'failed' | 'unknown'; resultId?: string; error?: string; createdAt: string; updatedAt: string }

/** Original recipient of a paired bot input proposal. Persist separately from editable approval fields. */
export interface FeishuAgentInputTarget {
  runId: string; sessionId: string; machineId: string; nativeSessionId?: string; executorId: string; cwd?: string;
  projectId: string; todoId: string; botId: string; appId: string; revision: number;
  topic?: { publishTurnResult?: true; grant: string; chatId: string; threadId: string; messageId: string; inputId: string; binding: string };
  owner: { chatId: string; senderId: string };
}

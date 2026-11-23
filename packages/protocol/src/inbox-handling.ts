import type { RunBlocker } from './execution-progress.ts';
import type { Approval, Json, Message, Run } from './index.ts';

/** Draft/confirmation evidence for existing Inbox/Todo/Approval records, not another task model. */
export interface InboxHandlingRef { kind: 'personal' | 'mailbox'; id: string }
export interface InboxHandlingSource extends InboxHandlingRef {
  version: number; title: string; text: string; projectId?: string; todoId?: string;
  active: boolean; reason?: string; replyAvailable: boolean; replyReason?: string;
  /** Opaque host identity/grant generation; never a profile or token. */
  binding?: string;
}
export type InboxHandlingAction =
  | { kind: 'todo'; title: string; notes: string }
  | { kind: 'dispatch'; executorId: string; prompt: string; doneWhen: string; expectMinutes: number; cwd?: string }
  | { kind: 'reply'; text: string }
  | { kind: 'conclusion'; text: string };
export interface InboxSuggestion {
  id: string; version: number; source: InboxHandlingRef; sourceVersion: number; conversationId: string;
  action: InboxHandlingAction; status: 'draft' | 'discarded' | 'submitted' | 'executing' | 'applied' | 'stale' | 'unknown';
  approvalId?: string; result?: Json; error?: string; createdAt: string; updatedAt: string;
}
export interface InboxDispatchRun {
  blockedBy: RunBlocker[];
  id: string; status: Run['status']; updatedAt: string; webPath: string; webCitation: string;
}
export interface InboxReplyDelivery { id: string; status: 'sent' | 'failed' | 'unknown' | 'pending'; updatedAt: string }
export type InboxLinkedTodo = { status: 'unavailable' } | {
  status: 'open' | 'completed'; id: string; title: string; completedAt?: string; webPath: string; webCitation: string;
};
export interface InboxSuggestionProgress {
  linkedTodo?: InboxLinkedTodo;
  total: number;
  recent: { id: string; version: number; kind: InboxHandlingAction['kind']; status: InboxSuggestion['status']; approvalStatus?: Approval['status']; delivery?: InboxReplyDelivery; run?: InboxDispatchRun }[];
}
export interface InboxHandlingRequest {
  id: string; key: string; conversationId: string; status: 'pending' | 'completed' | 'failed' | 'unknown';
  error?: string; createdAt: string; updatedAt: string;
}
export interface InboxHandlingView {
  linkedTodo?: InboxLinkedTodo;
  source: InboxHandlingSource; conversationId: string; available: boolean; reason?: string;
  messages: Message[]; suggestions: (InboxSuggestion & { approvalStatus?: Approval['status']; delivery?: InboxReplyDelivery; run?: InboxDispatchRun })[]; requests: InboxHandlingRequest[];
}
export interface InboxHandlingState { source:InboxHandlingRef;stage:'human'|'ai'|'processing';label:string;runId?:string }

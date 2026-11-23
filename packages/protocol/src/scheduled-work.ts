import type { Json, Message } from './index.ts';

export type ScheduledWorkTiming =
  | { kind: 'once'; at: string; tz?: string }
  | { kind: 'interval'; everySec: number; anchorAt?: string; until?: string; tz?: string }
  | { kind: 'cron'; cron: string; tz: string; until?: string };
export type ScheduledWorkAction = { kind: 'brief' } | {
  kind: 'dispatch'; executorId: string; prompt: string; doneWhen: string; expectMinutes: number; cwd?: string;
};
/** Model arguments only. The host supplies the source separately after its current-input guard. */
export interface ScheduledWorkInput {
  key: string; title: string; schedule: ScheduledWorkTiming; action: ScheduledWorkAction; projectId?: string; todoId?: string;
}
export interface ScheduledWorkScope {
  projectId?: string; todoId?: string; action: ScheduledWorkAction;
}
/** Coordination evidence for existing Schedule + Approval, not an independent executor. */
export interface ScheduledWorkRecord {
  id: string; version: number; input: ScheduledWorkInput; sourceMessage: Message;
  approvalId: string; approvalVersion: number; approvalParams: { [key: string]: Json };
  status: 'pending' | 'active' | 'cancelled'; scheduleId?: string; scheduleVersion?: number; initialScheduleVersion?: number;
}
export interface ScheduledWorkOccurrence {
  key: string; workId: string; workVersion: number; scheduleId: string; scheduleVersion: number; scheduledFor: string;
  status: 'claimed' | 'completed' | 'skipped' | 'unknown'; approvalId?: string; approvalVersion?: number;
  /** Time the host began handling this due event, before creating a brief or dispatch approval. */
  handledAt?: string;
  actionKind?: ScheduledWorkAction['kind'];
  /** Snapshot of the earlier occurrence that prevented a new action at this trigger. */
  blockedBy?: { occurrenceKey: string; scheduledFor: string; reason: string };
  ownerSkipToken?: string;
  dispatchParams?: { [key: string]: Json }; result?: Json; error?: string;
}

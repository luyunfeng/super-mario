import type { Json } from "./index.ts";
export interface StaleReference {
  ref: string;
  version: number;
}
export interface EventInput {
  type: string;
  typeVersion: number;
  sourceId: string;
  data: Json;
  subject?: { kind: string; id: string };
  causedBy?: string;
  staleIf?: StaleReference;
}
export interface DurableEvent extends EventInput {
  id: string;
  seq: number;
  source: string;
  rootId: string;
  hops?: number;
  createdAt: string;
}
export interface DeliveredEvent extends DurableEvent {
  attempt: number;
}
export type EventResult =
  | { status: "done"; outcome?: Json }
  | { status: "skip"; reason: string }
  | { status: "retry"; reason: string; afterSec?: number; deferred?: boolean }
  | { status: "failed"; reason: string };
export interface PluginEventSubscription {
  name: string;
  types: Array<{ type: string; version: number }>;
  subjectKind?: string;
  effects: "ledger" | "none" | "direct";
  serial?: "subject" | "none";
  retry?: { max: number; backoffSec: number[] };
  timeoutMs?: number;
  replay?: number;
  handler(
    event: DeliveredEvent,
    signal: AbortSignal,
  ): Promise<EventResult> | EventResult;
}
export interface EventDelivery {
  id: string;
  subscriptionId: string;
  eventId: string;
  seq: number;
  serialKey: string;
  status:
    | "pending"
    | "running"
    | "done"
    | "skipped"
    | "retry_wait"
    | "failed"
    | "unknown"
    | "cancelled";
  attempt: number;
  failures: number;
  createdAt: string;
  updatedAt: string;
  nextAt?: string;
  reason?: string;
  outcome?: Json;
  auditedBy?: string;
}
export interface EventSubscriptionRecord
  extends Omit<PluginEventSubscription, "handler"> {
  id: string;
  owner: string;
  status: "active" | "inactive";
  registeredAt: string;
  inactiveSince?: string;
  expiredCount: number;
}
export interface EventInboxApi {
  publish(event: EventInput): { id: string; duplicate: boolean };
}
export interface ScheduleInput {
  name: string;
  kind: "once" | "interval" | "cron";
  at?: string;
  everySec?: number;
  anchorAt?: string;
  until?: string;
  cron?: string;
  tz?: string;
  missed?: "coalesce" | "skip" | "catch_up";
  catchUpMax?: number;
  payload?: Json;
}
export interface ScheduleInfo extends ScheduleInput {
  id: string;
  owner: string;
  version: number;
  status: "active" | "paused" | "done" | "cancelled" | "owner_disabled";
  nextAt: string;
  lastFiredFor?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ScheduleApi {
  create(input: ScheduleInput): ScheduleInfo;
  update(
    id: string,
    patch: Partial<ScheduleInput> & {
      status?: "active" | "paused" | "cancelled";
    },
    version?: number,
  ): ScheduleInfo;
  cancel(id: string, version?: number): void;
  list(): ScheduleInfo[];
}
export interface OutboxInput {
  dedupKey: string;
  channel: string;
  target: string;
  content: { text: string };
  relatedTo?: { kind: string; id: string };
  causedBy?: string;
  window?: { notBefore?: string; expiresAt?: string };
  staleIf?: StaleReference;
}
export interface OutboxItem extends OutboxInput {
  id: string;
  owner: string;
  version: number;
  contentHash: string;
  status:
    | "queued"
    | "needs_approval"
    | "sending"
    | "sent"
    | "held"
    | "failed"
    | "unknown"
    | "expired"
    | "cancelled";
  attempt: number;
  approvalId?: string;
  nextAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  auditedBy?: string;
  /** The sent message's id on the other side, when the channel reported one. It is what a recall names. */
  messageRef?: string;
  /** When the owner took the message back, and how that ended. */
  recall?: OutboxRecall;
}
/** How a recall ended. Only done means the message is known to be gone; the others leave it uncertain or refused. */
export interface OutboxRecall {
  status: "done" | "refused" | "unknown";
  at: string;
  error?: string;
}
export interface OutboxApi {
  enqueue(input: OutboxInput): {
    id: string;
    duplicate: boolean;
    status: OutboxItem["status"];
  };
}
export interface BackgroundContext {
  eventbox: EventInboxApi;
  schedule: ScheduleApi;
  outbox: OutboxApi;
}
/** Local host adapter; plugins receive only their owner-scoped BackgroundContext. */
export interface BackgroundHost {
  context(
    owner: string,
    permit: (permission: string) => void,
  ): BackgroundContext;
  subscribe(owner: string, spec: PluginEventSubscription): () => void;
  ownerEnabled(owner: string, enabled: boolean): void;
}

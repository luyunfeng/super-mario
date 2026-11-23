/** A connector receives scoped grouping metadata. Its plan must assign every new message once. */
export type InboxFallbackInput = {
  kind: 'direct' | 'group';
  now: string;
  messages: Array<{
    id: string;
    title: string;
    at: string;
    tier: 'action' | 'fyi' | 'noise';
    replyToMessageId?: string;
    replyToMatterId?: string;
    topicId?: string;
  }>;
  existing: Array<{id: string; at: string; topicIds?: string[]}>;
};
export type InboxFallbackPlan = {assign: Array<{message: string; event: string}>};

export interface InboxMatter {
  /** Existing records without provenance were created by the model. */
  groupedBy?: 'model' | 'rules';
  lastGroupedBy?: 'model' | 'rules';
  id: string;
  title: string;
  summary: string;
  tier: "action" | "fyi" | "noise";
  messageIds: string[];
  reason?: string;
  urgent?: boolean;
  doneAt?: string;
  /** A distinct new matter may continue a previously handled matter in this conversation. */
  continues?: string;
}

export interface InboxConversation {
  matters?: InboxMatter[];
  id: string;
  version: number;
  projectId?: string;
  title: string;
  person: string;
  meetingMinutes?: true;
  chatName?: string;
  kind: "direct" | "group";
  messageIds: string[];
  pendingCount: number;
  latestAt: string;
  preview: string;
  status:
    | "queued"
    | "processing"
    | "watching"
    | "quiet"
    | "waiting_user"
    | "failed"
    | "paused";
  reason?: string;
  summary?: string;
  question?: string;
  error?: string;
  todoIds: string[];
  updatedAt?: string;
}

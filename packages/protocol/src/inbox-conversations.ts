export interface InboxMatter {
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

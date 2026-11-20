export interface InboxConversation {
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

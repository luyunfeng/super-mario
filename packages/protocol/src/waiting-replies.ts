/** Verified raw message metadata. source MUST include the account namespace;
 * display origin, names and aggregated inbox ids are not identity evidence. */
export interface NormalizedReplyEvidence {
  source: string;
  chatId: string;
  messageId: string;
  senderId: string;
  senderIdType: string;
  createdAt: string;
  parentId?: string;
  rootId?: string;
  threadId?: string;
  edited?: boolean;
  deleted?: boolean;
}

export interface ArmWaitingReply {
  todoId: string;
  /** Stable request id. A new wait requires a new key AND a fresh anchor. */
  key: string;
  anchor: NormalizedReplyEvidence;
  expectedSenderId: string;
  expectedSenderIdType: string;
  note?: string;
}

/** Evidence about one Todo's waiting state, not a separate task. */
export interface WaitingReplySnapshot extends ArmWaitingReply {
  cycle: number;
  startedAt: string;
  /** Derived exclusively from the stored Todo. */
  scope: { projectId?: string };
  waitingOn: string;
  reminderAt: string;
  status: 'waiting' | 'matched' | 'superseded' | 'invalidated';
  endedAt?: string;
  hit?: {
    evidence: NormalizedReplyEvidence;
    reason: 'direct_reply';
    processedAt: string;
  };
}

export interface ConsumeWaitingReplyResult {
  duplicate: boolean;
  matched: WaitingReplySnapshot[];
}

/** Local selection hints only; neither label nor preview establishes identity.
 * Collectors bound each hint to at most 160 characters. */
export interface CollectedReplyEvidence extends NormalizedReplyEvidence {
  label?: string;
  preview?: string;
}

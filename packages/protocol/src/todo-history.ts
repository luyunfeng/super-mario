import type { Run } from './index.ts';

export interface ExecutionReviewEvidence {
  status: 'pending' | 'accepted' | 'dispatching' | 'unknown' | 'reopened' | 'invalidated';
  version: number;
  updatedAt: string;
}

/** Read-only projection of stored runs. A round is an execution attempt, not a completed todo. */
export interface TodoExecutionRound {
  number: number;
  run: Pick<Run, 'id' | 'executorId' | 'prompt' | 'status' | 'createdAt' | 'updatedAt' | 'doneWhen' | 'output' | 'error' | 'resultSource'>;
  outputTruncated: boolean;
  review?: ExecutionReviewEvidence;
  answerReceipts: Array<{ cardId: string; title: string; answeredAt?: string; answeredBy?: string;
    target: 'executor' | 'workbench'; delivery: 'confirmed' | 'failed' | 'unknown' }>;
  decisions: Array<{ action: 'accept' | 'rework'; defects?: string; at: string; reworkRunId?: string; dispatchStatus?: 'dispatching' | 'unknown' }>;
}
export interface TodoHistory {
  todo: { id: string; title: string; projectId?: string; completedAt?: string };
  total: number;
  conversationReceipts?: Array<{ cardId: string; title: string; answeredAt?: string;
    delivery: 'confirmed' | 'failed' | 'unknown'; continuationAccepted: boolean }>;
  rounds: TodoExecutionRound[];
  nextBefore?: string;
}

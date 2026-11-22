import type { Run } from './index.ts';

/** Read-only projection of stored runs. A round is an execution attempt, not a completed todo. */
export interface TodoExecutionRound {
  number: number;
  run: Pick<Run, 'id' | 'executorId' | 'prompt' | 'status' | 'createdAt' | 'updatedAt' | 'doneWhen' | 'output' | 'error' | 'resultSource'>;
  outputTruncated: boolean;
  decisions: Array<{ action: 'accept' | 'rework'; defects?: string; at: string; reworkRunId?: string; dispatchStatus?: 'dispatching' | 'unknown' }>;
}
export interface TodoHistory {
  todo: { id: string; title: string; projectId?: string; completedAt?: string };
  total: number;
  rounds: TodoExecutionRound[];
  nextBefore?: string;
}

/** Latest adapter observation; never a completion or authorization signal. */
export type ExecutionProgress = {
  phase: 'starting' | 'thinking' | 'tool' | 'responding' | 'waiting';
  toolName?: string;
  detail?: string;
  /** Bounded public runtime events; no model reasoning, arguments or tool output. */
  recentSteps?: string[];
  observedAt: string;
};

export interface RunBlocker {
  questions?: {question: string; recommend: string; reason?: string; alternatives?: {label:string; description?:string}[]}[];
  delegationRequestedAt?: string; ownerConfirmation?:string;
  decisionContext?: string; contextRequestedAt?: string; decisionExplanation?: string;
  decisionDeadlineAt?: string; reversible?: boolean; deadlineRemindedAt?: string;
  id: string; kind: string; title: string; version: number; createdAt: string; href: string;
}

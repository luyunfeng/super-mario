/** Latest adapter observation; never a completion or authorization signal. */
export type ExecutionProgress = {
  phase: 'starting' | 'thinking' | 'tool' | 'responding' | 'waiting';
  toolName?: string;
  detail?: string;
  /** Bounded public runtime events; no model reasoning, arguments or tool output. */
  recentSteps?: string[];
  observedAt: string;
};

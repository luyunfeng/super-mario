/** Latest adapter observation; never a completion or authorization signal. */
export type ExecutionProgress = {
  phase: 'starting' | 'thinking' | 'tool' | 'responding' | 'waiting';
  toolName?: string;
  detail?: string;
  observedAt: string;
};

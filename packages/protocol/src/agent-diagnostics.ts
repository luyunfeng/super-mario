/** Diagnostic evidence is separate from ExecutorInfo.available and terminal/session state. */
export type DiagnosticExecutorId = 'codex' | 'claude-code';
export type DiagnosticErrorCode = 'not-configured' | 'missing' | 'permission-denied' | 'profile-unavailable'
  | 'profile-mismatch' | 'timeout' | 'output-limit' | 'execution-failed' | 'unrecognized-output';
export interface AgentDiagnostics {
  executorId: DiagnosticExecutorId;
  checkedAt: string;
  executable: { source: 'path' | 'configured-path' | 'unconfigured'; state: 'available' | 'missing' | 'unknown' };
  launcher: { state: 'available' | 'unavailable' | 'unknown' };
  version: { state: 'known' | 'unknown'; value?: string };
  authentication: { state: 'authenticated' | 'unauthenticated' | 'unknown'; scope: 'local-default' | 'configured-profile' };
  errors: Array<{ stage: 'executable' | 'profile' | 'version' | 'authentication'; code: DiagnosticErrorCode }>;
  notes: string[];
}

/** Only a trusted host adapter may assert these capabilities, after auditing upstream source.
 * A version, endpoint, session name, cwd or agent PID is never a daemon identity.
 */
export interface TerminalHostInstance {
  machineId: string;
  hostKind: string;
  /** Diagnostic proxy process incarnation; deliberately excluded from target ownership. */
  agentInstanceId?: string;
  identity:
    | { state: 'known'; id: string; source: string }
    | { state: 'unknown'; reason: string };
  atomicControl:
    | { state: 'supported'; source: string }
    | { state: 'unsupported'; reason: string };
}

/** Optional additions to SessionBinding and terminal.create owned records.
 * Legacy records remain readable, but absent fields do not prove ownership.
 * sessionId = workbench execution; paneId = host address; nativeSessionId = CLI history.
 * None may substitute for hostInstanceId or terminalId.
 */
export interface TerminalRecoveryBinding {
  paneId: string;
  machineId?: string;
  hostKind?: string;
  hostInstanceId?: string;
  /** Upstream terminal incarnation, distinct from a reusable pane address. */
  terminalId?: string;
  agentInstanceId?: string;
  sessionId?: string;
  nativeSessionId?: string;
  cwd?: string;
}

export interface TerminalRecoveryTarget {
  machineId: string;
  hostKind: string;
  hostInstanceId: string;
  paneId: string;
  terminalId: string;
}

/** A list observation helps reject stale targets; it never grants atomic ownership. */
export interface TerminalRecoveryPane { paneId: string; terminalId?: string; cwd?: string }

export type TerminalRecoveryCheck =
  | { state: 'confirmed'; canControl: true; target: TerminalRecoveryTarget }
  | { state: 'unknown' | 'changed' | 'missing' | 'unsupported'; canControl: false; reason: string };

/** input includes optional keys so submission need not become two separately checked writes. */
export type RecoveredTerminalAction =
  | { kind: 'input'; text: string; keys?: string[] }
  | { kind: 'keys'; keys: string[] }
  | { kind: 'close' };

export type TerminalRecoveryWriteResult =
  | { state: 'requested'; retryable: false }
  | { state: 'rejected' | 'unknown'; retryable: false; reason: string };

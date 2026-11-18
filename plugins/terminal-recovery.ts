import type {
  RecoveredTerminalAction, TerminalHostInstance, TerminalRecoveryBinding,
  TerminalRecoveryCheck, TerminalRecoveryPane, TerminalRecoveryTarget, TerminalRecoveryWriteResult,
} from '../packages/protocol/src/index.ts';

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

/** Source audit: runtime src/cli/status.rs::ServerStatusJson exposes running,
 * version, protocol, capabilities, socket and session, but no daemon incarnation.
 * src/api/schema/panes.rs::PaneSend{Text,Keys,Input}Params addresses only pane_id.
 * src/client/terminal_sessions.rs sends ControlTerminal { target, takeover };
 * its controller lease is not an expected-daemon/terminal-incarnation condition.
 * Do not promote arbitrary extra JSON fields to a capability on a future version.
 */
export function describeTerminalHostInstance(
  scope: { machineId: string; agentInstanceId?: string },
  _serverStatus: unknown,
): TerminalHostInstance {
  return {
    ...scope, hostKind: 'terminal-cli',
    identity: { state: 'unknown', reason: 'Audited server status provides no daemon instance identifier' },
    atomicControl: { state: 'unsupported', reason: 'Audited control commands have no atomic expected daemon and terminal incarnation condition' },
  };
}

/** confirmed means eligible to TRY an atomic command, not proof from a list/read.
 * The adapter must check the complete target as part of the operation itself.
 * No mutation, rebind, dispatch, native resume, or host read occurs here.
 */
export function validateTerminalRecovery(
  binding: Readonly<TerminalRecoveryBinding>,
  host: Readonly<TerminalHostInstance>,
  pane: Readonly<TerminalRecoveryPane> | undefined,
): TerminalRecoveryCheck {
  const deny = (state: 'unknown' | 'changed' | 'missing' | 'unsupported', reason: string): TerminalRecoveryCheck =>
    ({ state, canControl: false, reason });
  if (![binding.machineId, binding.hostKind, binding.hostInstanceId, binding.paneId].every(identifier)) {
    return deny('unknown', 'Historical binding has no complete machine/host/daemon/pane identity');
  }
  if (!identifier(host.machineId) || !identifier(host.hostKind)) return deny('unknown', 'Current host scope is missing');
  if (binding.machineId !== host.machineId || binding.hostKind !== host.hostKind) {
    return deny('changed', 'Machine or host kind differs from historical binding');
  }
  if (host.identity?.state !== 'known' || !identifier(host.identity.id) || !identifier(host.identity.source)) {
    return deny('unknown', 'Current daemon instance identity is not established by upstream evidence');
  }
  if (binding.hostInstanceId !== host.identity.id) return deny('changed', 'Daemon instance changed; historical binding is retained without rebinding');
  if (!pane) return deny('missing', 'Historical pane is absent');
  if (pane.paneId !== binding.paneId) return deny('changed', 'Pane address differs from historical binding');
  if (!identifier(binding.terminalId) || !identifier(pane.terminalId)) {
    return deny('unknown', 'Terminal incarnation is missing; pane address alone does not prove ownership');
  }
  if (binding.terminalId !== pane.terminalId) return deny('changed', 'Pane address now belongs to another terminal incarnation');
  if (host.atomicControl?.state !== 'supported' || !identifier(host.atomicControl.source)) {
    return deny('unsupported', 'Host cannot atomically enforce daemon and terminal identity during control');
  }
  // cwd, native session and proxy process incarnation intentionally do not establish ownership.
  return { state: 'confirmed', canControl: true, target: {
    machineId: binding.machineId!, hostKind: binding.hostKind!, hostInstanceId: binding.hostInstanceId!,
    paneId: binding.paneId, terminalId: binding.terminalId,
  } };
}

export interface TerminalRecoveryController {
  /** Trusted adapter contract: reject mismatches BEFORE effects, in the same upstream
   * operation. Never implement as describe/list followed by an unguarded CLI write.
   * requested only acknowledges the operation; it says nothing about task completion.
   * Current audited CLI has no implementation of this contract.
   */
  control(target: Readonly<TerminalRecoveryTarget>, action: RecoveredTerminalAction): Promise<TerminalRecoveryWriteResult>;
}

/** Invoke at most once. Transport errors may follow effects: unknown is never retried.
 * RPC callers must also preserve unknown across reconnects; this is not durable deduplication.
 */
export async function controlRecoveredTerminal(
  binding: Readonly<TerminalRecoveryBinding>,
  host: Readonly<TerminalHostInstance>,
  pane: Readonly<TerminalRecoveryPane> | undefined,
  action: RecoveredTerminalAction,
  controller?: TerminalRecoveryController,
): Promise<TerminalRecoveryWriteResult> {
  const check = validateTerminalRecovery(binding, host, pane);
  if (!check.canControl) return { state: 'rejected', retryable: false, reason: check.reason };
  if (!controller) return { state: 'rejected', retryable: false, reason: 'Atomic recovery controller is unavailable' };
  try {
    const result = await controller.control(check.target, action);
    if (result?.state === 'requested') return { state: 'requested', retryable: false };
    if ((result?.state === 'rejected' || result?.state === 'unknown') && typeof result.reason === 'string') {
      return { state: result.state, retryable: false, reason: result.reason };
    }
  } catch { /* Do not leak action text or CLI logs through arbitrary thrown errors. */ }
  return { state: 'unknown', retryable: false, reason: 'Terminal control outcome unknown; do not automatically resend' };
}

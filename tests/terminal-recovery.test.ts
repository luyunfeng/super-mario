import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controlRecoveredTerminal, describeTerminalHostInstance, validateTerminalRecovery } from '../plugins/terminal-recovery.ts';
import type {
  RecoveredTerminalAction, TerminalHostInstance, TerminalRecoveryBinding, TerminalRecoveryPane, TerminalRecoveryTarget,
} from '../packages/protocol/src/terminal-recovery.ts';

// Entirely synthetic upstream with a real atomic check inside the fake operation.
// These capabilities are NOT claims about the installed or audited terminal CLI.
function fixture() {
  const binding: TerminalRecoveryBinding = {
    machineId: 'machine-1', hostKind: 'fake-atomic-host', hostInstanceId: 'daemon-1',
    paneId: 'w1:p1', terminalId: 'terminal-1', agentInstanceId: 'proxy-1',
    sessionId: 'workbench-1', nativeSessionId: 'cli-history-1', cwd: '/same-cwd',
  };
  const host: TerminalHostInstance = {
    machineId: binding.machineId!, hostKind: binding.hostKind!, agentInstanceId: 'proxy-1',
    identity: { state: 'known', id: 'daemon-1', source: 'test fake daemon incarnation' },
    atomicControl: { state: 'supported', source: 'test fake checks expected target before effect' },
  };
  const pane: TerminalRecoveryPane = { paneId: binding.paneId, terminalId: binding.terminalId, cwd: binding.cwd };
  return { binding, host, pane };
}

test('audited adapter never infers identity or atomic capabilities from status JSON', () => {
  for (const status of [undefined, null, {}, 'malformed', {
    running: true, version: 'same-version', socket: '/same/socket', endpoint: '/same/socket',
    protocol: 1, session: 'same-session', pid: 123, agentpid: 123, cwd: '/same-cwd',
    instance_id: 'unreviewed-extension', daemonInstanceId: 'unreviewed-extension',
    capabilities: { atomicControl: true },
  }]) {
    const host = describeTerminalHostInstance({ machineId: 'machine-1', agentInstanceId: 'proxy-1' }, status);
    assert.equal(host.identity.state, 'unknown');
    assert.equal(host.atomicControl.state, 'unsupported');
    assert.equal(host.agentInstanceId, 'proxy-1');
    const { binding, pane } = fixture();
    assert.equal(validateTerminalRecovery({ ...binding, hostKind: host.hostKind }, host, pane).canControl, false);
  }
});

test('legacy bindings remain unchanged and readable without inventing missing ownership', () => {
  const { host, pane } = fixture();
  const legacy = Object.freeze({ sessionId: 'workbench-1', paneId: 'w1:p1', nativeSessionId: 'cli-history-1', cwd: '/same-cwd' });
  const before = JSON.stringify(legacy);
  assert.equal(validateTerminalRecovery(legacy, host, pane).state, 'unknown');
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(legacy.sessionId, 'workbench-1');
  assert.equal(legacy.paneId, 'w1:p1');
  assert.equal(legacy.nativeSessionId, 'cli-history-1');
});

test('missing or malformed optional persisted identities fail closed without throwing', () => {
  const { binding, host, pane } = fixture();
  for (const field of ['machineId', 'hostKind', 'hostInstanceId', 'terminalId'] as const) {
    for (const value of [undefined, null, '', ' ', 123, 'bad\0id']) {
      const old = { ...binding, [field]: value } as TerminalRecoveryBinding;
      assert.equal(validateTerminalRecovery(old, host, pane).state, 'unknown', field);
    }
  }
  assert.equal(validateTerminalRecovery(binding, { ...host, identity: undefined } as unknown as TerminalHostInstance, pane).state, 'unknown');
});

test('same pane/cwd/native history cannot mask a daemon restart or missing identity', () => {
  const { binding, host, pane } = fixture();
  const before = structuredClone(binding);
  assert.equal(validateTerminalRecovery(binding, { ...host, identity: { state: 'known', id: 'daemon-2', source: 'fake' } }, pane).state, 'changed');
  assert.equal(validateTerminalRecovery(binding, { ...host, identity: { state: 'unknown', reason: 'offline' } }, pane).state, 'unknown');
  assert.deepEqual(binding, before);
});

test('matching daemon identity requires an upstream source and matching scope', () => {
  const { binding, host, pane } = fixture();
  assert.equal(validateTerminalRecovery(binding, { ...host, identity: { state: 'known', id: 'daemon-1', source: '' } }, pane).state, 'unknown');
  for (const changed of [{ machineId: 'machine-2' }, { hostKind: 'other-host' }]) {
    assert.equal(validateTerminalRecovery(binding, { ...host, ...changed }, pane).state, 'changed');
  }
});

test('pane reuse inside one daemon is rejected even with identical cwd and native session', () => {
  const { binding, host, pane } = fixture();
  assert.equal(validateTerminalRecovery(binding, host, { ...pane, terminalId: 'terminal-2' }).state, 'changed');
  assert.equal(validateTerminalRecovery(binding, host, { ...pane, terminalId: undefined }).state, 'unknown');
  assert.equal(validateTerminalRecovery(binding, host, undefined).state, 'missing');
  assert.equal(validateTerminalRecovery(binding, host, { ...pane, paneId: 'w1:p2' }).state, 'changed');
});

test('new proxy process does not change daemon ownership; same proxy cannot vouch for new daemon', () => {
  const { binding, host, pane } = fixture();
  assert.equal(validateTerminalRecovery(binding, { ...host, agentInstanceId: 'proxy-2' }, pane).canControl, true);
  assert.equal(validateTerminalRecovery({ ...binding, agentInstanceId: undefined }, host, pane).canControl, true);
  assert.equal(validateTerminalRecovery(binding, { ...host, identity: { state: 'known', id: 'proxy-1', source: 'fake' } }, pane).canControl, false);
});

test('matching identity/list is insufficient without atomic control support', async () => {
  const { binding, host, pane } = fixture();
  host.atomicControl = { state: 'unsupported', reason: 'only check then write exists' };
  assert.equal(validateTerminalRecovery(binding, host, pane).state, 'unsupported');
  let calls = 0;
  const result = await controlRecoveredTerminal(binding, host, pane, { kind: 'close' }, {
    async control() { calls++; return { state: 'requested', retryable: false }; },
  });
  assert.equal(result.state, 'rejected');
  assert.equal(calls, 0);
});

test('same instance permits a guarded operation with complete independent target identifiers', async () => {
  const { binding, host, pane } = fixture();
  let calls = 0;
  const result = await controlRecoveredTerminal(binding, host, pane, { kind: 'input', text: 'hello', keys: ['Enter'] }, {
    async control(target, action) {
      calls++;
      assert.deepEqual(target, {
        machineId: 'machine-1', hostKind: 'fake-atomic-host', hostInstanceId: 'daemon-1',
        paneId: 'w1:p1', terminalId: 'terminal-1',
      });
      assert.deepEqual(action, { kind: 'input', text: 'hello', keys: ['Enter'] });
      return { state: 'requested', retryable: false };
    },
  });
  assert.deepEqual(result, { state: 'requested', retryable: false });
  assert.equal(calls, 1);
});

test('atomic fake rejects daemon or terminal replacement between observation and operation', async () => {
  for (const replacement of [{ hostInstanceId: 'daemon-2' }, { terminalId: 'terminal-2' }]) {
    const { binding, host, pane } = fixture();
    const live: TerminalRecoveryTarget = {
      machineId: 'machine-1', hostKind: 'fake-atomic-host', hostInstanceId: 'daemon-1',
      paneId: 'w1:p1', terminalId: 'terminal-1', ...replacement,
    };
    let effects = 0;
    const result = await controlRecoveredTerminal(binding, host, pane, { kind: 'close' }, {
      async control(expected) {
        // This comparison and effect are synchronous in the fake host operation.
        if (JSON.stringify(expected) !== JSON.stringify(live)) return { state: 'rejected', retryable: false, reason: 'upstream target mismatch' };
        effects++;
        return { state: 'requested', retryable: false };
      },
    });
    assert.equal(result.state, 'rejected');
    assert.equal(effects, 0);
  }
});

test('all actions are blocked before calling controller on changed or unknown daemon', async () => {
  const actions: RecoveredTerminalAction[] = [{ kind: 'input', text: 'x' }, { kind: 'keys', keys: ['C-c'] }, { kind: 'close' }];
  for (const action of actions) {
    const { binding, host, pane } = fixture();
    host.identity = { state: 'unknown', reason: 'no identity' };
    let calls = 0;
    const result = await controlRecoveredTerminal(binding, host, pane, action, {
      async control() { calls++; return { state: 'requested', retryable: false }; },
    });
    assert.equal(result.state, 'rejected');
    assert.equal(calls, 0);
  }
});

test('no controller means unsupported execution even with advertised capabilities', async () => {
  const { binding, host, pane } = fixture();
  assert.equal((await controlRecoveredTerminal(binding, host, pane, { kind: 'close' })).state, 'rejected');
});

test('write then disconnect returns unknown without retrying or leaking prompt/logs', async () => {
  const { binding, host, pane } = fixture();
  const before = structuredClone(binding);
  let effects = 0;
  const result = await controlRecoveredTerminal(binding, host, pane, { kind: 'input', text: 'private prompt' }, {
    async control() { effects++; throw new Error('private prompt and secret CLI output'); },
  });
  assert.equal(result.state, 'unknown');
  assert.equal(result.retryable, false);
  assert.equal(effects, 1);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(binding, before);
});

test('explicit unknown/rejection is preserved without retry; malformed acknowledgement stays unknown', async () => {
  const { binding, host, pane } = fixture();
  for (const state of ['unknown', 'rejected'] as const) {
    let calls = 0;
    const result = await controlRecoveredTerminal(binding, host, pane, { kind: 'keys', keys: ['C-c'] }, {
      async control() { calls++; return { state, retryable: false, reason: 'fake transport result' }; },
    });
    assert.equal(result.state, state);
    assert.equal(result.retryable, false);
    assert.equal(calls, 1);
  }
  const result = await controlRecoveredTerminal(binding, host, pane, { kind: 'close' }, {
    control: async () => undefined as never,
  });
  assert.equal(result.state, 'unknown');
});

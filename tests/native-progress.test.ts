import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNativeCollector, readTaskResult, saveTaskResult } from '../plugins/task-results.ts';

// Native schemas: developers.openai.com/codex/noninteractive and
// code.claude.com/docs/en/headless, /docs/en/agent-sdk/typescript.
// All payloads are synthetic. No personal CLI, config, or session is read.
test('Codex native lifecycle moves from reasoning through tools to response', () => {
  const collector = createNativeCollector('codex');
  collector.event({ type: 'thread.started', thread_id: 'fixture-codex' });
  assert.equal(collector.result().progress?.phase, 'starting');
  collector.event({ type: 'turn.started' });
  assert.equal(collector.result().progress?.phase, 'thinking');
  collector.event({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Plan' } });
  assert.equal(collector.result().progress?.phase, 'thinking');
  for (const type of ['item.started', 'item.updated', 'item.completed']) {
    collector.event({ type, item: { id: 'c1', type: 'command_execution', command: 'bash -lc ls', status: type === 'item.completed' ? 'completed' : 'in_progress' } });
    assert.equal(collector.result().progress?.phase, 'tool');
    assert.equal(collector.result().progress?.toolName, 'command_execution');
    assert.equal(collector.result().state, 'running');
  }
  collector.event({ type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call', server: 'fixture', tool: 'lookup', arguments: { query: 'fixture' }, status: 'in_progress' } });
  assert.equal(collector.result().progress?.toolName, 'lookup');
  collector.event({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'Done' } });
  assert.equal(collector.result().progress?.phase, 'responding');
  assert.equal(collector.result().progress?.toolName, undefined);
  assert.equal(collector.result(0).state, 'unknown', 'a response item is not a terminal turn');
  collector.event({ type: 'turn.completed', usage: {} });
  assert.equal(collector.result(0).state, 'completed');
  assert.equal(collector.result(0).text, 'Done');
});

test('Claude initialization and message.content tool_use/text provide progress', () => {
  const collector = createNativeCollector('claude-code');
  collector.event({ type: 'system', subtype: 'init', session_id: 'fixture-claude' });
  assert.equal(collector.result().progress?.phase, 'starting');
  collector.event({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Plan' }] } });
  assert.equal(collector.result().progress?.phase, 'thinking');
  collector.event({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/fixture' } }] } });
  assert.equal(collector.result().progress?.phase, 'tool');
  assert.equal(collector.result().progress?.toolName, 'Read');
  collector.event({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } });
  assert.equal(collector.result().progress?.phase, 'responding');
  assert.equal(collector.result().progress?.toolName, undefined);
  assert.equal(collector.result(0).state, 'unknown');
  collector.event({ type: 'result', subtype: 'success', is_error: false, result: 'Done' });
  assert.equal(collector.result(0).state, 'completed');
});

test('no native event, unknown event, idle and permission-like prose never invent a phase', () => {
  for (const executor of ['codex', 'claude-code'] as const) {
    const collector = createNativeCollector(executor);
    assert.equal(collector.result().progress, undefined);
    for (const event of [null, [], 'done; waiting for approval', { type: 'idle' }, { type: 'permission_required' },
      { type: 'something.new', phase: 'waiting', text: 'success' },
      { type: 'item.started', item: { type: 'unknown_tool', status: 'waiting' } },
      { type: 'assistant', content: [{ type: 'text', text: 'not message.content' }] },
      { type: 'assistant', message: { content: [null, {}, { type: 'text', text: 42 }, { type: 'tool_use', name: {} }] } },
    ]) collector.event(event);
    assert.equal(collector.result().progress, undefined);
    assert.equal(collector.result(0).state, 'unknown');
  }
});

test('duplicate events and result reads do not refresh observedAt; semantic changes do', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-01T00:00:00.000Z') });
  for (const executor of ['codex', 'claude-code'] as const) {
    const collector = createNativeCollector(executor);
    const tool = executor === 'codex'
      ? { type: 'item.started', item: { type: 'mcp_tool_call', tool: 'Read', arguments: {} } }
      : { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking' }, { type: 'tool_use', name: 'Read', input: {} }] } };
    collector.event(tool);
    const first = collector.result().progress!;
    t.mock.timers.tick(1000);
    collector.event(tool);
    collector.event({ type: 'unknown' });
    assert.deepEqual(collector.result().progress, first);
    // Changing ignored inputs also cannot masquerade as new observed activity.
    collector.event(executor === 'codex' ? { ...tool, item: { type: 'mcp_tool_call', tool: 'Read', arguments: { ignored: true } } } : tool);
    assert.deepEqual(collector.result().progress, first);
    collector.event(executor === 'codex'
      ? { type: 'item.started', item: { type: 'agent_message', text: 'Reply' } }
      : { type: 'assistant', message: { content: [{ type: 'text', text: 'Reply' }] } });
    assert.equal(collector.result().progress?.phase, 'responding');
    assert.notEqual(collector.result().progress?.observedAt, first.observedAt);
    const snapshot = collector.result().progress!;
    snapshot.phase = 'waiting';
    assert.equal(collector.result().progress?.phase, 'responding', 'callers cannot mutate collector observations');
  }
});

test('progress stays bounded and omits argv, tool input, output, credentials and model prose', () => {
  const secret = 'FIXTURE_PRIVATE_TOKEN';
  const huge = secret.repeat(1000);
  for (const executor of ['codex', 'claude-code'] as const) {
    const collector = createNativeCollector(executor);
    const events = executor === 'codex' ? [
      { type: 'item.started', item: { type: 'command_execution', command: `bash -lc ${huge}`, aggregated_output: huge } },
      { type: 'item.started', item: { type: 'mcp_tool_call', tool: 'x'.repeat(1000), server: huge, arguments: { token: huge }, result: huge } },
      { type: 'item.updated', item: { type: 'reasoning', text: huge } },
      { type: 'item.started', item: { type: 'agent_message', text: huge } },
    ] : [
      { type: 'system', subtype: 'init', apiKeySource: huge, tools: [huge] },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'x'.repeat(1000), input: { command: huge } }] } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: huge }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: huge }] } },
    ];
    for (const event of events) {
      collector.event(event);
      const progress = collector.result().progress!;
      assert.ok(progress);
      assert.ok((progress.toolName?.length ?? 0) <= 80);
      assert.ok((progress.detail?.length ?? 0) <= 80);
      assert.ok(JSON.stringify(progress).length < 256);
      assert.ok(!JSON.stringify(progress).includes(secret));
    }
    collector.event(executor === 'codex'
      ? { type: 'item.started', item: { type: 'mcp_tool_call', tool: `Bash --token=${secret}` } }
      : { type: 'assistant', message: { content: [{ type: 'tool_use', name: `Bash --token=${secret}`, input: {} }] } });
    assert.ok(!JSON.stringify(collector.result().progress).includes(secret));
  }
});

test('progress and permission prose cannot alter exit, terminal-event or identity requirements', () => {
  for (const executor of ['codex', 'claude-code'] as const) {
    const collector = createNativeCollector(executor, 'expected');
    collector.event(executor === 'codex'
      ? { type: 'item.completed', item: { type: 'agent_message', text: 'done; waiting for approval' } }
      : { type: 'assistant', message: { content: [{ type: 'text', text: 'done; waiting for approval' }] } });
    assert.equal(collector.result().state, 'running');
    assert.equal(collector.result().progress?.phase, 'responding');
    assert.equal(collector.result(0).state, 'unknown');
    collector.event(executor === 'codex' ? { type: 'turn.completed' } : { type: 'result', subtype: 'success', is_error: false });
    const finalProgress = collector.result().progress;
    assert.equal(collector.result(0).state, 'unknown', 'native identity still required');
    collector.event(executor === 'codex' ? { type: 'thread.started', thread_id: 'expected' } : { type: 'system', subtype: 'init', session_id: 'expected' });
    assert.equal(collector.result(0).state, 'completed');
    assert.equal(collector.result(7).state, 'failed');
    assert.equal(collector.result(undefined, 'SIGTERM').state, 'unknown');
    assert.ok(finalProgress);
    const last = collector.result().progress;
    collector.event(executor === 'codex' ? { type: 'turn.failed', error: { message: 'failure' } } : { type: 'result', subtype: 'error_during_execution', is_error: true });
    assert.equal(collector.result(0).state, 'failed');
    assert.deepEqual(collector.result(0).progress, last, 'terminal records retain the last observation');
  }
});

test('wrong native ID remains failed despite progress, later matching ID, completion or signal', () => {
  for (const executor of ['codex', 'claude-code'] as const) {
    const collector = createNativeCollector(executor, 'expected');
    const identity = (id: string) => executor === 'codex'
      ? { type: 'thread.started', thread_id: id } : { type: 'system', subtype: 'init', session_id: id };
    collector.event(identity('wrong'));
    collector.event(executor === 'codex'
      ? { type: 'item.started', item: { type: 'command_execution', command: 'ls' } }
      : { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
    assert.equal(collector.result().state, 'failed');
    assert.equal(collector.result().nativeSessionId, 'wrong');
    collector.event(identity('expected'));
    collector.event(executor === 'codex' ? { type: 'turn.completed' } : { type: 'result', subtype: 'success', is_error: false });
    assert.equal(collector.result(0).state, 'failed');
    assert.equal(collector.result(undefined, 'SIGTERM').state, 'failed');
    assert.match(collector.result(0).text, /不同的线程/);
  }
});

test('stored progress survives reload; disappeared runner remains unknown with its last observation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'super-mario-native-progress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'result.json');
  const collector = createNativeCollector('codex');
  collector.event({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } });
  saveTaskResult(path, collector.result(), process.pid);
  assert.deepEqual(readTaskResult(path), collector.result());
  saveTaskResult(path, collector.result(), 2147483647);
  assert.equal(readTaskResult(path).state, 'unknown');
  assert.deepEqual(readTaskResult(path).progress, collector.result().progress);
});

test('task usage comes from the invocation, includes cache once and preserves unavailable counts', () => {
  const claude = createNativeCollector('claude-code');
  const result = { type: 'result', subtype: 'success', is_error: false,
    usage: { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, output_tokens: 11 } };
  claude.event(result);
  claude.event(result);
  assert.deepEqual(claude.result(0).usage, { input: 15, output: 11 });
  assert.equal(claude.result().usage, undefined);
  const pi = createNativeCollector('pi');
  const message = { role: 'assistant', usage: { input: 0, cacheRead: 1, cacheWrite: 2, output: 3 } };
  pi.event({ type: 'message_end', message });
  pi.event({ type: 'message_end', message: { ...message, stopReason: 'stop', content: [] } });
  pi.event({ type: 'agent_settled', aborted: false });
  assert.deepEqual(pi.result(0).usage, { input: 6, output: 6 });
  pi.event({ type: 'message_end', message: { role: 'assistant' } });
  pi.event({ type: 'message_end', message });
  assert.equal(pi.result(0).usage, undefined);
  const codex = createNativeCollector('codex');
  for (const input_tokens of [-1, null, '4', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    codex.event({ type: 'turn.completed', usage: { input_tokens, output_tokens: 1 } });
    assert.equal(codex.result(0).usage, undefined);
  }
  codex.event({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } });
  assert.deepEqual(codex.result(0).usage, { input: 0, output: 0 });
});

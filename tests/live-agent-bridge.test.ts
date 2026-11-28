import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveAgentBridge, executeLiveAgentSend, type LiveTakeoverView } from '../plugins/live-agent-bridge.ts';
import type { ExtensionContext, Json, MachineClient, Tool } from '../packages/plugin-sdk/src/index.ts';
import type { Project } from '../packages/protocol/src/index.ts';

function activateBridge(options: {
  projects?: Project[];
  machines?: MachineClient;
  takeovers?: LiveTakeoverView[];
  names?: Record<string, string>;
  onSend?: (input: Record<string, unknown>) => unknown;
  onAnswer?: (input: Record<string, unknown>) => unknown;
}) {
  const tools = new Map<string, Tool>();
  const ext = createLiveAgentBridge({
    projects: () => options.projects ?? [],
    machines: () => options.machines,
    takeoverList: () => options.takeovers ?? [],
    sessionCustomTitle: (m, e, id) => options.names?.[`${m}:${e}:${id}`],
    proposeSend: input => (options.onSend ? options.onSend(input) : { approvalId: 'ap-send', ...input }) as never,
    proposeAnswerPrompt: input => (options.onAnswer ? options.onAnswer(input) : { approvalId: 'ap-ans', keys: input.keys }) as never,
  });
  ext.activate({
    contribute(kind: string, id: string, value: unknown) {
      if (kind === 'tools') tools.set(id, value as Tool);
    },
  } as unknown as ExtensionContext);
  return tools;
}

test('live_agents_list scopes by project subdirectory, merges custom titles and open prompts', async () => {
  const projects: Project[] = [
    { id: 'p1', name: 'Demo Hub', description: '', workspace: { machineId: 'm1', cwd: '/work/demo' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  ];
  const machines: MachineClient = {
    list: () => [{ id: 'm1', name: 'DevBox', online: true, capabilities: ['terminal.live.list', 'terminal.live.read', 'agents.sessions'], connectedAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-01T00:00:00Z' } as never],
    async call(_mid, method): Promise<Json> {
      if (method === 'terminal.live.list') {
        return {
          panes: [
            { paneId: 'w1:p1', terminalId: 't1', cwd: '/work/demo/sub-a', title: 'raw-title', agent: 'claude', state: 'working', nativeSessionId: 'sess-111' },
            { paneId: 'w2:p2', terminalId: 't2', cwd: '/work/other', title: 'outside', agent: 'codex', state: 'idle' },
          ],
        };
      }
      if (method === 'terminal.live.read') return { text: '\x1b[32mline1\x1b[0m\nline2\nline3' };
      return {};
    },
  };
  const takeovers: LiveTakeoverView[] = [{
    key: 'm1:t1:rev1', machineId: 'm1', machineName: 'DevBox', paneId: 'w1:p1', terminalId: 't1',
    cwd: '/work/demo/sub-a', paneTitle: 'raw-title', agent: 'claude', projectId: 'p1',
    kind: 'permission', title: '终端等待权限确认', excerpt: 'Allow running npm test?',
    options: [{ label: '1. Allow', keys: '1\r' }, { label: '2. Deny', keys: '2\r' }],
    status: 'open',
  }];
  const tools = activateBridge({
    projects, machines, takeovers,
    names: { 'm1:claude-code:sess-111': '主干重构会话' },
  });

  const ac = new AbortController();
  const listed = await tools.get('live_agents_list')!.execute({ projectName: 'Demo' }, ac.signal) as {
    agents: Array<{ paneId: string; title: string; customTitle?: string; projectId?: string }>;
    openPrompts: Array<{ key: string; options: Array<{ index: number; label: string }> }>;
    terminalsUrl: string;
  };
  assert.equal(listed.agents.length, 1);
  assert.equal(listed.agents[0]!.paneId, 'w1:p1');
  assert.equal(listed.agents[0]!.title, '主干重构会话');
  assert.equal(listed.agents[0]!.projectId, 'p1');
  assert.equal(listed.openPrompts.length, 1);
  assert.equal(listed.openPrompts[0]!.options[0]!.index, 1);
  assert.equal(listed.terminalsUrl, '/terminals.html?projectId=p1');

  const read = await tools.get('live_agent_read')!.execute({ machineId: 'm1', paneId: 'w1:p1', terminalId: 't1', cwd: '/work/demo/sub-a', lines: 20 }, ac.signal) as { output: string };
  assert.equal(read.output, 'line1\nline2\nline3');

  // Controlled write tools propose approvals instead of writing directly.
  const sent = await tools.get('live_agent_send')!.execute({
    machineId: 'm1', paneId: 'w1:p1', terminalId: 't1', cwd: '/work/demo/sub-a', text: 'run tests', reason: '主人要求跑测试',
  }, ac.signal) as { approvalId: string };
  assert.equal(sent.approvalId, 'ap-send');

  const answered = await tools.get('live_agent_answer_prompt')!.execute({
    key: 'm1:t1:rev1', optionIndex: 1, reason: '允许运行单测',
  }, ac.signal) as { approvalId: string; keys: string };
  assert.equal(answered.approvalId, 'ap-ans');
  assert.equal(answered.keys, '1\r');

  await assert.rejects(
    () => tools.get('live_agent_answer_prompt')!.execute({ key: 'm1:t1:rev1', optionIndex: 9, reason: 'bad' }, ac.signal),
    /选项序号无效/,
  );
});

test('executeLiveAgentSend opens control lease, writes UTF-8 base64 payload, and always releases lease', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const machines: MachineClient = {
    list: () => [],
    async call(_mid, method, params): Promise<Json> {
      calls.push({ method, params });
      if (method === 'terminal.live.open') return { connectionId: 'lease-42' };
      return { ok: true };
    },
  };
  const res = await executeLiveAgentSend(machines, {
    machineId: 'm1', paneId: 'w1:p1', terminalId: 't1', cwd: '/work/demo', text: '继续执行', submit: true,
  }) as { delivered: boolean };
  assert.equal(res.delivered, true);
  assert.deepEqual(calls.map(c => c.method), ['terminal.live.open', 'terminal.live.input', 'terminal.live.release']);
  assert.equal(Buffer.from(String(calls[1]!.params.data), 'base64').toString('utf8'), '继续执行\r');
  assert.equal(calls[2]!.params.connectionId, 'lease-42');
});

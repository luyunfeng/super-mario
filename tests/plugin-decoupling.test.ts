import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import type { Extension } from '../packages/plugin-sdk/src/index.ts';

async function workbenchFixture(t: test.TestContext, demo = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-plugin-decouple-'));
  const app = await createWorkbench({ dataDir, host: '127.0.0.1', port: 0, demo });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { app, dataDir };
}

test('plugin-owned tools mount and unmount strictly with their owning system extension', async t => {
  const { app } = await workbenchFixture(t, true);
  const toolNames = () => new Set(app.contributions.list('tools').map(entry => entry.value.name));

  const groups: Array<[string, string[]]> = [
    ['feishu', ['feishu_status', 'bots_list', 'bot_handoff', 'mailboxes_list', 'mailbox_propose']],
    ['inbox-triage', ['inbox_triage_status', 'inbox_list', 'inbox_assign_project', 'inbox_handling_read']],
    ['terminal-host', ['terminal_host_status', 'agent_sessions', 'session_resume']],
    ['knowledge-local', ['knowledge_ingest', 'knowledge_jobs']],
    ['daily-brief', ['brief_read', 'scheduled_work_list', 'scheduled_work_propose', 'scheduled_work_cancel', 'scheduled_work_set_paused']],
  ];

  for (const [pluginId, expectedTools] of groups) {
    for (const name of expectedTools) assert.equal(toolNames().has(name), true, `${pluginId} should expose ${name} when enabled`);
    await app.plugins.setEnabled(pluginId, false);
    for (const name of expectedTools) assert.equal(toolNames().has(name), false, `${pluginId} must unmount ${name} when disabled`);
    await app.plugins.setEnabled(pluginId, true);
    for (const name of expectedTools) assert.equal(toolNames().has(name), true, `${pluginId} must restore ${name} when re-enabled`);
  }
});

test('non-Feishu channel, custom triage service and custom remote executor plug into core without core edits', async t => {
  const { app } = await workbenchFixture(t, false);
  const sent: Array<[string, string]> = [];

  // 1. Replace default inbox-triage with a custom plugin-provided triage service.
  await app.plugins.setEnabled('inbox-triage', false);
  const customTriage: Extension = {
    id: 'custom-triage',
    name: '自定义分拣器',
    capabilities: ['inbox.triage'],
    activate(context) {
      context.contribute('inbox_triage', 'custom', { id: 'custom-triage', service: 'custom-triage.classify' });
      context.provide('custom-triage.classify', input => {
        const text = String((input as { text?: string })?.text ?? '');
        return text.includes('URGENT_CUSTOM')
          ? { tier: 'action', reason: '插件分拣命中紧急标记' }
          : { tier: 'fyi', reason: '插件分拣普通通知' };
      });
    },
  };
  app.plugins.register(customTriage);

  // 2. Register a second IM channel plugin (Slack) and verify outbox + attention work with zero core hardcoding.
  const slackChannel: Extension = {
    id: 'slack',
    name: 'Slack',
    capabilities: ['slack.channel'],
    activate(context) {
      context.contribute('channels', 'slack', {
        id: 'slack',
        name: 'Slack',
        outboxPrefixes: ['slack.bot'],
        approvalKinds: ['channel-reply'],
        sourcePrefix: 'slack:',
      });
    },
  };
  app.plugins.register(slackChannel);

  // 3. Register a third-party executor plugin whose id does not use the builtin `executor-*` prefix.
  const opencodePlugin: Extension = {
    id: 'vendor-opencode',
    name: 'OpenCode 执行器',
    capabilities: ['executor.opencode'],
    activate(context) {
      context.contribute('executors', 'opencode', {
        id: 'opencode',
        name: 'OpenCode',
        kind: 'opencode',
        machineId: 'local',
        available: false,
        mode: 'real',
        nativeResultSources: ['opencode-json'],
        description: '第三方 CLI 执行器',
        async execute() { throw new Error('requires remote node'); },
      });
    },
  };
  app.plugins.register(opencodePlugin);
  await app.plugins.start();

  // Verify custom triage + Slack source in attention
  await app.inbox.ingest('slack:workspace-1', [
    { thread: 'slack:c1', last: 'm1', title: '架构频道', text: 'URGENT_CUSTOM 请确认插件解耦契约' },
  ]);
  const item = app.inbox.list().find(row => row.source === 'slack:workspace-1')!;
  assert.equal(item.tier, 'action');
  assert.equal(item.reason, '注入分拣器：插件分拣命中紧急标记');
  const attentionRow = app.attention().find(row => row.id === `inbox:${item.id}`);
  assert.ok(attentionRow, 'Slack action item must appear in unified attention');
  assert.equal(attentionRow.source, 'Slack');

  // Verify Slack outbox enqueue -> channel-reply approval -> single delivery
  const unregister = app.background.outbox.registerChannel('slack.bot', async (target, text) => {
    sent.push([target, text]);
  }, () => 'C_OWNER');
  try {
    const queued = app.background.outbox.enqueue('core', {
      dedupKey: 'slack-msg-1',
      channel: 'slack.bot',
      target: 'C_ARCH',
      content: { text: '通过通用渠道审批发送' },
    });
    const pending = await app.background.outbox.send(queued.id);
    assert.equal(pending.status, 'needs_approval');
    const approval = app.approvals.list().find(a => a.id === pending.approvalId)!;
    assert.equal(approval.kind, 'channel-reply');
    await app.approvals.approve(approval.id, approval.version);
    await app.background.outbox.send(queued.id);
    assert.deepEqual(sent, [['C_ARCH', '通过通用渠道审批发送']]);
  } finally {
    unregister();
  }

  // Verify third-party executor merges with connected node and unmounts when terminal-host disables
  app.setMachineClient({
    list: () => [{
      id: 'box-1', name: '远端开发机', online: true, platform: 'linux', connectedAt: new Date().toISOString(),
      capabilities: ['executor.start', 'executor.result'],
      executors: [{ id: 'opencode', name: 'OpenCode', kind: 'opencode', machineId: 'box-1', available: true, mode: 'real', description: '远端 OpenCode', nativeResultSources: ['opencode-json'] }],
    }],
    call: async () => ({ sessionId: 'sess-1' }),
  });
  assert.equal(app.snapshot !== undefined, true);
  const snapOn = await app.snapshot();
  assert.equal(snapOn.executors.some(e => e.id === 'box-1/opencode' && e.available), true);
  await app.plugins.setEnabled('terminal-host', false);
  const snapOff = await app.snapshot();
  assert.equal(snapOff.executors.some(e => e.id === 'box-1/opencode'), false);
});

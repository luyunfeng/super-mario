import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkbench } from '../packages/core/src/workbench.ts';
import { loadDefaultNodePlugins } from '../apps/agent-node/src/node-plugins.ts';
import { officeWorkerGuide } from '../plugins/office/guide.ts';
import type { JsonObject, MachineInfo } from '../packages/protocol/src/index.ts';

test('machine advertises its read-only Office guide without a configured executor', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-node-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const command = join(dataDir, 'missing-executor');
  const plugins = await loadDefaultNodePlugins({ machineId: 'fixture', agentInstanceId: 'instance', dataDir, terminalCommand: command,
    launchers: { codex: { command }, 'claude-code': { command }, pi: { command } } });
  t.after(() => plugins.close());
  assert.deepEqual(await plugins.handlers['office.guide']({}, () => {}), { guide: officeWorkerGuide });
  await assert.rejects(plugins.handlers['office.guide']({ path: '/unused' }, () => {}), /不接受参数/);
});

test('dispatch attaches the Office guide only to a new ordinary task on a capable machine', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'office-dispatch-'));
  const app = await createWorkbench({ dataDir, host: '127.0.0.1', port: 0, demo: false });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const machine: MachineInfo = { id: 'fixture', name: '测试执行机', platform: 'linux', online: true, connectedAt: '',
    capabilities: ['executor.start', 'office.guide'], executors: [{ id: 'codex', name: '伪执行者', kind: 'cli', machineId: 'fixture',
      available: true, mode: 'real', description: 'Collects prompts only' }] };
  const starts: JsonObject[] = [];
  app.setMachineClient({ list: () => [machine], async call(id, method, params) {
    assert.equal(id, machine.id);
    assert.equal(method, 'executor.start');
    starts.push(params);
    return { sessionId: 'fake-session-' + starts.length };
  } });
  const task = { executorId: 'fixture/codex', cwd: '/fixture', prompt: '测试工作', doneWhen: '得到结果', expectMinutes: 1 };
  async function promptAfter(send: () => unknown) {
    const before = starts.length;
    await send();
    for (let i = 0; i < 150 && starts.length === before; i++) await delay(10);
    assert.equal(starts.length, before + 1);
    return starts[before].prompt;
  }
  assert.equal(await promptAfter(() => app.dispatch(task)), task.prompt + '\n\n' + officeWorkerGuide);
  const approval = app.approvals.propose({ kind: 'dispatch', title: '已确认的精确任务', details: '', params: task });
  assert.equal(await promptAfter(() => app.approvals.approve(approval.id, approval.version)), task.prompt);
  assert.equal(await promptAfter(() => app.dispatch({ ...task, executionMode: 'interactive' })), task.prompt);
  await app.plugins.setEnabled('office-documents', false);
  assert.equal(await promptAfter(() => app.dispatch(task)), task.prompt);
  await app.plugins.setEnabled('office-documents', true);
  machine.capabilities = ['executor.start'];
  assert.equal(await promptAfter(() => app.dispatch(task)), task.prompt);
});

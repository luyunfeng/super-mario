import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { CPU_BUSY_FOR_MS, findAlerts, newAlerts } from '../packages/core/src/machine-alerts.ts';
import type { Json } from '../packages/plugin-sdk/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

const NOW = Date.parse('2026-11-27T10:00:00.000Z');

test('a disk nearly full, memory nearly used up, and processors busy for minutes are worth telling of', () => {
  const storage = { mounts: [{ mount: '/', usedPercent: 93 }, { mount: '/data00', usedPercent: 40 }] };
  // Five minutes of samples, all with the processors busy and memory filling up.
  const samples = Array.from({ length: 61 }, (_, index) => ({ at: new Date(NOW - (60 - index) * 5000).toISOString(), cpuPercent: 95, memoryPercent: index === 60 ? 92 : 50 }));
  const alerts = findAlerts(storage, { samples }, NOW);
  assert.deepEqual(alerts, [
    { name: 'disk:/', text: '/ 已用 93%，快满了。' },
    { name: 'memory', text: '内存已用 92%。' },
    { name: 'cpu', text: '处理器已连续 5 分钟在 90% 以上。' },
  ]);
  // Below the thresholds nothing is said, and one busy moment is not five busy minutes.
  assert.deepEqual(findAlerts({ mounts: [{ mount: '/', usedPercent: 89 }] }, { samples: samples.map(sample => ({ ...sample, cpuPercent: 50, memoryPercent: 50 })) }, NOW), []);
  const brieflyBusy = samples.map((sample, index) => ({ ...sample, cpuPercent: index >= 58 ? 95 : 10, memoryPercent: 50 }));
  assert.deepEqual(findAlerts(undefined, { samples: brieflyBusy }, NOW), []);
  // A reading that is not well-formed says nothing, and does not fail.
  assert.deepEqual(findAlerts(null, null, NOW), []);
  assert.deepEqual(findAlerts({ mounts: 'nope' }, { samples: [{ at: 'not a date', cpuPercent: 95 }] }, NOW), []);
  assert.deepEqual(findAlerts({ mounts: [{ mount: '', usedPercent: 99 }, { mount: '/x', usedPercent: '99' }] }, undefined, NOW), []);
  assert.equal(CPU_BUSY_FOR_MS, 5 * 60 * 1000);
});

test('a condition is new only when this computer was not already told of it', () => {
  const alerts = [{ name: 'disk:/', text: '/' }, { name: 'memory', text: 'm' }];
  assert.deepEqual(newAlerts(alerts, []).map(alert => alert.name), ['disk:/', 'memory']);
  assert.deepEqual(newAlerts(alerts, ['disk:/']).map(alert => alert.name), ['memory']);
  assert.deepEqual(newAlerts(alerts, ['disk:/', 'memory']), []);
});

test('巡检读每台在线电脑，新问题通知主人一次；问题还在不再通知，消失后再出现会再通知', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-alerts-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token: 'alerts-fixture' });
  let full = true;
  const node = startAgentNode({ url: server.url, token: 'alerts-fixture', machineId: 'alerts-machine', name: '告警测试电脑', dataDir: join(dir, 'node'), executors: [],
    handlers: {
      'machine.storage': async () => ({ at: new Date().toISOString(), os: 'linux', supported: true, collectedMs: 1, mounts: full ? [{ mount: '/', device: '/dev/vda', fsType: 'ext4', totalBytes: 100, usedBytes: 95, availBytes: 5, usedPercent: 95, readOnly: false }] : [] }) as unknown as Json,
      'machine.resources': async () => ({ at: new Date().toISOString(), os: 'linux', supported: true, cpus: 4, memory: { totalBytes: 100, freeBytes: 50, usedPercent: 50 }, load: [0, 0, 0], uptimeSeconds: 1, samples: [], windowSeconds: 900 }) as unknown as Json,
    } });
  t.after(async () => { await server.close(); await node.close(); await rm(dir, { recursive: true, force: true }); });
  for (let tries = 0; tries < 100 && !server.machines.list().some(item => item.id === 'alerts-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const notices = () => server.app.store.list<Message>('messages').filter(message => message.origin === 'notification' && message.text.includes('告警测试电脑'));
  // The first check finds the disk nearly full and tells the owner once.
  assert.deepEqual(await server.app.machineAlertsCheck(), { checked: 1, told: 1 });
  assert.equal(notices().length, 1);
  assert.match(notices()[0]!.text, /告警测试电脑：\/ 已用 95%，快满了。/);
  assert.match(notices()[0]!.text, /这台电脑需要你看一下/);
  // The disk is still nearly full: it is not told of again.
  assert.deepEqual(await server.app.machineAlertsCheck(), { checked: 1, told: 0 });
  assert.equal(notices().length, 1);
  // Space is made. Nothing is told, and the condition is forgotten.
  full = false;
  assert.deepEqual(await server.app.machineAlertsCheck(), { checked: 1, told: 0 });
  assert.equal(server.app.store.get<{ told: string[] }>('machine-alerts', 'alerts-machine')?.told.length, 0);
  // It fills up again: the owner is told again.
  full = true;
  assert.deepEqual(await server.app.machineAlertsCheck(), { checked: 1, told: 1 });
  assert.equal(notices().length, 2);
  // A computer that goes offline is not read, and is not treated as having a problem.
  // Turned off by the owner: nothing is read and nothing is told, and what was told is kept.
  full = true;
  assert.equal((await fetch(server.url + '/api/v1/briefing/settings', { method: 'PUT', headers: { authorization: 'Bearer alerts-fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ machineAlerts: false }) })).status, 200);
  assert.deepEqual(await server.app.machineAlertsCheck(), { checked: 0, told: 0 });
  assert.equal(server.app.store.get<{ told: string[] }>('machine-alerts', 'alerts-machine')?.told.length, 1, 'what was told is kept for when it is on again');
  // On again: the disk is still nearly full and was already told of, so nothing more is said.
  assert.equal((await fetch(server.url + '/api/v1/briefing/settings', { method: 'PUT', headers: { authorization: 'Bearer alerts-fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ machineAlerts: true }) })).status, 200);
  assert.deepEqual(await server.app.machineAlertsCheck(), { checked: 1, told: 0 });
  assert.equal(notices().length, 2);
  // A computer that goes offline is not read, and is not treated as having a problem.
  await node.close();
  for (let tries = 0; tries < 100 && server.machines.list().some(item => item.id === 'alerts-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await server.app.machineAlertsCheck(), { checked: 0, told: 0 });
  assert.equal(notices().length, 2);
});

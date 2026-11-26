import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Json } from '../packages/plugin-sdk/src/index.ts';

const at = '2026-11-27T10:00:00.000Z';
/** What a machine says of its resources and its network. Fixed, so that the test does not
 *  depend on the computer it runs on. */
const resources = {
  at, os: 'linux', supported: true, cpus: 8, memory: { totalBytes: 16000, freeBytes: 4000, usedPercent: 75 },
  load: [1.5, 2, 2.5], uptimeSeconds: 90000, windowSeconds: 900,
  samples: [
    { at: '2026-11-27T09:59:50.000Z', cpuPercent: 10, memoryPercent: 70, load: [1, 1, 1] },
    { at: '2026-11-27T09:59:55.000Z', cpuPercent: 45, memoryPercent: 75, load: [1.5, 1.2, 1.1] },
  ],
};
const network = {
  at, os: 'linux', supported: true, collectedMs: 12, processesKnown: false,
  addresses: [{ name: 'eth0', address: '10.0.0.5', family: 'IPv4', mac: '', internal: false, netmask: '255.255.255.0', cidr: '10.0.0.5/24' }],
  ports: [
    { protocol: 'tcp', address: '0.0.0.0', port: 22, pid: 1234, processName: 'sshd' },
    { protocol: 'tcp', address: '127.0.0.1', port: 8080 },
  ],
  probes: [{ host: '10.0.0.1', ok: true, ms: 2 }],
};

async function start(t: { after(fn: () => void): void }, options: { offers?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-inspect-http-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token: 'offline-inspect' });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const asked: string[] = [];
  const node = startAgentNode({ url: server.url, token: 'offline-inspect', machineId: 'inspect-machine', name: '工作电脑', dataDir: join(dir, 'node'), executors: [],
    handlers: options.offers === false ? {} : {
      'machine.resources': async params => { assert.deepEqual(params, {}); asked.push('resources'); return resources as unknown as Json; },
      'machine.network': async params => { assert.deepEqual(params, {}); asked.push('network'); return network as unknown as Json; },
    } });
  t.after(() => node.close());
  for (let tries = 0; tries < 100 && !server.machines.list().some(item => item.id === 'inspect-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const read = async (what: 'resources' | 'network', query = '?machineId=inspect-machine', credential = 'offline-inspect') => {
    const answer = await fetch(server.url + '/api/v1/machines/' + what + query, { headers: credential ? { authorization: 'Bearer ' + credential } : {} });
    return { status: answer.status, body: await answer.json() as Record<string, unknown> };
  };
  return { server, node, read, asked };
}

test('页面请求某台电脑的资源和网络，服务端向那台电脑读取并原样返回，带上电脑编号', async t => {
  const f = await start(t);
  for (const [what, report] of [['resources', resources], ['network', network]] as const) {
    const { status, body } = await f.read(what);
    assert.equal(status, 200);
    assert.deepEqual(body, { ...report, machineId: 'inspect-machine' });
  }
  // Each was asked for once, by name, with no arguments.
  assert.deepEqual(f.asked, ['resources', 'network']);
});

test('电脑离线、代理太旧、参数不对、没有令牌时各自说明原因', async t => {
  const f = await start(t);
  for (const what of ['resources', 'network'] as const) {
    assert.equal((await f.read(what, '?machineId=no-such-machine')).status, 503);
    assert.equal((await f.read(what, '')).status, 400);
    assert.equal((await f.read(what, '?machineId=inspect-machine&path=/etc')).status, 400);
    assert.equal((await f.read(what, '?machineId=inspect-machine&machineId=other')).status, 400);
    assert.equal((await f.read(what, '?machineId=inspect-machine', '')).status, 401);
  }
  assert.deepEqual(f.asked, [], 'nothing was asked of the machine for a request that was refused');
  // A machine goes offline: the reading says so and does not hang.
  await f.node.close();
  for (let tries = 0; tries < 100 && f.server.machines.list().some(item => item.id === 'inspect-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await f.read('resources')).status, 503);
});

test('一台没有这两项读取的旧代理，服务端让页面升级而不是报错', async t => {
  const f = await start(t, { offers: false });
  assert.equal((await f.read('resources')).status, 409);
  assert.equal((await f.read('network')).status, 409);
  assert.deepEqual(f.asked, []);
});

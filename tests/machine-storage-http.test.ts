import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { StorageReport } from '../apps/agent-node/src/machine-storage.ts';
import type { Json } from '../packages/plugin-sdk/src/index.ts';

const at = '2026-11-27T10:00:00.000Z';
/** What a machine says of its disks. Fixed, so that the test does not depend on the disk it runs on. */
const report: StorageReport = {
  at, os: 'linux', supported: true, collectedMs: 7,
  mounts: [
    { mount: '/', device: '/dev/vda2', fsType: 'ext4', totalBytes: 120, usedBytes: 90, availBytes: 30, usedPercent: 75, inodesTotal: 10, inodesUsed: 2, inodesPercent: 20, readOnly: false },
    { mount: '/data00', device: '/dev/vdb', fsType: 'ext4', totalBytes: 500, usedBytes: 100, availBytes: 400, usedPercent: 20, readOnly: false },
  ],
};

async function start(t: { after(fn: () => void): void }, options: { offersStorage?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-storage-http-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token: 'offline-storage' });
  let node: ReturnType<typeof startAgentNode> | undefined;
  t.after(async () => { await node?.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const asked: unknown[] = [];
  node = startAgentNode({ url: server.url, token: 'offline-storage', machineId: 'storage-machine', name: '工作电脑', dataDir: join(dir, 'node'), executors: [],
    handlers: options.offersStorage === false ? {} : {
      'machine.storage': async params => { asked.push(params); return report as unknown as Json; },
    } });
  // Wait until the machine has said hello, so that the server knows what it can do.
  for (let tries = 0; tries < 100 && !server.machines.list().some(item => item.id === 'storage-machine' && item.online); tries++)
    await new Promise(resolve => setTimeout(resolve, 20));
  const read = async (query = '?machineId=storage-machine') => {
    const answer = await fetch(server.url + '/api/v1/machines/storage' + query, { headers: { authorization: 'Bearer offline-storage' } });
    return { status: answer.status, body: await answer.json() as Record<string, unknown> };
  };
  return { server, read, asked };
}

test('页面请求某台电脑的存储，服务端向那台电脑的执行机读取并原样返回，带上电脑编号', async t => {
  const f = await start(t);
  const { status, body } = await f.read();
  assert.equal(status, 200);
  assert.deepEqual(body, { ...report, machineId: 'storage-machine' });
  // The machine was asked once, with no arguments: it has no say in which computer is read.
  assert.deepEqual(f.asked, [{}]);
});

test('电脑离线、代理太旧、参数不对时各自说明原因', async t => {
  const f = await start(t);
  assert.equal((await f.read('?machineId=no-such-machine')).status, 503);
  assert.equal((await f.read('')).status, 400);
  assert.equal((await f.read('?machineId=storage-machine&path=/etc')).status, 400);
  assert.equal((await f.read('?machineId=storage-machine&machineId=other')).status, 400);
  // Nothing was asked of the machine for a request that was refused.
  assert.deepEqual(f.asked, []);
  // Without the owner's token there is no reading.
  assert.equal((await fetch(f.server.url + '/api/v1/machines/storage?machineId=storage-machine')).status, 401);
});

test('执行机版本太旧、没有这项能力时，请主人升级而不是报错', async t => {
  const f = await start(t, { offersStorage: false });
  const { status, body } = await f.read();
  assert.equal(status, 409);
  assert.match(String(body.error), /升级执行机代理/);
  assert.deepEqual(f.asked, []);
});

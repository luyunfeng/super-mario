import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInfo, buildLabel, parseBuildRecord } from '../packages/core/src/build-info.ts';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';

const commit = 'b'.repeat(40);
const at = '2026-11-26T12:00:00.000Z';
const unknown = { commit: 'unknown', builtAt: 'unknown', dirty: false };
const quote = String.fromCharCode(34);

test('构建记录格式损坏或内容不合法时读作未知，不编造提交号', () => {
  const bad = [
    '{not json', '[]', 'null', '{}', quote + 'a string' + quote, '7', '',
    JSON.stringify({ commit, builtAt: 'yesterday' }),
    JSON.stringify({ commit, builtAt: '2026-13-45T00:00:00Z' }),
    JSON.stringify({ commit, builtAt: 1764158400000 }),
    JSON.stringify({ commit: 'abc', builtAt: at }),
    JSON.stringify({ commit: commit.toUpperCase(), builtAt: at }),
    JSON.stringify({ commit: commit + '0', builtAt: at }),
    JSON.stringify({ builtAt: at }),
    JSON.stringify({ commit, builtAt: at, dirty: 'yes' }),
  ];
  for (const text of bad) assert.deepEqual(parseBuildRecord(text), unknown, text);
  // A record that says unknown is unknown, and a good one keeps its commit, time and flag.
  assert.deepEqual(parseBuildRecord(JSON.stringify({ commit: 'unknown', builtAt: at })), unknown);
  assert.deepEqual(parseBuildRecord(JSON.stringify({ commit, builtAt: at, dirty: true })), { commit, builtAt: at, dirty: true });
  // The time is kept as an instant, so the same moment in another zone reads the same.
  assert.deepEqual(parseBuildRecord(JSON.stringify({ commit, builtAt: '2026-11-26T20:00:00+08:00' })), { commit, builtAt: at, dirty: false });
});

test('给人看的构建标识是短的，并在构建含未提交改动时标明', () => {
  assert.equal(buildLabel(unknown), '未构建');
  assert.equal(buildLabel({ commit, builtAt: at, dirty: false }), 'b'.repeat(10));
  assert.equal(buildLabel({ commit, builtAt: at, dirty: true }), 'b'.repeat(10) + '（含未提交改动）');
  // Without an argument it reads the real build record.
  assert.equal(buildLabel(), buildLabel(buildInfo()));
});

test('代理握手上报自己的构建，服务端记下它，健康接口报告同一个构建', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-build-node-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'offline-build-info' });
  const node = startAgentNode({ url: server.url, token: 'offline-build-info', machineId: 'build-machine', name: '开发机', dataDir: join(dir, 'node') });
  t.after(async () => { await node.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const expected = buildInfo();
  for (let i = 0; i < 200 && !server.machines.list().some(machine => machine.id === 'build-machine' && machine.online); i++)
    await new Promise(resolve => setTimeout(resolve, 25));
  const machine = server.machines.list().find(item => item.id === 'build-machine')!;
  assert.ok(machine, 'the node connected');
  assert.equal(machine.build?.commit, expected.commit, 'the node reports the build it was started from');
  assert.equal(machine.build?.dirty, expected.dirty || undefined);
  const health = await (await fetch(server.url + '/api/v1/health')).json() as { version: string; build: { commit: string; dirty: boolean } };
  assert.equal(health.build.commit, expected.commit, 'the server and the node were started from the same tree');
  assert.match(health.version, /^\d+\.\d+\.\d+$/, 'the package version is still reported');
  // What a person reads agrees with the record, in this tree whether built or not.
  assert.equal(buildLabel(), expected.commit === 'unknown' ? '未构建' : expected.commit.slice(0, 10) + (expected.dirty ? '（含未提交改动）' : ''));
});

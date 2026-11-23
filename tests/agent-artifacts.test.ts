import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { agentArtifactSha256, loadVerifiedAgentArtifact, verifyAgentArtifact } from '../packages/plugin-sdk/src/agent-artifacts.ts';
import { createAgentArtifactLoader } from '../apps/agent-node/src/agent-artifacts.ts';
import { createAgentArtifacts } from '../apps/server/src/agent-artifacts.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import type { MachineClient } from '../packages/plugin-sdk/src/index.ts';
import type { JsonObject } from '../packages/protocol/src/index.ts';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-artifact-'));
  const sentinel = join(dir, 'sentinel');
  const loader = createAgentArtifactLoader({ dataDir: dir });
  t.after(async () => { await loader.close(); await rm(dir, { recursive: true, force: true }); });
  const emit = () => {};
  const load = (value: unknown) => loader.handlers['extension.load'](value as JsonObject, emit);
  const status = (id = 'probe') => loader.handlers['extension.status']({ id }, emit);
  const source = (version = '1.0.0', extra = '') => `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(sentinel)}, 'import;');
    export default { id: 'probe', version: '${version}', async activate(context) {
      appendFileSync(${JSON.stringify(sentinel)}, 'activate;');
      context.defer(() => appendFileSync(${JSON.stringify(sentinel)}, 'dispose;'));
      context.register('x.probe.echo', async params => ({ echo: params.text }));
      ${extra}
    }};
  `;
  const input = (code = source(), version = '1.0.0') => {
    const manifest = { id: 'probe', version, apiVersion: 1 as const, sha256: agentArtifactSha256(code) };
    return { manifest, source: code, approval: { id: manifest.id, version, sha256: manifest.sha256, approved: true as const } };
  };
  return { dir, sentinel, loader, load, status, source, input, emit };
}

test('rejects unconfirmed, changed version/hash and non-JSON inputs before side effects', async t => {
  const f = await fixture(t);
  const good = f.input();
  const invalid = [
    { ...good, approval: { ...good.approval, approved: false } },
    { ...good, approval: null },
    { ...good, manifest: { ...good.manifest, version: '2.0.0' } },
    { ...good, source: good.source + '\n// changed' },
    { ...good, approval: { ...good.approval, sha256: '0'.repeat(64) } },
    { ...good, bad: () => {} }, { ...good, bad: new Date() },
    Object.defineProperty({ ...good }, 'bad', { enumerable: true, get() { throw new Error('accessor executed'); } }),
  ];
  for (const input of invalid) await assert.rejects(f.load(input));
  await assert.rejects(stat(f.sentinel), { code: 'ENOENT' });
  assert.equal(f.loader.handlers['x.probe.echo'], undefined);
  assert.equal(agentArtifactSha256('你好'), '670d9743542cae3ea7ebe36af56bd53648b0a1126162e78d81a32934a711302e');
});

test('relative/file/external/re-export/dynamic dependencies never execute either module', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'dependency.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(f.sentinel)}, 'DEPENDENCY');`);
  const dependencies = [
    "import './dependency.mjs';", `import ${JSON.stringify(`file://${f.dir}/dependency.mjs`)};`,
    "import 'unapproved-package';", "export * from './dependency.mjs';",
    "await import('./dependency.mjs');", "const later = () => import('node:fs');",
    "// comment\u2028await import('node:fs');", "const t = `${import('node:fs')}`;",
    "const \u0069mportAlias = 1; import('./dependency.mjs');",
  ];
  for (const dependency of dependencies) await assert.rejects(f.load(f.input(f.source() + dependency)), () => true, dependency);
  await assert.rejects(stat(f.sentinel), { code: 'ENOENT' });
});

test('normal JavaScript regex, division, templates and Unicode do not trigger false dependency failures', async t => {
  const f = await fixture(t);
  const loaded = await f.load(f.input(f.source() + "const normal = /import('node:fs')/; const ratio = 1 / 2; const 中文 = `value:${ratio}`;"));
  assert.equal((loaded as JsonObject).loaded, true);
});

test('verified builtin and public SDK imports load; activate, idempotence, update and close clean resources', async t => {
  const f = await fixture(t);
  const input = f.input(f.source() + "\nimport * as sdk from 'super-mario/plugin-sdk';");
  const result = await f.load(input);
  assert.deepEqual(result, { ...input.manifest, loaded: true, methods: ['x.probe.echo'] });
  assert.deepEqual(await f.loader.handlers['x.probe.echo']({ text: 'hello' }, f.emit), { echo: 'hello' });
  await f.load(input);
  assert.equal(await readFile(f.sentinel, 'utf8'), 'import;activate;');
  const next = f.input(f.source('2.0.0'), '2.0.0');
  await assert.rejects(f.load({ ...next, approval: input.approval }), /未确认/);
  await f.load(next);
  assert.equal(await readFile(f.sentinel, 'utf8'), 'import;activate;dispose;import;activate;');
  f.loader.handlers['unrelated.method'] = async () => null;
  await f.loader.close();
  await f.loader.close();
  assert.equal(f.loader.handlers['x.probe.echo'], undefined);
  assert.ok(f.loader.handlers['unrelated.method']);
  assert.ok(f.loader.handlers['extension.status']);
  assert.equal(await readFile(f.sentinel, 'utf8'), 'import;activate;dispose;import;activate;dispose;');
  await assert.rejects(f.load(next), /关闭/);
  const restart = createAgentArtifactLoader({ dataDir: f.dir });
  t.after(() => restart.close());
  const status = await restart.handlers['extension.status']({ id: 'probe' }, f.emit);
  assert.equal((status as JsonObject).loaded, false);
  assert.equal(restart.handlers['x.probe.echo'], undefined);
  assert.equal(await readFile(f.sentinel, 'utf8'), 'import;activate;dispose;import;activate;dispose;');
  const mode = (await stat(join(f.dir, 'agent-artifacts', 'confirmed.json'))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('failed activation removes staged registrations and disposes once; cannot replace builtin or others', async t => {
  const f = await fixture(t);
  for (const method of ['extension.status', 'node.status', 'x.other.echo', 'x.probe.echo']) {
    const bad = f.input(f.source('1.0.0', `context.register('${method}', async () => null);`));
    await assert.rejects(f.load(bad), /不能重复注册/);
    assert.equal(f.loader.handlers['x.probe.echo'], undefined);
  }
  assert.equal((await readFile(f.sentinel, 'utf8')).split('dispose;').length - 1, 4);
  assert.equal((await f.status() as JsonObject).loaded, false);
});

test('module identity and version must match manifest; handler JSON boundary rejects functions', async t => {
  const f = await fixture(t);
  await assert.rejects(f.load(f.input("export default {id:'other',version:'1.0.0',activate(){}}")), /default/);
  const code = f.source('1.0.0', "context.register('x.probe.bad', async () => ({ fn() {} }));");
  await f.load(f.input(code));
  await assert.rejects(f.loader.handlers['x.probe.bad']({}, f.emit), /JSON/);
  assert.throws(() => verifyAgentArtifact({ ...f.input(), manifest: new Date() }));
  await assert.rejects(loadVerifiedAgentArtifact({ ...f.input(), approval: null }));
});

async function serviceFixture(t: TestContext) {
  const f = await fixture(t);
  const store = createStore(join(f.dir, 'service.sqlite'));
  const events = createEventBus(store);
  t.after(() => store.close());
  let calls = 0;
  let online = true;
  let response: 'real' | 'false' | 'timeout' = 'real';
  const machine: MachineClient = {
    list: () => [{ id: 'm1', name: 'Fixture', platform: 'test', online, capabilities: ['extension.load', 'extension.status', 'extension.call'], connectedAt: '' }],
    async call(_id, method, params) {
      calls++;
      if (response === 'false') return { loaded: true };
      if (response === 'timeout') throw Object.assign(new Error('timeout: execution unknown'), { delivery: 'unknown' });
      return f.loader.handlers[method](params, f.emit);
    },
  };
  const service = createAgentArtifacts({ store, events, machines: () => machine });
  const stage = (version = '1.0.0') => service.stage({ machineId: 'm1', manifest: { id: 'probe', version, apiVersion: 1 }, source: f.source(version) });
  return { ...f, store, events, service, stage, count: () => calls, offline: () => { online = false; }, response: (value: typeof response) => { response = value; } };
}

test('service stage → explicit SHA approval → fake-node deployment; immutable records and source-free events', async t => {
  const f = await serviceFixture(t);
  const first = f.stage();
  assert.notEqual(first.id, first.pluginId);
  assert.equal(first.status, 'pending');
  assert.equal(f.service.list()[0].source, first.source);
  await assert.rejects(f.service.deploy(first.id), /先确认/);
  assert.throws(() => f.service.approve(first.id, { sha256: '0'.repeat(64) }), /SHA256/);
  assert.equal(f.count(), 0);
  f.service.approve(first.id, { sha256: first.manifest.sha256 });
  const earlierCheck = f.service.status(first.id);
  const loading = f.service.deploy(first.id);
  assert.equal((await f.service.status(first.id)).status, 'deploying');
  assert.ok(['deploying','loaded'].includes((await earlierCheck).status));
  const loaded = await loading;
  assert.equal(loaded.status, 'loaded');
  assert.deepEqual(await f.service.call(first.id, { method: 'x.probe.echo', params: { text: 'gateway' } }), { echo: 'gateway' });
  assert.equal((await f.service.status(first.id)).status, 'loaded');
  const next = f.stage('2.0.0');
  assert.notEqual(next.id, first.id);
  assert.equal(next.status, 'pending');
  assert.equal(next.approval, undefined);
  await assert.rejects(f.service.deploy(next.id));
  assert.throws(() => f.service.approve(next.id, { sha256: first.manifest.sha256 }));
  assert.ok(f.events.since(0).every(event => !JSON.stringify(event.data).includes('source')));
  assert.throws(() => f.service.stage({ machineId: 'm1', manifest: { ...first.manifest, sha256: '0'.repeat(64) }, source: first.source }), /SHA256/);
});

test('service offline, forged success and unknown delivery fail explicitly and never retry', async t => {
  const f = await serviceFixture(t);
  for (const mode of ['false', 'timeout'] as const) {
    f.response(mode);
    const record = f.stage();
    f.service.approve(record.id, { sha256: record.manifest.sha256 });
    await assert.rejects(f.service.deploy(record.id));
    assert.equal(f.service.list().find(item => item.id === record.id)?.status, 'unknown');
    const calls = f.count();
    await assert.rejects(f.service.deploy(record.id));
    assert.equal(f.count(), calls);
    assert.throws(() => f.service.approve(record.id, { sha256: record.manifest.sha256 }));
  }
  f.offline();
  const record = f.stage();
  f.service.approve(record.id, { sha256: record.manifest.sha256 });
  const calls = f.count();
  await assert.rejects(f.service.deploy(record.id), /离线/);
  assert.equal(f.count(), calls);
  assert.equal(f.service.list().find(item => item.id === record.id)?.status, 'failed');
  await assert.rejects(stat(f.sentinel), { code: 'ENOENT' });
});

test('a new pending record cannot inherit approval through status; persisted tampering is rejected', async t => {
  const f = await serviceFixture(t);
  const first = f.stage();
  f.service.approve(first.id, { sha256: first.manifest.sha256 });
  await f.service.deploy(first.id);
  const pending = f.stage();
  const calls = f.count();
  assert.equal((await f.service.status(pending.id)).status, 'pending');
  assert.equal(f.count(), calls);
  assert.equal(f.service.list().find(item => item.id === pending.id)?.approval, undefined);
  f.service.approve(pending.id, { sha256: pending.manifest.sha256 });
  f.store.put('agent-artifacts', pending.id, { ...f.service.list().find(item => item.id === pending.id)!, manifest: { ...pending.manifest, version: '9.0.0' } });
  await assert.rejects(f.service.deploy(pending.id), /未确认/);
  assert.equal(f.count(), calls);
  const modified = f.service.stage({ machineId: 'm1', manifest: { id: 'probe', version: '1.0.0', apiVersion: 1 }, source: f.source() + '\n// changed bytes' });
  assert.equal(modified.status, 'pending');
  assert.notEqual(modified.manifest.sha256, first.manifest.sha256);
  assert.throws(() => f.service.approve(modified.id, { sha256: first.manifest.sha256 }));
});

test('activation failure and disposer failure never report loaded; concurrent loads do not duplicate registrations', async t => {
  const f = await fixture(t);
  const bad = f.input(f.source('1.0.0', "context.defer(() => { throw new Error('cleanup failed'); }); throw new Error('activation failed');"));
  await assert.rejects(f.load(bad), /activation failed.*清理失败/);
  assert.equal(f.loader.handlers['x.probe.echo'], undefined);
  assert.equal((await f.status() as JsonObject).loaded, false);
  const good = f.input(f.source('2.0.0'), '2.0.0');
  const results = await Promise.all([f.load(good), f.load(good)]);
  assert.ok(results.every(result => (result as JsonObject).loaded === true));
  assert.equal(Object.keys(f.loader.handlers).filter(method => method === 'x.probe.echo').length, 1);
  assert.equal((await readFile(f.sentinel, 'utf8')).split('activate;').length - 1, 2);
});

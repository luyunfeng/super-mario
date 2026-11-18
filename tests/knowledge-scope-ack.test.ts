import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createKnowledgeCurator, type Job } from '../packages/core/src/knowledge-curator.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createLocalKnowledge } from '../plugins/knowledge-local.ts';
import type { ExtensionContext, MachineClient } from '../packages/plugin-sdk/src/index.ts';
import type { Json, JsonObject } from '../packages/protocol/src/index.ts';

const personal = { layer: 'personal' };
const project = (projectId: string) => ({ layer: 'project', projectId });
const output = JSON.stringify({ pages: [{ title: '合成知识', content: '仅合成资料' }] });
type Reply = (method: string, params: JsonObject, normal: JsonObject) => JsonObject;
async function fixture(t: TestContext, reply: Reply = (_method, _params, normal) => normal) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-scope-ack-'));
  const store = createStore(join(dir, 'store.sqlite'));
  const events = createEventBus(store);
  const knowledge = createLocalKnowledge({ store, dataDir: join(dir, 'plugins', 'knowledge-local') } as ExtensionContext);
  const calls: { method: string; params: JsonObject }[] = [];
  const remoteJobs = new Map<string, JsonObject>();
  let online = true, valid = true;
  const client: MachineClient = {
    list: () => [{ id: 'node', name: 'Synthetic', online, platform: 'linux', connectedAt: 'now', capabilities: ['executor.knowledge.start'] }],
    async call(_machine, method, params) {
      calls.push({ method, params });
      const normal: JsonObject = { workerId: 'worker-' + JSON.stringify(params.scope), provider: 'codex', scope: params.scope!, state: 'idle',
        ...(params.jobId && remoteJobs.has(String(params.jobId)) ? { job: remoteJobs.get(String(params.jobId))! } : {}) };
      if (method === 'executor.knowledge.submit') {
        remoteJobs.set(String(params.jobId), { id: params.jobId!, scope: params.scope!, status: 'completed', text: output });
        return { accepted: true };
      }
      return reply(method, params, normal);
    },
  };
  store.put('knowledge.curator', 'settings', { enabled: true, machineId: 'node', provider: 'codex' });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const make = () => createKnowledgeCurator({ store, events, dataDir: dir, knowledge: () => knowledge, machines: () => client, enabled: () => true, validProject: () => valid });
  let curator = make();
  t.after(async () => { await curator.close(); store.close(); t.mock.timers.reset(); await rm(dir, { recursive: true, force: true }); });
  const pulse = async () => { t.mock.timers.tick(2000); await delay(15); };
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 150; i++) { if (done()) return; await pulse(); }
    assert.fail('synthetic curator did not settle');
  };
  return { store, events, knowledge, calls, remoteJobs, pulse, until,
    get curator() { return curator; },
    job: (id: string) => store.get<Job>('knowledge.sources', id)!,
    online: (value: boolean) => { online = value; }, archive: () => { valid = false; },
    restart: async () => { await curator.close(); curator = make(); },
  };
}

for (const scope of [personal, project('A')]) {
  for (const fault of ['missing start scope', 'wrong start scope', 'missing status scope', 'wrong status scope', 'wrong start provider', 'wrong status provider', 'wrong status worker', 'wrong idle job scope'] as const) {
    test(`${JSON.stringify(scope)}: ${fault} blocks all material and preserves the queued source`, async t => {
      const f = await fixture(t, (method, _params, normal) => {
        const result = { ...normal };
        if (method === 'executor.knowledge.start') {
          if (fault === 'missing start scope') delete result.scope;
          if (fault === 'wrong start scope') result.scope = project('other');
          if (fault === 'wrong start provider') result.provider = 'claude-code';
        }
        if (method === 'executor.knowledge.status') {
          if (fault === 'missing status scope') delete result.scope;
          if (fault === 'wrong status scope') result.scope = project('other');
          if (fault === 'wrong status provider') result.provider = 'claude-code';
          if (fault === 'wrong status worker') result.workerId = 'unrelated';
          if (fault === 'wrong idle job scope') result.job = { id: 'other', scope: project('other'), status: 'completed', text: output };
        }
        return result;
      });
      const job = f.curator.addSource({ ...scope, text: 'PRIVATE_SYNTHETIC_SOURCE' });
      await f.until(() => f.curator.status().worker.state === 'failed');
      for (let i = 0; i < 3; i++) await f.pulse();
      assert.match(f.curator.status().worker.reason!, /执行机未确认知识作用域，请升级/);
      assert.equal(f.job(job.id).status, 'queued');
      assert.equal(f.job(job.id).text, 'PRIVATE_SYNTHETIC_SOURCE');
      assert.equal(f.calls.filter(call => call.method === 'executor.knowledge.submit' || call.method === 'executor.knowledge.stop').length, 0);
      assert.equal((await f.knowledge.list()).length, 0);
      assert.equal(f.store.get('knowledge.curator', 'bindings'), undefined);
      assert.ok(f.events.since(0).some(event => event.type === 'knowledge.curator.changed'));
    });
  }
}

for (const fault of ['missing job scope', 'wrong job scope', 'wrong job id', 'wrong live scope', 'only local metadata', 'missing all evidence'] as const) {
  test(`durable recovery: ${fault} cannot import or redispatch`, async t => {
    const f = await fixture(t, (method, params, normal) => {
      if (method !== 'executor.knowledge.status' || !params.jobId) return normal;
      const job: JsonObject = { id: params.jobId, scope: project('A'), status: 'completed', text: output };
      if (fault === 'missing job scope') delete job.scope;
      if (fault === 'wrong job scope') job.scope = project('B');
      if (fault === 'wrong job id') job.id = 'unrelated';
      if (fault === 'only local metadata') { delete job.scope; job.source = { scope: project('A') }; job.wait = { scope: project('A') }; }
      if (fault === 'missing all evidence') return { state: 'stopped' };
      if (fault === 'wrong live scope') return { ...normal, scope: project('B'), job };
      return { state: 'stopped', job };
    });
    const job = f.curator.addSource({ layer: 'project', projectId: 'A', text: 'synthetic' });
    f.store.put('knowledge.sources', job.id, { ...job, status: 'running' });
    await f.until(() => f.job(job.id).status === 'unknown');
    for (let i = 0; i < 3; i++) await f.pulse();
    assert.equal(f.job(job.id).recoveryPending, true);
    assert.match(f.job(job.id).error!, /执行机未确认知识作用域，请升级/);
    assert.equal((await f.knowledge.list()).length, 0);
    assert.ok(f.calls.every(call => call.method === 'executor.knowledge.status'));
  });
}

for (const status of ['completed', 'unknown'] as const) test(`scoped durable ${status} recovers without a live worker or binding`, async t => {
  const f = await fixture(t, (method, params, normal) => method === 'executor.knowledge.status' && params.jobId
    ? { state: 'stopped', job: { id: params.jobId, scope: project('A'), status, text: output } } : normal);
  const job = f.curator.addSource({ layer: 'project', projectId: 'A', text: 'synthetic' });
  f.store.put('knowledge.sources', job.id, { ...job, status: 'unknown', recoveryPending: true });
  await f.until(() => f.job(job.id).recoveryPending === false);
  assert.equal(f.job(job.id).status, status);
  assert.equal((await f.knowledge.list()).length, status === 'completed' ? 1 : 0);
  assert.ok(f.calls.every(call => call.method === 'executor.knowledge.status'));
});

test('different scopes cannot bind the same machine/provider/workerId; prior binding and history remain', async t => {
  const f = await fixture(t, (_method, _params, normal) => ({ ...normal, workerId: 'shared-worker' }));
  const binding = { machineId: 'node', workerId: 'shared-worker', provider: 'codex', scope: personal };
  // Reload an existing binding, rather than treating a local source as remote evidence.
  await f.curator.close();
  f.store.put('knowledge.curator', 'bindings', [binding]);
  await f.restart();
  const page = await f.knowledge.put({ layer: 'personal', title: '已有历史', content: '保留历史' });
  const job = f.curator.addSource({ layer: 'project', projectId: 'A', text: 'private-A' });
  await f.until(() => f.curator.status().worker.state === 'failed');
  assert.deepEqual(f.store.get('knowledge.curator', 'bindings'), [binding]);
  assert.equal(f.job(job.id).status, 'queued');
  assert.equal(f.calls.filter(call => call.method === 'executor.knowledge.submit').length, 0);
  assert.deepEqual((await f.knowledge.list()).map(page => page.id), [page.id]);
});

test('modern exact echo completes personal and project jobs through the real queue and Store', async t => {
  const f = await fixture(t);
  for (const scope of [personal, project('A'), project('B')]) {
    const job = f.curator.addSource({ ...scope, text: 'synthetic-' + JSON.stringify(scope) });
    await f.until(() => f.job(job.id).status === 'completed');
  }
  assert.equal(f.calls.filter(call => call.method === 'executor.knowledge.submit').length, 3);
  assert.equal((await f.knowledge.list()).length, 3);
  assert.equal(new Set(f.calls.filter(call => call.method === 'executor.knowledge.submit').map(call => call.params.workerId)).size, 3);
  assert.equal(f.events.since(0).filter(event => event.type === 'knowledge.changed').length, 3);
});

test('offline waits, archived destinations fail, unknown results are never automatically replayed', async t => {
  const f = await fixture(t, (method, params, normal) => {
    if (method === 'executor.knowledge.status' && params.jobId) return { ...normal, job: { id: params.jobId, scope: params.scope!, status: 'unknown' } };
    return normal;
  });
  f.online(false);
  const job = f.curator.addSource({ layer: 'project', projectId: 'A', text: 'synthetic' });
  await f.until(() => f.curator.status().worker.state === 'waiting');
  assert.equal(f.calls.length, 0);
  assert.equal(f.job(job.id).status, 'queued');
  f.online(true);
  await f.until(() => f.job(job.id).status === 'unknown');
  for (let i = 0; i < 3; i++) await f.pulse();
  assert.equal(f.calls.filter(call => call.method === 'executor.knowledge.submit').length, 1);
  f.archive();
  const archived = f.curator.addSource({ text: 'synthetic' });
  f.store.put('knowledge.sources', archived.id, { ...archived, layer: 'project', projectId: 'B' });
  await f.until(() => f.job(archived.id).status === 'failed');
  assert.match(f.job(archived.id).error!, /归档/);
  assert.equal(f.calls.filter(call => call.method === 'executor.knowledge.submit').length, 1);
});

for (const scope of [null, [], {}, { layer: 'global' }, { layer: 'project' }, project(' A'), { ...personal, projectId: 'A' }, { ...project('A'), extra: true }] as Json[]) {
  test(`invalid remote scope ${JSON.stringify(scope)} is not an acknowledgement`, async t => {
    const f = await fixture(t, (_method, _params, normal) => ({ ...normal, scope }));
    f.curator.addSource({ layer: 'project', projectId: 'A', text: 'synthetic' });
    await f.until(() => f.curator.status().worker.state === 'failed');
    assert.match(f.curator.status().worker.reason!, /执行机未确认知识作用域，请升级/);
    assert.equal(f.calls.filter(call => call.method === 'executor.knowledge.submit').length, 0);
  });
}

test('scope comparison uses canonical fields rather than JSON property order', async t => {
  const f = await fixture(t, (_method, _params, normal) => ({ ...normal,
    scope: { projectId: 'A', layer: 'project' } }));
  const job = f.curator.addSource({ layer: 'project', projectId: 'A', text: 'synthetic' });
  await f.until(() => f.job(job.id).status === 'completed');
  assert.equal((await f.knowledge.list()).length, 1);
});

const legacyBinding = { machineId: 'node', provider: 'codex', workerId: 'legacy-worker' };
for (const fault of ['missing scope', 'wrong scope', 'wrong provider', 'wrong worker', 'status unavailable'] as const) {
  test(`legacy cleanup: ${fault} preserves bindings and sources, pause stops dispatch and forbids switching`, async t => {
    const f = await fixture(t, (method, _params, normal) => {
      if (method === 'executor.knowledge.status') {
        if (fault === 'status unavailable') throw new Error('Synthetic status unavailable');
        const remote: JsonObject = { ...normal, workerId: legacyBinding.workerId };
        if (fault === 'missing scope') delete remote.scope;
        if (fault === 'wrong scope') remote.scope = project('other');
        if (fault === 'wrong provider') remote.provider = 'claude-code';
        if (fault === 'wrong worker') remote.workerId = 'someone-else';
        return remote;
      }
      // Emulate an old node that ignores the requested scope on start as well.
      if (method === 'executor.knowledge.start') return { workerId: legacyBinding.workerId, provider: 'codex', state: 'idle' };
      return normal;
    });
    await f.curator.close();
    f.store.put('knowledge.curator', 'binding', legacyBinding);
    const job = f.curator.addSource({ text: 'PRESERVE_LEGACY_SOURCE' });
    await f.restart();
    // A running durable source must not prevent a local pause.
    f.store.put('knowledge.sources', job.id, { ...job, status: 'running' });
    const paused = await f.curator.configure({ enabled: false, machineId: 'node', provider: 'codex' });
    assert.equal(paused.settings.enabled, false);
    assert.equal(paused.worker.state, 'disabled');
    assert.match(paused.worker.reason!, /已暂停派料.*远端停止未确认.*升级/);
    assert.deepEqual(f.store.get('knowledge.curator', 'binding'), legacyBinding);
    assert.equal(f.job(job.id).text, 'PRESERVE_LEGACY_SOURCE');
    assert.equal(f.job(job.id).status, 'running');
    // Remove only the test's running marker so switching tests the cleanup gate,
    // independently of the pre-existing running-job configuration guard.
    f.store.put('knowledge.sources', job.id, { ...job, status: 'unknown' });
    const count = f.calls.length;
    for (let i = 0; i < 3; i++) await f.pulse();
    assert.ok(f.calls.slice(count).every(call => call.method === 'executor.knowledge.status'));
    for (const change of [{ machineId: 'other', provider: 'codex' }, { machineId: 'node', provider: 'claude-code' }]) {
      await assert.rejects(f.curator.configure({ enabled: false, ...change }), /远端停止未确认/);
    }
    assert.equal(f.curator.status().settings.machineId, 'node');
    assert.equal(f.curator.status().settings.provider, 'codex');
    await f.curator.close();
    assert.deepEqual(f.store.get('knowledge.curator', 'binding'), legacyBinding);
    assert.equal(f.calls.filter(call => call.method === 'executor.knowledge.stop' || call.method === 'executor.knowledge.start' || call.method === 'executor.knowledge.submit').length, 0);
    assert.equal(f.job(job.id).status, 'unknown');
    await f.restart();
    const restartedCount = f.calls.length;
    for (let i = 0; i < 3; i++) await f.pulse();
    assert.equal(f.curator.status().settings.enabled, false);
    assert.ok(f.calls.slice(restartedCount).every(call => call.method === 'executor.knowledge.status'));
    assert.deepEqual(f.store.get('knowledge.curator', 'binding'), legacyBinding);
  });
}

test('closing an online legacy binding skips control and leaves the Store usable', async t => {
  const f = await fixture(t, (_method, _params, normal) => {
    const remote: JsonObject = { ...normal, workerId: legacyBinding.workerId };
    delete remote.scope;
    return remote;
  });
  await f.curator.close();
  f.store.put('knowledge.curator', 'binding', legacyBinding);
  const job = f.curator.addSource({ text: 'source retained after close' });
  await f.restart();
  await f.curator.close();
  assert.deepEqual(f.store.get('knowledge.curator', 'binding'), legacyBinding);
  assert.equal(f.job(job.id).status, 'queued');
  assert.ok(f.calls.every(call => call.method === 'executor.knowledge.status'));
  f.store.put('synthetic', 'gateway-still-open', true);
  assert.equal(f.store.get('synthetic', 'gateway-still-open'), true);
});

test('a scoped stopped snapshot clears an obsolete pointer without inventing a worker or sending stop', async t => {
  const f = await fixture(t, (method, params, normal) => method === 'executor.knowledge.status'
    ? { state: 'stopped', scope: params.scope! } : normal);
  await f.curator.close();
  f.store.put('knowledge.curator', 'bindings', [{ ...legacyBinding, scope: project('A') }]);
  await f.restart();
  const paused = await f.curator.configure({ enabled: false, machineId: 'node', provider: 'codex' });
  assert.equal(paused.worker.state, 'disabled');
  assert.deepEqual(f.store.get('knowledge.curator', 'bindings'), []);
  assert.equal(f.calls.filter(call => call.method === 'executor.knowledge.stop').length, 0);
  await f.curator.configure({ enabled: false, machineId: 'other', provider: 'claude-code' });
  assert.equal(f.curator.status().settings.provider, 'claude-code');
});

test('a stopped snapshot with no scope is not proof of absence, even for personal', async t => {
  const f = await fixture(t, (method, _params, normal) => method === 'executor.knowledge.status' ? { state: 'stopped' } : normal);
  await f.curator.close();
  f.store.put('knowledge.curator', 'binding', legacyBinding);
  await f.restart();
  await f.curator.configure({ enabled: false, machineId: 'node', provider: 'codex' });
  assert.deepEqual(f.store.get('knowledge.curator', 'binding'), legacyBinding);
  await assert.rejects(f.curator.configure({ enabled: false, machineId: 'other', provider: 'codex' }), /远端停止未确认/);
  assert.ok(f.calls.every(call => call.method === 'executor.knowledge.status'));
});

test('duplicate workerId bindings cannot stop either scope and remain durable', async t => {
  const f = await fixture(t, (_method, _params, normal) => ({ ...normal, workerId: 'shared' }));
  await f.curator.close();
  const bindings = [personal, project('A')].map(scope => ({ ...legacyBinding, workerId: 'shared', scope }));
  f.store.put('knowledge.curator', 'bindings', bindings);
  await f.restart();
  await f.curator.configure({ enabled: false, machineId: 'node', provider: 'codex' });
  await f.curator.close();
  assert.deepEqual(f.store.get('knowledge.curator', 'bindings'), bindings);
  assert.equal(f.calls.filter(call => call.method === 'executor.knowledge.stop').length, 0);
  assert.deepEqual(new Set(f.calls.map(call => JSON.stringify(call.params.scope))), new Set(bindings.map(binding => JSON.stringify(binding.scope))));
});

test('a confirmed stop failure still tries other scopes, retains the failed binding and persists pause', async t => {
  let failing = true;
  const f = await fixture(t, (method, params, normal) => {
    if (method === 'executor.knowledge.stop' && JSON.stringify(params.scope) === JSON.stringify(project('A')) && failing) throw new Error('Synthetic confirmed stop failure');
    return normal;
  });
  await f.curator.close();
  const bindings = [project('A'), project('B')].map(scope => ({ machineId: 'node', provider: 'codex', workerId: 'worker-' + JSON.stringify(scope), scope }));
  f.store.put('knowledge.curator', 'bindings', bindings);
  await f.restart();
  await assert.rejects(f.curator.configure({ enabled: false, machineId: 'node', provider: 'codex' }), /Synthetic confirmed stop failure/);
  assert.equal(f.curator.status().settings.enabled, false);
  assert.match(f.curator.status().worker.reason!, /已暂停派料.*Synthetic confirmed stop failure/);
  assert.deepEqual(f.store.get('knowledge.curator', 'bindings'), [bindings[0]]);
  assert.equal(f.calls.filter(call => call.method === 'executor.knowledge.stop').length, 2);
  await assert.rejects(f.curator.close(), /Synthetic confirmed stop failure/);
  assert.deepEqual(f.store.get('knowledge.curator', 'bindings'), [bindings[0]]);
  failing = false;
  await f.curator.close();
  assert.deepEqual(f.store.get('knowledge.curator', 'bindings'), []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createPolicies } from '../packages/core/src/policies.ts';
import { applyPolicyPreset, conservativePolicyConfig, policyPresets, policyRuleHits } from '../packages/core/src/policy-presets.ts';

function fixture(t: { after(fn: () => void): void }) {
  const store = createStore(':memory:'); t.after(() => store.close());
  return createPolicies({ store, events: createEventBus(store) });
}
test('conservative is field-for-field identical to real default policy; previews do not mutate current config', t => {
  const policies = fixture(t), current = policies.read();
  assert.deepEqual(conservativePolicyConfig(), current);
  const before = structuredClone(current), presets = policyPresets(current);
  assert.deepEqual(presets[0].diff, []);
  assert.deepEqual(current, before);
  presets[0].config.rules.push({ id: 'copy', kind: 'question', handler: 'user' });
  assert.deepEqual(current, before);
});
test('balanced automatically answers questions while every approval remains with the user', t => {
  const policies = fixture(t);
  policies.write({}, applyPolicyPreset(policies.read(), 'balanced'));
  assert.equal(policies.decide({ kind: 'question' }).mode, 'auto');
  for (const kind of ['permission', 'plan', 'review'] as const) assert.deepEqual(policies.decide({ kind, cwd: '/repo' }).stages, [{ handler: 'user', mode: 'suggest' }]);
});
test('less interruption requires trusted directory and explicit confirmation; containment is real policy behavior', t => {
  const policies = fixture(t), current = policies.read();
  assert.equal(policyPresets(current)[2].available, false);
  assert.throws(() => applyPolicyPreset(current, 'low-interruption', { confirmed: true }), /目录/);
  assert.throws(() => applyPolicyPreset(current, 'low-interruption', { trustedDirectories: ['/work/repo'] }), /确认/);
  for (const path of ['relative', '/', '/work/..']) assert.throws(() => policyPresets(current, { trustedDirectories: [path] }), TypeError);
  const value = applyPolicyPreset(current, 'low-interruption', { trustedDirectories: ['/work/repo'], confirmed: true });
  policies.write({}, value);
  assert.equal(policies.decide({ kind: 'permission', cwd: '/work/repo/src' }).mode, 'auto');
  for (const cwd of [undefined, '/work/repo-other', '/work/repo/../secret']) assert.equal(policies.decide({ kind: 'permission', cwd }).handler, 'user');
  for (const kind of ['plan', 'review'] as const) assert.equal(policies.decide({ kind, cwd: '/work/repo' }).handler, 'user');
  assert.throws(() => applyPolicyPreset(current, 'bogus'), /未知/);
});
test('seven-day hits count actual answering or suggestion evidence, once per card and in scope', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  const recent = '2026-11-15T12:00:00Z';
  const cards = [
    { id: 'a', ruleId: 'r', projectId: 'p', answeredAt: recent, routingHistory: [{ at: recent, outcome: 'suggested' }] },
    { id: 'a', ruleId: 'r', projectId: 'p', answeredAt: recent },
    { id: 'b', ruleId: 'r', projectId: 'p', routingHistory: [{ at: recent, outcome: 'suggested' }] },
    { id: 'c', ruleId: 'r', projectId: 'p', routingHistory: [{ at: recent, outcome: 'failed' }] },
    { id: 'd', ruleId: 'r', projectId: 'p', answeredAt: '2026-11-01T12:00:00Z' },
    { id: 'e', ruleId: 'r', projectId: 'p', answeredAt: '2026-11-17T12:00:00Z' },
    { id: 'f', ruleId: 'r', projectId: 'other', answeredAt: recent },
    { id: 'g', ruleId: 'r', projectId: 'p', answeredAt: 'invalid' },
  ];
  assert.deepEqual({ ...policyRuleHits(cards, { now, projectId: 'p' }) }, { r: 2 });
  assert.deepEqual({ ...policyRuleHits(cards, { now }) }, { r: 3 });
  assert.deepEqual({ ...policyRuleHits([], { now }) }, {});
});

test('HTTP presets and follow-up settings use real policy storage and reject unconfirmed relaxation', { timeout: 15000 }, async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startServer } = await import('../apps/server/src/index.ts');
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-policy-redesign-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, demo: true });
  const request = (path: string, body?: unknown) => fetch(`${server.url}/api/v1${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const preview = await request('/policies/presets');
    assert.equal(preview.status, 200);
    const data = await preview.json();
    assert.equal(data.presets.length, 3);
    assert.deepEqual(data.presets[0].config, conservativePolicyConfig());
    const project = await (await request('/projects', { name: '预设测试', description: '隔离配置' })).json();
    const balanced = await request('/policies/presets', { preset: 'balanced', projectId: project.id });
    assert.equal(balanced.status, 200);
    const before = await (await request(`/policies?projectId=${project.id}`)).json();
    assert.equal(before.rules[0].kind, 'question');
    const refused = await request('/policies/presets', { preset: 'low-interruption', projectId: project.id, trustedDirectories: ['/work/repo'] });
    assert.equal(refused.status, 400);
    assert.deepEqual(await (await request(`/policies?projectId=${project.id}`)).json(), before);
    assert.equal((await request('/policies/presets', { preset: 'low-interruption', projectId: project.id, trustedDirectories: ['/work/repo'], confirmed: true })).status, 200);
    assert.deepEqual(await (await request('/policies')).json(), conservativePolicyConfig());
    const settings = await request('/supervisor/settings');
    assert.equal(settings.status, 200);
    const followup = await settings.json();
    assert.equal(typeof followup.batchSeconds, 'number'); assert.equal(typeof followup.minGapMinutes, 'number');
  } finally { await server.close(); await rm(dataDir, { recursive: true, force: true }); }
});

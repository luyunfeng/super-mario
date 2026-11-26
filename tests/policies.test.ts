import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createPolicies, validatePolicyPatch, validatePolicyGrants, type PolicyRule } from '../packages/core/src/policies.ts';

function fixture(t: { after(fn: () => void): void }) {
  const store = createStore(':memory:');
  const events = createEventBus(store);
  t.after(() => store.close());
  return { store, events, policies: createPolicies({ store, events }) };
}
const rule: PolicyRule = { id: 'global', kind: 'question', handler: 'rules', mode: 'auto', answer: 'secret answer' };
const createdAt = '2026-01-01T00:00:00Z';

test('global/project/run overlays replace whole rule tables and preserve live inheritance', t => {
  const { policies, store, events } = fixture(t);
  policies.write({}, { rules: [rule], escalateAfterMinutes: 10 });
  policies.write({ projectId: 'p' }, { rules: [{ ...rule, id: 'project' }] });
  policies.write({ projectId: 'p', runId: 'r' }, { escalateAfterMinutes: 2 });
  assert.deepEqual(policies.decide({ kind: 'question', projectId: 'p', runId: 'r', createdAt }), {
    layer: 'project', ruleId: 'project', handler: 'rules', mode: 'auto', answer: 'secret answer', deadlineAt: '2026-01-01T00:02:00.000Z',
    userDeadlineAt:'2026-01-01T00:15:00.000Z', escalationMinutes:2, stages:[{handler:'rules',mode:'auto',answer:'secret answer'},{handler:'supervisor',mode:'suggest'},{handler:'main_agent',mode:'suggest'},{handler:'user',mode:'suggest'}],
  });
  policies.write({ projectId: 'p', runId: 'r' }, { rules: [{ ...rule, id: 'run' }] });
  assert.equal(policies.decide({ kind: 'question', projectId: 'p', runId: 'r' }).layer, 'run');
  policies.write({ projectId: 'p' }, { rules: [] });
  assert.equal(policies.decide({ kind: 'question', projectId: 'p' }).ruleId, null);
  policies.write({}, { escalateAfterMinutes: 15 });
  assert.equal(policies.read({ projectId: 'p' }).escalateAfterMinutes, 15);
  const restarted = createPolicies({ store, events });
  assert.deepEqual(restarted.read({ projectId: 'p', runId: 'r' }), policies.read({ projectId: 'p', runId: 'r' }));
  const copy = policies.read(); copy.rules[0].answer = 'mutated';
  assert.equal(policies.read().rules[0].answer, rule.answer);
  assert.ok(events.since(0).every(event => event.type === 'policies.changed' && JSON.stringify(event.data) === '{}'));
});

test('defaults are conservative; auto requires explicit mode and rules auto needs text', t => {
  const { policies } = fixture(t);
  for (const kind of ['question', 'permission', 'plan', 'review'] as const) {
    const result = policies.decide({ kind, createdAt });
    assert.deepEqual(result, { layer: 'default', ruleId: null, handler: kind === 'question' ? 'supervisor' : 'user',
      mode: 'suggest', answer: null, deadlineAt: kind === 'question' ? '2026-01-01T00:03:00.000Z' : '2026-01-01T00:15:00.000Z',
      userDeadlineAt:'2026-01-01T00:15:00.000Z', escalationMinutes:3, stages:kind === 'question' ? [{handler:'supervisor',mode:'suggest'},{handler:'main_agent',mode:'suggest'},{handler:'user',mode:'suggest'}] : [{handler:'user',mode:'suggest'}] });
  }
  for (const kind of ['permission', 'plan'] as const) {
    // The rule moves an approval away from the owner, so writing it needs the owner's reason.
    policies.write({}, { rules: [{ id: kind, kind, handler: 'rules', answer: 'yes', note: '合成测试的授权说明' }] });
    assert.equal(policies.decide({ kind }).mode, 'suggest');
  }
});

test('first matching rule wins; path containment excludes siblings and traversal', t => {
  const { policies } = fixture(t);
  policies.write({}, { rules: [{ ...rule, executorId: 'e', cwdUnder: '/work/repo' }, { ...rule, id: 'fallback', handler: 'user', mode: 'suggest' }] });
  for (const cwd of ['/work/repo', '/work/repo/src', '/work/repo/../repo/src']) {
    assert.equal(policies.decide({ kind: 'question', executorId: 'e', cwd }).ruleId, 'global');
  }
  for (const cwd of ['/work/repo-other', '/work/repository', '/work/repo/../secret', '/work']) {
    assert.equal(policies.decide({ kind: 'question', executorId: 'e', cwd }).ruleId, 'fallback');
  }
  assert.equal(policies.decide({ kind: 'question', cwd: '/work/repo' }).ruleId, 'fallback');
  assert.equal(policies.decide({ kind: 'question', executorId: 'e' }).ruleId, 'fallback');
});

test('tuple keys avoid separator collisions and key order does not matter', t => {
  const { policies } = fixture(t);
  policies.write({ projectId: 'a:b', runId: 'c' }, { escalateAfterMinutes: 4 });
  policies.write({ runId: 'b:c', projectId: 'a' }, { escalateAfterMinutes: 5 });
  policies.write({ runId: 'solo' }, { escalateAfterMinutes: 6 });
  assert.equal(policies.read({ runId: 'c', projectId: 'a:b' }).escalateAfterMinutes, 4);
  assert.equal(policies.read({ projectId: 'a', runId: 'b:c' }).escalateAfterMinutes, 5);
  assert.equal(policies.read({ runId: 'solo' }).escalateAfterMinutes, 6);
});

test('invalid config/scope/card inputs do not save or publish', t => {
  const { policies, events } = fixture(t);
  const patches = [null, [], { unknown: true }, { rules: undefined }, { rules: [rule, rule] },
    ...[0, -1, 43201, 1.5, Infinity, NaN, '3', undefined].map(escalateAfterMinutes => ({ escalateAfterMinutes })),
    ...[{ id: '' }, { kind: 'other' }, { handler: 'other' }, { mode: 'other' }, { answer: 3 }, { executorId: '' },
      { cwdUnder: 'relative' }, { unknown: true }, { answer: undefined }, { answer: '  ' }].map(patch => ({ rules: [{ ...rule, ...patch }] }))];
  for (const patch of patches) assert.throws(() => policies.write({}, patch as never), TypeError);
  for (const scope of [null, [], { projectId: '' }, { runId: 2 }, { bogus: 'x' }, { projectId: undefined }]) {
    assert.throws(() => policies.read(scope as never), TypeError);
    assert.throws(() => policies.write(scope as never, {}), TypeError);
  }
  for (const card of [null, { kind: 'other' }, { kind: 'question', cwd: 'relative' }, { kind: 'question', createdAt: 'bad' }, { kind: 'question', runId: '' }]) {
    assert.throws(() => policies.decide(card as never), TypeError);
  }
  assert.deepEqual(events.since(0), []);
  assert.deepEqual(policies.read(), { rules: [], escalateAfterMinutes: 3, userDeadlineMinutes:15,ladder:['rules','supervisor','main_agent','user'],agentModes:{supervisor:'suggest',main_agent:'suggest'} });
});

test('a task-only policy still applies when core supplies the task project context', t => {
  const { policies } = fixture(t);
  policies.write({}, {rules:[{id:'global',kind:'question',handler:'rules',mode:'auto',answer:'global-answer'}]});
  policies.write({runId:'task-one'}, {rules:[{id:'task-owner',kind:'question',handler:'user'}]});
  const decision = policies.decide({kind:'question',runId:'task-one',projectId:'project-one'});
  assert.equal(decision.handler,'user'); assert.equal(decision.layer,'run');
});

test('ladder ordering and off modes are configurable while user stays final and permissions stay conservative', t => {
  const { policies } = fixture(t);
  policies.write({}, {ladder:['main_agent','supervisor','user'],agentModes:{main_agent:'off',supervisor:'auto'},userDeadlineMinutes:20});
  assert.equal(policies.decide({kind:'question'}).handler,'supervisor');
  assert.equal(policies.decide({kind:'question'}).mode,'auto');
  assert.deepEqual(policies.decide({kind:'permission'}).stages,[{handler:'user',mode:'suggest'}]);
  policies.write({}, {rules:[{id:'off',kind:'question',handler:'supervisor',mode:'off'}]});
  assert.equal(policies.decide({kind:'question'}).handler,'user');
  for (const ladder of [[],['supervisor'],['user','supervisor'],['supervisor','supervisor','user']]) assert.throws(()=>policies.write({}, {ladder:ladder as never}),TypeError);
  assert.throws(()=>policies.write({}, {agentModes:{supervisor:'bad'} as never}),TypeError);
  assert.throws(()=>policies.write({}, {userDeadlineMinutes:0}),TypeError);
});

test('partial Agent-mode updates preserve previous choices and reject explicit undefined configuration', t => {
  const {policies}=fixture(t);
  policies.write({}, {agentModes:{supervisor:'auto'}});
  policies.write({}, {agentModes:{main_agent:'off'}});
  assert.deepEqual(policies.read().agentModes,{supervisor:'auto',main_agent:'off'});
  assert.throws(()=>policies.write({}, {ladder:undefined}),TypeError);
  assert.throws(()=>policies.write({}, {agentModes:undefined}),TypeError);
});

test('主对话问题默认等待两小时，显式用户期限及执行机期限优先', t => {
  const { policies } = fixture(t);
  const question = { kind:'question' as const, createdAt };
  assert.equal(policies.decide(question, true).userDeadlineAt, '2026-01-01T02:00:00.000Z');
  assert.equal(policies.decide({...question, runId:'r'}, true).userDeadlineAt, '2026-01-01T00:15:00.000Z');
  policies.write({}, {userDeadlineMinutes:8});
  assert.equal(policies.decide(question, true).userDeadlineAt, '2026-01-01T00:08:00.000Z');
});

test('放宽审批的规则生效时必须有授权说明，起草时只校验格式', t => {
  const { policies } = fixture(t);
  const relaxed: PolicyRule = { id: 'relaxed', kind: 'permission', handler: 'supervisor', mode: 'auto', cwdUnder: '/srv/fixture' };
  // A policy drafted inside a plan is only a shape until the owner approves the plan.
  assert.doesNotThrow(() => validatePolicyPatch({ rules: [relaxed] }));
  assert.throws(() => validatePolicyGrants({ rules: [relaxed] }), /放宽审批的规则必须填写授权说明/);
  // It takes effect only when written, and writing without a reason is refused.
  assert.throws(() => policies.write({ runId: 'r' }, { rules: [relaxed] }), /放宽审批的规则必须填写授权说明/);
  assert.deepEqual(policies.read({ runId: 'r' }).rules, [], 'the refused rule is not stored');
  const granted = policies.write({ runId: 'r' }, { rules: [{ ...relaxed, note: '主人批准了带这条规则的计划', grantedAt: createdAt }] });
  assert.equal(granted.rules[0]!.note, '主人批准了带这条规则的计划');
  // A later write that does not touch that rule is not blocked by it.
  assert.doesNotThrow(() => policies.write({ runId: 'r' }, { escalateAfterMinutes: 5 }));
  assert.equal(policies.read({ runId: 'r' }).rules[0]!.note, '主人批准了带这条规则的计划');
  // Questions handed to an Agent, and approvals that stay with the owner, need no reason.
  for (const rule of [
    { id: 'q', kind: 'question' as const, handler: 'supervisor' as const, mode: 'auto' as const },
    { id: 'u', kind: 'permission' as const, handler: 'user' as const, mode: 'suggest' as const },
    { id: 'o', kind: 'permission' as const, handler: 'supervisor' as const, mode: 'off' as const },
  ]) assert.doesNotThrow(() => policies.write({ runId: 'other' }, { rules: [rule] }), rule.id);
});

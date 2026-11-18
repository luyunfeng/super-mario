import test from 'node:test';
import assert from 'node:assert/strict';
import { botConversationId, botForConversation, pinBotExecutor, relaySender } from '../packages/core/src/bot-agent-routing.ts';
import type { FeishuBot } from '../packages/protocol/src/bots.ts';
import type { Message } from '../packages/protocol/src/index.ts';
const bot = (id: string, scope: FeishuBot['scope'] = { kind: 'global' }): FeishuBot => ({ id, name: id, scope, appId: 'cli_example', enabled: true, configured: true, paired: true, connected: true, requireConfirmation: true, createdAt: '', updatedAt: '' });
const input = (conversationId = 'main'): Message => ({ id: 'input', conversationId, role: 'user', text: 'work', createdAt: '' });
test('optional robot binding pins the real executor without changing unbound and non-robot inputs', () => {
 const a = { ...bot('a'), executorId: 'machine:codex' }, source = input(botConversationId(a));
 assert.equal(pinBotExecutor([a], source, undefined), 'machine:codex');
 assert.equal(pinBotExecutor([a], source, 'machine:codex'), 'machine:codex');
 assert.throws(() => pinBotExecutor([a], source, 'machine:claude'), /绑定其他执行者/);
 assert.equal(pinBotExecutor([bot('a')], source, 'custom'), 'custom');
 assert.equal(pinBotExecutor([a], input(), 'custom'), 'custom');
 assert.equal(pinBotExecutor([], source, 'legacy'), 'legacy');
});
test('old scope and disabled/unpaired robot conversations cannot silently adopt a new binding', () => {
 const a = bot('a', { kind: 'project', projectId: 'A' }), source = input(botConversationId(a));
 for (const next of [{ ...a, enabled: false }, { ...a, paired: false }, { ...a, scope: { kind: 'project' as const, projectId: 'B' } }]) assert.throws(() => pinBotExecutor([next], source, undefined), /绑定已变化/);
 // Scope property ordering is not part of identity.
 assert.equal(botConversationId(a), botConversationId({ ...a, scope: { projectId: 'A', kind: 'project' } }));
});
test('relay sender comes from the current conversation; main can choose only a paired global identity', () => {
 const a = bot('a'), b = bot('b', { kind: 'project', projectId: 'B' }), source = input(botConversationId(b));
 assert.equal(relaySender([a,b], source).id, 'b');
 assert.throws(() => relaySender([a,b], source, 'a'), /冒用/);
 assert.equal(relaySender([a,b], input()).id, 'a');
 assert.throws(() => relaySender([a,b], input(), 'b'), /全局机器人/);
 assert.throws(() => relaySender([a,bot('second')], input()), /明确选择/);
 assert.throws(() => relaySender([a], undefined), /当前用户输入/);
 assert.throws(() => relaySender([a], input('project:B:work')), /主对话/);
 assert.throws(() => relaySender([a], { ...input(), role: 'assistant' }), /当前用户输入/);
 assert.throws(() => relaySender([a], { ...input(), readOnly: true, origin: 'result' }), /当前用户输入/);
 const unmarked = bot('u',{ kind:'unmarked' });
 assert.throws(() => relaySender([unmarked],input(botConversationId(unmarked))), /未标记/);
});
test('trusted runtime scope resolves assigned unmarked conversations without changing bot identity', () => {
 const a = bot('u', { kind: 'unmarked' });
 const scopes: FeishuBot['scope'][] = [
  { kind: 'unmarked' }, { kind: 'global' }, { kind: 'project', projectId: 'A' },
  { kind: 'task', todoId: 'T' }, { kind: 'task', todoId: 'T', projectId: 'A' },
 ];
 for (const scope of scopes) {
  const conversationId = botConversationId({ ...a, scope });
  assert.equal(botForConversation([a], conversationId, scope), a);
  assert.equal(a.scope.kind, 'unmarked');
  if (scope.kind !== 'unmarked') assert.throws(() => botForConversation([a], conversationId), /绑定已变化/);
  for (const next of [{ ...a, enabled: false }, { ...a, paired: false }]) {
   assert.throws(() => botForConversation([next], conversationId, scope), /绑定已变化/);
  }
 }
 assert.throws(() => botForConversation([a], botConversationId({ ...a, scope: { kind: 'project', projectId: 'B' } }), { kind: 'project', projectId: 'A' }), /绑定已变化/);
 assert.throws(() => botForConversation([a], 'bot:u:arbitrary', { kind: 'global' }), /绑定已变化/);
});
test('executor pinning derives assigned scope from stored message fields and checks the exact hash', () => {
 const a = { ...bot('u', { kind: 'unmarked' }), executorId: 'machine:codex' };
 const assignments: { scope: FeishuBot['scope']; fields: Pick<Message, 'projectId' | 'todoId'> }[] = [
  { scope: { kind: 'unmarked' }, fields: {} },
  { scope: { kind: 'global' }, fields: {} },
  { scope: { kind: 'project', projectId: 'A' }, fields: { projectId: 'A' } },
  { scope: { kind: 'task', todoId: 'T' }, fields: { todoId: 'T' } },
  { scope: { kind: 'task', todoId: 'T', projectId: 'A' }, fields: { todoId: 'T', projectId: 'A' } },
 ];
 for (const { scope, fields } of assignments) {
  const source = { ...input(botConversationId({ ...a, scope })), ...fields };
  assert.equal(pinBotExecutor([a], source, undefined), a.executorId);
  assert.equal(pinBotExecutor([a], source, a.executorId), a.executorId);
  assert.throws(() => pinBotExecutor([a], source, 'machine:other'), /绑定其他执行者/);
  assert.throws(() => relaySender([a], source), /未标记机器人不能发起协作/);
  assert.throws(() => pinBotExecutor([a], { ...source, projectId: 'wrong' }, undefined), /绑定已变化/);
  if (scope.kind === 'project' || scope.kind === 'task') {
   assert.throws(() => pinBotExecutor([a], input(source.conversationId), undefined), /绑定已变化/);
  }
 }
 for (const conversationId of ['bot:u:arbitrary', botConversationId({ ...a, scope: { kind: 'project', projectId: 'hidden' } })]) {
  assert.throws(() => pinBotExecutor([a], input(conversationId), undefined), /绑定已变化/);
  assert.throws(() => relaySender([a], input(conversationId)), /绑定已变化/);
 }
 const task = { ...input(botConversationId({ ...a, scope: { kind: 'task' as const, todoId: 'T', projectId: 'A' } })), todoId: 'wrong', projectId: 'A' };
 assert.throws(() => pinBotExecutor([a], task, undefined), /绑定已变化/);
});
test('trusted assignment cannot override a fixed scope or bypass pairing checks', () => {
 const scopes: FeishuBot['scope'][] = [{ kind: 'global' }, { kind: 'project', projectId: 'A' }, { kind: 'task', todoId: 'T', projectId: 'A' }];
 const assigned: FeishuBot['scope'] = { kind: 'project', projectId: 'other' };
 for (const scope of scopes) {
  const a = { ...bot('fixed', scope), executorId: 'machine:codex' };
  const original = botConversationId(a), changed = botConversationId({ ...a, scope: assigned });
  assert.equal(botForConversation([a], original, assigned), a);
  assert.throws(() => botForConversation([a], changed, assigned), /绑定已变化/);
  const source = { ...input(changed), projectId: 'other' };
  assert.throws(() => pinBotExecutor([a], source, undefined), /绑定已变化/);
  assert.throws(() => relaySender([a], source), /绑定已变化/);
  for (const next of [{ ...a, enabled: false }, { ...a, paired: false }]) {
   assert.throws(() => botForConversation([next], original, assigned), /绑定已变化/);
   assert.throws(() => relaySender([next], input(original)), /绑定已变化/);
  }
 }
});

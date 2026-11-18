import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedBotGroup, canRelayBotScope, nextRelayPath, validateBotGroupConfig } from '../packages/core/src/bot-group-policy.ts';
import type { BotScope } from '../packages/protocol/src/bots.ts';

const group = { chatId: 'oc_team', mentionOnly: true, allowedSenderIds: ['ou_member'] };

test('legacy empty configuration stays private and explicit empty values clear configuration', () => {
  assert.deepEqual(validateBotGroupConfig({}), {});
  assert.deepEqual(validateBotGroupConfig({ executorId: '', groupChats: [], collaboration: { peerBotIds: [] } }),
    { executorId: '', groupChats: [], collaboration: { peerBotIds: [] } });
  assert.equal(allowedBotGroup({}, { chatId: 'oc_team', senderId: 'ou_owner', mentionedSelf: true }, 'ou_owner'), false);
  assert.equal(allowedBotGroup({ groupChats: [] }, { chatId: 'oc_team', senderId: 'ou_member' }), false);
});

test('configuration deduplicates permissions without mutating input and accepts offline executors', () => {
  const input = { groupChats: [{ ...group, allowedSenderIds: ['ou_member', 'ou_member'] }, group],
    collaboration: { peerBotIds: ['bot-a', 'bot-a'] }, executorId: 'offline-executor' };
  assert.deepEqual(validateBotGroupConfig(input), { groupChats: [group], collaboration: { peerBotIds: ['bot-a'] }, executorId: 'offline-executor' });
  assert.equal(input.groupChats[0]!.allowedSenderIds.length, 2);
  assert.throws(() => validateBotGroupConfig({ groupChats: [group, { ...group, mentionOnly: false }] }));
});

test('configuration rejects unknown fields, wrong types, malformed identities and excess entries', () => {
  const invalid: unknown[] = [null, [], { extra: true }, { executorId: 1 }, { executorId: ' worker ' },
    { groupChats: {} }, { groupChats: [null] }, { groupChats: [{ ...group, extra: true }] },
    { groupChats: [{ ...group, chatId: 'ou_wrong' }] }, { groupChats: [{ ...group, chatId: 'oc_' }] },
    { groupChats: [{ ...group, mentionOnly: 'true' }] }, { groupChats: [{ chatId: 'oc_team', allowedSenderIds: [] }] },
    { groupChats: [{ ...group, allowedSenderIds: ['oc_wrong'] }] }, { groupChats: [{ ...group, allowedSenderIds: [42] }] },
    { groupChats: [{ ...group, allowedSenderIds: ['ou_ member'] }] },
    { groupChats: Array.from({ length: 21 }, () => group) },
    { groupChats: [{ ...group, allowedSenderIds: Array(101).fill('ou_member') }] },
    { collaboration: [] }, { collaboration: {} }, { collaboration: { peerBotIds: [], extra: true } },
    { collaboration: { peerBotIds: [''] } }, { collaboration: { peerBotIds: [false] } },
    { collaboration: { peerBotIds: Array(33).fill('bot-a') } }];
  for (const input of invalid) assert.throws(() => validateBotGroupConfig(input as Parameters<typeof validateBotGroupConfig>[0]), JSON.stringify(input));
  assert.equal(validateBotGroupConfig({ groupChats: Array.from({ length: 20 }, (_, i) => ({ ...group, chatId: `oc_${i}`,
    allowedSenderIds: Array.from({ length: 100 }, (_, j) => `ou_${j}`) })),
    collaboration: { peerBotIds: Array.from({ length: 32 }, (_, i) => `bot-${i}`) } }).groupChats?.length, 20);
});

test('group admission requires explicit group, identified owner or member, and required mention', () => {
  const bot = { groupChats: [group] };
  for (const senderId of ['ou_owner', 'ou_member']) {
    assert.equal(allowedBotGroup(bot, { chatId: 'oc_team', senderId, mentionedSelf: true }, 'ou_owner'), true);
    assert.equal(allowedBotGroup(bot, { chatId: 'oc_team', senderId }, 'ou_owner'), false);
    assert.equal(allowedBotGroup(bot, { chatId: 'oc_team', senderId, mentionedSelf: false }, 'ou_owner'), false);
  }
  for (const senderId of [undefined, '', 'anonymous', 'ou_stranger']) {
    assert.equal(allowedBotGroup(bot, { chatId: 'oc_team', senderId, mentionedSelf: true }, 'ou_owner'), false);
  }
  assert.equal(allowedBotGroup(bot, { chatId: 'oc_other', senderId: 'ou_owner', mentionedSelf: true }, 'ou_owner'), false);
  assert.equal(allowedBotGroup({ groupChats: [{ ...group, mentionOnly: false }] }, { chatId: 'oc_team', senderId: 'ou_member' }), true);
  const ownerOnly = { groupChats: [{ ...group, mentionOnly: false, allowedSenderIds: [] }] };
  assert.equal(allowedBotGroup(ownerOnly, { chatId: 'oc_team', senderId: 'ou_owner' }, 'ou_owner'), true);
  assert.equal(allowedBotGroup(ownerOnly, { chatId: 'oc_team', senderId: 'ou_member' }, 'ou_owner'), false);
});

test('relay scope prevents project escalation and task leakage including projectless tasks', () => {
  const scopes: BotScope[] = [{ kind: 'unmarked' }, { kind: 'global' }, { kind: 'project', projectId: 'a' },
    { kind: 'project', projectId: 'b' }, { kind: 'task', todoId: 'one', projectId: 'a' },
    { kind: 'task', todoId: 'two', projectId: 'a' }, { kind: 'task', todoId: 'one', projectId: 'b' },
    { kind: 'task', todoId: 'one' }];
  // Explicit access matrix makes escalation and cross-project regressions visible.
  const allowed = [[], [1, 2, 3, 4, 5, 6, 7], [2, 4, 5], [3, 6], [4], [5], [6], [7]];
  scopes.forEach((from, i) => scopes.forEach((to, j) => assert.equal(canRelayBotScope(from, to), allowed[i]!.includes(j), `${i} -> ${j}`)));
});

test('relay paths reject self, cycles, broken provenance and ninth identity without mutating parent', () => {
  assert.deepEqual(nextRelayPath('a', 'b'), ['a', 'b']);
  const parent = ['a', 'b'];
  assert.deepEqual(nextRelayPath('b', 'c', parent), ['a', 'b', 'c']);
  assert.deepEqual(parent, ['a', 'b']);
  assert.deepEqual(nextRelayPath('g', 'h', ['a', 'b', 'c', 'd', 'e', 'f', 'g']), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  for (const invoke of [() => nextRelayPath('a', 'a'), () => nextRelayPath('b', 'a', parent),
    () => nextRelayPath('c', 'd', parent), () => nextRelayPath('a', 'b', []),
    () => nextRelayPath('b', 'c', ['a', 'a', 'b']), () => nextRelayPath('', 'b'),
    () => nextRelayPath('b', 'c', ['a', '', 'b']),
    () => nextRelayPath('h', 'i', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])]) assert.throws(invoke);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizeWorkDecisionSource } from '../packages/core/src/work-decision-access.ts';
import { botConversationId } from '../packages/core/src/bot-agent-routing.ts';
import { createFeishuBotConfig } from '../packages/core/src/feishu-bot-config.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createWorkDecisions } from '../packages/core/src/work-decisions.ts';
import type { BotScope, Message, Project, Todo } from '../packages/protocol/src/index.ts';

const global: BotScope = { kind: 'global' };
const project: BotScope = { kind: 'project', projectId: 'a' };
const task: BotScope = { kind: 'task', projectId: 'a', todoId: 'ta' };
const other: BotScope = { kind: 'project', projectId: 'b' };
const now = '2026-11-17T00:00:00Z';
const denied = (error: unknown) => (error as { status?: number }).status === 403;

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'mario-decision-access-'));
  const path = join(dir, 'test.sqlite');
  let store = createStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const id of ['a', 'b']) store.put<Project>('projects', id, { id, name: id, description: '', createdAt: now, updatedAt: now });
  for (const [id, projectId] of [['ta', 'a'], ['ta2', 'a'], ['tb', 'b'], ['loose', undefined]]) {
    store.put<Todo>('todos', id!, { id: id!, title: id!, notes: '', projectId, createdAt: now, updatedAt: now });
  }
  function message(patch: Partial<Message> = {}) {
    const source: Message = { id: 'source', conversationId: 'main', role: 'user', origin: 'user', text: '用户明确决定', createdAt: now, ...patch };
    store.put('messages', source.id, source);
    return source;
  }
  function bot(scope: BotScope = global, botId = 'bot-a', accountId = 'cli_test') {
    const source = message({ conversationId: botConversationId({ id: botId, scope }),
      ...('projectId' in scope ? { projectId: scope.projectId } : {}), ...(scope.kind === 'task' ? { todoId: scope.todoId } : {}) });
    // Exact dispatchInbox persistence shape, with no SDK/network/mock Store.
    const route = { channel: 'feishu', accountId, target: 'owner', botId, scope, revision: 1,
      inputId: source.id, envelopeId: 'inbox', sourceMessageId: 'platform-user' };
    store.put('message.routes', source.id, route);
    store.put('event.mailboxes', 'inbox', { id: 'inbox', version: 2, direction: 'inbox', scope, botId,
      eventKey: `feishu-in:${JSON.stringify([botId, accountId, route.sourceMessageId])}`, title: '用户消息', text: source.text,
      sourceMessageId: route.sourceMessageId, target: route.target, origin: { kind: 'direct', connector: '飞书机器人' },
      requiresConfirmation: false, status: 'completed', resultId: source.id, createdAt: now, updatedAt: now });
    store.put('feishu.bot.envelopes', 'inbox', { revision: 1 });
    store.put('feishu.bot.dispatch', `${botId}:${accountId}:inbox`, { status: 'completed', id: source.id });
    return { source, route };
  }
  const ledger = () => createWorkDecisions({ store, events: createEventBus(store),
    authorize: (scope, source) => authorizeWorkDecisionSource(store, scope, source) });
  return { get store() { return store; }, dir, message, bot, ledger,
    authorize(scope: BotScope, source: Message) { authorizeWorkDecisionSource(store, scope, source); },
    record(scope = global) { return ledger().record({ key: 'release', text: '先验收', sourceMessageId: 'source', scope }); },
    restart() { store.close(); store = createStore(path); } };
}

test('main and exact project work user entries authorize only inside their ownership', t => {
  const f = fixture(t);
  const main = f.message();
  for (const scope of [global, project, task, other, { kind: 'task', todoId: 'loose' } as BotScope]) f.authorize(scope, main);
  const source = f.message({ conversationId: 'project:a:work', projectId: 'a' });
  f.authorize(project, source);
  f.authorize(task, source);
  for (const scope of [global, other, { kind: 'task', todoId: 'tb' } as BotScope]) assert.throws(() => f.authorize(scope, source), denied);
  for (const patch of [{ projectId: undefined }, { projectId: 'b' }, { conversationId: 'project:a:work:fake' },
    { conversationId: 'project:a:memory' }, { conversationId: 'main:fake' }, { conversationId: 'custom' }]) {
    assert.throws(() => f.authorize(project, f.message({ ...source, ...patch })), denied);
  }
  assert.throws(() => f.record(project), denied);
  f.message(source);
  const fact = f.record(project);
  f.restart();
  assert.deepEqual(f.ledger().reference(fact), fact);
});

test('bot scope may narrow global → project/task and project → same project/task; task stays exact', t => {
  const f = fixture(t);
  for (const owner of [global, project, task, { kind: 'task', todoId: 'loose' } as BotScope]) {
    const { source } = f.bot(owner);
    for (const target of [global, project, task, other, { kind: 'task', projectId: 'a', todoId: 'ta2' } as BotScope,
      { kind: 'task', todoId: 'loose' } as BotScope]) {
      const allowed = owner.kind === 'global' || owner.kind === 'project' && 'projectId' in target && target.projectId === owner.projectId
        || owner.kind === 'task' && target.kind === 'task' && target.todoId === owner.todoId;
      if (allowed) f.authorize(target, source);
      else assert.throws(() => f.authorize(target, source), denied);
    }
    assert.throws(() => f.authorize({ kind: 'unmarked' }, source), denied);
  }
});

test('main legacy channel route is accepted but cannot conceal a bot identity or resumed source', t => {
  const f = fixture(t);
  const source = f.message({ origin: undefined });
  const route = { channel: 'feishu', accountId: 'cli_legacy', target: 'owner' };
  f.store.put('message.routes', source.id, route);
  const fact = f.record();
  assert.deepEqual(f.ledger().reference(fact), fact);
  for (const patch of [{ botId: 'other' }, { scope: global }, { resumed: true }, { relay: {} }, { inputId: 'other' }]) {
    f.store.put('message.routes', source.id, { ...route, ...patch });
    assert.throws(() => f.ledger().reference(fact), denied);
  }
  f.store.put('message.routes', source.id, route);
  const projectSource = f.message({ conversationId: 'project:a:work', projectId: 'a' });
  assert.throws(() => f.authorize(project, projectSource), denied);
});

test('real user group envelope is accepted; bot route must match source project/task labels', t => {
  const f = fixture(t);
  const { source } = f.bot(project);
  const envelope = f.store.get<Record<string, unknown>>('event.mailboxes', 'inbox')!;
  f.store.put('event.mailboxes', 'inbox', { ...envelope, origin: { kind: 'group', connector: '飞书机器人' } });
  f.authorize(task, source);
  for (const patch of [{ projectId: undefined }, { projectId: 'b' }, { todoId: 'ta' }]) {
    assert.throws(() => f.authorize(task, { ...source, ...patch }), denied);
  }
  const taskSource = f.bot(task).source;
  assert.throws(() => f.authorize(task, { ...taskSource, todoId: undefined }), denied);
  const unmarked = f.bot({ kind: 'unmarked' }).source;
  assert.throws(() => f.authorize(global, unmarked), denied);
});

test('forged bot prefix, mismatched bot/conversation/scope and missing dispatch evidence fail closed', t => {
  const f = fixture(t);
  const { source, route } = f.bot(project);
  for (const conversationId of ['bot:bot-a:anything', `${source.conversationId}:suffix`, botConversationId({ id: 'bot-b', scope: project }),
    botConversationId({ id: 'bot-a', scope: other })]) {
    assert.throws(() => f.authorize(project, { ...source, conversationId }), denied);
  }
  for (const patch of [{ botId: 'bot-b' }, { accountId: 'other-app' }, { scope: other }, { scope: global },
    { inputId: 'other' }, { envelopeId: 'other' }, { target: 'other' }, { sourceMessageId: 'other' }, { revision: 2 },
    { channel: 'model' }, { resumed: true }, { relay: {} }, { resultRelayEntryId: 'result' }]) {
    f.store.put('message.routes', source.id, { ...route, ...patch });
    assert.throws(() => f.authorize(project, source), denied);
  }
  f.store.remove('message.routes', source.id);
  assert.throws(() => f.authorize(project, source), denied);
  f.store.put('message.routes', source.id, route);
  f.store.put('feishu.bot.dispatch', 'bot-a:cli_test:inbox', { status: 'unknown', id: source.id });
  assert.throws(() => f.authorize(project, source), denied);
});

test('assistant/model, readOnly and reflected result/notification sources never authorize', t => {
  const f = fixture(t);
  for (const source of [f.message(), f.message({ projectId: 'a', conversationId: 'project:a:work' }), f.bot().source]) {
    for (const patch of [{ role: 'assistant' }, { role: 'model' }, { origin: 'result' }, { origin: 'notification' }, { readOnly: true }]) {
      f.store.put('messages', source.id, { ...source, ...patch });
      assert.throws(() => f.authorize(global, { ...source, ...patch } as Message), denied);
      assert.throws(() => f.record(), denied);
    }
  }
  const { source } = f.bot();
  const envelope = f.store.get<Record<string, unknown>>('event.mailboxes', 'inbox')!;
  for (const patch of [{ eventKey: 'feishu-a2a:fake' }, { eventKey: 'feishu-collect:fake' }, { origin: { kind: 'agent' } }]) {
    f.store.put('event.mailboxes', 'inbox', { ...envelope, ...patch });
    assert.throws(() => f.authorize(global, source), denied);
  }
  f.store.put('event.mailboxes', 'inbox', envelope);
  f.store.put('feishu.bot.envelopes', 'inbox', { revision: 1, relay: {} });
  assert.throws(() => f.record(), denied);
});

test('confirmed history survives actual config disable/rebind and SQLite restart', t => {
  const f = fixture(t);
  const settings = createFeishuBotConfig(f.dir);
  const configured = settings.write(undefined, { name: '历史机器人', appId: 'cli_history', appSecret: 'test-only', scope: project });
  f.bot(project, configured.id, configured.appId);
  const fact = f.record(task);
  settings.write(configured.id, { enabled: false });
  assert.deepEqual(f.ledger().reference(fact), fact);
  settings.write(configured.id, { scope: other });
  f.restart();
  assert.deepEqual(f.ledger().get(fact.id), fact);
  assert.deepEqual(f.ledger().list(task).items, [fact]);
  assert.deepEqual(f.ledger().reference(fact), fact);
});

test('persisted route identity tampering invalidates get/list/reference/correct/withdraw', t => {
  const f = fixture(t);
  const { route } = f.bot(project);
  const fact = f.record(project);
  f.message({ id: 'correction' });
  for (const patch of [{ botId: 'other' }, { scope: other }, { scope: global }, { inputId: 'other' }, { accountId: 'other' }]) {
    f.store.put('message.routes', 'source', { ...route, ...patch });
    for (const action of [() => f.ledger().get(fact.id), () => f.ledger().list(project), () => f.ledger().reference(fact),
      () => f.ledger().correct({ ...fact, text: '洗白', sourceMessageId: 'correction' }),
      () => f.ledger().withdraw({ ...fact, sourceMessageId: 'correction' })]) assert.throws(action, denied);
  }
  f.store.put('message.routes', 'source', route);
  assert.deepEqual(f.ledger().reference(fact), fact);
});

test('current single-route contract rejects arrays and unknown source.routes instead of selecting one route', t => {
  const f = fixture(t);
  const { source, route } = f.bot();
  for (const routes of [[route, { ...route, botId: 'wrong' }], [{ ...route, botId: 'wrong' }, route], [route]]) {
    f.store.put('message.routes', source.id, routes);
    assert.throws(() => f.authorize(global, source), denied);
    f.store.put('message.routes', source.id, route);
    assert.throws(() => f.authorize(global, { ...source, routes } as Message), denied);
  }
});

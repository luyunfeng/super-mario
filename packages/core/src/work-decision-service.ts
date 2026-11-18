import { createHash } from 'node:crypto';
import type { Store, EventBus } from '../../plugin-sdk/src/index.ts';
import type { BotScope, Message } from '../../protocol/src/index.ts';
import { createWorkDecisions } from './work-decisions.ts';
import { authorizeWorkDecisionSource } from './work-decision-access.ts';
import { validateBotScope } from './bot-scopes.ts';
import { canRelayBotScope } from './bot-group-policy.ts';

function fail(text: string, status = 400): never { throw Object.assign(new Error(text), { status }); }
/** Composition of the small fact ledger with real current inputs and explicit Web edits. */
export function createWorkDecisionService(options: {
  store: Store; events: EventBus; currentInput(): Message | undefined;
  assertCurrentInput(input: Message): void;
}) {
  const { store, events } = options;
  const ledger = createWorkDecisions({ store, events, authorize: (scope, source) => authorizeWorkDecisionSource(store, scope, source),
    // Seal the historical route, including its absence; it is evidence, not a live binding.
    sourceProof: source => store.get('message.routes', source.id) ?? null });
  function target(input: Record<string, unknown>): BotScope {
    if (input.todoId !== undefined) return validateBotScope(store, { kind: 'task', todoId: input.todoId, ...(input.projectId ? { projectId: input.projectId } : {}) });
    if (input.projectId !== undefined) return validateBotScope(store, { kind: 'project', projectId: input.projectId });
    return { kind: 'global' };
  }
  function inputSource() {
    const source = options.currentInput();
    if (!source || source.role !== 'user' || source.readOnly || source.origin && source.origin !== 'user') fail('记录工作决定需要当前用户输入', 403);
    options.assertCurrentInput(source);
    return source;
  }
  function scopedTarget(input: Record<string, unknown>, source?: Message) {
    // Model arguments cannot widen a project's current input into another scope.
    return target({ ...(source?.projectId ? { projectId: source.projectId } : {}), ...(source?.todoId ? { todoId: source.todoId } : {}), ...input });
  }
  function checkSourceTarget(source: Message, scope: BotScope) { authorizeWorkDecisionSource(store, scope, source); }
  function list(input: Record<string, unknown> = {}) { return ledger.list(target(input)); }
  function forAgent(input: Record<string, unknown>) {
    const source = inputSource();
    const scope = scopedTarget(input, source); checkSourceTarget(source, scope);
    return { source, scope };
  }
  function currentFact(input: Record<string, unknown>, source?: Message) {
    if (typeof input.id !== 'string') fail('请选择工作决定');
    const fact = ledger.get(input.id);
    if (!fact) fail('工作决定不存在', 404);
    if (source) checkSourceTarget(source, fact.scope);
    return fact;
  }
  function webSource(id: string, text: string, scope: BotScope) {
    const now = new Date().toISOString();
    const source: Message = { id, conversationId: 'projectId' in scope && scope.projectId ? `project:${scope.projectId}:work` : 'main',
      role: 'user', origin: 'user', text, status: 'done', createdAt: now,
      ...('projectId' in scope && scope.projectId ? { projectId: scope.projectId } : {}),
      ...(scope.kind === 'task' ? { todoId: scope.todoId } : {}) };
    const old = store.get<Message>('messages', id);
    if (old) {
      if (old.text !== text || old.conversationId !== source.conversationId || old.projectId !== source.projectId || old.todoId !== source.todoId || old.origin !== 'user' || old.readOnly) fail('同一工作决定请求已有不同内容', 409);
      return old;
    }
    // This is the user's explicit edit, stored as evidence; it does not enqueue a model turn.
    store.put('messages', id, source);
    events.publish('messages.changed', { messageId: id, conversationId: source.conversationId });
    return source;
  }
  const sourceId = (value: unknown) => 'wd-input-' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    ledger, list,
    recordFromAgent(input: Record<string, unknown>) {
      const { source, scope } = forAgent(input);
      return ledger.record({ key: input.key as string, text: input.text as string, scope, sourceMessageId: source.id });
    },
    changeFromAgent(input: Record<string, unknown>, withdraw = false) {
      const source = inputSource(); currentFact(input, source);
      const change = { id: input.id as string, version: input.version as number, sourceMessageId: source.id };
      return withdraw ? ledger.withdraw(change) : ledger.correct({ ...change, text: input.text as string });
    },
    referenceFromAgent(input: Record<string, unknown>) {
      const source = options.currentInput();
      if (!source) fail('没有当前工作输入', 403);
      // Reading is allowed in result turns, but never outside their pinned ownership.
      const fact = currentFact(input);
      const own = source.todoId ? { kind: 'task' as const, todoId: source.todoId, ...(source.projectId ? { projectId: source.projectId } : {}) }
        : source.projectId ? { kind: 'project' as const, projectId: source.projectId } : undefined;
      if (own && !canRelayBotScope(own, fact.scope)) fail('工作决定不属于当前范围', 403);
      return ledger.reference({ id: input.id as string, version: input.version as number });
    },
    recordFromWeb(input: Record<string, unknown>) {
      if (typeof input.key !== 'string' || !input.key.trim() || input.key.length > 200 || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000) fail('工作决定需要标识和不超过4000字的内容');
      return store.transaction(() => {
        const scope = target(input);
        const source = webSource(sourceId(['record', scope, input.key]), input.text as string, scope);
        return ledger.record({ key: input.key as string, text: input.text as string, scope, sourceMessageId: source.id });
      });
    },
    changeFromWeb(input: Record<string, unknown>, withdraw = false) {
      return store.transaction(() => {
        const fact = currentFact(input);
        // Validate active ownership before recording another source in that scope.
        validateBotScope(store, fact.scope);
        if (fact.version !== input.version) fail('工作决定版本已失效', 409);
        if (!withdraw && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000)) fail('工作决定需要不超过4000字的内容');
        const text = withdraw ? `撤回工作决定：${fact.id} v${fact.version}` : input.text as string;
        const source = webSource(sourceId([withdraw ? 'withdraw' : 'correct', fact.id, input.version, text]), text, fact.scope);
        const change = { id: fact.id, version: input.version as number, sourceMessageId: source.id };
        return withdraw ? ledger.withdraw(change) : ledger.correct({ ...change, text });
      });
    },
    context(scope?: BotScope, projectId?: string) {
      if (scope?.kind === 'unmarked') return { unavailable: '未标记范围没有工作决定' };
      try {
        const result = ledger.list(scope?.kind === 'project' || scope?.kind === 'task' ? scope : projectId ? { kind: 'project', projectId } : { kind: 'global' });
        const active = result.items.filter(row => row.status === 'active').sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
        return { items: active.slice(0, 16).map(({ id, text, scope, version, source, updatedAt }) => ({ id, text, scope, version, source, updatedAt })),
          counts: result.counts, truncated: result.truncated || active.length > 16,
          instructions: '这些是用户明确记录的当前版本决定，不是原始聊天。引用前用work_decision_reference核对版本；修正和撤回后旧引用失效。' };
      } catch { return { unavailable: '部分工作决定的来源或范围已失效，请在记忆页核对；不能继续依赖旧版本。' }; }
    },
  };
}

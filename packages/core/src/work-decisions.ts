import { createHash } from 'node:crypto';
import type { EventBus, Store } from '../../plugin-sdk/src/index.ts';
import type { BotScope, Message } from '../../protocol/src/index.ts';
import { sameBotScope, validateBotScope } from './bot-scopes.ts';

import type { WorkDecision, WorkDecisionSource } from '../../protocol/src/work-decisions.ts';
export type { WorkDecision, WorkDecisionSource } from '../../protocol/src/work-decisions.ts';
export interface RecordWorkDecision { key: string; text: string; sourceMessageId: string; scope: BotScope }
export interface WorkDecisionReference { id: string; version: number }
export interface ChangeWorkDecision extends WorkDecisionReference { sourceMessageId: string }
export interface WorkDecisionsOptions {
  store: Store;
  events: EventBus;
  /** Synchronous host authority; throw to deny. Called again on reads and mutations.
   * The host must resolve actual bot/channel bindings, not infer identity from a prefix.
   * Without this hook, only eligible messages in the exact main conversation are accepted.
   */
  authorize?: (scope: BotScope, source: Message) => void;
  /** Stable host provenance, excluding mutable delivery bookkeeping. */
  sourceProof?: (source: Message) => unknown;
}
interface Proof { messageId: string; contentHash: string; ownershipHash: string }
interface Revision { decision: WorkDecision; proof: Proof }
const currentCollection = 'work.decisions';
const revisionCollection = 'work.decision-revisions';
const listLimit = 100;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
function bounded(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} 必须非空且不超过 ${max} 字符`);
  return value.trim();
}
function checkVersion(actual: number, expected: number) {
  if (!Number.isSafeInteger(expected) || expected !== actual) fail('工作决定版本已失效', 409);
}

/** A small fact ledger over the existing Store, not another conversation or business entity.
 * Public methods are synchronous so hosts can compose them with their own Store transaction.
 * Bind a host-specific authorize callback before exposing get/reference through tools or HTTP.
 */
export function createWorkDecisions({ store, events, authorize, sourceProof }: WorkDecisionsOptions) {
  function scope(input: BotScope) {
    const resolved = validateBotScope(store, input);
    if (resolved.kind === 'unmarked') fail('未标记范围没有工作事实', 403);
    return resolved;
  }
  function source(messageId: string, target: BotScope): { message: Message; proof: Proof } {
    bounded(messageId, 'sourceMessageId', 512);
    const message = store.get<Message>('messages', messageId);
    if (!message || message.id !== messageId) fail('工作决定来源不存在', 409);
    if (message.role !== 'user' || message.readOnly || message.origin !== undefined && message.origin !== 'user') {
      fail('工作决定需要可写的真实用户消息', 403);
    }
    if (typeof message.text !== 'string' || !message.text.trim() ||
        typeof message.conversationId !== 'string' || !message.conversationId.trim() ||
        typeof message.createdAt !== 'string' || !Number.isFinite(Date.parse(message.createdAt))) fail('来源消息无效', 409);
    // Explicit source ownership is an upper bound, even if the host authorizes it.
    // An unlabelled main request can explicitly choose a target; other entries need the host.
    if (message.todoId !== undefined) {
      const owner = validateBotScope(store, { kind: 'task', todoId: message.todoId, projectId: message.projectId }, { allowArchived: true });
      if (!sameBotScope(owner, target)) fail('事项来源不能扩大工作决定范围', 403);
    } else if (message.projectId !== undefined) {
      const owner = validateBotScope(store, { kind: 'project', projectId: message.projectId }, { allowArchived: true });
      if (!('projectId' in target) || target.projectId !== ('projectId' in owner ? owner.projectId : undefined)) {
        fail('项目来源不能跨项目或提升为全局事实', 403);
      }
    }
    if (!authorize && message.conversationId !== 'main') fail('非 main 来源需要 host 明确授权', 403);
    // A callback cannot mutate the source or the scope being persisted.
    const authorization: unknown = authorize?.(structuredClone(target), structuredClone(message));
    // TypeScript permits async functions for void callbacks. Never mistake an unfinished
    // authorization for approval in this synchronous transaction boundary.
    if (authorization != null && typeof (authorization as { then?: unknown }).then === 'function') {
      void Promise.resolve(authorization).catch(() => {});
      fail('authorize 必须同步完成授权', 403);
    }
    return { message, proof: {
      messageId,
      contentHash: hash(message.text),
      // Execution status is mutable; identity, provenance and ownership are not.
      ownershipHash: hash(JSON.stringify({ id: message.id, conversationId: message.conversationId,
        projectId: message.projectId, todoId: message.todoId, role: message.role,
        origin: message.origin, readOnly: message.readOnly, replyTo: message.replyTo, createdAt: message.createdAt,
        provenance: sourceProof?.(structuredClone(message)) })),
    } };
  }
  function trace(message: Message): WorkDecisionSource { return { messageId: message.id, createdAt: message.createdAt }; }
  function checked(row: WorkDecision): WorkDecision {
    if (!Number.isSafeInteger(row.version) || row.version < 1) fail('工作决定版本无效', 409);
    // Archived ownership remains historical evidence; new writes validate active scope.
    const target = validateBotScope(store, row.scope, { allowArchived: true });
    if (!sameBotScope(row.scope, target)) fail('工作决定归属已改变', 409);
    // Every revision remains evidence. Correcting a fact cannot launder a changed original
    // source, or a changed intermediate correction, into a new trusted fact.
    for (let version = 1; version <= row.version; version++) {
      const revision = store.get<Revision>(revisionCollection, `${row.id}:${version}`);
      if (!revision || revision.decision.id !== row.id || revision.decision.version !== version ||
          !sameBotScope(revision.decision.scope, row.scope)) fail('工作决定修订账本不完整', 409);
      const evidence = source(revision.proof.messageId, target);
      if (evidence.proof.contentHash !== revision.proof.contentHash || evidence.proof.ownershipHash !== revision.proof.ownershipHash ||
          JSON.stringify(trace(evidence.message)) !== JSON.stringify(revision.decision.source)) fail('工作决定来源已改变', 409);
      if (version === row.version && JSON.stringify(row) !== JSON.stringify(revision.decision)) fail('工作决定与修订账本不一致', 409);
    }
    return structuredClone(row);
  }
  function get(id: string): WorkDecision | undefined {
    bounded(id, 'id', 512);
    const row = store.get<WorkDecision>(currentCollection, id);
    return row ? checked(row) : undefined;
  }
  function required(id: string) {
    const row = get(id);
    if (!row) fail('工作决定不存在', 404);
    return row;
  }
  function save(row: WorkDecision, proof: Proof, type: string) {
    store.put(revisionCollection, `${row.id}:${row.version}`, { decision: row, proof } satisfies Revision);
    store.put(currentCollection, row.id, row);
    // Event streams contain invalidation metadata only, never source text or proof hashes.
    events.publish(type, { id: row.id, version: row.version, status: row.status });
    return structuredClone(row);
  }
  function change(input: ChangeWorkDecision, text?: string) {
    return store.transaction(() => {
      const row = required(input.id);
      checkVersion(row.version, input.version);
      if (row.status !== 'active') fail('工作决定已撤回', 409);
      scope(row.scope);
      const evidence = source(input.sourceMessageId, row.scope);
      return save({ ...row, version: row.version + 1, text: text ?? row.text,
        status: text === undefined ? 'withdrawn' : 'active', source: trace(evidence.message),
        updatedAt: new Date().toISOString() }, evidence.proof,
      text === undefined ? 'work.decision.withdrawn' : 'work.decision.corrected');
    });
  }
  return {
    /** Omitted scope means global. Exact project/task scopes never inherit broader facts.
     * Filter before validation/counting/truncation so other projects cannot affect the view.
     * Invalid evidence fails closed; withdrawn rows remain visible as audit information.
     */
    list(input?: BotScope) {
      const target = validateBotScope(store, input === undefined ? { kind: 'global' } : input);
      const rows = store.list<WorkDecision>(currentCollection)
        .filter(row => target.kind === 'global' || target.kind !== 'unmarked' && sameBotScope(row.scope, target))
        .map(checked);
      const counts = { total: rows.length, active: rows.filter(row => row.status === 'active').length,
        withdrawn: rows.filter(row => row.status === 'withdrawn').length };
      return { items: rows.slice(0, listLimit), counts, truncated: rows.length > listLimit, limit: listLimit };
    },
    get,
    record(input: RecordWorkDecision): WorkDecision {
      const key = bounded(input.key, 'key', 200);
      const text = bounded(input.text, 'text', 4000);
      return store.transaction(() => {
        const target = scope(input.scope);
        const evidence = source(input.sourceMessageId, target);
        // Scope participates in the key. Independent module instances/restarts use the
        // same SQLite row, and a synchronous transaction serializes competing writers.
        const id = `wd_${hash(JSON.stringify([target, key]))}`;
        const existing = get(id);
        if (existing) {
          if (existing.text !== text || existing.status !== 'active') fail('同 key 工作决定已存在不同内容或已撤回', 409);
          return existing;
        }
        const now = new Date().toISOString();
        const provenance = trace(evidence.message);
        return save({ id, key, text, scope: target, version: 1, status: 'active', source: provenance,
          recordSource: provenance, createdAt: now, updatedAt: now }, evidence.proof, 'work.decision.recorded');
      });
    },
    correct(input: ChangeWorkDecision & { text: string }): WorkDecision {
      return change(input, bounded(input.text, 'text', 4000));
    },
    withdraw(input: ChangeWorkDecision): WorkDecision { return change(input); },
    /** Revalidate at use time. A returned snapshot is not a permanent authorization token. */
    reference(input: WorkDecisionReference): WorkDecision {
      const row = required(input.id);
      checkVersion(row.version, input.version);
      if (row.status !== 'active') fail('工作决定已撤回，不能引用', 409);
      return row;
    },
  };
}

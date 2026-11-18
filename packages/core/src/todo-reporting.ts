import { createHash, randomUUID } from 'node:crypto';
import type { EventBus, OutboxItem, Store } from '../../plugin-sdk/src/index.ts';
import type { Message, Todo } from '../../protocol/src/index.ts';

export interface TodoReport {
  id: string;
  todoId: string;
  cycle: number;
  version: number;
  messageId?: string;
  outboxId?: string;
  projectId?: string;
  contentHash: string;
  sourceHash: string;
  reportedAt: string;
}
export interface TodoReportingState {
  todoId: string;
  required: boolean;
  requireDelivery: boolean;
  cycle: number;
  version: number;
  /** Sources must be newer than this boundary after reopening. */
  cycleStartedAt?: string;
  report?: TodoReport;
}
export interface ConfigureTodoReporting {
  todoId: string;
  required: boolean;
  requireDelivery?: boolean;
  version?: number;
}
export interface ReportTodo {
  todoId: string;
  version: number;
  messageId?: string;
  outboxId?: string;
}

const collection = 'todo.reporting';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
function identifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} 无效`);
}
function checkVersion(actual: number, expected: unknown) {
  if (!Number.isSafeInteger(expected) || expected !== actual) fail('答复约束版本已更新或缺失', 409);
}

/** No agent tool is registered here. Only the user-facing configuration path may relax a rule.
 * All methods are synchronous so completion/reopening can share the caller's Store transaction.
 */
export function createTodoReporting({ store, events }: { store: Store; events: EventBus }) {
  function todo(id: string) {
    identifier(id, 'todoId');
    const result = store.get<Todo>('todos', id);
    if (!result || result.id !== id) fail('待办不存在', 404);
    return result;
  }
  function get(todoId: string): TodoReportingState {
    todo(todoId);
    return store.get<TodoReportingState>(collection, todoId) ?? {
      todoId, required: false, requireDelivery: false, cycle: 1, version: 0,
    };
  }
  function save(state: TodoReportingState, type: string) {
    store.put(collection, state.todoId, state);
    events.publish(type, { todoId: state.todoId, cycle: state.cycle, version: state.version });
    return store.get<TodoReportingState>(collection, state.todoId)!;
  }
  function source(input: Pick<ReportTodo, 'messageId' | 'outboxId'>, state: TodoReportingState) {
    const currentTodo = todo(state.todoId);
    if (input.messageId !== undefined) identifier(input.messageId, 'messageId');
    if (input.outboxId !== undefined) identifier(input.outboxId, 'outboxId');
    if (!input.messageId && !input.outboxId) fail('必须提供真实 Message 或 outbox 来源');
    function fresh(createdAt: string) {
      const at = Date.parse(createdAt);
      if (!Number.isFinite(at)) fail('答复来源时间无效');
      if (state.cycleStartedAt && at <= Date.parse(state.cycleStartedAt)) fail('旧周期答复不能用于当前周期', 409);
    }
    let message: Message | undefined;
    if (input.messageId) {
      message = store.get<Message>('messages', input.messageId);
      if (!message || message.id !== input.messageId) fail('答复 Message 不存在', 404);
      if (message.role !== 'assistant' || message.status !== 'done' ||
          message.todoId !== state.todoId || message.projectId !== currentTodo.projectId ||
          typeof message.text !== 'string' || !message.text.trim()) fail('答复 Message 状态、正文或归属无效');
      fresh(message.createdAt);
    }
    let outbox: OutboxItem | undefined;
    if (input.outboxId) {
      outbox = store.get<OutboxItem>('outbox.items', input.outboxId);
      if (!outbox || outbox.id !== input.outboxId) fail('答复 outbox 不存在', 404);
      // relatedTo is the actual outbox source reference; matching text alone proves no ownership.
      const linked = outbox.relatedTo?.kind === 'todo' && outbox.relatedTo.id === state.todoId ||
        message && outbox.relatedTo?.kind === 'message' && outbox.relatedTo.id === message.id;
      if (!linked || typeof outbox.content?.text !== 'string' || !outbox.content.text.trim() ||
          message && outbox.content.text !== message.text) fail('答复 outbox 正文或来源归属不匹配');
      // Delivery belongs to the registered channel plugin, not a vendor allowlist.
      if (typeof outbox.channel !== 'string' || !outbox.channel.trim() || typeof outbox.target !== 'string' || !outbox.target.trim()) fail('答复 outbox 渠道或目标无效');
      fresh(outbox.createdAt);
    }
    const text = message?.text ?? outbox!.content.text;
    // Snapshot the source identity and actual content, independently of outbox's supplied hash.
    // Mutable delivery status is deliberately excluded so queued -> sent can satisfy the rule.
    const sourceHash = hash(JSON.stringify({
      projectId: currentTodo.projectId,
      message: message && { id: message.id, todoId: message.todoId, projectId: message.projectId,
        conversationId: message.conversationId, createdAt: message.createdAt, text: message.text },
      outbox: outbox && { id: outbox.id, version: outbox.version, owner: outbox.owner,
        contentHash: outbox.contentHash, content: outbox.content, channel: outbox.channel,
        target: outbox.target, relatedTo: outbox.relatedTo, causedBy: outbox.causedBy,
        dedupKey: outbox.dedupKey, createdAt: outbox.createdAt },
    }));
    return { contentHash: hash(text), sourceHash, outbox, projectId: currentTodo.projectId };
  }
  return {
    get,
    configure(input: ConfigureTodoReporting): TodoReportingState {
      return store.transaction(() => {
        const state = get(input.todoId);
        checkVersion(state.version, input.version === undefined && state.version === 0 ? 0 : input.version);
        if (typeof input.required !== 'boolean' || input.requireDelivery !== undefined && typeof input.requireDelivery !== 'boolean') fail('答复约束必须为 boolean');
        // Configuration changes invalidate evidence, including disable/re-enable within one cycle.
        return save({ ...state, required: input.required,
          requireDelivery: input.requireDelivery ?? state.requireDelivery,
          version: state.version + 1, report: undefined }, 'todo.reporting.configured');
      });
    },
    report(input: ReportTodo): TodoReportingState {
      return store.transaction(() => {
        const state = get(input.todoId);
        checkVersion(state.version, input.version);
        const evidence = source(input, state);
        const version = state.version + 1;
        const report: TodoReport = {
          id: randomUUID(), todoId: state.todoId, cycle: state.cycle, version,
          messageId: input.messageId, outboxId: input.outboxId,
          projectId: evidence.projectId, contentHash: evidence.contentHash,
          sourceHash: evidence.sourceHash, reportedAt: new Date().toISOString(),
        };
        store.put('todo.reporting.reports', report.id, report);
        return save({ ...state, version, report }, 'todo.reporting.reported');
      });
    },
    assertCanComplete(todoId: string): void {
      const state = get(todoId);
      if (!state.required) return;
      const report = state.report;
      if (!report || report.todoId !== todoId || report.cycle !== state.cycle || report.version !== state.version) fail('当前周期尚未记录有效答复', 409);
      const evidence = source(report, state);
      if (report.projectId !== evidence.projectId || report.contentHash !== evidence.contentHash || report.sourceHash !== evidence.sourceHash) fail('答复来源或正文已改变，必须重新报告', 409);
      if (state.requireDelivery && evidence.outbox?.status !== 'sent') fail('答复尚无真实 outbox sent 送达证据', 409);
    },
    /** Call exactly once on completed -> open, inside updateTodo's synchronous transaction. */
    onReopen(todoId: string): TodoReportingState {
      return store.transaction(() => {
        const state = get(todoId);
        return save({ ...state, cycle: state.cycle + 1, version: state.version + 1,
          cycleStartedAt: new Date().toISOString(), report: undefined }, 'todo.reporting.reopened');
      });
    },
  };
}

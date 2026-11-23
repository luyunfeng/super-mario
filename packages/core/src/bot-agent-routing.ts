import { createHash } from 'node:crypto';
import type { BotScope, FeishuBot } from '../../protocol/src/bots.ts';
import type { Message } from '../../protocol/src/index.ts';

const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 409 }); };
function canonicalScope(scope: BotScope): BotScope {
  if (scope.kind === 'project') return { kind: 'project', projectId: scope.projectId };
  if (scope.kind === 'task') return { kind: 'task', todoId: scope.todoId, ...(scope.projectId ? { projectId: scope.projectId } : {}) };
  return { kind: scope.kind };
}
export function validBotThreadId(id: unknown): id is string {
  return typeof id === 'string' && id.length === 64 && !/[^a-f0-9]/.test(id);
}

export function botConversationId(bot: Pick<FeishuBot, 'id' | 'scope'>, threadId?: string): string {
  const base = `bot:${bot.id}:${createHash('sha256').update(JSON.stringify(canonicalScope(bot.scope))).digest('hex')}`;
  if (threadId === undefined) return base;
  if (bot.scope.kind !== 'global' || !validBotThreadId(threadId))
    throw Object.assign(new Error('独立会话需要全局机器人和有效话题标识'), { status: 400 });
  return `${base}:thread:${threadId}`;
}
/** resolvedScope must come from the host runtime, never from model-supplied fields.
 * An inbox assignment changes an unmarked bot's conversation, not its configured identity. */
export function botForConversation(bots: FeishuBot[], conversationId?: string, resolvedScope?: BotScope, threadId?: string): FeishuBot | undefined {
  const bot = bots.find(item => conversationId?.startsWith(`bot:${item.id}:`));
  if (!bot) return undefined; // Legacy/custom scoped runtimes need no robot binding.
  const scope = bot.scope.kind === 'unmarked' && resolvedScope ? resolvedScope : bot.scope;
  if ((threadId !== undefined && bot.scope.kind !== 'global') || conversationId !== botConversationId({ id: bot.id, scope }, threadId) || !bot.enabled || !bot.paired) fail('机器人会话绑定已变化或尚未配对');
  return bot;
}
/** Stored message fields are authoritative for assignments; no fields can mean either
 * global or unmarked, so only the exact global hash selects global. */
function messageScope(bots: FeishuBot[], source: Pick<Message, 'conversationId' | 'projectId' | 'todoId'>, threadId?: string): BotScope {
  if (source.todoId) return { kind: 'task', todoId: source.todoId, ...(source.projectId ? { projectId: source.projectId } : {}) };
  if (source.projectId) return { kind: 'project', projectId: source.projectId };
  return { kind: bots.some(bot => source.conversationId === botConversationId({ id: bot.id, scope: { kind: 'global' } }, threadId)) ? 'global' : 'unmarked' };
}
/** The explicit approved executor must still agree with the current optional binding.
 * Checking this again at dispatch also covers delayed plan/approval continuations. */
export function pinBotExecutor(bots: FeishuBot[], source: Pick<Message, 'conversationId' | 'projectId' | 'todoId'> | undefined, requested: unknown, threadId?: string): unknown {
  const bot = botForConversation(bots, source?.conversationId, source && messageScope(bots, source, threadId), threadId);
  if (!bot?.executorId) return requested;
  if (requested !== undefined && requested !== '' && requested !== bot.executorId) fail('此机器人已绑定其他执行者，请通过协作委派而非切换执行者');
  return bot.executorId;
}
export function relaySender(bots: FeishuBot[], source: Message | undefined, requested?: unknown, threadId?: string): FeishuBot {
  if (!source || source.role !== 'user' || source.readOnly) return fail('协作需要明确的当前用户输入或机器人会话');
  const own = botForConversation(bots, source.conversationId, messageScope(bots, source, threadId), threadId);
  if (own) {
    if (requested !== undefined && requested !== own.id) fail('不能冒用其他机器人的协作身份');
    if (own.scope.kind === 'unmarked') fail('未标记机器人不能发起协作');
    return own;
  }
  if (source.conversationId !== 'main') return fail('只有主对话或绑定机器人能发起机器人协作');
  const candidates = bots.filter(bot => bot.enabled && bot.paired && bot.scope.kind === 'global');
  const selected = requested === undefined ? candidates.length === 1 ? candidates[0] : undefined : candidates.find(bot => bot.id === requested);
  if (!selected) return fail('请明确选择已配对的全局机器人作为主 Agent 的协作身份');
  return selected;
}

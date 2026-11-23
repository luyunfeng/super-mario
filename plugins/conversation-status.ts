import type { Json, Store } from '../packages/plugin-sdk/src/index.ts';
import type { Message, Run } from '../packages/protocol/src/index.ts';

type QuestionKind = 'question' | 'permission' | 'plan' | 'review';
type Interaction = { id: string; runId?: string; projectId?: string; status: string; handler: string;
  kind: QuestionKind; title: string; createdAt: string; expiresAt?: string };
export type ConversationStatus = {
  phase: 'no_records' | 'idle' | 'working' | 'waiting' | 'failed' | 'unknown';
  lastMessage: { role: Message['role']; text: string; at: string; truncated: boolean } | null;
  pending: { total: number; items: { kind: QuestionKind; title: string }[]; truncated: boolean };
  goal: string | null;
};

function excerpt(text: string, limit: number) {
  const chars = Array.from(text.replace(/[\p{Cc}\s]+/gu, ' ').trim());
  return { text: chars.slice(0, limit).join(''), truncated: chars.length > limit };
}

export function readConversationStatus(store: Pick<Store, 'list' | 'get'>, input: Json): ConversationStatus {
  const allowed = ['conversationId', 'projectId', 'todoId', 'excludeId'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.conversationId !== 'string' || !input.conversationId.trim()
    || Object.entries(input).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string'
      || !value.trim() || value.length > 512 || /[\p{Cc}]/u.test(value)))
    throw Object.assign(new Error('缺少有效的当前会话范围'), { status: 400 });
  const { conversationId, projectId, todoId, excludeId } = input;
  const workProject = /^project:(.+):work$/.exec(conversationId)?.[1];
  const belongs = (row: Pick<Message, 'conversationId' | 'projectId' | 'todoId'>) =>
    row.conversationId === conversationId && (!workProject || !row.projectId || row.projectId === workProject)
    && (projectId === undefined || (row.projectId ?? workProject) === projectId)
    && (todoId === undefined || row.todoId === todoId);
  const messages = store.list<Message>('messages').filter(row => belongs(row) && row.id !== excludeId
    && (!excludeId || row.replyTo !== excludeId) && (row.role === 'user' || row.role === 'assistant') && (!row.origin || row.origin === 'user'))
    .reverse().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  // Recovery marks interrupted inputs failed. A previously persisted assistant
  // placeholder can still say pending after its owning input has terminated.
  const turnId = (message: Message) => message.role === 'user' ? message.id : message.replyTo;
  const settled = new Set<string>();
  for (const message of messages) {
    const id = turnId(message);
    if (id && (message.status === 'done' || message.status === 'failed')) settled.add(id);
  }
  const currentMessages = messages.filter(message => message.status !== 'pending' || !settled.has(turnId(message) ?? ''));
  const runs = store.list<Run>('runs').filter(row => belongs(row) && (!excludeId || row.sourceMessageId !== excludeId));
  const runIds = new Map(runs.map(run => [run.id, run]));
  const inputs = new Map(messages.filter(message => message.role === 'user').map(message => [message.id, message]));
  const pending = store.list<Interaction>('interactions').filter(card => {
    if (card.status !== 'open' || card.handler !== 'user' || (card.expiresAt && Date.parse(card.expiresAt) <= Date.now())) return false;
    // A card may be opened directly by an assistant, or against an executor run.
    // Only its persisted owner establishes the conversation; a project label alone cannot.
    const origin = store.get<{ inputId?: string }>('interaction-origins', card.id)?.inputId;
    const owner = card.runId ? runIds.get(card.runId) : origin && inputs.get(origin);
    return owner && (!card.projectId || card.projectId === (owner.projectId ?? workProject));
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  // A removed queue item still settles the turn, but its draft is no longer a conversation excerpt.
  const last = currentMessages.find(message => message.queueState !== 'withdrawn' && message.queueState !== 'cancelled' && message.text.trim());
  const active = runs.filter(run => run.status === 'queued' || run.status === 'running');
  const lastRun = runs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const latest = lastRun && (!currentMessages[0] || Date.parse(lastRun.updatedAt) >= Date.parse(currentMessages[0].createdAt)) ? lastRun : currentMessages[0];
  let phase: ConversationStatus['phase'];
  if (pending.length) phase = 'waiting';
  else if (active.length || currentMessages.some(m => m.status === 'pending')) phase = 'working';
  else if (!latest) phase = 'no_records';
  else if (runs.some(run => run.status === 'unknown')) phase = 'unknown';
  else if ('queueState' in latest && (latest.queueState === 'cancelled' || latest.queueState === 'withdrawn')) phase = 'idle';
  else if (latest.status === 'failed') phase = 'failed';
  else if (latest.status === 'done' || latest.status === 'completed' || latest.status === 'cancelled') phase = 'idle';
  else phase = 'unknown';
  return { phase, lastMessage: last ? { role: last.role, at: last.createdAt, ...excerpt(last.text, 160) } : null,
    goal: active.length === 1 ? excerpt(active[0].prompt, 120).text || null : null,
    pending: { total: pending.length, items: pending.slice(0, 5).map(card => ({ kind: card.kind, title: excerpt(card.title, 100).text })),
      truncated: pending.length > 5 } };
}

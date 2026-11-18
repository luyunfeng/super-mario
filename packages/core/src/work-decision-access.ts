import type { Store } from '../../plugin-sdk/src/index.ts';
import type { BotScope, MailboxEntry, Message, MessageRoute } from '../../protocol/src/index.ts';
import { botConversationId } from './bot-agent-routing.ts';
import { canRelayBotScope } from './bot-group-policy.ts';
import { sameBotScope, scopeError, validateBotScope } from './bot-scopes.ts';

// This is the persisted shape written by feishu-bots.dispatchInbox, not current
// bot configuration. A later disable/rebind must not revoke an explicit fact.
type HistoricalRoute = MessageRoute & {
  botId?: string; scope?: BotScope; revision?: number; inputId?: string;
  envelopeId?: string; sourceMessageId?: string; relay?: unknown;
  resultRelayEntryId?: string;
};
type Envelope = { revision?: number; relay?: unknown; resultRelayEntryId?: string };
function deny(): never { return scopeError('工作决定来源路由或身份范围无效', 403); }
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && value.length > 0;

/** Historical source authority only. The host must separately assertBotInput for
 * current writes, and seal message.routes in work-decisions' source proof.
 * No writes or caches: all evidence survives a Store/process restart.
 */
export function authorizeWorkDecisionSource(store: Store, scope: BotScope, source: Message): void {
  if (source.role !== 'user' || source.readOnly || source.origin !== undefined && source.origin !== 'user') deny();
  const target = validateBotScope(store, scope, { allowArchived: true });
  if (target.kind === 'unmarked') deny();
  const narrow = (owner: BotScope) => { if (!canRelayBotScope(owner, target)) deny(); };
  // Keep explicit ownership as an upper bound even when called without the ledger.
  if (source.todoId !== undefined) narrow(validateBotScope(store, { kind: 'task', todoId: source.todoId, projectId: source.projectId }, { allowArchived: true }));
  else if (source.projectId !== undefined) narrow(validateBotScope(store, { kind: 'project', projectId: source.projectId }, { allowArchived: true }));

  // This checkout has one external route per message, not Message.routes. Do not
  // silently approve an unrecognised multi-route contract or ignore extra routes.
  if ('routes' in source) deny();
  const route = store.get<HistoricalRoute>('message.routes', source.id);
  if (route && (Array.isArray(route) || route.resumed || route.relay !== undefined || route.resultRelayEntryId !== undefined)) deny();
  if (source.conversationId === 'main') {
    // The legacy main Feishu connector writes a plain route without bot identity.
    if (route && (route.channel !== 'feishu' || !identifier(route.accountId) || !identifier(route.target)
      || route.botId !== undefined || route.scope !== undefined || route.inputId !== undefined || route.envelopeId !== undefined)) deny();
    return;
  }
  if (source.projectId !== undefined && source.conversationId === `project:${source.projectId}:work`) {
    if (route) deny(); // The project runtime never creates a channel route.
    return;
  }
  if (!route || route.channel !== 'feishu' || !identifier(route.botId) || !identifier(route.accountId)
    || !identifier(route.target) || !identifier(route.envelopeId) || route.inputId !== source.id
    || !identifier(route.sourceMessageId) || !Number.isSafeInteger(route.revision) || route.revision! < 1 || !route.scope) deny();
  const owner = validateBotScope(store, route.scope, { allowArchived: true });
  if (!sameBotScope(owner, route.scope) || owner.kind === 'unmarked'
    || source.conversationId !== botConversationId({ id: route.botId, scope: owner })) deny();
  // Scoped runtimes stamp the exact project/task identity on accepted messages.
  if (source.projectId !== ('projectId' in owner ? owner.projectId : undefined)
    || source.todoId !== (owner.kind === 'task' ? owner.todoId : undefined)) deny();
  narrow(owner);
  const envelope = store.get<MailboxEntry>('event.mailboxes', route.envelopeId);
  const stamp = store.get<Envelope>('feishu.bot.envelopes', route.envelopeId);
  const receipt = store.get<{ status: string; id?: string }>('feishu.bot.dispatch', `${route.botId}:${route.accountId}:${route.envelopeId}`);
  // A2A/model requests are also stored as role:user. Only the real inbound user
  // path is evidence; a valid bot hash or an inherited result route is insufficient.
  if (!envelope || envelope.id !== route.envelopeId || envelope.direction !== 'inbox'
    || envelope.botId !== route.botId || !sameBotScope(envelope.scope, owner)
    || envelope.eventKey !== `feishu-in:${JSON.stringify([route.botId, route.accountId, route.sourceMessageId])}`
    || envelope.sourceMessageId !== route.sourceMessageId || envelope.target !== route.target
    || envelope.text !== source.text || envelope.origin?.kind !== 'direct' && envelope.origin?.kind !== 'group'
    || !stamp || stamp.revision !== route.revision || stamp.relay !== undefined || stamp.resultRelayEntryId !== undefined
    || receipt?.status !== 'completed' || receipt.id !== source.id) deny();
}

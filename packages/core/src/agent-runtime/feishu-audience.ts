import { createHash } from 'node:crypto';
import { mailboxEntryId } from '../event-mailboxes.ts';
import type { Store } from '../../../plugin-sdk/src/index.ts';
import type { MailboxEntry, Message } from '../../../protocol/src/index.ts';

type Cutover = { generation: string; revision: number; appId: string; senderId: string; chatId: string };
type Route = { channel: string; botId: string; accountId: string; revision: number; target: string; inputId: string; envelopeId: string;
  scope?: { kind: string }; conversationThreadId?: string; privateSenderId?: string; chatProject?: string; audienceGeneration?: string;
  group?: { chatType?: string; chatId: string; senderType?: string }; command?: string; relay?: unknown; resultRelayEntryId?: string };
export type FeishuAudience = { key: string; kind: 'owner' | 'group' | 'isolated' };
const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** SDK sessions used to keep all global-bot turns together. Only validated channel utterances can seed their replacements. */
export function feishuAudienceHistory(store: Store, botId: string, conversationId: string) {
  function identify(message: Message, route: Route | undefined): FeishuAudience {
    const isolated = { key: hash([botId, 'turn', message.id]), kind: 'isolated' as const };
    if (!route || route.channel !== 'feishu' || route.botId !== botId || route.scope?.kind !== 'global'
      || !route.accountId || !route.target || route.inputId !== message.id || route.relay || route.command
      || route.resultRelayEntryId || route.chatProject || route.conversationThreadId) return isolated;
    const generation = store.get<string>('feishu.group-read.generation', botId) ?? '';
    if (route.audienceGeneration !== undefined && generation !== route.audienceGeneration) return isolated;
    const paired = store.get<{chatId: string; senderId?: string}>('settings', 'feishu.bot.owner:' + botId + ':' + route.accountId);
    if (!paired?.senderId || !paired.chatId) return isolated;
    if (route.audienceGeneration === undefined) {
      const cutover = store.get<Cutover>('feishu.audience.cutover', botId);
      if (!cutover || cutover.generation !== generation || cutover.appId !== route.accountId
        || cutover.chatId !== paired.chatId || cutover.senderId !== paired.senderId || cutover.revision !== route.revision) return isolated;
    }
    const base = [botId, route.accountId, generation, paired.chatId, paired.senderId];
    if (route.group) {
      if (route.group.chatType !== 'group' || route.group.chatId !== route.target || route.group.senderType !== 'user') return isolated;
      return { key: hash([...base, 'group', route.target]), kind: 'group' };
    }
    if (paired.chatId !== route.target || paired.senderId !== route.privateSenderId) return isolated;
    return { key: hash([...base, 'owner']), kind: 'owner' };
  }
  function forInput(message: Message) {
    return identify(message, store.get<Route>('message.routes', message.id));
  }
  function visible(message: Message, audience: FeishuAudience) {
    if (message.conversationId !== conversationId || audience.kind === 'isolated') return false;
    const input = message.role === 'user' && !message.readOnly ? message
      : message.replyTo ? store.get<Message>('messages', message.replyTo) : undefined;
    if (!input || input.role !== 'user' || input.conversationId !== conversationId) return false;
    const route = store.get<Route>('message.routes', input.id);
    if (!route || identify(input, route).key !== audience.key) return false;
    // A legacy row has no pairing stamp. Require the original completed delivery and a matching receipt.
    if (route.audienceGeneration === undefined) {
      const mail = store.get<MailboxEntry>('event.mailboxes', route.envelopeId);
      const receipt = store.get<{ id?: string; status: string }>('feishu.bot.dispatch', botId + ':' + route.accountId + ':' + route.envelopeId);
      if (mail?.direction !== 'inbox' || mail.botId !== botId || mail.status !== 'completed' || mail.target !== route.target || mail.text !== input.text
        || receipt?.status !== 'completed' || receipt.id !== input.id) return false;
      // Do not trust an old generated sentence merely because its prompt belonged to this chat.
      if (message.role === 'assistant' && !delivered(message, route)) return false;
    }
    return true;
  }
  function delivered(message: Message, route: Route) {
    const key = 'feishu-reply:' + JSON.stringify([botId, route.accountId, route.inputId, message.id]);
    const mail = store.get<MailboxEntry>('event.mailboxes', mailboxEntryId(botId, 'outbox', key));
    return mail?.status === 'completed' && mail.direction === 'outbox' && mail.botId === botId && mail.target === route.target
      && mail.replyTo === route.inputId && mail.text === message.text && mail.eventKey === key;
  }
  function legacyUtterances(audience: FeishuAudience) {
    if (audience.kind === 'isolated') return [];
    return store.list<Message>('messages').filter(m => {
      if (m.status !== 'done' || m.readOnly || (m.origin && m.origin !== 'user') || !visible(m, audience)) return false;
      if (m.role === 'user') return true;
      const route = m.replyTo && store.get<Route>('message.routes', m.replyTo);
      return m.role === 'assistant' && route && delivered(m, route);
    }).slice(-40).map(m => ({ role: m.role, text: m.text.slice(0, 2000) }));
  }
  return { forInput, visible, legacyUtterances };
}

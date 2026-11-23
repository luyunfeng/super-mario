import { createHash } from 'node:crypto';
import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Message } from '../../protocol/src/index.ts';

const collection = 'message.requests';

function receiptKey(conversationId: string, requestId: string) {
  if (typeof requestId !== 'string' || requestId.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId))
    throw Object.assign(new Error('requestId 必须是标准小写 UUID v4'), { status: 400 });
  return JSON.stringify([conversationId, requestId]);
}

function fingerprint(message: Message): string {
  // Only bind immutable input fields. Status is read live from the message.
  return createHash('sha256').update(JSON.stringify([message.conversationId, message.role, message.text,
    message.projectId, message.todoId, !!message.readOnly, message.origin, message.replyTo,
    ...(message.retryOf ? [{retryOf:message.retryOf}] : []),
    ...(message.images?.length ? [message.images.map(ref => [ref.mime, ref.bytes, ref.sha256])] : []),
    ...(message.files?.length ? [{files:message.files.map(ref => [ref.name,ref.mime,ref.bytes,ref.sha256])}] : [])])).digest('hex');
}

function conflict(): never {
  throw Object.assign(new Error('这个请求号已受理，无法匹配原消息'), { status: 409 });
}

export function readMessageReceipt(store: Store, conversationId: string, requestId: string): Message | undefined {
  const row = store.get<{ fingerprint: string; messageId: string }>(collection, receiptKey(conversationId, requestId));
  if (!row) return undefined;
  const saved = store.get<Message>('messages', row.messageId);
  if (!saved || saved.id !== row.messageId || saved.role !== 'user' || saved.conversationId !== conversationId ||
      saved.requestId !== requestId || fingerprint(saved) !== row.fingerprint) conflict();
  return saved;
}

/** Return the existing input on replay. Only a new acceptance may be queued. */
export function acceptMessage(store: Store, message: Message): Message | undefined {
  const { conversationId, requestId } = message;
  if (requestId === undefined) {
    store.put('messages', message.id, message);
    return;
  }
  return store.transaction(() => {
    const saved = readMessageReceipt(store, conversationId, requestId);
    const digest = fingerprint(message);
    if (saved) {
      if (fingerprint(saved) !== digest) conflict();
      return saved;
    }
    store.put('messages', message.id, message);
    store.put(collection, receiptKey(conversationId, requestId), { fingerprint: digest, messageId: message.id });
  });
}

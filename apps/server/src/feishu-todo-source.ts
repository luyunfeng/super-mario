import { createHash } from 'node:crypto';

export function feishuTodoSource(binding: string, chatId: string, messageId: string, ownerWords: string) {
  const audience = createHash('sha256').update(JSON.stringify([binding, chatId])).digest('hex');
  return {id:messageId, conversationId:'feishu-group:' + audience, text:ownerWords};
}

export type FeishuTodoSource = ReturnType<typeof feishuTodoSource>;

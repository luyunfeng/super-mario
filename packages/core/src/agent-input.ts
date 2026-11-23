import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatFileRef, Message } from '../../protocol/src/index.ts';

export type OfficeFileOrigin = {sourceId:string;replyId:string;ref:ChatFileRef};

// Tool callbacks are shared, but the calling bot is not. Async context keeps
// concurrent bot tool calls from inheriting the main Agent's current message.
const inputs = new AsyncLocalStorage<{input?:Message;replyId?:string}>();
export const currentAgentInput = () => inputs.getStore()?.input;
export const currentAgentReplyId = () => inputs.getStore()?.replyId;
export function runWithAgentInput<T>(input: Message | undefined, action: () => T, replyId?:string): T {
  return inputs.run({input,replyId}, action);
}

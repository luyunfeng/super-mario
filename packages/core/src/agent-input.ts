import { AsyncLocalStorage } from 'node:async_hooks';
import type { Message } from '../../protocol/src/index.ts';

// Tool callbacks are shared, but the calling bot is not. Async context keeps
// concurrent bot tool calls from inheriting the main Agent's current message.
const inputs = new AsyncLocalStorage<Message | undefined>();
export const currentAgentInput = () => inputs.getStore();
export function runWithAgentInput<T>(input: Message | undefined, action: () => T): T {
  return inputs.run(input, action);
}

import type { Extension } from '../../packages/plugin-sdk/src/index.ts';
import type { JsonObject } from '../../packages/protocol/src/index.ts';

/** A third-party style extension: the host owns registration and listener cleanup. */
export const sdkOnlyExtension: Extension = {
  id: 'example-sdk-only',
  name: 'SDK-only example',
  capabilities: ['tools'],
  activate(context) {
    let observed = 0;
    context.onEvent(event => { if (event.type === 'example.ping') observed++; });
    context.contribute('tools', 'example_echo', {
      name: 'example_echo', description: 'Return JSON input and observed ping count',
      parameters: { type: 'object' },
      async execute(args: JsonObject, signal) {
        signal.throwIfAborted();
        return { input: args, observed };
      },
    });
  },
};

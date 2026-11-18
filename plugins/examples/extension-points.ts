import type { Extension, Json, JsonObject } from '../../packages/plugin-sdk/src/index.ts';
// The SDK re-exports transport types; no core implementation is imported by either plugin.
export const catalog: Extension = {
  id: 'example.catalog', name: '示例目录服务', capabilities: ['example.catalog'],
  extensionPoints: [{ id: 'example.catalog.labels', version: 1 }],
  permissions: ['point.define:example.catalog.labels', 'service.provide:example.catalog.echo'],
  activate(context) {
    context.provide('example.catalog.echo', input => ({ text: String((input as JsonObject).text) }));
  },
};
export const consumer: Extension = {
  id: 'example.consumer', name: '示例目录消费者', capabilities: ['example.consumer'], dependencies: ['example.catalog'],
  permissions: ['contribute:example.catalog.labels', 'service.wrap:example.catalog.echo', 'service.use:example.catalog.echo', 'hook:work.dispatch'],
  activate(context) {
    context.contribute('example.catalog.labels', 'example.consumer.label', { label: '通过插件声明的扩展点' });
    context.wrap('example.catalog.echo', async (input, next) => {
      const result = await next({ text: 'wrapped:' + String((input as JsonObject).text) });
      return { ...(result as JsonObject), wrapped: true };
    });
    context.hook('work.dispatch', 'before', value => ({ action: 'continue', value: { ...(value as JsonObject), prompt: 'reviewed:' + String((value as JsonObject).prompt) } as Json }));
  },
};

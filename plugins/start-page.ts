import type { Extension, Store } from '../packages/plugin-sdk/src/index.ts';
import type { PluginInfo, StartPagePreference } from '../packages/protocol/src/index.ts';

export function readStartPage(store: Store): StartPagePreference {
  return store.get<StartPagePreference>('start-page', 'workspace') ?? { key: 'home', revision: 0 };
}

export function createStartPage(plugins: () => PluginInfo[]): Extension {
  return {
    id: 'start-page', name: '启动页', capabilities: ['web.start-page'],
    permissions: ['store.read', 'store.write', 'service.provide:start-page.save', 'events.publish'],
    activate({ store, provide, events }) {
      provide('start-page.save', input => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.key !== 'string' ||
          typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0 || Object.keys(input).some(k => k !== 'key' && k !== 'revision'))
          throw Object.assign(Error('启动页设置无效'), { status: 400 });
        const keys = ['home', 'chat', 'inbox', 'outbox', 'agent', 'projects', 'memory', 'channels'];
        for (const plugin of plugins()) {
          if (plugin.status === 'active') for (const item of plugin.navigation ?? []) keys.push(JSON.stringify([plugin.id, item.id]));
        }
        if (!keys.includes(input.key)) throw Object.assign(Error('请选择当前可用的页面'), { status: 400 });
        const current = readStartPage(store);
        if (input.revision !== current.revision) throw Object.assign(Error('启动页设置已变更，请刷新后重试'), { status: 409 });
        if (input.key === current.key) return { ...current };
        const next = { key: input.key, revision: current.revision + 1 };
        store.put('start-page', 'workspace', next);
        events.publish('start-page.changed', { revision: next.revision });
        return next;
      });
    },
  };
}

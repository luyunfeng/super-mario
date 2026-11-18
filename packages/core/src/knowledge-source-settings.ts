import type { Store, EventBus } from '../../plugin-sdk/src/index.ts';
export interface KnowledgeReaderSettings { enabled: boolean; profile?: string; trustedHosts: string[]; revision: number }
/** Reader consent/configuration stays separate from message collection and worker execution. */
export function createKnowledgeSourceSettings(store: Store, events: EventBus) {
  const read = (): KnowledgeReaderSettings => ({ enabled: false, trustedHosts: [], revision: 1, ...store.get<KnowledgeReaderSettings>('knowledge.reader', 'settings') });
  return { read,
    configure(input: Record<string, unknown>) {
      if (Object.keys(input).some(key => !['enabled', 'profile', 'trustedHosts'].includes(key)) || typeof input.enabled !== 'boolean') throw Object.assign(new Error('来源读取配置无效'), { status: 400 });
      const profile = typeof input.profile === 'string' ? input.profile.trim() : undefined;
      if (input.profile !== undefined && (typeof input.profile !== 'string' || profile && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(profile))) throw Object.assign(new Error('命令行连接名称无效'), { status: 400 });
      const hosts = input.trustedHosts ?? [];
      if (!Array.isArray(hosts) || hosts.length > 32 || hosts.some(host => typeof host !== 'string' || host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host))) throw Object.assign(new Error('请填写精确的受信域名，不使用通配符'), { status: 400 });
      const next = { enabled: input.enabled, ...(profile ? { profile } : {}), trustedHosts: [...new Set(hosts.map(host => host.toLowerCase()))] };
      const previous = read();
      if (JSON.stringify({ enabled:previous.enabled,...(previous.profile?{profile:previous.profile}:{}),trustedHosts:previous.trustedHosts }) === JSON.stringify(next)) return previous;
      const saved = { ...next, revision: previous.revision + 1 };
      store.transaction(() => { store.put('knowledge.reader', 'settings', saved); events.publish('knowledge.reader.changed', { revision: saved.revision, enabled: saved.enabled }); });
      return saved;
    },
  };
}

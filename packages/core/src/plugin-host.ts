import { assertBackgroundExecution } from './eventbox.ts';
import { assertJson, assertPluginPermissions } from '../../plugin-sdk/src/index.ts';
import { createPluginInvocations, validateInvocationOptions } from './plugin-invocations.ts';
import { join } from 'node:path';
import type { JsonObject, PluginInfo } from '../../protocol/src/index.ts';
import type { ContributionMap, Contributions, Dispose, EventBus, Extension, ExtensionContext, Store, ExtensionPointDefinition, BackgroundHost } from '../../plugin-sdk/src/index.ts';

const builtinMethods: Record<string, string[]> = {
  tools: ['execute'], executors: ['execute'], knowledge_backends: ['list', 'put', 'remove'], routines: ['run'],
  event_subscriptions: ['handler'], hooks: ['handler'], services: ['handler'], service_wrappers: ['handler'],
};
const builtinPointNames = ['event_subscriptions', 'tools', 'skills', 'context_providers', 'model_providers', 'channels', 'connectors', 'inbox_triage', 'executors', 'terminal_hosts', 'screen_parsers', 'knowledge_backends', 'interaction_policies', 'routines', 'api', 'events', 'web_extensions', 'hooks', 'services', 'service_wrappers'];
function registrationValue(value: unknown, methods: string[], optional: string[] = []) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Contribution must be a plain object');
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !('value' in field)) throw new TypeError('Contribution cannot contain accessors or symbols');
    if (optional.includes(key) && field.value !== undefined && typeof field.value !== 'function') throw new TypeError('Optional callback must be a function');
    if ((methods.includes(key) || optional.includes(key)) && typeof field.value === 'function') continue;
    // Existing local contracts have optional fields; absent values are not sent over JSON services.
    if (field.value !== undefined) assertJson(field.value, `contribution.${key}`);
  }
  if (!methods.every(key => typeof (value as Record<string, unknown>)[key] === 'function')) throw new TypeError('Contribution is missing its registered callback');
}
export function createContributions(): Contributions {
  const entries = new Map<string, Map<string, unknown>>();
  const points = new Map<string, ExtensionPointDefinition>();
  const registry: Contributions = {
    definePoint(definition) {
      assertJson(definition as unknown);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(definition.id) || definition.version !== 1 || !['json', 'local'].includes(definition.transport ?? 'json')) throw new TypeError('Invalid extension point definition');
      if (points.has(definition.id)) throw new Error(`Extension point already declared: ${definition.id}`);
      points.set(definition.id, { ...definition, transport: definition.transport ?? 'json' });
      let disposed = false;
      return () => { if (!disposed) { disposed = true; points.delete(definition.id); entries.delete(definition.id); } };
    },
    points: () => [...points.values()].map(value => ({ ...value })),
    add(kind, id, value) {
      const point = points.get(String(kind));
      if (!point) throw new Error(`Undeclared extension point: ${String(kind)}`);
      if (typeof id !== 'string' || !id.trim()) throw new TypeError('Contribution id is required');
      if (point.transport === 'json') assertJson(value);
      else registrationValue(value, builtinMethods[String(kind)] ?? [], kind === 'knowledge_backends' ? ['revision'] : []);
      let collection = entries.get(kind);
      if (!collection) { collection = new Map(); entries.set(kind, collection); }
      if (collection.has(id)) throw new Error(`Contribution already registered: ${String(kind)}/${id}`);
      // Connector declarations carry trusted routing and classification settings.
      collection.set(id, kind === 'connectors' ? structuredClone(value) : value);
      let disposed = false;
      return () => { if (!disposed) { disposed = true; collection!.delete(id); } };
    },
    list<K extends keyof ContributionMap>(kind: K) {
      return [...(entries.get(kind) ?? [])].map(([id, value]) => ({ id, value: (kind === 'connectors' ? structuredClone(value) : value) as ContributionMap[K] }));
    },
  };
  // Built-ins use the same declaration path as plugin-owned JSON points.
  for (const id of builtinPointNames) registry.definePoint({ id, version: 1, transport: builtinMethods[id] ? 'local' : 'json' });
  return registry;
}

type Entry = { extension: Extension; config: JsonObject; info: PluginInfo; dispose?: () => Promise<void> };
type HostOptions = { store: Store; events: EventBus; contributions: Contributions; dataDir: string; background?: BackgroundHost };
const settingsCollection = 'core.plugin-settings';

export class PluginHost {
  private options: HostOptions;
  private entries = new Map<string, Entry>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private sequence = 0;
  readonly invocations: ReturnType<typeof createPluginInvocations>;

  constructor(options: HostOptions) { this.options = options; this.invocations = createPluginInvocations(options.contributions); }

  register(extension: Extension, config: JsonObject = {}): void {
    if (this.closed) throw new Error('Plugin host is closed');
    assertJson(config);
    if (extension.permissions !== undefined) assertPluginPermissions(extension.permissions);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(extension.id)) throw new Error(`Invalid plugin id: ${extension.id}`);
    if (this.entries.has(extension.id)) throw new Error(`Plugin already registered: ${extension.id}`);
    const enabled = this.options.store.get<{ enabled: boolean }>(settingsCollection, extension.id)?.enabled !== false;
    this.entries.set(extension.id, {
      extension, config, info: { ...(extension.navigation && { navigation: structuredClone(extension.navigation) }), id: extension.id, name: extension.name, capabilities: [...extension.capabilities], enabled, status: enabled ? 'waiting' : 'disabled' },
    });
    try { this.checkCycles(); }
    catch (error) { this.entries.delete(extension.id); throw error; }
  }

  start(): Promise<void> {
    return this.enqueue(async () => { await this.reconcile(); });
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown plugin: ${id}`);
      const saved=this.options.store.get<{enabled:boolean;revision?:number}>(settingsCollection,id);
      const revision=saved?.revision??1;
      // Persist the enablement generation: off→on must not revive an old
      // content-bound approval, including after a process restart.
      this.options.store.put(settingsCollection, id, { enabled,revision:entry.info.enabled!==enabled||entry.info.status==='failed'?revision+1:revision });
      entry.info.enabled = enabled;
      // An explicit enable is also the user's way to retry a failed activation.
      if (enabled && entry.info.status === 'failed') { entry.info.status = 'waiting'; delete entry.info.error; }
      await this.reconcile();
    });
  }

  list(): PluginInfo[] { return [...this.entries.values()].map(entry => ({ ...entry.info, capabilities: [...entry.info.capabilities] })); }

  close(): Promise<void> {
    const result = this.queue.then(async () => {
      if (this.closed) return;
      this.closed = true;
      const errors: unknown[] = [];
      for (const entry of this.entries.values()) await this.stop(entry, errors);
      if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed');
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.queue.then(async () => {
      if (this.closed) throw new Error('Plugin host is closed');
      await action();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private checkCycles(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Plugin dependency cycle: ${[...visiting, id].join(' -> ')}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of this.entries.get(id)?.extension.dependencies ?? []) visit(dependency);
      visiting.delete(id); visited.add(id);
    };
    for (const id of this.entries.keys()) visit(id);
  }

  private async reconcile(): Promise<void> {
    const errors: unknown[] = [];
    const canRemain = (entry: Entry): boolean => entry.info.enabled && (entry.extension.dependencies ?? []).every(id => {
      const dependency = this.entries.get(id);
      return dependency?.info.status === 'active' && canRemain(dependency);
    });
    for (const entry of this.entries.values()) {
      if (entry.info.status === 'active' && !canRemain(entry)) await this.stop(entry, errors);
      if (!entry.info.enabled && entry.info.status !== 'failed') entry.info.status = 'disabled';
    }
    const visited = new Set<string>();
    const activate = async (entry: Entry): Promise<void> => {
      if (visited.has(entry.info.id)) return;
      visited.add(entry.info.id);
      if (!entry.info.enabled || entry.info.status === 'active' || entry.info.status === 'failed') return;
      for (const id of entry.extension.dependencies ?? []) {
        const dependency = this.entries.get(id);
        if (dependency) await activate(dependency);
      }
      const missing = (entry.extension.dependencies ?? []).filter(id => this.entries.get(id)?.info.status !== 'active');
      if (missing.length) {
        entry.info.status = 'waiting'; entry.info.error = `Dependencies unavailable: ${missing.join(', ')}`;
        return;
      }
      await this.activate(entry);
    };
    for (const entry of this.entries.values()) await activate(entry);
    if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed');
  }

  private async activate(entry: Entry): Promise<void> {
    this.options.background?.ownerEnabled(entry.info.id, false);
    const disposers: Dispose[] = [];
    let live = true;
    const own = (dispose: Dispose): Dispose => {
      assertBackgroundExecution();
      if (!live) throw new Error(`Plugin scope is closed: ${entry.info.id}`);
      let done = false;
      const once = () => { if (!done) { done = true; return dispose(); } };
      disposers.push(once);
      return once;
    };
    const assertLive = () => { assertBackgroundExecution(); if (!live) throw new Error(`Plugin scope is closed: ${entry.info.id}`); };
    const permission = (name: string) => {
      assertBackgroundExecution();
      const grants = entry.extension.permissions;
      if (grants && !grants.includes('*') && !grants.includes(name) && !grants.some(grant => /^(eventbox\.(publish|subscribe)|outbox\.enqueue):/.test(grant) && name.startsWith(grant))) throw new Error(`Plugin ${entry.info.id} requires ${name}`);
    };
    const requireDependency = (name: string) => {
      const owner = [...this.entries.keys()].sort((a,b)=>b.length-a.length).find(id => name.startsWith(id + '.'));
      if (owner && owner !== entry.info.id && !entry.extension.dependencies?.includes(owner)) throw new Error(`Plugin must declare dependency: ${owner}`);
    };
    const contributions: Contributions = {
      list: kind => this.options.contributions.list(kind),
      points: () => this.options.contributions.points(),
      definePoint: definition => {
        assertLive(); permission(`point.define:${definition.id}`);
        if (!definition.id.startsWith(entry.info.id + '.') || definition.transport === 'local' || !entry.extension.extensionPoints?.some(point => point.id === definition.id)) throw new Error('Plugin points must be declared, namespaced JSON data');
        return own(this.options.contributions.definePoint({ ...definition, transport: 'json' }));
      },
      add: (kind, id, value) => {
        assertLive();
        if (kind === 'event_subscriptions') {
          const spec = value as ContributionMap['event_subscriptions'];
          for (const type of spec.types ?? []) permission(`eventbox.subscribe:${type.type}`);
          if (!this.options.background) throw new Error('Background host is not configured');
          const registered = own(this.options.contributions.add(kind, id, value));
          try { const off = own(this.options.background.subscribe(entry.info.id, spec)); return own(() => { off(); registered(); }); }
          catch (error) { registered(); throw error; }
        } else if (kind === 'services') {
          const service = value as ContributionMap['services']; permission(`service.provide:${service.name}`);
          if (!service.name.startsWith(entry.info.id + '.') || service.version !== 1) throw new Error('Service name must belong to its provider and use version 1');
          if (this.options.contributions.list('services').some(item => item.value.name === service.name)) throw new Error('Service already provided');
        } else if (kind === 'service_wrappers') {
          const wrapper = value as ContributionMap['service_wrappers']; permission(`service.wrap:${wrapper.name}`); requireDependency(wrapper.name); validateInvocationOptions(wrapper);
        } else if (kind === 'hooks') {
          const hook = value as ContributionMap['hooks']; permission(`hook:${hook.name}`); validateInvocationOptions(hook);
          if (!['work.dispatch', 'channel.send', 'knowledge.put'].includes(hook.name) || !['before', 'after'].includes(hook.phase)) throw new Error('Unknown hook name or phase');
        } else {
          permission(`contribute:${String(kind)}`);
          if (kind === 'connectors' && value && typeof value === 'object' && !Array.isArray(value) &&
            'kind' in value && value.kind === 'subscription-source') {
            const service = 'service' in value && value.service;
            if (typeof service !== 'string' || !service.startsWith(entry.info.id + '.') || service.slice(entry.info.id.length+1).includes('.'))
              throw new Error('订阅来源只能公开本插件自己的读取服务');
          }
        }
        requireDependency(String(kind));
        return own(this.options.contributions.add(kind, id, value));
      },
    };
    const events: EventBus = {
      publish: (type, data) => { permission('events.publish'); assertJson(data); return this.options.events.publish(type, data); },
      since: id => { permission('events.read'); return this.options.events.since(id); },
      subscribe: listener => { assertLive(); permission('events.subscribe'); return own(this.options.events.subscribe(listener)); },
    };
    const store: Store = {
      get: (collection, id) => { permission('store.read'); return this.options.store.get(collection, id); },
      list: collection => { permission('store.read'); return this.options.store.list(collection); },
      put: (collection, id, value) => { permission('store.write'); assertJson(value); this.options.store.put(collection, id, value); },
      remove: (collection, id) => { permission('store.write'); return this.options.store.remove(collection, id); },
      transaction: action => { permission('store.write'); return this.options.store.transaction(action); },
      close: () => { throw new Error('Plugins cannot close the shared store'); },
    };
    entry.dispose = async () => {
      live = false;
      const errors: unknown[] = [];
      for (const dispose of disposers.reverse()) {
        try { await dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, `Cleanup failed: ${entry.info.id}`);
    };
    const context: ExtensionContext = {
      id: entry.info.id, dataDir: join(this.options.dataDir, 'plugins', entry.info.id), config: structuredClone(entry.config),
      store, events, contributions,
      ...(this.options.background ? this.options.background.context(entry.info.id, name => { assertLive(); permission(name); }) : {}),
      hook: (name, phase, handler, options = {}) => contributions.add('hooks', `${entry.info.id}:hook:${++this.sequence}`, { name, phase, handler, ...options }),
      provide: (name, handler) => contributions.add('services', `${entry.info.id}:service:${name}`, { name, version: 1, handler }),
      use: async (name, input) => { assertLive(); permission(`service.use:${name}`); requireDependency(name); return this.invocations.use(name, name.startsWith('core.') && input && typeof input === 'object' && !Array.isArray(input) ? { ...input, __owner: entry.info.id } : input); },
      wrap: (name, handler, options = {}) => contributions.add('service_wrappers', `${entry.info.id}:wrap:${++this.sequence}`, { name, handler, ...options }),
      contribute: (kind, id, value) => { contributions.add(kind, id, value); },
      onEvent: listener => { events.subscribe(listener); }, defer: dispose => { own(dispose); },
    };
    try {
      for (const point of entry.extension.extensionPoints ?? []) contributions.definePoint(point);
      await entry.extension.activate(context);
      this.options.background?.ownerEnabled(entry.info.id, true);
      entry.info.status = 'active'; delete entry.info.error;
    } catch (error) {
      this.options.background?.ownerEnabled(entry.info.id,false);
      let message = error instanceof Error ? error.message : String(error);
      try { await entry.dispose(); } catch (cleanup) { message += `; ${String(cleanup)}`; }
      entry.dispose = undefined;
      entry.info.status = 'failed'; entry.info.error = message;
    }
  }

  private async stop(entry: Entry, errors: unknown[]): Promise<void> {
    if (!entry.dispose) return;
    // Dependents release their resources before the dependency disappears.
    for (const dependent of this.entries.values()) {
      if (dependent.extension.dependencies?.includes(entry.info.id)) await this.stop(dependent, errors);
    }
    const dispose = entry.dispose;
    this.options.background?.ownerEnabled(entry.info.id, false);
    entry.dispose = undefined;
    try { await dispose(); entry.info.status = entry.info.enabled ? 'waiting' : 'disabled'; delete entry.info.error; }
    catch (error) { errors.push(error); entry.info.status = 'failed'; entry.info.error = String(error); }
  }
}

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import type { Store } from '../../../plugin-sdk/src/index.ts';
import type { AppConfig, ModelConfig } from '../../../protocol/src/index.ts';

// Only chat-model IDs leave this boundary. Catalog reads never probe a provider or a CLI.
export function readModelCatalog(setting: ModelConfig | undefined, active: { provider: string; id: string } | undefined, demo: boolean) {
  if (!setting) {
    const current = active?.id ?? '';
    return { provider: active?.provider ?? '', current, models: current ? [current] : [], source: 'automatic', demo };
  }
  const { provider, model: current } = setting;
  const builtin = !setting.baseUrl && getBuiltinProviders().find(id => id === provider);
  const registered = builtin ? getBuiltinModels(builtin).map(model => model.id).sort() : [];
  // Include an explicitly configured ID even when it is absent from the SDK catalog.
  const models = [current, ...registered.filter(id => id !== current)];
  return { provider, current, models, source: registered.length ? 'builtin' : 'configured', demo };
}

interface ModelPick { conversationId: string; provider: string; defaultModel: string; model: string; route?: string }
interface RecentModel { route: string; model: string }
const picks = 'conversation.model-picks';
const recentKey = 'recent-custom-models';

// The route identifies the local adapter and upstream without publishing paths, URLs or credentials.
function typedRoute(setting?: ModelConfig): string | undefined {
  if (!setting) return;
  let identity: string[];
  if (setting.provider === 'codex-cli') {
    identity = [setting.provider, setting.cliCommand || 'codex', setting.cliConfigDir || process.env.CODEX_HOME || join(homedir(), '.codex')];
  } else if (setting.baseUrl && ['openai-compatible', 'anthropic'].includes(setting.provider)) {
    const url = URL.parse(setting.baseUrl);
    if (!url || !['http:', 'https:'].includes(url.protocol)) return;
    const endpoint = url.href.replace(/\/+$/, '');
    identity = [setting.provider, setting.provider === 'anthropic' ? endpoint.replace(/\/v1(?:\/messages)?$/, '') : endpoint];
  } else return;
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function validModelId(model: string) {
  return typeof model === 'string' && model.length > 0 && model.length <= 256 &&
    /^~?[a-zA-Z0-9]/.test(model) && !/[^a-zA-Z0-9._/:@\[\]-]/.test(model.replace(/^~/, ''));
}

function matchesDefault(pick: ModelPick, setting?: ModelConfig) {
  return !!setting && setting.provider === pick.provider && setting.model === pick.defaultModel &&
    (pick.route ? pick.route === typedRoute(setting) : !setting.baseUrl);
}

export function discardObsoleteModelPicks(store: Store, setting?: ModelConfig) {
  store.transaction(() => {
    for (const pick of store.list<ModelPick>(picks)) {
      if (!matchesDefault(pick, setting)) store.remove(picks, pick.conversationId);
    }
  });
}

export function conversationModels(config: AppConfig, store: Store, conversationId: string) {
  const recents = () => store.get<RecentModel[]>('settings', recentKey) ?? [];
  function catalog(active?: { provider: string; id: string }): ReturnType<typeof readModelCatalog> & { typed?: boolean; custom?: string[] } {
    const result = readModelCatalog(config.model, active, config.demo);
    const route = typedRoute(config.model);
    const pick = store.get<ModelPick>(picks, conversationId);
    if (pick && matchesDefault(pick, config.model) &&
      (pick.route ? validModelId(pick.model) : result.models.includes(pick.model))) result.current = pick.model;
    if (!route) return result;
    const custom = recents().filter(row => row.route === route && !result.models.includes(row.model)).map(row => row.model);
    return { ...result, typed: true, ...(custom.length ? { custom, models: [...result.models, ...custom] } : {}) };
  }
  return {
    catalog,
    pick(model: string, typed = false, snapshot = catalog()) {
      const route = typedRoute(config.model);
      const canType = typed === true && route && validModelId(model) && !(config.model?.provider === 'codex-cli' && model === 'default');
      if (!snapshot.models.includes(model) && !canType) {
        throw Object.assign(new Error('型号不在目录内或自填型号无效'), { status: 400 });
      }
      if (snapshot.current !== model && config.model) {
        if (model === config.model.model) store.remove(picks, conversationId);
        else store.put<ModelPick>(picks, conversationId, {
          conversationId, provider: config.model.provider, defaultModel: config.model.model, model, ...(route && { route }),
        });
      }
      return { current: model };
    },
    rememberUsed(model: string) {
      const pick = store.get<ModelPick>(picks, conversationId);
      if (config.demo || !pick?.route || pick.model !== model || !matchesDefault(pick, config.model) || !validModelId(model)) return;
      const route = pick.route;
      store.transaction(() => {
        const others = recents().filter(row => row.route !== route || row.model !== model);
        let count = 0;
        const recent = [{ route, model }, ...others].filter(row => row.route !== route || ++count <= 8);
        store.put('settings', recentKey, recent.slice(0, 256));
      });
    },
    forget(model: string) {
      if (!validModelId(model)) throw Object.assign(new Error('自定义型号无效'), { status: 400 });
      const route = typedRoute(config.model);
      if (!route) return { forgotten: false };
      return store.transaction(() => {
        const previous = recents();
        const kept = previous.filter(row => row.route !== route || row.model !== model);
        const forgotten = kept.length !== previous.length;
        if (forgotten) store.put('settings', recentKey, kept);
        return { forgotten };
      });
    },
  };
}

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

interface ModelPick { conversationId: string; provider: string; defaultModel: string; model: string }
const picks = 'conversation.model-picks';

// Multiple candidates exist only on a built-in provider without an overridden endpoint.
function matchesDefault(pick: ModelPick, setting?: ModelConfig) {
  return !!setting && !setting.baseUrl && setting.provider === pick.provider && setting.model === pick.defaultModel;
}

export function discardObsoleteModelPicks(store: Store, setting?: ModelConfig) {
  store.transaction(() => {
    for (const pick of store.list<ModelPick>(picks)) {
      if (!matchesDefault(pick, setting)) store.remove(picks, pick.conversationId);
    }
  });
}

export function conversationModels(config: AppConfig, store: Store, conversationId: string) {
  function catalog(active?: { provider: string; id: string }) {
    const result = readModelCatalog(config.model, active, config.demo);
    const pick = store.get<ModelPick>(picks, conversationId);
    if (pick && matchesDefault(pick, config.model) && result.models.includes(pick.model)) result.current = pick.model;
    return result;
  }
  return {
    catalog,
    pick(model: string, snapshot = catalog()) {
      if (typeof model !== 'string' || !model || !snapshot.models.includes(model)) {
        throw Object.assign(new Error('型号不在当前会话的模型目录内'), { status: 400 });
      }
      if (snapshot.current !== model && config.model) {
        if (model === config.model.model) store.remove(picks, conversationId);
        else store.put<ModelPick>(picks, conversationId, {
          conversationId, provider: config.model.provider, defaultModel: config.model.model, model,
        });
      }
      return { current: model };
    },
  };
}

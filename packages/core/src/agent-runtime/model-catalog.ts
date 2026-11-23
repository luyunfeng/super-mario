import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ModelConfig } from '../../../protocol/src/index.ts';

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

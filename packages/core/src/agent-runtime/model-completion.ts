import type { ImageContent } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import type { AppConfig } from '../../../protocol/src/index.ts';
import type { Store } from '../../../plugin-sdk/src/index.ts';
import { countUse, readRouting, recordFallback, resolvePurpose, type Purpose } from '../model-routing.ts';

/** Also stop promptly when a provider ignores AbortSignal; late answers cannot become results. */
export async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return work();
    }), stopped]);
    if (signal.aborted) throw signal.reason;
    return result;
  } finally { signal.removeEventListener('abort', abort); }
}

/** `purpose` and `store` decide which model this call is given: without them it is the main model. */
/** A limit that is reached. It is the one failure of a completion that is safe to show as it is:
 *  it names the purpose and the count, and nothing of the prompt, the key or the endpoint. */
export class ModelLimitError extends Error { status = 429; }

/** Whether a provider's error says the model asked for is not one it has. It is read from the
 *  status and the code the provider gives, and not from the words of a message: a 404 is the
 *  one answer that means this, and a rate limit or an outage must not be taken for it. */
export function modelNotFound(message: string | undefined): boolean {
  if (!message) return false;
  return /^\s*404\b/.test(message) || /"code"\s*:\s*"(?:model_not_found|model_not_available|not_found_model)"/.test(message);
}

export async function modelCompletion(config: Pick<AppConfig, 'dataDir' | 'model'>, signal: AbortSignal, systemPrompt: string, tokenBudget = 8192, requestImages = false, purpose: Purpose = 'main', store?: Pick<Store, 'get' | 'list' | 'put' | 'remove'>, timeZone = 'Asia/Shanghai'): Promise<(text: string, signal: AbortSignal, images?: ImageContent[]) => Promise<string>> {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  signal.throwIfAborted();
  const dir = join(config.dataDir, 'pi');
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'),
    modelsStorePath: join(dir, 'model-cache.json'), allowModelNetwork: false, signal });
  const setting = config.model;
  // Which model this purpose is given. One with a model of its own uses it; another follows the main model.
  const now = new Date();
  const resolved = store ? resolvePurpose(store, readRouting(store), purpose, setting?.model, now, timeZone) : undefined;
  if (resolved?.blocked) throw new ModelLimitError(resolved.blocked);
  const chosen = resolved?.own ? resolved.model : setting?.model;
  const spare = resolved?.fallback;
  let apiKey = setting?.apiKey;
  if (setting?.provider === 'codex-cli') {
    const { registerCodexProvider } = await import('./codex-provider.ts');
    registerCodexProvider(runtime, chosen!, { command: setting.cliCommand, configDir: setting.cliConfigDir });
  } else if (setting) {
    const { provider, baseUrl } = setting;
    const id = chosen!;
    const endpoint = provider === 'anthropic' ? baseUrl?.replace(/\/v1(?:\/messages)?\/?$/, '') : baseUrl;
    const customAnthropic = provider === 'anthropic' && endpoint && !runtime.getModel(provider, id);
    if (provider === 'openai-compatible' || customAnthropic) {
      runtime.registerProvider(provider, { baseUrl: endpoint, api: customAnthropic ? 'anthropic-messages' : 'openai-completions',
        ...(customAnthropic ? {} : { authHeader: true }), models: [id, ...(spare ? [spare] : [])].map(modelId => ({ id: modelId, name: modelId, reasoning: false, input: requestImages ? ['text', 'image'] : ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: tokenBudget })) });
    } else if (endpoint) runtime.registerProvider(provider, { baseUrl: endpoint });
    if (provider === 'openai-compatible') apiKey ||= process.env.OPENAI_API_KEY;
  }
  const model = setting ? runtime.getModel(setting.provider, chosen!) : (await runtime.getAvailable(undefined, { signal }))[0];
  if (!model) throw new Error('主模型不可用');
  const fallbackModel = spare ? runtime.getModel(setting!.provider, spare) : undefined;
  return async (text, requestSignal, images) => {
    requestSignal.throwIfAborted();
    // Each call is one request, and is counted when it is made. A limit is read again here: the
    // completion is made once and called many times.
    if (store) {
      const at = new Date();
      const allowance = resolvePurpose(store, readRouting(store), purpose, setting?.model, at, timeZone);
      if (allowance.blocked) throw new ModelLimitError(allowance.blocked);
      countUse(store, purpose, at, timeZone);
    }
    if (images?.length && !model.input.includes('image')) throw new Error('主模型不支持图片');
    // Direct completion: no agent session, workspace context, tool loop, or configuration echo.
    const ask = (target: typeof model) => runtime.completeSimple(target, { systemPrompt,
      messages: [{ role: 'user', content: images?.length ? [{ type: 'text', text }, ...images] : text, timestamp: Date.now() }], tools: [] },
    { apiKey, maxTokens: Math.min(tokenBudget, target.maxTokens), reasoning: 'medium', maxRetries: 0, cacheRetention: 'none', signal: requestSignal });
    let reply = await ask(model);
    // The provider says this model is not one it has. Nothing has run but this one request, so
    // asking the spare is safe: it is the one failure a completion retries on another model.
    if (reply.stopReason === 'error' && fallbackModel && modelNotFound(reply.errorMessage)) {
      reply = await ask(fallbackModel);
      if (store && reply.stopReason === 'stop') recordFallback(store, { purpose, from: model.id, to: fallbackModel.id, at: new Date().toISOString(), reason: '供应商没有这个型号' });
    }
    // A length-limited or tool-bearing reply is a failure, even when it includes some usable text.
    if (images?.length && reply.stopReason === 'error' &&
      /(?:image|vision).{0,80}(?:not supported|unsupported|not allowed)|(?:does not support|unsupported).{0,80}(?:image|vision)/i.test(reply.errorMessage ?? ''))
      throw new Error('主模型不支持图片');
    if (reply.stopReason !== 'stop' || reply.content.some(part => part.type === 'toolCall')) throw new Error('主模型未完整返回');
    return reply.content.filter(part => part.type === 'text').map(part => part.text).join('');
  };
}

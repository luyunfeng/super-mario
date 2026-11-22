import { join } from 'node:path';
import type { AppConfig } from '../../../protocol/src/index.ts';

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

export async function modelCompletion(config: Pick<AppConfig, 'dataDir' | 'model'>, signal: AbortSignal, systemPrompt: string, tokenBudget = 8192): Promise<(text: string, signal: AbortSignal) => Promise<string>> {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  signal.throwIfAborted();
  const dir = join(config.dataDir, 'pi');
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'),
    modelsStorePath: join(dir, 'model-cache.json'), allowModelNetwork: false, signal });
  const setting = config.model;
  let apiKey = setting?.apiKey;
  if (setting?.provider === 'codex-cli') {
    const { registerCodexProvider } = await import('./codex-provider.ts');
    registerCodexProvider(runtime, setting.model, { command: setting.cliCommand, configDir: setting.cliConfigDir });
  } else if (setting) {
    const { provider, model: id, baseUrl } = setting;
    const endpoint = provider === 'anthropic' ? baseUrl?.replace(/\/v1(?:\/messages)?\/?$/, '') : baseUrl;
    const customAnthropic = provider === 'anthropic' && endpoint && !runtime.getModel(provider, id);
    if (provider === 'openai-compatible' || customAnthropic) {
      runtime.registerProvider(provider, { baseUrl: endpoint, api: customAnthropic ? 'anthropic-messages' : 'openai-completions',
        ...(customAnthropic ? {} : { authHeader: true }), models: [{ id, name: id, reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: tokenBudget }] });
    } else if (endpoint) runtime.registerProvider(provider, { baseUrl: endpoint });
    if (provider === 'openai-compatible') apiKey ||= process.env.OPENAI_API_KEY;
  }
  const model = setting ? runtime.getModel(setting.provider, setting.model) : (await runtime.getAvailable(undefined, { signal }))[0];
  if (!model) throw new Error('主模型不可用');
  return async (text, requestSignal) => {
    requestSignal.throwIfAborted();
    // Direct completion: no agent session, workspace context, tool loop, or configuration echo.
    const reply = await runtime.completeSimple(model, { systemPrompt,
      messages: [{ role: 'user', content: text, timestamp: Date.now() }], tools: [] },
    { apiKey, maxTokens: Math.min(tokenBudget, model.maxTokens), reasoning: 'medium', maxRetries: 0, cacheRetention: 'none', signal: requestSignal });
    // A length-limited or tool-bearing reply is a failure, even when it includes some usable text.
    if (reply.stopReason !== 'stop' || reply.content.some(part => part.type === 'toolCall')) throw new Error('主模型未完整返回');
    return reply.content.filter(part => part.type === 'text').map(part => part.text).join('');
  };
}

import { assertJson } from '../../plugin-sdk/src/index.ts';
import type { Contributions, HookName, HookPhase, InvocationOptions, PluginHookHandler, ServiceHandler, ServiceWrapper } from '../../plugin-sdk/src/index.ts';
import type { Json } from '../../protocol/src/index.ts';
export class PluginCallError extends Error {
  delivery: 'no' | 'unknown';
  constructor(message: string, completed = false) { super(message); this.delivery = completed ? 'unknown' : 'no'; }
}
const names = new Set<HookName>(['work.dispatch', 'channel.send', 'knowledge.put']);
export function validateInvocationOptions(options: InvocationOptions, maxTimeout = 30000) {
  if (options.order !== undefined && (!Number.isSafeInteger(options.order) || Math.abs(options.order) > 10000)) throw new TypeError('Hook order must be an integer between -10000 and 10000');
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > maxTimeout)) throw new TypeError(`timeoutMs must be 1–${maxTimeout}`);
}
/** One sequential, bounded pipeline. Before failures deny execution; after failures report unknown, never replay. */
export function createPluginInvocations(contributions: Contributions) {
  async function bounded<T>(call: (signal: AbortSignal) => Promise<T> | T, options: InvocationOptions, label: string, parent?: AbortSignal, maxTimeout = 30000): Promise<T> {
    validateInvocationOptions(options, maxTimeout);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = Object.assign(new Error(`${label} cancelled`), { code: 'CANCELLED' });
    let cancel = () => controller.abort();
    const abort = new Promise<never>((_, reject) => { cancel = () => { controller.abort(); reject(cancelled); }; });
    if (parent?.aborted) throw cancelled;
    parent?.addEventListener('abort', cancel, { once: true });
    try {
      return await Promise.race([abort, Promise.resolve().then(() => call(controller.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error(`${label} timed out`)); }, options.timeoutMs ?? 5000);
      })]);
    } finally { if (timer) clearTimeout(timer); parent?.removeEventListener('abort', cancel); controller.abort(); }
  }
  async function hooks(name: HookName, phase: HookPhase, original: Json): Promise<Json> {
    if (!names.has(name)) throw new TypeError('Unknown hook name');
    assertJson(original); let value = structuredClone(original);
    const entries = contributions.list('hooks').filter(item => item.value.name === name && item.value.phase === phase).sort((a,b)=>(a.value.order ?? 0)-(b.value.order ?? 0));
    for (const entry of entries) {
      // A provider disabled while awaiting an earlier hook cannot execute through a stale list.
      if (!contributions.list('hooks').some(item => item.id === entry.id && item.value === entry.value)) continue;
      try {
        const decision = await bounded(signal => entry.value.handler(structuredClone(value), signal), entry.value, `Hook ${entry.id}`);
        if (decision === undefined) continue;
        assertJson(decision);
        if (decision.action === 'deny') throw new Error(decision.reason || 'Plugin denied action');
        if (decision.action !== 'continue') throw new Error('Invalid hook decision');
        if (decision.value !== undefined) value = structuredClone(decision.value);
      } catch (error) { throw new PluginCallError(`${phase} ${name}: ${error instanceof Error ? error.message : String(error)}`, phase === 'after'); }
    }
    return value;
  }
  async function invoke(name: HookName, input: Json, action: (input: Json) => Promise<Json>): Promise<Json> {
    const prepared = await hooks(name, 'before', input);
    const result = await action(prepared); assertJson(result);
    return hooks(name, 'after', result);
  }
  async function use(name: string, input: Json, request: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Json> {
    assertJson(input);
    const service = contributions.list('services').find(item => item.value.name === name);
    if (!service) throw new Error(`Service unavailable: ${name}`);
    const wrappers = contributions.list('service_wrappers').filter(item => item.value.name === name).sort((a,b)=>(a.value.order ?? 0)-(b.value.order ?? 0));
    let invoke: (input: Json) => Promise<Json> = async value => {
      assertJson(value);
      if (!contributions.list('services').some(item => item.value === service.value)) throw new Error(`Service stopped: ${name}`);
      const result = await bounded(signal => service.value.handler(structuredClone(value), signal), { timeoutMs: request.timeoutMs }, `Service ${name}`, request.signal, 120000);
      assertJson(result); return structuredClone(result);
    };
    for (const item of wrappers.reverse()) {
      const next = invoke;
      invoke = async value => {
        assertJson(value);
        if (!contributions.list('service_wrappers').some(entry => entry.value === item.value)) return next(value);
        let called = false;
        const result = await bounded(signal => item.value.handler(structuredClone(value), async forwarded => {
          if (signal.aborted || called) throw new Error('Wrapper next() may run only once before timeout'); called = true;
          assertJson(forwarded); return next(forwarded);
        }, signal), item.value, `Wrapper ${item.id}`, request.signal);
        assertJson(result); return structuredClone(result);
      };
    }
    return invoke(input);
  }
  return { invoke, use, hooks };
}

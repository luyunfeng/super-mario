import type { Message } from '../../../packages/protocol/src/index.ts';

interface State { latest: Message; platformId?: string; task?: Promise<void>; dirty: boolean; failed: boolean; final: boolean; lastWrite: number; wake?: () => void }
/** Serial and coalescing: uncertain creation/updates stop a turn's stream.
 * Callers retain their normal final-text path when a card cannot be finalized.
 */
export function createAgentProgressStream(options: {
  create(message: Message): Promise<string>; patch(id: string, message: Message): Promise<void>;
  valid(message: Message): boolean; failed?(message: Message, error: unknown): void; intervalMs?: number; firstProgressMs?: number;
}) {
  const streams = new Map<string, State>(); let closed = false;
  const final = (message: Message) => ['done', 'failed'].includes(message.status ?? '');
  const delegating = (m: Message) => ['work_dispatch', 'bot_handoff'].includes(m.progress?.toolName ?? '');
  async function drain(state: State) {
    try {
      // Give short answers a single ordinary reply. A handoff wakes this delay immediately.
      if (!state.platformId && !state.lastWrite && !final(state.latest) && !delegating(state.latest)) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { state.wake = undefined; resolve(); }, options.firstProgressMs ?? 5000);
          state.wake = () => { clearTimeout(timer); state.wake = undefined; resolve(); };
        });
        if (final(state.latest)) { state.dirty = false; state.failed = true; return; }
      }
      while (state.dirty && !state.failed && !state.final && !closed) {
        if (state.platformId && !final(state.latest)) {
          const delay = (options.intervalMs ?? 1000) - (Date.now() - state.lastWrite);
          if (delay > 0) await new Promise<void>(resolve => {
            const timer = setTimeout(() => { state.wake = undefined; resolve(); }, delay);
            state.wake = () => { clearTimeout(timer); state.wake = undefined; resolve(); };
          });
        }
        if (closed || !options.valid(state.latest)) { state.failed = true; break; }
        const message = structuredClone(state.latest); state.dirty = false;
        if (!state.platformId) state.platformId = await options.create(message);
        else await options.patch(state.platformId, message);
        if (!state.platformId) throw new Error('进度卡片没有返回消息标识');
        state.lastWrite = Date.now(); state.final = final(message);
      }
    } catch (error) { state.failed = true; options.failed?.(state.latest, error); }
  }
  function start(state: State) {
    if (state.task) return;
    state.task = drain(state).finally(() => {
      state.task = undefined;
      if (!closed && state.dirty && !state.failed && !state.final) start(state);
    });
  }
  return {
    async update(message: Message): Promise<boolean> {
      if (closed || !message.progress || !options.valid(message)) return false;
      let state = streams.get(message.id);
      if (!state) {
        if (final(message)) return false;
        state = { latest: structuredClone(message), dirty: true, failed: false, final: false, lastWrite: 0 }; streams.set(message.id, state);
        if (streams.size > 128) for (const [id, old] of streams) if (old !== state && !old.task && (old.failed || old.final)) { streams.delete(id); break; }
      } else {
        if (state.failed) return false;
        if (state.final) return true;
        state.latest = structuredClone(message); state.dirty = true;
      }
      if (final(message) || delegating(message)) state.wake?.();
      start(state);
      if (!final(message)) return false;
      while (!closed && !state.failed && !state.final && (state.task || state.dirty)) { start(state); await state.task; }
      return state.final && !state.failed;
    },
    async close() { closed = true; for (const state of streams.values()) state.wake?.(); await Promise.allSettled([...streams.values()].map(state => state.task)); streams.clear(); },
  };
}

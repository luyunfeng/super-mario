import type { EventBus, MachineClient, Store } from '../../plugin-sdk/src/index.ts';
import type { ExecutionResult, Run } from '../../protocol/src/index.ts';
import { executionProgress } from './execution-progress.ts';

/** Poll only native result records. Terminal activity is never completion evidence. */
export function createRunMonitor(options: { store: Store; events: EventBus; machines: () => MachineClient | undefined; onResult: (run: Run, result: ExecutionResult) => void }) {
  let closed = false;
  let pending: Promise<void> | undefined;
  async function inspect() {
    const machines = options.machines();
    if (!machines || closed) return;
    for (const run of options.store.list<Run>('runs')) {
      if (closed) return;
      if (!run.machineId || !run.sessionId || run.executionMode !== 'task' || !['running', 'unknown'].includes(run.status)) continue;
      const machine = machines.list().find(item => item.id === run.machineId);
      if (!machine?.online || !machine.capabilities.includes('executor.result')) continue;
      try {
        const raw = await machines.call(run.machineId, 'executor.result', { sessionId: run.sessionId });
        if (closed || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const result = raw as unknown as ExecutionResult;
        if (!['running', 'completed', 'failed', 'unknown'].includes(result.state) || typeof result.text !== 'string' || typeof result.source !== 'string') continue;
        let current = options.store.get<Run>('runs', run.id);
        if (!current || !['running', 'unknown'].includes(current.status)) continue;
        if (result.nativeSessionId !== undefined && (typeof result.nativeSessionId !== 'string' || result.nativeSessionId.length > 512 || /[\s\p{Cc}]/u.test(result.nativeSessionId))) continue;
        // Old task agents supplied explicit parser sources before capability declarations existed.
        // Keep those outcomes readable, without fabricating a declaration or native progress support.
        const trustedSource = !['screen', 'text', 'runner', 'demo', 'unknown', 'idle', 'terminal-idle'].includes(result.source.trim().toLowerCase())
          && (current.nativeResultSources !== undefined
            ? current.nativeResultSources.includes(result.source)
            : !current.nativeResume && ['codex-json', 'claude-result', 'claude-stream-json'].includes(result.source));
        const pinnedSessionId = current.nativeResume?.nativeSessionId ?? current.nativeSessionId;
        const matchingThread = !pinnedSessionId || result.nativeSessionId === pinnedSessionId;
        // Validate before *any* evidence is persisted, including output and provenance.
        if (!trustedSource || !matchingThread) {
          if (result.state === 'completed' && current.nativeResume
            && (current.status !== 'unknown' || current.error !== '恢复结果缺少匹配的原生线程证据')) {
            options.store.put('runs', run.id, { ...current, status: 'unknown', error: '恢复结果缺少匹配的原生线程证据', updatedAt: new Date().toISOString() });
            options.events.publish('runs.changed', { id: run.id });
          }
          continue;
        }
        const progress = executionProgress(result.progress);
        if (progress && current.nativeResultSources?.includes(result.source)
          && JSON.stringify(progress) !== JSON.stringify(current.progress)) {
          current = { ...current, progress, resultSource: result.source, updatedAt: new Date().toISOString() };
          options.store.put('runs', run.id, current); options.events.publish('runs.changed', { id: run.id });
        }
        // Thread identity/progress may arrive before the outcome; it is not a completion signal.
        if (result.nativeSessionId && current.nativeSessionId !== result.nativeSessionId) {
          current = { ...current, nativeSessionId: result.nativeSessionId, resultSource: result.source, updatedAt: new Date().toISOString() };
          options.store.put('runs', run.id, current); options.events.publish('runs.changed', { id: run.id });
        }
        if (result.state === 'running') {
          if (result.text && result.text !== current.output) {
            options.store.put('runs', run.id, { ...current, output: result.text, resultSource: result.source, updatedAt: new Date().toISOString() });
            options.events.publish('runs.changed', { id: run.id });
          }
          continue;
        }
        if (result.state === 'unknown') {
          if (current.status !== 'unknown' || current.error !== result.text || current.resultSource !== result.source) {
            options.store.put('runs', run.id, { ...current, status: 'unknown', error: result.text, resultSource: result.source, updatedAt: new Date().toISOString() });
            options.events.publish('runs.changed', { id: run.id });
          }
          continue;
        }
        options.onResult(current, result);
      } catch { /* Read failures may be retried; never replay a launch or terminal input. */ }
    }
  }
  function poll() {
    if (!pending && !closed) pending = inspect().finally(() => { pending = undefined; });
    return pending ?? Promise.resolve();
  }
  const timer = setInterval(() => { void poll(); }, 1000); timer.unref();
  return { poll, async close() { closed = true; clearInterval(timer); await pending; } };
}

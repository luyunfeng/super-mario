import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { ExecutionProgress, ExecutionResult } from '../packages/protocol/src/index.ts';

export interface TaskConfig {
  prompt: string;
  cwd: string;
  executorId: 'codex' | 'claude-code';
  resultsPath: string;
  nativeSessionId?: string;
  /** Trusted local launcher snapshot; never supplied through executor RPC parameters. */
  launcher?: { command: string; profile?: { configDir: string } };
}
interface StoredResult extends ExecutionResult { runnerPid?: number }

// Tool identifiers are useful; commands, inputs, output and model text may contain secrets.
function progressToolName(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]+$/.test(value) ? value.slice(0, 80) : fallback;
}

/** Atomic replacement keeps RPC readers from observing half-written JSON. */
export function saveTaskResult(path: string, result: ExecutionResult, runnerPid?: number): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ ...result, ...(runnerPid ? { runnerPid } : {}) }), { mode: 0o600 });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export function readTaskResult(path: string): ExecutionResult {
  if (!existsSync(path)) return { state: 'unknown', text: 'Task runner has not recorded a result', source: 'runner' };
  const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredResult;
  if (!['running', 'completed', 'failed', 'unknown'].includes(stored.state) || typeof stored.text !== 'string' || typeof stored.source !== 'string') throw new Error('Invalid task result');
  const { runnerPid, ...result } = stored;
  if (result.state === 'running') {
    // A killed runner cannot publish an exit record. Never infer success from its disappearance.
    if (!Number.isInteger(runnerPid) || runnerPid! <= 0) return { ...result, state: 'unknown' };
    try { process.kill(runnerPid!, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { ...result, state: 'unknown' };
    }
  }
  return result;
}

/** Only documented terminal events count as task outcome evidence; screen text does not. */
export function createNativeCollector(executorId: TaskConfig['executorId'], expectedNativeSessionId?: string) {
  let text = '';
  let nativeSessionId: string | undefined;
  let sessionMismatch = false;
  let progress: ExecutionProgress | undefined;
  const observeProgress = (next: Omit<ExecutionProgress, 'observedAt'>) => {
    // Persist semantic changes only. Replayed events and reads must not refresh liveness.
    if (progress?.phase === next.phase && progress.toolName === next.toolName && progress.detail === next.detail) return;
    progress = { ...next, observedAt: new Date().toISOString() };
  };
  const observeSession = (id: string) => {
    nativeSessionId = id;
    if (expectedNativeSessionId !== undefined && id !== expectedNativeSessionId) sessionMismatch = true;
  };
  let outcome: 'completed' | 'failed' | undefined;
  return {
    event(value: unknown) {
      if (!value || typeof value !== 'object') return;
      const event = value as Record<string, unknown>;
      if (executorId === 'codex') {
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          observeSession(event.thread_id);
          observeProgress({ phase: 'starting', detail: '原生线程已启动' });
        }
        if (event.type === 'turn.started') observeProgress({ phase: 'thinking', detail: '原生回合已开始' });
        // codex exec --json emits item lifecycle events, not terminal-idle signals.
        // https://developers.openai.com/codex/noninteractive
        if (['item.started', 'item.updated', 'item.completed'].includes(event.type as string) && event.item && typeof event.item === 'object') {
          const item = event.item as Record<string, unknown>;
          const lifecycle = event.type === 'item.started' ? '开始' : event.type === 'item.updated' ? '更新' : '结束';
          if (item.type === 'reasoning') observeProgress({ phase: 'thinking', detail: `推理事件${lifecycle}` });
          if (item.type === 'agent_message') observeProgress({ phase: 'responding', detail: `回应事件${lifecycle}` });
          if (item.type === 'command_execution' || item.type === 'mcp_tool_call' || item.type === 'file_change' || item.type === 'web_search') {
            observeProgress({ phase: 'tool', toolName: item.type === 'mcp_tool_call' ? progressToolName(item.tool, item.type) : item.type,
              detail: `工具事件${lifecycle}` });
          }
          if (item.type === 'todo_list') observeProgress({ phase: 'thinking', detail: `计划事件${lifecycle}` });
        }
        if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
          const item = event.item as Record<string, unknown>;
          if (item.type === 'agent_message' && typeof item.text === 'string') text = item.text;
        }
        if (event.type === 'turn.completed') outcome = 'completed';
        if (event.type === 'turn.failed') { outcome = 'failed'; text ||= JSON.stringify(event.error ?? 'Codex turn failed'); }
      } else {
        if (typeof event.session_id === 'string') observeSession(event.session_id);
        // Claude emits complete assistant message.content blocks without partial-message flags.
        // https://code.claude.com/docs/en/headless (stream responses / session metadata)
        if (event.type === 'system' && event.subtype === 'init') observeProgress({ phase: 'starting', detail: '原生会话已初始化' });
        if (event.type === 'assistant' && event.message && typeof event.message === 'object') {
          const message = event.message as Record<string, unknown>;
          let next: Omit<ExecutionProgress, 'observedAt'> | undefined;
          if (Array.isArray(message.content)) for (const value of message.content) {
            if (!value || typeof value !== 'object') continue;
            const block = value as Record<string, unknown>;
            if (block.type === 'tool_use' && typeof block.name === 'string') next = { phase: 'tool', toolName: progressToolName(block.name, 'tool_use'), detail: '原生工具调用' };
            if (block.type === 'text' && typeof block.text === 'string') next = { phase: 'responding', detail: '原生回应' };
            if (block.type === 'thinking' && typeof block.thinking === 'string') next = { phase: 'thinking', detail: '原生推理' };
          }
          // Choose once per message: replaying mixed blocks must not churn observedAt.
          if (next) observeProgress(next);
        }
        // No permission/wait event is assumed for either non-interactive CLI. Text and
        // tool failures cannot establish waiting, completion, or business acceptance.
        if (event.type === 'result') {
          outcome = event.subtype === 'success' && event.is_error === false ? 'completed' : 'failed';
          if (typeof event.result === 'string') text = event.result;
          else if (Array.isArray(event.errors)) text = event.errors.join('\n');
        }
      }
    },
    result(exitCode?: number, signal?: string | null): ExecutionResult {
      let state: ExecutionResult['state'] = signal ? 'unknown' : exitCode !== undefined && exitCode !== 0 ? 'failed'
        : outcome === 'failed' ? 'failed' : exitCode === 0 && outcome === 'completed' ? 'completed'
          : exitCode === undefined ? 'running' : 'unknown';
      // A requested ID is not evidence: the native event stream must confirm it.
      const missingIdentity = state === 'completed' && expectedNativeSessionId !== undefined && nativeSessionId !== expectedNativeSessionId;
      if (missingIdentity) state = 'unknown';
      // Conflicting identity is a permanent failure, even before exit or after a signal.
      if (sessionMismatch) state = 'failed';
      return { state, text: sessionMismatch ? `原生恢复返回了不同的线程；未自动重试。\n${text}` : missingIdentity ? `原生恢复缺少匹配的线程证据，结果未知。\n${text}` : text, source: executorId === 'codex' ? 'codex-json' : 'claude-stream-json',
        ...(exitCode !== undefined ? { exitCode } : {}), ...(nativeSessionId ? { nativeSessionId } : {}), ...(progress ? { progress: { ...progress } } : {}) };
    },
  };
}

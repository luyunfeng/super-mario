import { buildNativeResumeCommand } from './session-resume.ts';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeCollector, saveTaskResult } from './task-results.ts';
import type { TaskConfig } from './task-results.ts';

// Validate local persisted configuration before spawning or recording a result.
// Deliberately accepts only a command and a config directory, never arbitrary argv/env.
export function validateTaskLauncher(value: unknown): NonNullable<TaskConfig['launcher']> {
  const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !/[\x00-\x1f\x7f]/.test(v);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid launcher');
  const spec = value as Record<string, unknown>;
  if (Object.keys(spec).some(k => !['command', 'profile'].includes(k)) || !text(spec.command) ||
      spec.command.startsWith('-') || (!isAbsolute(spec.command) && !/^[a-zA-Z0-9_.+-]+$/.test(spec.command))) throw new Error('Invalid launcher command');
  if (spec.profile === undefined) return { command: spec.command };
  if (!spec.profile || typeof spec.profile !== 'object' || Array.isArray(spec.profile)) throw new Error('Invalid launcher profile');
  const profile = spec.profile as Record<string, unknown>;
  if (Object.keys(profile).some(k => k !== 'configDir') || !text(profile.configDir) || !isAbsolute(profile.configDir)) throw new Error('Invalid launcher profile');
  return { command: spec.command, profile: { configDir: profile.configDir } };
}

export async function runTask(config: TaskConfig): Promise<number> {
  if (!config || typeof config !== 'object' || !['codex', 'claude-code', 'pi'].includes(config.executorId) ||
      typeof config.prompt !== 'string' || !config.prompt.trim() || config.prompt.includes('\0') ||
      typeof config.cwd !== 'string' || !isAbsolute(config.cwd) || config.cwd.includes('\0') ||
      typeof config.resultsPath !== 'string' || !isAbsolute(config.resultsPath) || config.resultsPath.includes('\0')) throw new Error('Invalid task config');
  const pi = config.executorId === 'pi';
  if (pi && config.nativeSessionId !== undefined) throw new Error('Pi task resume is unsupported');
  const launcher = config.launcher === undefined ? undefined : validateTaskLauncher(config.launcher);
  const collector = createNativeCollector(config.executorId, config.nativeSessionId);
  let finished = false;
  let malformed = false;
  const persist = (code?: number, signal?: string | null, error?: string) => {
    const result = collector.result(code, signal);
    if (pi && result.state === 'completed' && malformed) {
      result.state = 'unknown';
      result.text = 'Incomplete or malformed pi JSONL stream';
    }
    if (error) { result.state = 'failed'; result.text = error; }
    if (pi && code && !result.text) result.text = `pi exited with code ${code}`;
    saveTaskResult(config.resultsPath, result, process.pid);
  };
  persist();
  const resume = config.nativeSessionId !== undefined ? buildNativeResumeCommand({ ...config, nativeSessionId: config.nativeSessionId, mode: 'task' }) : undefined;
  const command = launcher?.command ?? resume?.command ?? (pi ? 'pi' : config.executorId === 'codex' ? 'codex' : 'claude');
  const args = resume?.args ?? (pi ? ['--mode', 'json'] : config.executorId === 'codex'
    ? ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--output-last-message', `${config.resultsPath}.last-message`, '--', config.prompt]
    : ['-p', '--output-format', 'stream-json', '--verbose', '--', config.prompt]);
  // No shell, approval bypass, or automatic retry. All CLI output remains visible in the PTY.
  const env = { ...process.env };
  if (launcher?.profile) env[pi ? 'PI_CODING_AGENT_DIR' : config.executorId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = launcher.profile.configDir;
  const child = spawn(command, args, { cwd: config.cwd, env, stdio: [pi ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(process.stdout, { end: false });
  child.stderr!.pipe(process.stderr, { end: false });
  let inputError: Error | undefined;
  if (pi) {
    // Even after --, Pi interprets an @-prefixed positional argument as a file.
    child.stdin!.on('error', error => { inputError = error; });
    child.stdin!.end(config.prompt);
  }
  const onLine = (line: string) => {
    try {
      const event = JSON.parse(line);
      // Deltas can arrive per token. Persist the authoritative message at message_end.
      if (pi && event?.type === 'message_update') return;
      collector.event(event);
    } catch { malformed = true; return; }
    persist();
    const observed = collector.result();
    if (config.nativeSessionId && observed.nativeSessionId && observed.nativeSessionId !== config.nativeSessionId) child.kill('SIGTERM');
  };
  if (pi) {
    let pending = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      const records = (pending + chunk).split('\n');
      pending = records.pop()!;
      for (const line of records) onLine(line);
    }).on('end', () => { if (pending) malformed = true; });
  } else createInterface({ input: child.stdout!, crlfDelay: Infinity }).on('line', onLine);
  const onExit = () => { if (!finished) persist(undefined, 'runner-exit'); };
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted = signal;
    persist(undefined, signal);
    child.kill(signal);
  };
  const onTerm = () => onSignal('SIGTERM');
  const onInt = () => onSignal('SIGINT');
  process.on('exit', onExit);
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  return await new Promise<number>(resolve => {
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    // close follows drained stdout, so the final JSON event is included before finalization.
    child.on('close', (code, signal) => {
      finished = true;
      persist(code ?? undefined, interrupted ?? signal, spawnError?.message ?? (interrupted || signal ? undefined : inputError?.message));
      process.removeListener('exit', onExit);
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onInt);
      resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as TaskConfig;
    process.exitCode = await runTask(config);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

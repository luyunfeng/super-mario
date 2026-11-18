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
  if (!config || typeof config !== 'object' || !['codex', 'claude-code'].includes(config.executorId) ||
      typeof config.prompt !== 'string' || !config.prompt.trim() || config.prompt.includes('\0') ||
      typeof config.cwd !== 'string' || !isAbsolute(config.cwd) || config.cwd.includes('\0') ||
      typeof config.resultsPath !== 'string' || !isAbsolute(config.resultsPath) || config.resultsPath.includes('\0')) throw new Error('Invalid task config');
  const launcher = config.launcher === undefined ? undefined : validateTaskLauncher(config.launcher);
  const collector = createNativeCollector(config.executorId, config.nativeSessionId);
  let finished = false;
  const persist = (code?: number, signal?: string | null, error?: string) => {
    const result = collector.result(code, signal);
    if (error) { result.state = 'failed'; result.text ||= error; }
    saveTaskResult(config.resultsPath, result, process.pid);
  };
  persist();
  const resume = config.nativeSessionId !== undefined ? buildNativeResumeCommand({ ...config, nativeSessionId: config.nativeSessionId, mode: 'task' }) : undefined;
  const command = launcher?.command ?? resume?.command ?? (config.executorId === 'codex' ? 'codex' : 'claude');
  const args = resume?.args ?? (config.executorId === 'codex'
    ? ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--output-last-message', `${config.resultsPath}.last-message`, '--', config.prompt]
    : ['-p', '--output-format', 'stream-json', '--verbose', '--', config.prompt]);
  // No shell, approval bypass, or automatic retry. All CLI output remains visible in the PTY.
  const env = { ...process.env };
  if (launcher?.profile) env[config.executorId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = launcher.profile.configDir;
  const child = spawn(command, args, { cwd: config.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    try { collector.event(JSON.parse(line)); } catch { return; }
    persist();
    const observed = collector.result();
    if (config.nativeSessionId && observed.nativeSessionId && observed.nativeSessionId !== config.nativeSessionId) child.kill('SIGTERM');
  });
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
      persist(code ?? undefined, interrupted ?? signal, spawnError?.message);
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

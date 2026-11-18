import { isAbsolute } from 'node:path';
import type { NativeExecutorId } from '../packages/protocol/src/index.ts';

export function validateNativeSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 512 || /^[-]/.test(value) || /[\s\p{Cc}]/u.test(value)) {
    throw new Error('Invalid nativeSessionId: expected at most 512 characters without whitespace, control characters, or a leading dash');
  }
}

/** Construct argv only. Callers own discovery, availability checks, and process launch. */
export function buildNativeResumeCommand(input: {
  executorId: NativeExecutorId;
  nativeSessionId: string;
  mode: 'task' | 'interactive';
  prompt: string;
  cwd: string;
  resultsPath?: string;
}): { command: string; args: string[] } {
  if (input.executorId !== 'codex' && input.executorId !== 'claude-code') throw new Error('Invalid executorId');
  validateNativeSessionId(input.nativeSessionId);
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || input.cwd.includes('\0')) throw new Error('cwd must be absolute and contain no NUL');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.includes('\0')) throw new Error('prompt must not be empty or contain NUL');
  if (input.mode !== 'task' && input.mode !== 'interactive') throw new Error('Invalid resume mode');
  const { nativeSessionId: id, prompt } = input;
  if (input.executorId === 'claude-code') {
    return { command: 'claude', args: ['--resume', id,
      ...(input.mode === 'task' ? ['-p', '--output-format', 'stream-json', '--verbose'] : []), '--', prompt] };
  }
  if (input.mode === 'interactive') return { command: 'codex', args: ['resume', '--', id, prompt] };
  if (typeof input.resultsPath !== 'string' || !input.resultsPath.trim() || input.resultsPath.includes('\0')) throw new Error('Task resume requires resultsPath without NUL');
  return { command: 'codex', args: ['--sandbox', 'workspace-write', 'exec', 'resume', '--json',
    '--skip-git-repo-check', '--output-last-message', `${input.resultsPath}.last-message`, '--', id, prompt] };
}

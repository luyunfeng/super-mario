import { execFile } from 'node:child_process';
import type { ChildProcess, ExecFileOptions } from 'node:child_process';

export interface PersonalReplyInput {
  profile: string;
  messageId: string;
  text: string;
  key: string;
  signal?: AbortSignal;
}

/** Trusted test seam only. Never expose this runner or identity selection to model tools. */
export type PersonalReplyCLI = (
  file: string, args: string[], options: ExecFileOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => ChildProcess;

export class PersonalReplyError extends Error {
  readonly delivery: 'no' | 'unknown';
  constructor(delivery: 'no' | 'unknown') {
    super(delivery === 'no' ? '飞书个人回复未发送。' : '飞书个人回复结果不确定，请核实消息记录。');
    this.name = 'PersonalReplyError';
    this.delivery = delivery;
  }
}

const messageID = /^om_[A-Za-z0-9_-]+$/;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Caller must resolve the verified identity, approve exact content, and reserve the effect key first.
 * Importing this module or reading a session never sends a reply. No retries or logging here.
 */
export async function replyAsPersonalUser(
  input: PersonalReplyInput,
  runCLI: PersonalReplyCLI = execFile as PersonalReplyCLI,
): Promise<{ messageId: string }> {
  if (!input || typeof input.profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.profile)
    || typeof input.messageId !== 'string' || !messageID.test(input.messageId)
    || typeof input.key !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(input.key)
    || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20_000) {
    throw new PersonalReplyError('no');
  }
  if (input.signal?.aborted) throw new PersonalReplyError('unknown');
  const args = ['--profile', input.profile, 'im', '+messages-reply', '--message-id', input.messageId,
    '--text', input.text, '--idempotency-key', input.key, '--as', 'user', '--format', 'json'];
  return new Promise((resolve, reject) => {
    let interrupted = false;
    let completed = false;
    let failure: Error | null = null;
    let output = '';
    let diagnostic = '';
    let child: ChildProcess;
    const abort = () => { interrupted = true; child.kill('SIGKILL'); };
    try {
      child = runCLI('lark-cli', args, {
        shell: false, encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL',
      }, (error, stdout, stderr) => { completed = true; failure = error; output = stdout; diagnostic = stderr; });
    } catch (error) {
      reject(new PersonalReplyError(record(error).code === 'ENOENT' ? 'no' : 'unknown'));
      return;
    }
    child.once('error', error => { failure = error; });
    child.once('close', (code, signal) => {
      input.signal?.removeEventListener('abort', abort);
      if (interrupted || signal || record(failure).killed || record(failure).code === 'ETIMEDOUT' || record(failure).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { reject(new PersonalReplyError('unknown')); return; }
      if (record(failure).code === 'ENOENT') { reject(new PersonalReplyError('no')); return; }
      if (!completed || Buffer.byteLength(output) > 64 * 1024 || Buffer.byteLength(diagnostic) > 64 * 1024) { reject(new PersonalReplyError('unknown')); return; }
      let raw: Record<string, unknown>;
      try { raw = record(JSON.parse(output.trim() ? output : diagnostic)); }
      catch { reject(new PersonalReplyError('unknown')); return; }
      const data = record(raw.data);
      const ids = [data.message_id, record(data.message).message_id];
      const id = ids.find(value => typeof value === 'string' && messageID.test(value));
      if (!failure && code === 0 && raw.ok !== false && typeof id === 'string') {
        resolve({ messageId: id }); return;
      }
      // Only explicit structured denials count as unsent; contradictory success evidence wins.
      const error = record(raw.error);
      const denied = ['permission_denied', 'missing_scope', 'forbidden', 'unauthorized', 'authentication_required', 'token_expired'];
      const transportFailure = typeof record(failure).code === 'string';
      const refusal = !transportFailure && !(output.trim() && diagnostic.trim()) && raw.ok === false && denied.includes(String(error.subtype ?? error.type ?? error.code))
        && !ids.some(value => value !== undefined && value !== null && value !== '');
      reject(new PersonalReplyError(refusal ? 'no' : 'unknown'));
    });
    // No interactive auth/input. Abort resolution deliberately waits for close, not the error event.
    child.stdin?.on('error', () => { /* Completion is classified only after close. */ });
    child.stdin?.end();
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
  });
}

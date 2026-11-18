import { spawn } from 'node:child_process';
import { CODEX_MODEL_CONFIG, codexConfigArgs, codexModelConfig } from '../../../protocol/src/codex-model-policy.ts';

/** Config-only app-server: never creates a thread or model turn; never returns config secrets. */
export async function readCodexModelConfig(command: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Codex configuration preflight aborted.');
  return new Promise<ReturnType<typeof codexModelConfig>>((resolve, reject) => {
    const child = spawn(command, ['app-server', '--stdio', ...codexConfigArgs(CODEX_MODEL_CONFIG)], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let buffer = '', bytes = 0, done = false;
    let config: ReturnType<typeof codexModelConfig> | undefined;
    let failure = 'Codex configuration preflight failed.';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (force: boolean) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        else child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch { /* Already exited. */ }
    };
    const stop = () => {
      if (done) return;
      done = true; kill(false); killTimer = setTimeout(() => kill(true), 500);
    };
    const abort = () => { failure = 'Codex configuration preflight aborted.'; config = undefined; stop(); };
    const timeout = setTimeout(() => { failure = 'Codex configuration preflight timed out.'; stop(); }, 15_000);
    signal?.addEventListener('abort', abort, { once: true });
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
    child.stdin.on('error', stop);
    child.on('error', stop);
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) stop(); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) { stop(); return; }
      buffer += chunk;
      let index: number;
      while (!done && (index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.method && message.id !== undefined) { stop(); return; }
          if (message.id === 1) {
            if (message.error || !message.result || typeof message.result !== 'object') { stop(); return; }
            send({ method: 'initialized', params: {} });
            send({ id: 2, method: 'config/read', params: { includeLayers: false, cwd } });
          } else if (message.id === 2) {
            if (message.error) { stop(); return; }
            config = codexModelConfig(message.result); stop();
          }
        } catch { stop(); }
      }
    });
    child.once('close', () => {
      clearTimeout(timeout); if (killTimer) { clearTimeout(killTimer); kill(true); }
      signal?.removeEventListener('abort', abort);
      if (config && !signal?.aborted) resolve(config); else reject(new Error(failure));
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'super-mario-model-config', version: '0.1.0' }, capabilities: null } });
    if (signal?.aborted) abort();
  });
}

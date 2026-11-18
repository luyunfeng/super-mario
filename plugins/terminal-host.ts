import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { describeTerminalHostInstance } from './terminal-recovery.ts';
import type { TerminalHost } from '../packages/plugin-sdk/src/index.ts';
import type { PaneInfo } from '../packages/protocol/src/index.ts';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid terminal CLI object');
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.includes('\0')) throw new Error(`Invalid ${name}`);
  return value;
}
function pane(value: unknown): PaneInfo {
  const data = record(value);
  return { id: string(data.pane_id, 'pane_id'), title: string(data.label ?? data.title ?? '', 'title', true), cwd: string(data.foreground_cwd ?? data.cwd ?? '', 'cwd', true) };
}
function target(id: string): string {
  string(id, 'paneId');
  if (id.startsWith('-') || /[\r\n]/.test(id)) throw new Error('Invalid paneId');
  return id;
}

/** CLI evidence: runtime src/cli/{spec.rs,pane/bindings.rs,tab_bindings.rs,status.rs},
 * src/api/schema/{panes,tabs,response}.rs and src/client/terminal_sessions.rs.
 * Reads are raw stdout; JSON operations carry result.panes / result.root_pane.
 */
export function createTerminalHost(options: { command?: string; env?: NodeJS.ProcessEnv } = {}): TerminalHost {
  const command = options.command ?? 'herdr';
  const env = { ...process.env, ...options.env };
  const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile(command, args, { env, encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      // Never include argv here: send-text and --env may contain private prompts.
      if (error) reject(new Error(`Terminal CLI ${args.slice(0, 2).join(' ')} failed (${error.code ?? 'unknown'})`));
      else resolve(stdout);
    });
  });
  const json = async (args: string[]) => {
    const value = record(JSON.parse(await run(args)));
    if (value.error != null) throw new Error('Terminal CLI returned an error response');
    return record(value.result);
  };
  return {
    async describeInstance(scope) {
      try {
        // Same read-only source as status(); no startup, pane access or identity invention.
        const state = record(JSON.parse(await run(['status', 'server', '--json'])));
        return describeTerminalHostInstance(scope, state);
      } catch {
        // Raw upstream failures may contain commands or private stderr.
        return {
          ...scope, hostKind: 'terminal-cli',
          identity: { state: 'unknown', reason: 'Terminal host status unavailable' },
          atomicControl: { state: 'unsupported', reason: 'Atomic recovery control is not implemented' },
        };
      }
    },
    async status() {
      try {
        const version = await run(['--version']);
        if (!version.trim()) throw new Error('Terminal CLI returned no version');
        const help = await run(['terminal', 'session', 'observe', '--help']);
        if (!help.includes('observe')) throw new Error('Terminal observation is unsupported');
        // This command only probes the daemon. It does not start or replace it.
        const state = record(JSON.parse(await run(['status', 'server', '--json'])));
        if (state.running !== true) throw new Error('Terminal daemon is not running');
        if (state.compatible !== true || state.endpoint_compatible === false) throw new Error('Terminal daemon protocol is incompatible or unknown');
        return { available: true };
      } catch { return { available: false, reason: 'Terminal host unavailable or incompatible; inspect its local CLI and daemon' }; }
    },
    async list() {
      const result = await json(['pane', 'list']);
      if (!Array.isArray(result.panes)) throw new Error('Terminal CLI returned no panes array');
      return result.panes.map(pane);
    },
    async create(spec) {
      string(spec.cwd, 'cwd');
      if (!isAbsolute(spec.cwd)) throw new Error('Terminal cwd must be absolute');
      string(spec.name, 'name');
      if (!Array.isArray(spec.argv) || spec.argv.length === 0) throw new Error('Terminal argv must contain an executable');
      spec.argv.forEach((arg, index) => string(arg, `argv[${index}]`, index !== 0));
      const profileEnv = Object.entries(spec.env ?? {});
      for (const [key, value] of profileEnv) {
        if (!['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(key)) throw new Error('Unsupported terminal environment key');
        string(value, key);
        if (!isAbsolute(value) || /[\r\n]/.test(value)) throw new Error('Profile directory must be an absolute path');
      }
      // Values travel as environment assignments, never shell source. The fixed
      // command works with POSIX shells and fish, including quotes/newlines in args.
      const vars = spec.argv.map((_, index) => `SUPER_MARIO_TERMINAL_ARG_${index}`);
      const args = ['tab', 'create', '--cwd', spec.cwd, '--label', spec.name, '--no-focus'];
      // Pin background work to the caller/configured workspace, never another client's focus.
      const workspace = env.SUPER_MARIO_TERMINAL_WORKSPACE || env.HERDR_WORKSPACE_ID;
      if (workspace) args.push('--workspace', workspace);
      profileEnv.forEach(([key, value]) => args.push('--env', `${key}=${value}`));
      vars.forEach((key, index) => args.push('--env', `${key}=${spec.argv[index]}`));
      const created = pane((await json(args)).root_pane);
      // Task panes retain their shell and screen after the CLI exits. Interactive CLI
      // panes still replace the shell, so a stale agent input cannot become a shell command.
      const launch = `${spec.keepOpen ? '' : 'exec '}/bin/sh -c 'exec "$@"' super-mario ${vars.map(key => `"$${key}"`).join(' ')}`;
      try {
        await run(['pane', 'rename', target(created.id), spec.name]);
        created.title = spec.name;
        await run(['pane', 'run', target(created.id), launch]);
      }
      catch (error) {
        // No blind retries or pane deletion: the launch may already have reached
        // the daemon. Keep its id visible so callers can inspect/close it.
        throw new Error(`Terminal launch outcome unknown for pane ${created.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      return created;
    },
    async read(paneId) {
      const id = target(paneId);
      const text = await run(['pane', 'read', id, '--format', 'text']);
      const ansi = await run(['pane', 'read', id, '--format', 'ansi']);
      return { text, ansi };
    },
    async input(paneId, text) { string(text, 'text', true); await run(['pane', 'send-text', target(paneId), text]); },
    async keys(paneId, keys) {
      const id = target(paneId);
      if (!Array.isArray(keys)) throw new Error('Invalid keys');
      keys.forEach(key => string(key, 'key'));
      if (keys.length) await run(['pane', 'send-keys', id, ...keys]);
    },
    async close(paneId) { await run(['pane', 'close', target(paneId)]); },
    async watch(paneId, onFrame, onError) {
      const child = spawn(command, ['terminal', 'session', 'observe', target(paneId)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const epoch = randomUUID();
      let disposed = false;
      let failed = false;
      let lastSeq = -1;
      let fullSeen = false;
      let forceKill: NodeJS.Timeout | undefined;
      const lines = createInterface({ input: child.stdout });
      const stop = () => {
        lines.close();
        if (!forceKill && child.exitCode === null && child.signalCode === null && child.pid) {
          child.kill('SIGTERM');
          forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
          forceKill.unref();
        }
      };
      const fail = (error: Error) => {
        if (disposed || failed) return;
        failed = true;
        stop();
        onError(error);
      };
      // Drain diagnostics without retaining or forwarding private daemon output.
      child.stderr.resume();
      lines.on('line', line => {
        if (disposed || failed || !line.trim()) return;
        try {
          const value = record(JSON.parse(line));
          if (value.type === 'terminal.closed') throw new Error('Terminal observation closed');
          if (value.type !== 'terminal.frame') throw new Error('Unexpected terminal observation message');
          if (value.encoding !== 'ansi' || typeof value.full !== 'boolean' ||
              !Number.isSafeInteger(value.seq) || (value.seq as number) < 0 ||
              !Number.isInteger(value.width) || (value.width as number) < 1 || (value.width as number) > 65535 ||
              !Number.isInteger(value.height) || (value.height as number) < 1 || (value.height as number) > 65535 ||
              typeof value.bytes !== 'string' || Buffer.from(value.bytes, 'base64').toString('base64') !== value.bytes) {
            throw new Error('Invalid terminal frame');
          }
          const seq = value.seq as number;
          if (seq <= lastSeq || (fullSeen && !value.full && seq !== lastSeq + 1)) throw new Error('Terminal frame sequence gap or regression');
          if (!fullSeen && !value.full) throw new Error('Terminal observation must begin with a full frame');
          fullSeen = true;
          lastSeq = seq;
          onFrame({ epoch, seq, full: value.full, width: value.width as number, height: value.height as number, data: value.bytes });
        } catch { fail(new Error('Invalid or interrupted terminal observation')); }
      });
      child.on('error', () => fail(new Error('Terminal observer could not start')));
      child.on('close', (code, signal) => {
        if (forceKill) clearTimeout(forceKill);
        lines.close();
        fail(new Error(`Terminal observer exited (${signal ?? code ?? 'unknown'})`));
      });
      // A spawn failure is reported through onError like a later stream failure.
      return async () => {
        if (disposed) return;
        disposed = true;
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) { lines.close(); return; }
        const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
        stop();
        await closed;
      };
    },
  };
}

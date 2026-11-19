import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { NodeHandler } from '../packages/plugin-sdk/src/index.ts';
import type { AgentDiagnostics, DiagnosticErrorCode, DiagnosticExecutorId } from '../packages/protocol/src/index.ts';

export interface DiagnosticLauncher {
  /** Trusted local configuration only: executable name on PATH or absolute launcher path; no argv. */
  command: string;
  /** Configuration directory, NOT a named Codex TOML/permissions profile. Never auto-discovered. */
  profile?: { configDir: string };
}
interface ExecError { code?: string | number | null; killed?: boolean; signal?: string | null }
interface ExecOptions {
  encoding: 'utf8'; shell: false; timeout: number; maxBuffer: number; killSignal: 'SIGKILL';
  env: NodeJS.ProcessEnv; cwd: string;
}
/** Injection seam for execFile test doubles; raw output never crosses the RPC boundary. */
export type DiagnosticExecFile = (file: string, args: string[], options: ExecOptions,
  callback: (error: ExecError | null, stdout: string, stderr: string) => void) => void;
export interface AgentDiagnosticsOptions {
  launchers?: Partial<Record<DiagnosticExecutorId, DiagnosticLauncher>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  execFile?: DiagnosticExecFile;
  /** Trusted process environment snapshot. Credential values never enter the response. */
  env?: NodeJS.ProcessEnv;
}
const ids: DiagnosticExecutorId[] = ['codex', 'claude-code', 'pi'];
const notes = [
  '仅按需运行固定的只读 version/status；不登录、不切换 profile、不调用模型。',
  '认证仅表示 CLI 报告的本地凭证状态，不证明凭证有效或任务可执行。',
  '不返回命令、目录、账号、原始输出或配置；凭证环境变量不外传，配置目录选择与执行保持一致。',
  '终端与会话状态未探测；PATH 或 launcher 可用不表示已认证。',
];
function limit(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > ceiling) throw new Error('Invalid diagnostic limit');
  return value;
}
function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}
function errorCode(error: ExecError): DiagnosticErrorCode {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output-limit';
  if (error.code === 'ETIMEDOUT' || (error.killed && error.signal === 'SIGKILL')) return 'timeout';
  if (error.code === 'ENOENT') return 'missing';
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'permission-denied';
  return 'execution-failed';
}
function executable(command: string, path: string): { file?: string; code?: DiagnosticErrorCode } {
  const candidates = isAbsolute(command) ? [command] : path.split(delimiter).filter(Boolean).map(dir => resolve(dir, command));
  let code: DiagnosticErrorCode = 'missing';
  for (const file of candidates) {
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return { file };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['EACCES', 'EPERM'].includes(String(error.code))) code = 'permission-denied';
    }
  }
  return { code };
}

/** Factory construction/handler registration does no I/O. Each probe is fresh; no polling or cache.
 * Main thread merges handlers into startAgentNode({ handlers }); do not call probe during hello.
 * Commands verified against official references (2026-11-17):
 * https://developers.openai.com/codex/cli/reference/ (login status)
 * https://github.com/openai/codex/blob/main/codex-rs/cli/src/login.rs (stderr status variants)
 * https://code.claude.com/docs/en/cli-reference (auth status --json)
 * Profile isolation uses CODEX_HOME / CLAUDE_CONFIG_DIR; no credential/config files are read here.
 */
export function createAgentDiagnostics(options: AgentDiagnosticsOptions = {}): {
  handlers: Record<string, NodeHandler>;
  probe(executorId: DiagnosticExecutorId): Promise<AgentDiagnostics>;
} {
  const timeout = limit(options.timeoutMs, 5000, 10_000);
  const maxBuffer = limit(options.maxOutputBytes, 16_384, 65_536);
  const sourceEnv = options.env ?? process.env;
  // Omit API keys, token helpers and NODE_OPTIONS. Apply only this CLI's selected configuration directory below.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot']) {
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }
  const launchers: Partial<Record<DiagnosticExecutorId, DiagnosticLauncher>> = {};
  for (const [id, spec] of Object.entries(options.launchers ?? {})) {
    if (!ids.includes(id as DiagnosticExecutorId) || !spec || !validText(spec.command) ||
        (!isAbsolute(spec.command) && !/^[a-zA-Z0-9_.+-]+$/.test(spec.command)) ||
        spec.command.startsWith('-') || Object.keys(spec).some(key => !['command', 'profile'].includes(key))) {
      throw new Error('Invalid diagnostic launcher configuration');
    }
    if (spec.profile !== undefined && (!spec.profile || Object.keys(spec.profile).some(key => key !== 'configDir') ||
        !validText(spec.profile.configDir) || !isAbsolute(spec.profile.configDir))) throw new Error('Invalid diagnostic profile configuration');
    launchers[id as DiagnosticExecutorId] = { command: spec.command, ...(spec.profile ? { profile: { configDir: resolve(spec.profile.configDir) } } : {}) };
  }
  const runFile: DiagnosticExecFile = options.execFile ?? ((file, args, opts, cb) => { execFile(file, args, opts, cb); });
  async function probe(executorId: DiagnosticExecutorId): Promise<AgentDiagnostics> {
    if (!ids.includes(executorId)) throw new Error('Unsupported diagnostic executor');
    const configured = launchers[executorId];
    const profileKey = executorId === 'pi' ? 'PI_CODING_AGENT_DIR' : executorId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    const inherited = configured && !configured.profile ? sourceEnv[profileKey] : undefined;
    const invalidProfile = inherited !== undefined && (!validText(inherited) || !isAbsolute(inherited));
    const spec = configured && inherited && !invalidProfile ? { ...configured, profile: { configDir: resolve(inherited) } } : configured;
    const result: AgentDiagnostics = {
      executorId, checkedAt: new Date().toISOString(),
      executable: { source: !spec ? 'unconfigured' : isAbsolute(spec.command) ? 'configured-path' : 'path', state: 'unknown' },
      launcher: { state: 'unknown' }, version: { state: 'unknown' },
      authentication: { state: 'unknown', scope: spec?.profile ? 'configured-profile' : 'local-default' },
      errors: [], notes: [...notes],
    };
    const fail = (stage: AgentDiagnostics['errors'][number]['stage'], code: DiagnosticErrorCode) => result.errors.push({ stage, code });
    if (!spec) { fail('executable', 'not-configured'); return result; }
    if (invalidProfile) { result.authentication.scope = 'configured-profile'; fail('profile', 'profile-unavailable'); return result; }
    const found = executable(spec.command, env.PATH ?? '');
    if (!found.file) {
      result.executable.state = found.code === 'missing' ? 'missing' : 'unknown';
      result.launcher.state = 'unavailable';
      fail('executable', found.code!);
      return result;
    }
    result.executable.state = 'available';
    const childEnv = { ...env };
    const cwd = spec.profile?.configDir ?? (env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir());
    if (spec.profile) {
      try {
        if (!statSync(spec.profile.configDir).isDirectory()) throw new Error();
        accessSync(spec.profile.configDir, constants.R_OK | constants.X_OK);
      } catch { fail('profile', 'profile-unavailable'); return result; }
      childEnv[profileKey] = spec.profile.configDir;
    }
    async function run(args: string[]) {
      return new Promise<{ code: number; stdout: string; stderr: string; failure?: DiagnosticErrorCode }>(done => {
        try {
          runFile(found.file!, args, { encoding: 'utf8', shell: false, timeout, maxBuffer, killSignal: 'SIGKILL', env: { ...childEnv }, cwd }, (error, stdout, stderr) => {
            if (Buffer.byteLength(stdout) > maxBuffer || Buffer.byteLength(stderr) > maxBuffer) {
              done({ code: -1, stdout: '', stderr: '', failure: 'output-limit' });
            } else if (error && (typeof error.code !== 'number' || error.killed || error.signal)) {
              done({ code: -1, stdout: '', stderr: '', failure: errorCode(error) });
            } else done({ code: error?.code as number ?? 0, stdout, stderr });
          });
        } catch { done({ code: -1, stdout: '', stderr: '', failure: 'execution-failed' }); }
      });
    }
    const version = await run(['--version']);
    if (version.failure || version.code !== 0) {
      result.launcher.state = 'unavailable';
      fail('version', version.failure ?? 'execution-failed');
      return result;
    }
    result.launcher.state = 'available';
    const match = (executorId === 'pi' ? /^(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/ : executorId === 'codex' ? /^codex-cli (\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/ : /^(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?) \(Claude Code\)$/).exec(version.stdout.trim());
    if (match) result.version = { state: 'known', value: match[1] };
    else fail('version', 'unrecognized-output');
    if (executorId === 'pi') {
      result.notes.push('pi 仅探测版本，认证状态未知。');
      return result;
    }
    const auth = await run(executorId === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json']);
    if (auth.failure) { fail('authentication', auth.failure); return result; }
    if (executorId === 'claude-code') {
      // Status JSON may contain account data/secrets. Select only the boolean and verify scope.
      let data: unknown;
      try { data = JSON.parse(auth.stdout); } catch { /* Changed/unsupported output remains unknown. */ }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const status = data as Record<string, unknown>;
        if (spec.profile && status.configDirectory !== undefined && (typeof status.configDirectory !== 'string' || !isAbsolute(status.configDirectory) || resolve(status.configDirectory) !== spec.profile.configDir)) {
          fail('profile', 'profile-mismatch'); return result;
        }
        if (status.loggedIn === true && auth.code === 0) result.authentication.state = 'authenticated';
        if (status.loggedIn === false && auth.code === 1) result.authentication.state = 'unauthenticated';
      }
    } else {
      // Codex writes status to stderr, sometimes with a masked key. Never forward any substring.
      const text = `${auth.stdout}\n${auth.stderr}`.trim();
      if (auth.code === 0 && /^(?:Logged in using (?:ChatGPT|API key(?: - [^\r\n]+)?|access token|personal access token|workload identity|Amazon Bedrock API key|Amazon Bedrock AWS access keys)|API key configured - [^\r\n]+\r?\nAuthentication is checked when you send a request\.)$/.test(text)) result.authentication.state = 'authenticated';
      if (auth.code === 1 && text === 'Not logged in') result.authentication.state = 'unauthenticated';
    }
    if (result.authentication.state === 'unknown') fail('authentication', auth.code === 0 || auth.code === 1 ? 'unrecognized-output' : 'execution-failed');
    return result;
  }
  return {
    probe,
    handlers: {
      'executor.diagnostics': async params => {
        // RPC/model input selects only a known executor, never a command, argv, env or profile.
        if (Object.keys(params).some(key => key !== 'executorId') || !ids.includes(params.executorId as DiagnosticExecutorId)) throw new Error('Invalid diagnostic parameters');
        return { ...await probe(params.executorId as DiagnosticExecutorId) };
      },
    },
  };
}

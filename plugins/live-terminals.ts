import { focusTerminalPane } from './terminal-focus.ts';
import { terminalCommand, terminalSocketPath, validTerminalSessionName } from './terminal-endpoint.ts';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { NodeHandler } from '../packages/plugin-sdk/src/index.ts';
import type { Json } from '../packages/protocol/src/index.ts';

interface Target { paneId: string; terminalId: string; cwd: string }
interface LivePane extends Target { title: string; agent: string; state: string; focused?: boolean; nativeSessionId?: string }
export interface ScreenPromptOption { label: string; keys: string }
export interface DetectedScreenPrompt {
  kind: 'trust_dir' | 'permission' | 'choice';
  rev: string;
  title: string;
  excerpt: string;
  options: ScreenPromptOption[];
}

/** Deterministic screen-dialog parser. Computes a content hash (rev) so answering
 * can re-verify the screen and refuse to press keys if the prompt already changed.
 */
export function detectScreenPrompt(rawText: string): DetectedScreenPrompt | undefined {
  const clean = (rawText ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
  const lines = clean.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0).slice(-28);
  if (!lines.length) return undefined;
  const tail = lines.slice(-14).join('\n');
  // Strip spinner glyphs and elapsed-second counters so status-bar ticks do not churn rev every scan.
  const stableTail = tail.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/g, '').replace(/\b\d+(?:\.\d+)?s\b/g, 'Xs');
  const rev = createHash('sha256').update(stableTail).digest('hex').slice(0, 16);

  if (/(?:do you trust|trust the files in this folder|trust this workspace|yes,\s*(?:i trust|proceed))/i.test(tail)) {
    return {
      kind: 'trust_dir',
      rev,
      title: '终端等待信任目录确认',
      excerpt: tail.slice(-500),
      options: [
        { label: '信任并继续 (Enter)', keys: '\r' },
        { label: '取消 (Esc)', keys: '\x1b' },
      ],
    };
  }

  const numbered: ScreenPromptOption[] = [];
  for (const line of lines.slice(-10)) {
    const m = line.match(/^\s*(?:[❯>›•]\s*)?([1-5])[.)]\s+(.{2,80})$/);
    if (m) numbered.push({ label: `${m[1]}. ${m[2]!.trim()}`, keys: `${m[1]}\r` });
  }
  const isPermission = /(?:allow|approve|permission|do you want to (?:run|proceed|execute|edit|create|make)|proceed\?|confirm)/i.test(tail);
  if (isPermission && numbered.length >= 2) {
    return {
      kind: 'permission',
      rev,
      title: '终端等待权限确认',
      excerpt: tail.slice(-500),
      options: numbered.slice(0, 4),
    };
  }
  if (isPermission && /(?:\[y\/n\]|\(y\/n\)|yes\/no)/i.test(tail)) {
    return {
      kind: 'permission',
      rev,
      title: '终端等待确认 (y/n)',
      excerpt: tail.slice(-500),
      options: [
        { label: '允许 (y)', keys: 'y\r' },
        { label: '拒绝 (n)', keys: 'n\r' },
      ],
    };
  }
  if (numbered.length >= 2 && /[❯>›]\s*1[.)]/.test(tail)) {
    return {
      kind: 'choice',
      rev,
      title: '终端等待选择选项',
      excerpt: tail.slice(-500),
      options: numbered.slice(0, 4),
    };
  }
  return undefined;
}
interface Frame { seq: number; full: boolean; width: number; height: number; data: string }
interface Lease { endpoint: NodeJS.ProcessEnv; target: Target; mode: 'observe' | 'control' | 'full'; child: ChildProcessWithoutNullStreams; frames: Frame[]; bytes: number; lastSeq: number; touched: number; checkedAt?: number; ready: boolean; error?: string; width?: number; height?: number }
// Lightweight Linux PTY bridge for `herdr session attach <session>` so the web
// browser can connect as a genuine full Herdr TUI client alongside local clients.
const PTY_BRIDGE_PY = `
import base64, fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios
cols, rows = int(sys.argv[1]), int(sys.argv[2])
cmd = sys.argv[3:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
env = os.environ.copy()
env['TERM'] = 'xterm-256color'
env['COLORTERM'] = 'truecolor'
# A standalone client needs a controlling terminal and must not inherit its caller's pane.
for key in list(env):
  if key.startswith('HERDR_') or key in ('TMUX', 'TMUX_PANE', 'STY', 'SSH_CLIENT', 'SSH_TTY'):
    del env[key]
env['SSH_CONNECTION'] = '127.0.0.1 1 127.0.0.1 2'
def own_terminal():
  os.setsid()
  fcntl.ioctl(0, termios.TIOCSCTTY, 0)
proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=env, preexec_fn=own_terminal)
os.close(slave)
os.set_blocking(master, False)
pending = bytearray()
stdin_fd = sys.stdin.fileno()
buf = b''
def emit(raw):
  sys.stdout.write(json.dumps({'type':'frame','bytes':base64.b64encode(raw).decode('ascii')}) + '\\n')
  sys.stdout.flush()
try:
  while True:
    r, writable, _ = select.select([master, stdin_fd], [master] if pending else [], [], 0.2)
    if master in writable:
      try:
        del pending[:os.write(master, pending)]
      except BlockingIOError:
        pass
    if master in r:
      try:
        chunk = os.read(master, 32768)
      except OSError:
        break
      if not chunk:
        break
      emit(chunk)
    if stdin_fd in r:
      data = os.read(stdin_fd, 65536)
      if not data:
        break
      buf += data
      while b'\\n' in buf:
        line, buf = buf.split(b'\\n', 1)
        if not line.strip():
          continue
        try:
          msg = json.loads(line.decode('utf-8'))
          t = msg.get('type')
          if t == 'terminal.input':
            pending.extend(base64.b64decode(msg['bytes']))
            if len(pending) > 1024 * 1024:
              raise SystemExit(1)
          elif t == 'terminal.resize':
            c, rr = int(msg.get('cols', cols)), int(msg.get('rows', rows))
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rr, c, 0, 0))
          elif t == 'terminal.release':
            raise SystemExit(0)
        except (ValueError, KeyError):
          raise SystemExit(1)
    if proc.poll() is not None:
      break
finally:
  os.close(master)
  for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
    if proc.poll() is not None:
      break
    try:
      os.killpg(proc.pid, sig)
      proc.wait(timeout=0.2)
    except ProcessLookupError:
      break
    except subprocess.TimeoutExpired:
      continue
`.trim();
// Leave room for the RPC envelope under MachineHub's 1 MiB message limit.
const FRAME_RESPONSE_BYTES = 768 * 1024;
const row = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
function text(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('终端参数无效'); return value; }
const json = (value: unknown) => value as Json;

/** Live host streams are never persisted or substituted with native history.
 * Each stream resolves an immutable terminal ID once. It cannot reconnect itself
 * to a replacement pane, and control exists only after an explicit open request.
 */
export function createLiveTerminalServices(options: { command?: string; env?: NodeJS.ProcessEnv } = {}) {
  const env = { ...process.env, ...options.env };
  const command = terminalCommand(options.command, env);
  const leases = new Map<string, Lease>();
  let closed = false, generation = 0;
  function allowed() {
    if (closed || env.HERDR_ENV === '0') throw new Error('当前执行机没有接入 Herdr 现场终端');
  }
  async function run(args: string[], endpoint = env) {
    allowed();
    return new Promise<string>((resolve, reject) => execFile(command, args, { env: endpoint, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error('现场终端读取失败，请检查执行机上的 Herdr')) : resolve(stdout)));
  }
  async function sessions() {
    const data = row(JSON.parse(await run(['session', 'list', '--json'])));
    if (!Array.isArray(data.sessions)) throw new Error('Herdr 会话列表格式无效');
    return data.sessions.flatMap((value: unknown) => {
      const entry = row(value);
      if (!validTerminalSessionName(entry.name)) return [];
      const socketPath = typeof entry.socket_path === 'string' && isAbsolute(entry.socket_path) ? normalize(entry.socket_path) : '';
      const current = env.HERDR_SOCKET_PATH ? socketPath === normalize(env.HERDR_SOCKET_PATH)
        : env.HERDR_SESSION ? env.HERDR_SESSION === entry.name : entry.default === true;
      return [{ name: entry.name as string, running: entry.running === true, default: entry.default === true, current, socketPath }];
    });
  }
  async function endpointFor(session: unknown) {
    if (session === undefined) return env;
    const entry = (await sessions()).find(item => item.name === session);
    if (!entry?.running || !entry.socketPath) throw new Error('指定的 Herdr 会话未运行或不在本机的会话列表中');
    const endpoint = { ...env, HERDR_SOCKET_PATH: entry.socketPath, HERDR_SESSION: entry.name } as NodeJS.ProcessEnv;
    // Pane/workspace IDs inherited from the agent only identify objects in its own session.
    if (!entry.current) {
      delete endpoint.HERDR_PANE_ID;
      delete endpoint.HERDR_TAB_ID;
      delete endpoint.HERDR_WORKSPACE_ID;
    }
    return endpoint;
  }
  const within = (root: string, dir: string) => {
    const rest = relative(root, dir);
    return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('../'));
  };
  const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  async function resolveNativeSessionFromPane(paneId: string, agent: string, endpoint: NodeJS.ProcessEnv): Promise<string | undefined> {
    if (!['codex', 'claude', 'claude-code'].includes(agent)) return undefined;
    try {
      const raw = row(row(JSON.parse(await run(['pane', 'process-info', '--pane', paneId], endpoint))).result);
      const info = row(raw.process_info);
      const procs = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
      for (const proc of procs) {
        const p = row(proc);
        const argv = Array.isArray(p.argv) ? p.argv.map(String) : [];
        for (let i = 0; i < argv.length - 1; i++) {
          if (['--resume', '-r', '--session-id'].includes(argv[i]!)) {
            const candidate = argv[i + 1]!.trim();
            if (candidate && !candidate.startsWith('-')) return candidate;
          }
        }
        const pid = typeof p.pid === 'number' && Number.isSafeInteger(p.pid) ? p.pid : undefined;
        if (pid && (agent === 'claude' || agent === 'claude-code')) {
          try {
            const claudeDir = endpoint.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
            const sessionFile = JSON.parse(await readFile(join(claudeDir, 'sessions', `${pid}.json`), 'utf8')) as Record<string, unknown>;
            if (typeof sessionFile.sessionId === 'string' && sessionFile.sessionId.trim()) {
              return sessionFile.sessionId.trim();
            }
          } catch { /* no pid session file */ }
        }
        if (pid && process.platform === 'linux') {
          try {
            const fds = await readdir(`/proc/${pid}/fd`);
            for (const fd of fds.slice(0, 128)) {
              try {
                const target = await readlink(`/proc/${pid}/fd/${fd}`);
                if (!target.endsWith('.jsonl')) continue;
                if (!target.includes('/.codex/') && !target.includes('/.claude/')) continue;
                const match = basename(target, '.jsonl').match(UUID_RE);
                if (match) return match[1];
              } catch { /* fd closed */ }
            }
          } catch { /* permission or exited */ }
        }
      }
    } catch { /* older herdr or fake test binary without process-info */ }
    return undefined;
  }
  async function list(cwd?: string, exact = false, endpoint = env, resolveNativeSession = true): Promise<LivePane[]> {
    const expected = cwd ? await realpath(text(cwd)) : undefined;
    // A per-tab pane.focused flag may be true in several tabs. The snapshot
    // identifies the one pane displayed by the whole session.
    let snapshot: Record<string, any> = {};
    if (!exact) {
      try { snapshot = row(row(row(JSON.parse(await run(['api', 'snapshot'], endpoint))).result).snapshot); }
      catch { /* Older hosts only implement pane list. */ }
    }
    const focusedPane = typeof snapshot.focused_pane_id === 'string' && snapshot.focused_pane_id;
    const data = Array.isArray(snapshot.panes) && snapshot.panes.every((p: unknown) => typeof row(p).terminal_id === 'string')
      ? snapshot : row(row(JSON.parse(await run(['pane', 'list'], endpoint))).result);
    if (!Array.isArray(data.panes)) throw new Error('现场终端列表格式无效');
    const result: LivePane[] = [];
    for (const value of data.panes) {
      const pane = row(value);
      if (typeof pane.pane_id !== 'string' || typeof pane.terminal_id !== 'string') continue;
      let directory: string;
      try { directory = await realpath(text(pane.foreground_cwd || pane.cwd)); } catch { continue; }
      if (expected && (exact ? expected !== directory : !within(expected, directory))) continue;
      const agent = typeof pane.agent === 'string' ? pane.agent : 'terminal';
      const native = row(pane.agent_session);
      let nativeSessionId = native.kind === 'id' && typeof native.value === 'string' ? native.value
        : typeof pane.agent_session === 'string' && pane.agent_session.trim() ? pane.agent_session.trim()
        : typeof native.id === 'string' && native.id.trim() ? native.id.trim()
        : undefined;
      if (!nativeSessionId && !exact && resolveNativeSession) {
        nativeSessionId = await resolveNativeSessionFromPane(pane.pane_id, agent, endpoint);
      }
      result.push({ paneId: pane.pane_id, terminalId: pane.terminal_id, cwd: directory,
        title: typeof pane.terminal_title_stripped === 'string' ? pane.terminal_title_stripped : typeof pane.label === 'string' ? pane.label : '现场终端',
        agent, state: typeof pane.agent_status === 'string' ? pane.agent_status : 'unknown',
        ...((focusedPane ? pane.pane_id === focusedPane : pane.focused === true) ? { focused: true } : {}),
        ...(nativeSessionId ? { nativeSessionId } : {}) });
    }
    return result;
  }
  async function check(target: Target, endpoint = env) {
    if (!isAbsolute(text(target.cwd))) throw new Error('终端目录必须为绝对路径');
    if (!(await list(target.cwd, true, endpoint)).some(pane => pane.paneId === target.paneId && pane.terminalId === target.terminalId)) throw new Error('现场终端已退出、替换或切换目录，请重新读取列表');
  }
  async function release(id: string) {
    const lease = leases.get(id); if (!lease) return;
    leases.delete(id);
    if (lease.child.exitCode !== null || lease.child.signalCode !== null) return;
    if (lease.mode === 'full') lease.child.stdout.resume();
    if (lease.mode === 'control' || lease.mode === 'full') lease.child.stdin.end(JSON.stringify({ type: 'terminal.release' }) + '\n');
    else lease.child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { lease.child.kill('SIGKILL'); resolve(); }, 1000); timeout.unref();
      lease.child.once('close', () => { clearTimeout(timeout); resolve(); });
    });
  }
  const cleanup = setInterval(() => { for (const [id, lease] of leases) if (Date.now() - lease.touched > 60_000) void release(id); }, 10_000); cleanup.unref();
  function leaseOf(params: unknown) {
    allowed(); const id = text(row(params).connectionId), lease = leases.get(id);
    if (!lease) throw new Error('终端观察已断开，请重新打开');
    lease.touched = Date.now();
    if (lease.error) throw new Error(lease.error);
    return { id, lease };
  }
  const handlers: Record<string, NodeHandler> = {
    'terminal.live.sessions': async () => json({ sessions: (await sessions()).map(({ socketPath, ...info }) => info) }),
    'terminal.live.list': async params => json({ panes: await list(row(params).cwd, false, await endpointFor(row(params).session)), observedAt: new Date().toISOString() }),
    'terminal.live.open': async params => {
      const input = row(params);
      const target = { paneId: text(input.paneId), terminalId: text(input.terminalId), cwd: text(input.cwd) };
      if (!['observe', 'control'].includes(input.mode)) throw new Error('终端打开模式无效');
      const openingGeneration = generation;
      const endpoint = await endpointFor(input.session);
      await check(target, endpoint);
      if (generation !== openingGeneration) throw new Error('执行机连接已断开');
      if (input.mode === 'control' && [...leases.values()].some(lease => lease.mode === 'control' && lease.target.terminalId === target.terminalId && normalize(terminalSocketPath(lease.endpoint)) === normalize(terminalSocketPath(endpoint)))) throw new Error('此终端已在另一个工作台窗口中接管');
      const mode = input.mode as Lease['mode'];
      // Target the host's terminal incarnation, never a reusable pane address.
      const child = spawn(command, ['terminal', 'session', mode, target.terminalId, ...(mode === 'control' ? ['--takeover'] : [])], { env: endpoint, stdio: ['pipe', 'pipe', 'pipe'] });
      const id = randomUUID(), lease: Lease = { endpoint, target, mode, child, frames: [], bytes: 0, lastSeq: -1, touched: Date.now(), ready: false };
      leases.set(id, lease);
      child.stdin.on('error', () => { lease.error = '终端输入连接已断开，未自动重试'; void release(id); });
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      try {
        await new Promise<void>((resolve, reject) => {
          const fail = () => { lease.error = '现场终端连接已中断，请重新观察；输入不会自动重试'; if (!lease.ready) reject(new Error(lease.error)); };
          const timeout = setTimeout(() => { fail(); }, 10_000); timeout.unref();
          child.once('error', fail); child.once('close', () => { clearTimeout(timeout); lines.close(); fail(); });
          lines.on('line', line => {
            if (!leases.has(id) || lease.error) return;
            try {
              const value = row(JSON.parse(line));
              if (value.type !== 'terminal.frame' || value.encoding !== 'ansi' || typeof value.full !== 'boolean'
                || !Number.isSafeInteger(value.seq) || value.seq <= lease.lastSeq || !value.full && value.seq !== lease.lastSeq + 1
                || !Number.isInteger(value.width) || value.width < 1 || value.width > 1000 || !Number.isInteger(value.height) || value.height < 1 || value.height > 1000
                || typeof value.bytes !== 'string' || value.bytes.length > FRAME_RESPONSE_BYTES - 1024 || Buffer.from(value.bytes, 'base64').toString('base64') !== value.bytes || !lease.ready && !value.full) throw new Error();
              const frame: Frame = { seq: value.seq, full: value.full, width: value.width, height: value.height, data: value.bytes };
              lease.frames.push(frame); lease.bytes += frame.data.length; lease.lastSeq = frame.seq;
              while (lease.frames.length > 256 || lease.bytes > 2 * 1024 * 1024) lease.bytes -= lease.frames.shift()!.data.length;
              if (!lease.ready) { lease.ready = true; clearTimeout(timeout); resolve(); }
            } catch { fail(); child.kill('SIGTERM'); }
          });
        });
        await check(target, endpoint);
        if (leases.get(id) !== lease) throw new Error('执行机连接已断开');
        lease.checkedAt = Date.now();
        return { connectionId: id, mode };
      } catch (error) { await release(id); throw error; }
    },
    'terminal.live.full.open': async params => {
      allowed();
      const input = row(params);
      const cols = Number.isInteger(input.cols) && input.cols >= 20 && input.cols <= 400 ? input.cols : 120;
      const rows = Number.isInteger(input.rows) && input.rows >= 8 && input.rows <= 160 ? input.rows : 36;
      const openingGeneration = generation;
      const known = await sessions();
      if (generation !== openingGeneration) throw new Error('执行机连接已断开');
      const chosen = input.session === undefined ? known.find(s => s.current) : known.find(s => s.name === input.session);
      if (!chosen?.running) throw new Error('指定的 Herdr 会话未运行或不在本机的会话列表中');
      allowed();
      if ([...leases.values()].filter(lease => lease.mode === 'full').length >= 4) throw new Error('本机已有四个完整客户端，请先关闭一个');
      const sessionName = chosen.name;
      // These legal names are interpreted as help by the 'session attach' subcommand.
      const attachArgs = ['help', '-h', '--help'].includes(sessionName) ? [`--session=${sessionName}`] : ['session', 'attach', sessionName];
      const child = spawn('python3', ['-u', '-c', PTY_BRIDGE_PY, String(cols), String(rows), command, ...attachArgs], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const id = randomUUID();
      const lease: Lease = {
        endpoint: env, target: { paneId: 'full', terminalId: `full:${sessionName}`, cwd: '/' },
        mode: 'full', child, frames: [], bytes: 0, lastSeq: -1, touched: Date.now(), ready: false, width: cols, height: rows,
      };
      leases.set(id, lease);
      child.stdin.on('error', () => { lease.error = '完整界面连接已断开'; void release(id); });
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      try {
        await new Promise<void>((resolve, reject) => {
          const fail = () => { lease.error = 'Herdr 完整界面连接已中断'; if (!lease.ready) reject(new Error(lease.error)); };
          const timeout = setTimeout(() => { fail(); }, 10_000); timeout.unref();
          child.once('error', fail);
          child.once('close', () => { clearTimeout(timeout); lines.close(); fail(); });
          lines.on('line', line => {
            if (!leases.has(id) || lease.error) return;
            try {
              const value = row(JSON.parse(line));
              if (value.type !== 'frame' || typeof value.bytes !== 'string') return;
              const seq = lease.lastSeq + 1;
              const frame: Frame = { seq, full: seq === 0, width: lease.width ?? cols, height: lease.height ?? rows, data: value.bytes };
              lease.frames.push(frame); lease.bytes += frame.data.length; lease.lastSeq = seq;
              // Raw PTY output has no later snapshot. Pause the pipe until the reader acknowledges bytes.
              if (lease.bytes >= FRAME_RESPONSE_BYTES || lease.frames.length >= 512) child.stdout.pause();
              if (!lease.ready) { lease.ready = true; clearTimeout(timeout); resolve(); }
            } catch { /* ignore non-json */ }
          });
        });
        return { connectionId: id, mode: 'full', session: sessionName, cols, rows };
      } catch (error) { await release(id); throw error; }
    },
    'terminal.live.resize': async params => {
      const { lease } = leaseOf(params);
      if (lease.mode !== 'full') return json({ resized: false });
      const input = row(params);
      const cols = Number.isInteger(input.cols) && input.cols >= 20 && input.cols <= 400 ? input.cols : 120;
      const rows = Number.isInteger(input.rows) && input.rows >= 8 && input.rows <= 160 ? input.rows : 36;
      lease.width = cols; lease.height = rows;
      lease.child.stdin.write(JSON.stringify({ type: 'terminal.resize', cols, rows }) + '\n');
      return json({ resized: true, cols, rows });
    },
    'terminal.live.frames': async params => {
      const { id, lease } = leaseOf(params), after = row(params).after;
      if (!Number.isSafeInteger(after) || after < -1) throw new Error('终端序号无效');
      if (lease.mode !== 'full') {
        // Polling an idle terminal must not launch a CLI every 60 ms. New bytes
        // always need a fresh identity check, even during the idle check interval.
        if (lease.lastSeq <= after && Date.now() - (lease.checkedAt ?? 0) < 5000) return json({ frames: [], mode: lease.mode });
        try { await check(lease.target, lease.endpoint); lease.checkedAt = Date.now(); } catch (error) { await release(id); throw error; }
      }
      if (leases.get(id) !== lease || lease.error) throw new Error('终端观察已断开，请重新打开');
      if (lease.mode === 'full') {
        while (lease.frames.length && lease.frames[0]!.seq <= after) lease.bytes -= lease.frames.shift()!.data.length;
        if (lease.bytes < FRAME_RESPONSE_BYTES && lease.frames.length < 512) lease.child.stdout.resume();
      }
      const frames: Frame[] = [];
      let size = 0;
      for (const frame of lease.frames) {
        if (frame.seq <= after) continue;
        const bytes = Buffer.byteLength(JSON.stringify(frame)) + 1;
        if (size + bytes > FRAME_RESPONSE_BYTES) break;
        frames.push(frame); size += bytes;
      }
      if (frames.length && !(after === -1 ? frames[0]!.full : frames[0]!.full || frames[0]!.seq === after + 1)) throw new Error('终端画面已过期，请重新打开以获取完整画面');
      return json({ frames, mode: lease.mode });
    },
    'terminal.live.input': async params => {
      const { id, lease } = leaseOf(params);
      if ((lease.mode !== 'control' && lease.mode !== 'full') || !lease.ready) throw new Error('请先明确接管终端输入');
      const bytes = row(params).data;
      if (typeof bytes !== 'string' || !bytes || bytes.length > 65536 || Buffer.from(bytes, 'base64').toString('base64') !== bytes) throw new Error('终端输入格式无效');
      if (lease.mode !== 'full') {
        try { await check(lease.target, lease.endpoint); } catch (error) { await release(id); throw error; }
      }
      if (leases.get(id) !== lease || lease.error) throw new Error('终端输入连接已断开，未自动重试');
      // One write to the already-bound controller stream; never retry uncertain input.
      try {
        await new Promise<void>((resolve, reject) => lease.child.stdin.write(JSON.stringify({ type: 'terminal.input', bytes }) + '\n', error => error ? reject(new Error('终端输入结果未知，未自动重试')) : resolve()));
      } catch (error) {
        lease.error = '终端输入结果未知，未自动重试';
        await release(id);
        throw error;
      }
      return { requested: true };
    },
    'terminal.live.read': async params => {
      const input = row(params), target = { paneId: text(input.paneId), terminalId: text(input.terminalId), cwd: text(input.cwd) };
      const endpoint = await endpointFor(input.session);
      await check(target, endpoint);
      const output = await run(['pane', 'read', target.paneId, '--source', 'recent-unwrapped', '--lines', '300', '--format', 'text'], endpoint);
      await check(target, endpoint);
      return { text: output.slice(-200_000), source: 'host-recent-output', completeHistory: false };
    },
    'terminal.live.focus': async params => {
      const input = row(params), endpoint = await endpointFor(input.session);
      const target = { paneId: text(input.paneId), terminalId: text(input.terminalId), cwd: text(input.cwd) };
      await check(target, endpoint);
      await focusTerminalPane(terminalSocketPath(endpoint), target.paneId);
      return { focused: true };
    },
    'terminal.live.scan_prompts': async params => {
      const panes = await list(row(params).cwd, false, env, false);
      const prompts: Array<Record<string, unknown>> = [];
      for (const pane of panes.slice(0, 24)) {
        if (pane.state === 'working') continue;
        try {
          const textOut = await run(['pane', 'read', pane.paneId, '--source', 'recent-unwrapped', '--lines', '40', '--format', 'text']);
          const detected = detectScreenPrompt(textOut);
          if (detected) {
            prompts.push({
              paneId: pane.paneId, terminalId: pane.terminalId, cwd: pane.cwd,
              title: pane.title, agent: pane.agent, state: pane.state,
              prompt: detected,
            });
          }
        } catch { /* ignore unreadable pane */ }
      }
      return json({ prompts, observedAt: new Date().toISOString() });
    },
    'terminal.live.answer_prompt': async params => {
      const input = row(params);
      const target = { paneId: text(input.paneId), terminalId: text(input.terminalId), cwd: text(input.cwd) };
      const expectedRev = text(input.rev);
      const keys = typeof input.keys === 'string' && input.keys.length > 0 && input.keys.length <= 64 ? input.keys : '';
      if (!keys) throw new Error('按键内容无效');
      await check(target);
      const currentText = await run(['pane', 'read', target.paneId, '--source', 'recent-unwrapped', '--lines', '40', '--format', 'text']);
      const detected = detectScreenPrompt(currentText);
      if (!detected || detected.rev !== expectedRev) {
        return json({ applied: false, reason: 'prompt_changed' });
      }
      await run(['pane', 'send-text', '--pane', target.paneId, '--', keys]);
      return json({ applied: true, rev: expectedRev });
    },
    'terminal.live.release': async params => { await release(text(row(params).connectionId)); return { released: true }; },
  };
  return { handlers, async disconnect() { generation++; await Promise.all([...leases.keys()].map(release)); }, async close() { closed = true; generation++; clearInterval(cleanup); await Promise.all([...leases.keys()].map(release)); } };
}

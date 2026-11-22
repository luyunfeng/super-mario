import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { NodeHandler } from '../packages/plugin-sdk/src/index.ts';
import type { Json } from '../packages/protocol/src/index.ts';

interface Target { paneId: string; terminalId: string; cwd: string }
interface LivePane extends Target { title: string; agent: string; state: string; nativeSessionId?: string }
interface Frame { seq: number; full: boolean; width: number; height: number; data: string }
interface Lease { target: Target; mode: 'observe' | 'control'; child: ChildProcessWithoutNullStreams; frames: Frame[]; bytes: number; lastSeq: number; touched: number; ready: boolean; error?: string }
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
  const command = options.command ?? 'herdr', env = { ...process.env, ...options.env };
  const leases = new Map<string, Lease>();
  let closed = false;
  function allowed() {
    if (closed || env.HERDR_ENV === '0') throw new Error('当前执行机没有接入 Herdr 现场终端');
    if (env.HERDR_ENV === '1') return;
    const sock = join(env.HOME || homedir(), '.config', 'herdr', 'herdr.sock');
    if (!existsSync(sock)) throw new Error('当前执行机没有接入 Herdr 现场终端');
  }
  async function run(args: string[]) {
    allowed();
    return new Promise<string>((resolve, reject) => execFile(command, args, { env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error('现场终端读取失败，请检查执行机上的 Herdr')) : resolve(stdout)));
  }
  const within = (root: string, dir: string) => {
    const rest = relative(root, dir);
    return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('../'));
  };
  const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  async function resolveNativeSessionFromPane(paneId: string, agent: string): Promise<string | undefined> {
    if (!['codex', 'claude', 'claude-code'].includes(agent)) return undefined;
    try {
      const raw = row(row(JSON.parse(await run(['pane', 'process-info', '--pane', paneId]))).result);
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
  async function list(cwd?: string, exact = false): Promise<LivePane[]> {
    const expected = cwd ? await realpath(text(cwd)) : undefined;
    const data = row(row(JSON.parse(await run(['pane', 'list']))).result);
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
      if (!nativeSessionId && !exact) {
        nativeSessionId = await resolveNativeSessionFromPane(pane.pane_id, agent);
      }
      result.push({ paneId: pane.pane_id, terminalId: pane.terminal_id, cwd: directory,
        title: typeof pane.terminal_title_stripped === 'string' ? pane.terminal_title_stripped : typeof pane.label === 'string' ? pane.label : '现场终端',
        agent, state: typeof pane.agent_status === 'string' ? pane.agent_status : 'unknown',
        ...(nativeSessionId ? { nativeSessionId } : {}) });
    }
    return result;
  }
  async function check(target: Target) {
    if (!isAbsolute(text(target.cwd))) throw new Error('终端目录必须为绝对路径');
    if (!(await list(target.cwd, true)).some(pane => pane.paneId === target.paneId && pane.terminalId === target.terminalId)) throw new Error('现场终端已退出、替换或切换目录，请重新读取列表');
  }
  async function release(id: string) {
    const lease = leases.get(id); if (!lease) return;
    leases.delete(id);
    if (lease.child.exitCode !== null || lease.child.signalCode !== null) return;
    if (lease.mode === 'control') lease.child.stdin.end(JSON.stringify({ type: 'terminal.release' }) + '\n');
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
    'terminal.live.list': async params => json({ panes: await list(row(params).cwd), observedAt: new Date().toISOString() }),
    'terminal.live.open': async params => {
      const input = row(params);
      const target = { paneId: text(input.paneId), terminalId: text(input.terminalId), cwd: text(input.cwd) };
      if (!['observe', 'control'].includes(input.mode)) throw new Error('终端打开模式无效');
      await check(target);
      if (input.mode === 'control' && [...leases.values()].some(lease => lease.mode === 'control' && lease.target.terminalId === target.terminalId)) throw new Error('此终端已在另一个工作台窗口中接管');
      const mode = input.mode as Lease['mode'];
      // Target the host's terminal incarnation, never a reusable pane address.
      const child = spawn(command, ['terminal', 'session', mode, target.terminalId, ...(mode === 'control' ? ['--takeover'] : [])], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const id = randomUUID(), lease: Lease = { target, mode, child, frames: [], bytes: 0, lastSeq: -1, touched: Date.now(), ready: false };
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
        await check(target);
        return { connectionId: id, mode };
      } catch (error) { await release(id); throw error; }
    },
    'terminal.live.frames': async params => {
      const { id, lease } = leaseOf(params), after = row(params).after;
      if (!Number.isSafeInteger(after) || after < -1) throw new Error('终端序号无效');
      try { await check(lease.target); } catch (error) { await release(id); throw error; }
      if (leases.get(id) !== lease || lease.error) throw new Error('终端观察已断开，请重新打开');
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
      if (lease.mode !== 'control' || !lease.ready) throw new Error('请先明确接管终端输入');
      const bytes = row(params).data;
      if (typeof bytes !== 'string' || !bytes || bytes.length > 65536 || Buffer.from(bytes, 'base64').toString('base64') !== bytes) throw new Error('终端输入格式无效');
      try { await check(lease.target); } catch (error) { await release(id); throw error; }
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
      await check(target);
      const output = await run(['pane', 'read', target.paneId, '--source', 'recent-unwrapped', '--lines', '300', '--format', 'text']);
      await check(target);
      return { text: output.slice(-200_000), source: 'host-recent-output', completeHistory: false };
    },
    'terminal.live.release': async params => { await release(text(row(params).connectionId)); return { released: true }; },
  };
  return { handlers, async disconnect() { await Promise.all([...leases.keys()].map(release)); }, async close() { closed = true; clearInterval(cleanup); await Promise.all([...leases.keys()].map(release)); } };
}

import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import WebSocket from 'ws';
import { validateNativeSessionId } from './session-resume.ts';

export type CodexTurnEndpoint = { path: string; dev: number; ino: number; ctimeMs: number; cwd: string; nativeSessionId: string };
type Obj = Record<string, unknown>;
function obj(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex app-server response');
  return value as Obj;
}

// Some Codex versions expose one canonical alias under the owner's profile. Follow only its prescribed target.
export function codexTurnEndpoint(configured: string, cwd: string, nativeSessionId: string): CodexTurnEndpoint {
  const uid = process.geteuid?.();
  let path = configured.startsWith('unix://') ? configured.slice(7) : configured;
  if (uid === undefined || !isAbsolute(path) || path !== resolve(path) || /[\p{Cc}%?#]/u.test(path))
    throw new Error('Invalid local Codex socket');
  const parent = dirname(path);
  if (realpathSync(parent) !== parent) throw new Error('Invalid Codex socket directory');
  if (lstatSync(path).isSymbolicLink()) {
    const dir = lstatSync(parent);
    if (dir.uid !== uid || dir.mode & 0o022) throw new Error('Unsafe Codex socket alias');
    const target = join(realpathSync('/tmp'), 'codex-daemon-' + uid, createHash('sha256').update(path).digest('hex'));
    if (readlinkSync(path) !== target) throw new Error('Invalid Codex socket alias');
    path = target;
  }
  const info = lstatSync(path),
    dir = lstatSync(dirname(path));
  if (
    realpathSync(dirname(path)) !== dirname(path) ||
    !info.isSocket() ||
    !dir.isDirectory() ||
    info.uid !== uid ||
    dir.uid !== uid ||
    (info.mode | dir.mode) & 0o077
  )
    throw new Error('Codex socket and its directory must be private');
  return { path, cwd: realpathSync(cwd), nativeSessionId, dev: info.dev, ino: info.ino, ctimeMs: info.ctimeMs };
}
class MissingMethod extends Error {}

async function connected<T>(
  endpoint: CodexTurnEndpoint,
  use: (rpc: (method: string, params: Obj) => Promise<Obj>) => Promise<T>
) {
  function verify() {
    const now = codexTurnEndpoint(endpoint.path, endpoint.cwd, endpoint.nativeSessionId);
    if (now.dev !== endpoint.dev || now.ino !== endpoint.ino || now.ctimeMs !== endpoint.ctimeMs || now.cwd !== endpoint.cwd)
      throw new Error('Codex socket changed');
  }
  verify();
  const ws = new WebSocket('ws://localhost/', {
    createConnection: () => createConnection({ path: endpoint.path }),
    handshakeTimeout: 3000,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
    followRedirects: false,
  });
  let seq = 0;
  let pending: { id: number; ok(value: Obj): void; fail(error: Error): void } | undefined;
  const disconnected = () => pending?.fail(new Error('Codex protocol connection lost'));
  ws.on('error', disconnected);
  ws.on('close', disconnected);
  ws.on('message', (data) => {
    try {
      const frame = obj(JSON.parse(data.toString()));
      if (frame.method !== undefined || frame.id !== pending?.id || !pending) return;
      if (frame.error !== undefined) {
        pending.fail(obj(frame.error).code === -32601 ? new MissingMethod() : new Error('Codex app-server rejected the request'));
        return;
      }
      pending.ok(obj(frame.result));
    } catch {
      pending?.fail(new Error('Invalid or rejected Codex protocol response'));
    }
  });
  async function rpc(method: string, params: Obj): Promise<Obj> {
    verify();
    if (ws.readyState !== WebSocket.OPEN) throw new Error('Codex socket is closed');
    const id = ++seq;
    try {
      return await new Promise<Obj>((ok, fail) => {
        pending = { id, ok, fail };
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => {
          if (error) fail(error);
        });
      });
    } finally {
      pending = undefined;
    }
  }
  const deadline = setTimeout(() => ws.terminate(), 7500);
  try {
    await new Promise<void>((ok, fail) => {
      ws.once('open', ok);
      ws.once('error', fail);
      ws.once('close', () => fail(new Error('Codex socket closed')));
    });
    verify();
    await rpc('initialize', {
      clientInfo: { name: 'super-mario', title: 'Super Mario', version: '1' },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
    return await use(rpc);
  } finally {
    clearTimeout(deadline);
    ws.terminate();
  }
}
function checkThread(thread: Obj, endpoint: CodexTurnEndpoint) {
  if (thread.id !== endpoint.nativeSessionId || thread.cwd !== endpoint.cwd || thread.ephemeral === true)
    throw new Error('Codex thread identity does not match the resumed session');
}
function idle(thread: Obj, endpoint: CodexTurnEndpoint) {
  checkThread(thread, endpoint);
  const status = obj(thread.status);
  if (
    status.type !== 'idle' ||
    (status.activeFlags !== undefined && (!Array.isArray(status.activeFlags) || status.activeFlags.length))
  )
    throw new Error('Codex thread is not idle');
}
export function startCodexTopicTurn(e: CodexTurnEndpoint, text: string) {
  let attempted = false;
  return connected(e, async (rpc) => {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await rpc('thread/loaded/list', { limit: 100, ...(cursor && { cursor }) });
      if (!Array.isArray(page.data)) throw new Error('Invalid Codex thread list');
      if (page.data.includes(e.nativeSessionId)) break;
      if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor) || cursors.size >= 50)
        throw new Error('Codex thread is not loaded');
      cursor = page.nextCursor;
      cursors.add(cursor);
    }
    const params = { threadId: e.nativeSessionId };
    idle(obj((await rpc('thread/read', { ...params, includeTurns: false })).thread), e);
    idle(obj((await rpc('thread/resume', { ...params, excludeTurns: true })).thread), e);
    attempted = true;
    const turn = obj((await rpc('turn/start', { ...params, input: [{ type: 'text', text, text_elements: [] }] })).turn);
    validateNativeSessionId(turn.id);
    return { nativeSessionId: e.nativeSessionId, turnId: turn.id };
  }).catch((error: unknown) => {
    if (attempted) throw error;
    return 'not-sent' as const;
  });
}
export async function codexTopicAnswer(e: CodexTurnEndpoint, turnId: string, fingerprint: string) {
  return connected(e, async (rpc) => {
    const params = { threadId: e.nativeSessionId };
    checkThread(obj((await rpc('thread/read', { ...params, includeTurns: false })).thread), e);
    let matching: Obj[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      let page: Obj;
      try {
        page = await rpc('thread/turns/list', {
          ...params,
          sortDirection: 'desc',
          itemsView: 'full',
          limit: 100,
          ...(cursor && { cursor }),
        });
      } catch (error) {
        if (cursor || !(error instanceof MissingMethod)) throw error;
        const thread = obj((await rpc('thread/read', { ...params, includeTurns: true })).thread);
        checkThread(thread, e);
        if (Array.isArray(thread.turns)) matching = thread.turns.map(obj).filter((turn) => turn.id === turnId);
        break;
      }
      if (!Array.isArray(page.data)) return { state: 'unknown' };
      matching = page.data.map(obj).filter((turn) => turn.id === turnId);
      if (matching.length || !page.nextCursor) break;
      if (typeof page.nextCursor !== 'string' || cursors.has(page.nextCursor) || cursors.size >= 50) return { state: 'unknown' };
      cursor = page.nextCursor;
      cursors.add(cursor);
    }
    if (matching.length !== 1) return { state: 'unknown' };
    const turn = matching[0];
    if (turn.status === 'inProgress') return { state: 'running' };
    if (turn.status === 'failed' || turn.status === 'interrupted') return { state: 'failed' };
    if (turn.status !== 'completed') return { state: 'unknown' };
    if (turn.error || !Array.isArray(turn.items)) return { state: 'failed' };
    const items = turn.items.map(obj),
      users = items.filter((i) => i.type === 'userMessage');
    if (users.length !== 1 || !Array.isArray(users[0].content) || users[0].content.length !== 1) return { state: 'failed' };
    const input = obj(users[0].content[0]);
    if (
      input.type !== 'text' ||
      typeof input.text !== 'string' ||
      createHash('sha256').update(JSON.stringify(input.text)).digest('hex') !== fingerprint
    )
      return { state: 'failed' };
    const answers = items.filter((i) => i.type === 'agentMessage' && ['final_answer', 'finalAnswer'].includes(String(i.phase)));
    if (
      answers.length !== 1 ||
      answers[0].delivery === 'async' ||
      typeof answers[0].text !== 'string' ||
      !answers[0].text.trim() ||
      items.indexOf(answers[0]) <= items.indexOf(users[0])
    )
      return { state: 'failed' };
    return { state: 'completed', text: answers[0].text };
  });
}

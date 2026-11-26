import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import WebSocket from 'ws';
import { buildInfo } from '../../../packages/core/src/build-info.ts';
import type { NodeOptions } from '../../../packages/plugin-sdk/src/index.ts';
import type { JsonObject, NodeMessage } from '../../../packages/protocol/src/index.ts';

/** Resolve executables without invoking a shell or starting an external agent. */
function cliAvailable(command: string): boolean {
  const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, command));
  for (const path of candidates) {
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return true;
    } catch { /* Missing or inaccessible PATH entries simply do not provide this CLI. */ }
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only expose a message, never arbitrary thrown objects, causes, stacks or CLI logs. */
function handlerError(error: unknown, token: string): string {
  let message: string;
  try {
    if (!(error instanceof Error) || typeof error.message !== 'string') return 'handler failed';
    message = error.message;
  } catch { return 'handler failed'; }
  // Redact before truncating, so a secret crossing the length limit cannot leak a prefix.
  const secrets = new Set([token, encodeURIComponent(token),
    new URLSearchParams({ token }).toString().slice('token='.length)]);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[REDACTED]');
  }
  message = message
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:\b[a-z][a-z\d+.-]*:)?\/\/[^\s"'<>]+/gi, (url) => url
      .replace(/(\/\/)[^/?#]*@/, '$1[REDACTED]@')
      // Query values and fragments can carry arbitrary provider-specific credentials.
      .replace(/[?#].*$/, '?[REDACTED]'))
    // Cover relative URLs too, including encoded query names such as %74oken.
    .replace(/([?&][^\s=?&#"'<>]+=)[^\s&#"'<>]*/g,
      '$1[REDACTED]');
  // Host errors sometimes append CLI output or a stack on subsequent lines.
  return message.split(/[\r\n\u2028\u2029]/, 1)[0].trim().slice(0, 500) || 'handler failed';
}

export function startAgentNode(options: NodeOptions & { piCommand?: string }): { close(): Promise<void> } {
  if (!options.token?.trim()) throw new Error('Agent node token is required');
  if (!options.machineId?.trim()) throw new Error('Agent node machineId is required');
  // One logical agent lifetime; reconnects retain it, a fresh agent gets a new value.
  // This is deliberately separate from machine identity, OS pid and terminal daemon identity.
  const agentInstanceId = options.agentInstanceId ?? randomUUID();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(agentInstanceId)) throw new Error('Invalid agent instance identity');
  const reconnectMs = options.reconnectMs ?? 2000;
  if (!Number.isFinite(reconnectMs) || reconnectMs < 1) {
    throw new Error('reconnectMs must be a positive number');
  }
  // Dedicated credentials use a header. Existing root-token connections retain their wire format.
  let url: URL;
  try { url = new URL('/api/v1/node', options.url); }
  catch { throw new Error('Agent node server URL is invalid'); }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Agent node server URL must use HTTP(S) or WS(S) without credentials');
  }

  const dedicated=/^smmc_[A-Za-z0-9_-]{43}$/.test(options.token);
  if(!dedicated)url.searchParams.set('token', options.token);

  // Snapshot the whitelist; node.status always remains the built-in read-only method.
  const handlers = new Map(Object.entries(options.handlers ?? {}));
  const capabilities = [...new Set(['node.status', ...handlers.keys()])];
  const build = buildInfo();
  let stopped = false;
  let socket: WebSocket;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let cleanup: Promise<void> = Promise.resolve();

  function connect(): void {
    if (stopped) return;
    const connection = new WebSocket(url, { handshakeTimeout: 5000, headers:dedicated?{authorization:`Bearer ${options.token}`}:undefined });
    socket = connection;
    let welcomed = false;
    let disconnected = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const pending = new Set<string>();
    // Connection-local serialized results preserve the exact response even if a handler mutates it later.
    // Eviction bounds memory; this is short-lived delivery deduplication, not durable idempotency.
    const results = new Map<string, string>();
    const active = () => !stopped && !disconnected && socket === connection;
    function send(message: NodeMessage): void {
      if (active() && connection.readyState === WebSocket.OPEN) {
        connection.send(JSON.stringify(message));
      }
    }
    function complete(message: Extract<NodeMessage, { type: 'result' }>): void {
      pending.delete(message.id);
      if (!active()) return;
      const serialized = JSON.stringify(message);
      results.set(message.id, serialized);
      if (results.size > 256) results.delete(results.keys().next().value!);
      if (connection.readyState === WebSocket.OPEN) connection.send(serialized);
    }
    connection.on('open', () => send({
      type: 'hello', agentInstanceId, machineId: options.machineId, name: options.name,
      platform: process.platform, capabilities,
      ...(options.executors === undefined ? {} : { executors: options.executors }),
      build: { commit: build.commit, ...(build.dirty ? { dirty: true } : {}) },
    }));
    connection.on('message', (data) => {
      if (!active()) return;
      let message: unknown;
      try { message = JSON.parse(data.toString()); }
      catch { connection.close(1008, 'Invalid JSON'); return; }
      if (!isObject(message)) return;
      if (message.type === 'welcome' && message.machineId === options.machineId && !welcomed) {
        welcomed = true;
        heartbeat = setInterval(() => send({ type: 'heartbeat' }), 1000);
      } else if (welcomed && message.type === 'call' && typeof message.id === 'string') {
        const id = message.id;
        const previous = results.get(id);
        if (previous !== undefined) {
          if (connection.readyState === WebSocket.OPEN) connection.send(previous);
          return;
        }
        if (pending.has(id)) return;
        const handler = typeof message.method === 'string' ? handlers.get(message.method) : undefined;
        if (message.method !== 'node.status' && !handler) {
          complete({ type: 'result', id, error: 'unsupported method' });
          return;
        }
        if (message.method === 'node.status') {
          // Availability means an executable is on PATH, not that it is authenticated or runnable.
          complete({ type: 'result', id, result: {
            machineId: options.machineId, name: options.name, platform: process.platform,
            arch: process.arch, nodeVersion: process.version, pid: process.pid, agentInstanceId,
            uptime: process.uptime(), cli: { codex: cliAvailable('codex'), claude: cliAvailable('claude'), pi: cliAvailable(options.piCommand ?? 'pi') },
          } });
          return;
        }
        if (!handler) return;
        if (!isObject(message.params)) {
          complete({ type: 'result', id, error: 'invalid params' });
          return;
        }
        // Parsed JSON plus the object guard satisfies the handler's JSON object boundary.
        const params = message.params as JsonObject;
        pending.add(id);
        // Each call runs independently; pending RPCs never hold up heartbeat or other calls.
        void (async () => {
          try {
            const result = await handler(params, (event, data) => send({ type: 'event', event, data }));
            complete({ type: 'result', id, result });
          } catch (error) {
            complete({ type: 'result', id, error: handlerError(error, options.token) });
          }
        })();
      }
    });
    // A failed handshake also emits close. Only close owns cleanup and reconnect.
    connection.on('error', () => {
      if (active()) console.error('Agent node connection failed');
    });
    connection.on('close', () => {
      if (disconnected || socket !== connection) return;
      disconnected = true;
      clearInterval(heartbeat);
      pending.clear();
      results.clear();
      // Finish observation cleanup before another connection can create observation streams.
      cleanup = Promise.resolve().then(() => options.onDisconnect?.()).then(() => {}, () => {
        console.error('Agent node disconnect cleanup failed');
      });
      void cleanup.then(() => {
        if (!stopped && socket === connection) reconnect = setTimeout(connect, reconnectMs);
      });
    });
  }

  connect();
  return {
    close() {
      if (closing) return closing;
      stopped = true;
      clearTimeout(reconnect);
      closing = (async () => {
        if (socket.readyState !== WebSocket.CLOSED) {
          await new Promise<void>((resolve) => {
            socket.once('close', resolve);
            // Local shutdown must finish even when the peer does not answer a close handshake.
            socket.terminate();
          });
        }
        await cleanup;
      })();
      return closing;
    },
  };
}

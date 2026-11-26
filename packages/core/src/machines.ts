import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Dispose, EventBus, MachineClient, Store } from '../../plugin-sdk/src/index.ts';
import type { ExecutorInfo, Json, MachineInfo, NodeMessage, ServerMessage } from '../../protocol/src/index.ts';

export class MachineError extends Error {
  readonly status: number;
  readonly delivery: 'no' | 'unknown';

  constructor(message: string, status: number, delivery: 'no' | 'unknown') {
    super(message);
    this.name = 'MachineError';
    this.status = status;
    this.delivery = delivery;
  }
}

export interface MachineEvent { machineId: string; event: string; data: Json }
export interface MachineHub extends MachineClient {
  attach(ws: WebSocket, hello: Extract<NodeMessage, { type: 'hello' }>): void;
  handle(ws: WebSocket, message: NodeMessage): void;
  detach(ws: WebSocket): void;
  onEvent(listener: (event: MachineEvent) => void): Dispose;
  close(): void;
}

type Pending = {
  ws: WebSocket;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: Json) => void;
  reject: (error: MachineError) => void;
};
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function validExecutor(value: ExecutorInfo, machineId: string): boolean {
  return value != null && nonempty(value.id) && nonempty(value.name) && nonempty(value.kind)
    && value.machineId === machineId && typeof value.available === 'boolean'
    && (value.mode === 'demo' || value.mode === 'real') && typeof value.description === 'string'
    && (value.reason === undefined || typeof value.reason === 'string');
}

export function createMachineHub({ store, events }: { store: Store; events: EventBus }): MachineHub {
  const connections = new Map<string, WebSocket>();
  const identities = new Map<WebSocket, string>();
  const closeHandlers = new Map<WebSocket, () => void>();
  const pending = new Map<string, Pending>();
  const listeners = new Set<(event: MachineEvent) => void>();
  let closed = false;

  // A previous process's online flag is not evidence of a live connection.
  for (const machine of store.list<MachineInfo>('machines')) {
    store.put('machines', machine.id, { ...machine, online: false });
  }

  function rejectPending(ws: WebSocket, reason: string) {
    for (const [id, request] of pending) {
      if (request.ws !== ws) continue;
      pending.delete(id);
      clearTimeout(request.timer);
      request.reject(new MachineError(reason, 502, 'unknown'));
    }
  }

  function detach(ws: WebSocket) {
    const machineId = identities.get(ws);
    if (machineId === undefined) return;
    identities.delete(ws);
    const onClose = closeHandlers.get(ws);
    if (onClose) ws.off('close', onClose);
    closeHandlers.delete(ws);
    rejectPending(ws, 'Machine disconnected; execution outcome is unknown');
    // Replacement connections own the machine's state, including late close events.
    if (connections.get(machineId) !== ws) return;
    connections.delete(machineId);
    const machine = store.get<MachineInfo>('machines', machineId);
    if (machine) {
      store.put('machines', machineId, { ...machine, online: false });
      events.publish('machines.changed', { id: machineId });
    }
  }

  const hub: MachineHub = {
    list() {
      return store.list<MachineInfo>('machines').map(machine => ({
        ...machine, online: connections.get(machine.id)?.readyState === WebSocket.OPEN,
      }));
    },
    attach(ws, hello) {
      if (closed) throw new MachineError('Machine hub is closed', 503, 'no');
      if (!hello || hello.type !== 'hello' || !nonempty(hello.machineId) || !nonempty(hello.name)
        || !nonempty(hello.platform) || (hello.agentInstanceId !== undefined && (typeof hello.agentInstanceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(hello.agentInstanceId))) || !Array.isArray(hello.capabilities) || !hello.capabilities.every(nonempty)
        || (hello.executors !== undefined && (!Array.isArray(hello.executors)
          || !hello.executors.every(executor => validExecutor(executor, hello.machineId))))
        || (hello.build !== undefined && (typeof hello.build !== 'object' || hello.build === null
          || typeof hello.build.commit !== 'string' || !/^(?:unknown|[0-9a-f]{40})$/.test(hello.build.commit)
          || (hello.build.dirty !== undefined && typeof hello.build.dirty !== 'boolean')))) {
        throw new MachineError('Invalid machine hello', 400, 'no');
      }
      if (ws.readyState !== WebSocket.OPEN) throw new MachineError('Machine connection is not open', 503, 'no');
      if (identities.has(ws)) throw new MachineError('Machine connection already attached', 400, 'no');
      const machine: MachineInfo = structuredClone({
        ...(hello.agentInstanceId === undefined ? {} : { agentInstanceId: hello.agentInstanceId }),
        id: hello.machineId, name: hello.name, platform: hello.platform, capabilities: hello.capabilities,
        ...(hello.executors === undefined ? {} : { executors: hello.executors }),
        ...(hello.build === undefined ? {} : { build: hello.build }),
        online: true, connectedAt: new Date().toISOString(),
      });
      store.put('machines', machine.id, machine);
      const previous = connections.get(machine.id);
      connections.set(machine.id, ws);
      identities.set(ws, machine.id);
      const onClose = () => detach(ws);
      closeHandlers.set(ws, onClose);
      ws.once('close', onClose);
      if (previous) {
        detach(previous);
        previous.close(1000, 'Machine connection replaced');
      }
      try {
        ws.send(JSON.stringify({ type: 'welcome', machineId: machine.id } satisfies ServerMessage), error => {
          if (error) detach(ws);
        });
      } catch (error) {
        detach(ws);
        throw error;
      }
      events.publish('machines.changed', machine as unknown as Json);
    },
    async call(machineId, method, params, options) {
      if (closed) throw new MachineError('Machine hub is closed', 503, 'no');
      const ws = connections.get(machineId);
      const machine = store.get<MachineInfo>('machines', machineId);
      if (!machine?.online || !ws || ws.readyState !== WebSocket.OPEN) {
        throw new MachineError('Machine is offline', 503, 'no');
      }
      if (!machine.capabilities.includes(method)) throw new MachineError('Unsupported machine method', 400, 'no');
      const timeoutMs = options?.timeoutMs ?? 10_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
        throw new MachineError('Invalid RPC timeout', 400, 'no');
      }
      const id = randomUUID();
      // Serialize before registering/sending: local encoding errors mean no delivery.
      let payload: string;
      try { payload = JSON.stringify({ type: 'call', id, method, params } satisfies ServerMessage); }
      catch { throw new MachineError('Invalid RPC parameters', 400, 'no'); }
      return new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new MachineError('Machine RPC timed out; execution outcome is unknown', 504, 'unknown'));
        }, timeoutMs);
        pending.set(id, { ws, timer, resolve, reject });
        // Once send is attempted, transport failures cannot prove non-execution.
        try { ws.send(payload, error => { if (error) detach(ws); }); }
        catch { detach(ws); }
      });
    },
    handle(ws, message) {
      const machineId = identities.get(ws);
      if (closed || machineId === undefined || connections.get(machineId) !== ws) return;
      if (message.type === 'result') {
        const request = pending.get(message.id);
        if (!request || request.ws !== ws) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error !== undefined) request.reject(new MachineError(message.error, 502, 'unknown'));
        else request.resolve(message.result ?? null);
      } else if (message.type === 'event') {
        // Terminal frames are transient. EventBus.publish would persist every frame.
        for (const listener of [...listeners]) {
          try {
            void Promise.resolve(listener(structuredClone({ machineId, event: message.event, data: message.data }))).catch(() => {});
          } catch { /* One observer must not interrupt the others. */ }
        }
      }
    },
    detach,
    onEvent(listener) {
      if (!closed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      for (const ws of [...identities.keys()]) {
        detach(ws);
        ws.close(1000, 'Machine hub closed');
      }
    },
  };
  return hub;
}

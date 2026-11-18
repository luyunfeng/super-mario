import { execFile } from 'node:child_process';
import type { Extension, Json } from '../../packages/plugin-sdk/src/index.ts';
import type { InboxOrigin, InboxThing } from '../../packages/protocol/src/index.ts';

export interface CommandInboxConfig {
  name?: string;
  command: string;
  args: string[];
  collectEnabled: boolean;
  timeoutMs?: number;
}
export interface CommandInboxRunOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxBuffer: number;
}
export type CommandInboxRun = (command: string, args: string[], options: CommandInboxRunOptions) => Promise<string>;
const DISPLAY_NAME = '命令收件箱';
const MAX_BYTES = 1024 * 1024;
const SOURCE_ID = 'messages';

/** Never include child errors, stdout, stderr, or command arguments in diagnostics. */
function failure(code: string, delivery: 'failed' | 'unknown' = 'failed'): Error {
  return Object.assign(new Error(`command-inbox: ${code}`), { code, delivery });
}
const runCommand: CommandInboxRun = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { ...options, encoding: 'utf8', shell: false, killSignal: 'SIGKILL' }, (error, stdout) => {
    if (error) reject(failure('command_failed', 'unknown'));
    else resolve(stdout);
  });
});
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw failure('invalid_schema');
}
function string(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) {
    throw failure('invalid_schema');
  }
  return value;
}
function origin(value: unknown, connector: string): InboxOrigin {
  if (value === undefined) return { kind: 'unknown', connector };
  if (!object(value)) throw failure('invalid_schema');
  keys(value, ['kind', 'connector', 'chatId', 'chatName', 'senderName', 'mentionedMe']);
  if (!['direct', 'group', 'agent', 'unknown'].includes(value.kind as string)) throw failure('invalid_schema');
  const result: InboxOrigin = { kind: value.kind as InboxOrigin['kind'], connector };
  for (const key of ['connector', 'chatId', 'chatName', 'senderName'] as const) {
    if (value[key] !== undefined) {
      const text = string(value[key], 1000).trim();
      if (text) result[key] = text;
    }
  }
  if (value.mentionedMe !== undefined) {
    if (typeof value.mentionedMe !== 'boolean') throw failure('invalid_schema');
    // Only explicit group provenance can carry personal-account mention evidence.
    if (result.kind === 'group') result.mentionedMe = value.mentionedMe;
  }
  return result;
}
function parseOutput(stdout: string, connector: string): InboxThing[] {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_BYTES) throw failure('output_too_large');
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw failure('invalid_json'); }
  if (object(value)) { keys(value, ['items']); value = value.items; }
  if (!Array.isArray(value) || value.length > 500) throw failure('invalid_schema');
  return value.map(item => {
    if (!object(item)) throw failure('invalid_schema');
    keys(item, ['thread', 'last', 'title', 'text', 'sender', 'receivedAt', 'origin']);
    const result: InboxThing = {
      thread: string(item.thread, 1000, true), last: string(item.last, 1000, true),
      title: string(item.title, 2000, true), text: string(item.text, 64 * 1024),
      origin: origin(item.origin, connector),
    };
    if (item.sender !== undefined) result.sender = string(item.sender, 1000);
    if (item.receivedAt !== undefined) {
      const date = string(item.receivedAt, 100);
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(date) || !Number.isFinite(Date.parse(date))) throw failure('invalid_schema');
      result.receivedAt = date;
    }
    return result;
  });
}

/** Trusted local wrapper configuration only. Tools cannot supply executable names or argv. */
export function createCommandInboxConnector(config: CommandInboxConfig, deps: { run?: CommandInboxRun } = {}) {
  // Copy argv so later mutation of the caller's config cannot change tool execution.
  const command = config.command;
  const args = Array.isArray(config.args) ? [...config.args] : undefined;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const name = typeof config.name === 'string' && config.name.trim() ? config.name.trim() : DISPLAY_NAME;
  let reason: string | undefined;
  if (config.collectEnabled !== true) reason = '采集未开启：需要 collectEnabled=true';
  else if (typeof command !== 'string' || !command.trim()) reason = '未配置 command';
  else if (command.includes('\0') || !args || args.length > 256 || args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || name.length > 1000 || name.includes('\0')) reason = '命令采集配置无效';
  const lifetime = new AbortController();
  let running = false;
  return {
    status() {
      const unavailable = lifetime.signal.aborted ? '插件已关闭' : reason;
      return { id: 'command-inbox', name, sourceId: SOURCE_ID, available: !unavailable,
        automatic: false, ...(unavailable ? { reason: unavailable } : {}) };
    },
    close() { lifetime.abort(); },
    async collect(signal: AbortSignal): Promise<InboxThing[]> {
      if (lifetime.signal.aborted) throw failure('closed');
      if (reason) throw failure(reason);
      if (signal.aborted) throw failure('cancelled', 'unknown');
      if (running) throw failure('collection_in_progress');
      running = true;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => { controller.abort(); reject(failure('cancelled', 'unknown')); };
        signal.addEventListener('abort', cancel, { once: true });
        lifetime.signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(failure('timeout', 'unknown')); }, timeoutMs);
      });
      try {
        const stdout = await Promise.race([
          Promise.resolve().then(() => {
            if (controller.signal.aborted) throw failure('cancelled', 'unknown');
            return (deps.run ?? runCommand)(command, args!, { signal: controller.signal, timeoutMs, maxBuffer: MAX_BYTES });
          }),
          cancelled,
        ]).catch(error => {
          if (error?.code === 'cancelled' || error?.code === 'timeout') throw failure(error.code, 'unknown');
          throw failure('command_failed', 'unknown');
        });
        if (signal.aborted || lifetime.signal.aborted) throw failure('cancelled', 'unknown');
        return parseOutput(stdout, name);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        lifetime.signal.removeEventListener('abort', cancel);
        running = false;
      }
    },
  };
}

export default {
  id: 'command-inbox', name: DISPLAY_NAME, capabilities: ['connectors', 'tools'],
  permissions: ['service.use:core.inbox.ingest', 'contribute:tools', 'contribute:connectors'],
  activate(context) {
    const connector = createCommandInboxConnector(context.config as unknown as CommandInboxConfig);
    context.defer(() => connector.close());
    context.contribute('connectors', 'command-inbox', connector.status());
    context.contribute('tools', 'command-inbox/collect', {
      name: 'command_inbox_collect', description: '运行已配置的本地采集 wrapper，将消息导入收件箱。未启用时失败；中断结果未知，不自动重试。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(args, signal) {
        if (!object(args) || Object.keys(args).length) throw failure('unexpected_arguments');
        const items = await connector.collect(signal);
        if (signal.aborted) throw failure('cancelled', 'unknown');
        // The host owns namespace, persistence, and subsequent processing policy.
        try {
          return await context.use('core.inbox.ingest', { sourceId: SOURCE_ID, items } as unknown as Json);
        } catch { throw failure('ingest_failed', 'unknown'); }
      },
    });
  },
} satisfies Extension;

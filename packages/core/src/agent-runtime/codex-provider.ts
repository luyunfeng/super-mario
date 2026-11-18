import { readCodexModelConfig } from './codex-model-config.ts';
import { codexConfigArgs, codexTextItem } from '../../../protocol/src/codex-model-policy.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools,
  type AssistantMessage, type StreamFunction, type SimpleStreamOptions,
} from '@earendil-works/pi-ai';

const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const schema = {
  type: 'object', additionalProperties: false, required: ['text', 'toolCalls'],
  properties: {
    text: { type: 'string' },
    toolCalls: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['name', 'arguments'],
        properties: { name: { type: 'string' }, arguments: { type: 'string' } },
      },
    },
  },
};
const instructions = [
  'You are the model provider for a pi agent, not an independent coding agent.',
  'Use only the supplied conversation, systemPrompt and tool definitions to decide the next response.',
  'Do not use your own tools, run commands, read project files, browse, or start another agent.',
  'All work and tool execution belongs to the parent pi agent. Request its tools only in toolCalls.',
  'Return ONLY strict JSON: {"text":string,"toolCalls":[{"name":string,"arguments":string}]}.',
  'Each arguments string must encode a JSON object. Use only names from the supplied tools.',
  'Use an empty toolCalls array for a final text answer. Never pretend a requested tool already ran.',
].join('\n');

class ProviderFailure extends Error {}
function fail(message: string): never { throw new ProviderFailure(message); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function parseAnswer(raw: string, allowed: Set<string>) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail('Codex CLI returned invalid JSON.'); }
  if (!object(value) || Object.keys(value).length !== 2 || typeof value.text !== 'string' || !Array.isArray(value.toolCalls)) {
    fail('Codex CLI returned an invalid response shape.');
  }
  const toolCalls = value.toolCalls.map((call: unknown) => {
    if (!object(call) || Object.keys(call).length !== 2 || typeof call.name !== 'string' || typeof call.arguments !== 'string') {
      fail('Codex CLI returned an invalid tool call.');
    }
    if (!allowed.has(call.name)) fail('Codex CLI requested an unavailable tool.');
    let args: unknown;
    try { args = JSON.parse(call.arguments); } catch { fail('Codex CLI returned invalid tool arguments.'); }
    if (!object(args)) fail('Codex CLI tool arguments must be a JSON object.');
    return { name: call.name, arguments: args, encoded: call.arguments };
  });
  return { text: value.text, toolCalls };
}

/** One process per model turn. No session resume or second agent loop lives here. */
async function runCLI(command: string, modelId: string, prompt: string, options: SimpleStreamOptions | undefined, configDir?: string) {
  const signal = options?.signal;
  if (signal?.aborted) fail('Codex CLI request aborted.');
  const directory = await mkdtemp(join(tmpdir(), 'super-mario-codex-'));
  try {
    await chmod(directory, 0o700);
    const schemaPath = join(directory, 'schema.json');
    const answerPath = join(directory, 'answer.json');
    await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    await writeFile(answerPath, '', { mode: 0o600 });
    if (signal?.aborted) fail('Codex CLI request aborted.');
    const env = { ...process.env, ...options?.env, ...(configDir ? { CODEX_HOME: configDir } : {}) };
    let config;
    try { config = await readCodexModelConfig(command, directory, env, signal); }
    catch { fail(signal?.aborted ? 'Codex CLI request aborted.' : 'Codex CLI configuration preflight failed.'); }
    const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json',
      ...codexConfigArgs(config), '--output-schema', schemaPath, '--output-last-message', answerPath];
    if (modelId !== 'default') args.push('--model', modelId);
    args.push('--', '-');
    await new Promise<void>((resolve, reject) => {
      // Empty private cwd avoids loading project instructions or exposing the project's working tree.
      // Read-only is a CLI sandbox policy, not a guarantee against reading arbitrary host files.
      let child;
      try {
        child = spawn(command, args, {
          cwd: directory, env,
          stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        });
      } catch { fail('Codex CLI could not start.'); }
      let failure: ProviderFailure | undefined;
      let closed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (force: boolean) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
          else child.kill(force ? 'SIGKILL' : 'SIGTERM');
        } catch { /* A concurrently exited process needs no further signal. */ }
      };
      const stop = (reason: string) => {
        if (failure || closed) return;
        failure = new ProviderFailure(reason);
        kill(false);
        killTimer = setTimeout(() => kill(true), 500);
      };
      const abort = () => stop('Codex CLI request aborted.');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timeout = setTimeout(() => stop('Codex CLI exceeded the 120 second time limit.'), TIMEOUT_MS);
      // stdout/stderr may include prompts and secrets. Count and discard them; never include them in errors.
      let outputBytes = 0;
      const count = (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) stop('Codex CLI output exceeded the size limit.');
      };
      let jsonl = '';
      child.stdout.setEncoding('utf8');
      const inspect = (line: string) => {
        if (!line.trim() || failure) return;
        try {
          const event = JSON.parse(line);
          if ((typeof event.type === 'string' && event.type.startsWith('item.') && !codexTextItem(event.item?.type)) ||
              event.method === 'item/tool/requestUserInput' || (event.id !== undefined && event.method)) {
            stop('Codex CLI attempted native tool use.');
          }
        } catch { stop('Codex CLI returned invalid JSONL.'); }
      };
      child.stdout.on('data', (chunk: string) => {
        count(Buffer.from(chunk));
        if (failure) return;
        jsonl += chunk;
        let index: number;
        while ((index = jsonl.indexOf('\n')) >= 0 && !failure) {
          inspect(jsonl.slice(0, index)); jsonl = jsonl.slice(index + 1);
        }
      });
      child.stderr.on('data', count);
      const sizeCheck = setInterval(() => {
        void stat(answerPath).then(info => {
          if (info.size > MAX_ANSWER_BYTES) stop('Codex CLI answer exceeded the size limit.');
        }).catch(() => stop('Codex CLI answer file is unavailable.'));
      }, 100);
      child.on('error', () => stop('Codex CLI could not start.'));
      child.stdin.on('error', () => stop('Codex CLI input could not be delivered.'));
      child.on('close', code => {
        inspect(jsonl);
        closed = true;
        clearTimeout(timeout);
        clearInterval(sizeCheck);
        if (killTimer) { clearTimeout(killTimer); kill(true); }
        signal?.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new ProviderFailure('Codex CLI exited unsuccessfully.'));
        else resolve();
      });
      child.stdin.end(prompt);
    });
    if (signal?.aborted) fail('Codex CLI request aborted.');
    // A bounded read also covers a last-moment oversized file, without allocating the whole file.
    const file = await open(answerPath, 'r');
    try {
      const bytes = Buffer.alloc(MAX_ANSWER_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_ANSWER_BYTES) fail('Codex CLI answer exceeded the size limit.');
      return bytes.toString('utf8', 0, length);
    } finally { await file.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function registerCodexProvider(runtime: ModelRuntime, modelId: string, options?: { command?: string; configDir?: string }) {
  const streamSimple: StreamFunction = (model, context, request) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), content: [], stopReason: 'pending',
      // CLI does not expose reliable per-answer usage/cost. Zero means unavailable, not free inference.
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    void (async () => {
      try {
        const tools = getCurrentTools(context.messages);
        const payload = {
          systemPrompt: getCurrentSystemPrompt(context.messages),
          messages: context.messages.filter(item => item.role !== 'system'), tools,
        };
        const replacement = await request?.onPayload?.(payload, model);
        const prompt = `${instructions}\n\n${JSON.stringify(replacement === undefined ? payload : replacement)}`;
        const raw = await runCLI(options?.command ?? 'codex', model.id, prompt, request, options?.configDir);
        // There is no HTTP response; this status describes successful CLI transport only.
        await request?.onResponse?.({ status: 200, headers: {} }, model);
        const answer = parseAnswer(raw, new Set(tools.map(tool => tool.name)));
        await request?.onProviderStreamEvent?.(answer, model);
        if (request?.signal?.aborted) fail('Codex CLI request aborted.');
        stream.push({ type: 'start', partial: message });
        if (answer.text) {
          message.content.push({ type: 'text', text: '' });
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          message.content[0] = { type: 'text', text: answer.text };
          stream.push({ type: 'text_delta', contentIndex: 0, delta: answer.text, partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: answer.text, partial: message });
        }
        for (const call of answer.toolCalls) {
          const contentIndex = message.content.length;
          const block = { type: 'toolCall' as const, id: randomUUID(), name: call.name, arguments: {} };
          message.content.push(block);
          stream.push({ type: 'toolcall_start', contentIndex, partial: message });
          block.arguments = call.arguments;
          stream.push({ type: 'toolcall_delta', contentIndex, delta: call.encoded, partial: message });
          stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: message });
        }
        message.stopReason = answer.toolCalls.length ? 'toolUse' : 'stop';
        stream.push({ type: 'done', reason: message.stopReason, message });
      } catch (error) {
        message.content = [];
        message.stopReason = request?.signal?.aborted ? 'aborted' : 'error';
        message.errorMessage = error instanceof ProviderFailure ? error.message : 'Codex CLI provider failed.';
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      } finally { stream.end(); }
    })();
    return stream;
  };
  runtime.registerProvider('codex-cli', {
    api: 'openai-completions', apiKey: 'local-cli', baseUrl: 'http://localhost',
    models: [{ id: modelId, name: `Codex CLI (${modelId})`, input: ['text'], reasoning: false,
      contextWindow: 128_000, maxTokens: 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple,
  });
}

import type { Store } from '../../plugin-sdk/src/index.ts';
import type { Message, Project } from '../../protocol/src/index.ts';

export const TRACE_COLLECTION = 'agent.traces';
const MAX_CONTENT_CHARS = 131072;
const MAX_TURNS_PER_SESSION = 150;

export type TraceCategory =
  | 'system'
  | 'tools'
  | 'memory'
  | 'snapshot'
  | 'history'
  | 'tool_result'
  | 'thinking'
  | 'response';

export interface AgentTraceRuntimeMeta {
  transport: 'http' | 'codex-cli' | 'sdk';
  method?: string;
  baseUrl?: string;
  endpoint?: string;
  apiFormat?: string;
  account?: string;
  tokenSource?: string;
  cliCommand?: string;
  cliConfigDir?: string;
  cwd?: string;
}

export interface AgentTraceContextItem {
  id: string;
  category: TraceCategory;
  label: string;
  tag?: string;
  count?: number;
  tokens: number;
  chars: number;
  content: string;
  truncated?: boolean;
}

export interface AgentTraceToolCall {
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
  startedAt: string;
  finishedAt?: string;
  tokens: number;
}

export interface AgentTraceThinkingBlock {
  index: number;
  text: string;
  tokens: number;
}

export interface AgentTurnTrace {
  id: string;
  conversationId: string;
  userMessageId: string;
  projectId?: string;
  status: 'pending' | 'done' | 'failed';
  provider: string;
  model: string;
  contextWindow: number;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  userText: string;
  assistantText: string;
  runtime?: AgentTraceRuntimeMeta;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    estimated: boolean;
  };
  summary: Record<TraceCategory, number>;
  contextItems: AgentTraceContextItem[];
  thinkingBlocks: AgentTraceThinkingBlock[];
  toolCalls: AgentTraceToolCall[];
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x3000 && code <= 0x303f)) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.max(1, Math.ceil(cjk / 1.4 + other / 3.8));
}

/** Local personal inspector keeps full raw text intact; only caps extreme blobs. */
export function boundTraceText(raw: string, limit = MAX_CONTENT_CHARS): { text: string; truncated: boolean } {
  const value = raw ?? '';
  if (value.length > limit) return { text: value.slice(0, limit) + '\n…（超出单块上限已截断）', truncated: true };
  return { text: value, truncated: false };
}

export function summarizeTrace(items: readonly AgentTraceContextItem[]): Record<TraceCategory, number> {
  const summary: Record<TraceCategory, number> = {
    system: 0, tools: 0, memory: 0, snapshot: 0, history: 0, tool_result: 0, thinking: 0, response: 0,
  };
  for (const item of items) summary[item.category] = (summary[item.category] ?? 0) + item.tokens;
  return summary;
}

// Request URLs can carry credentials in userinfo, query parameters, or fragments.
function traceUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return url.origin + url.pathname;
  } catch {
    return undefined;
  }
}

export function formatTraceRequest(runtime: AgentTraceRuntimeMeta, model: Pick<AgentTurnTrace, 'provider' | 'model'>): string {
  const endpoint = traceUrl(runtime.endpoint);
  const baseUrl = traceUrl(runtime.baseUrl);
  return [
    `Transport: ${runtime.transport}`,
    ...(endpoint ? [`Request: ${runtime.method ?? 'POST'} ${endpoint}`] : []),
    ...(baseUrl ? [`Base URL: ${baseUrl}`] : []),
    `Model: ${model.provider}/${model.model} (${runtime.apiFormat ?? 'sdk'})`,
    `Account: ${runtime.account ?? 'local'}`,
    `Token Source: ${runtime.tokenSource ?? 'unknown'}`,
    ...(runtime.cliCommand ? [`CLI Command: ${runtime.cliCommand}`] : []),
    ...(runtime.cliConfigDir ? [`CLI Config Dir: ${runtime.cliConfigDir}`] : []),
    ...(runtime.cwd ? [`Workspace CWD: ${runtime.cwd}`] : []),
  ].join('\n');
}

// Older traces stored the model key in both runtime.token and the rendered request block.
// Rebuild that block from allowlisted metadata even when only the old text survives.
function publicTurnTrace(trace: AgentTurnTrace): AgentTurnTrace {
  const rt = trace.runtime;
  const runtime: AgentTraceRuntimeMeta | undefined = rt && {
    transport: rt.transport, method: rt.method, baseUrl: traceUrl(rt.baseUrl), endpoint: traceUrl(rt.endpoint),
    apiFormat: rt.apiFormat, account: rt.account, tokenSource: rt.tokenSource,
    cliCommand: rt.cliCommand, cliConfigDir: rt.cliConfigDir, cwd: rt.cwd,
  };
  const contextItems = trace.contextItems.map(item => {
    if (item.id !== 'req-meta') return item;
    const raw = runtime ? formatTraceRequest(runtime, trace) : '调用元数据未记录';
    const { text, truncated } = boundTraceText(raw);
    return { ...item, label: '本次调用 · 账号 / HTTP 请求 / 凭据来源', content: text, chars: raw.length, tokens: estimateTokens(raw), truncated };
  });
  return { ...trace, runtime, contextItems, summary: summarizeTrace(contextItems) };
}

export function saveTurnTrace(store: Pick<Store, 'put' | 'list' | 'remove'>, trace: AgentTurnTrace) {
  try {
    store.put(TRACE_COLLECTION, trace.id, publicTurnTrace(trace));
    const sameSession = store.list<AgentTurnTrace>(TRACE_COLLECTION)
      .filter(item => item.conversationId === trace.conversationId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (sameSession.length > MAX_TURNS_PER_SESSION) {
      for (const old of sameSession.slice(MAX_TURNS_PER_SESSION)) {
        store.remove(TRACE_COLLECTION, old.id);
      }
    }
  } catch {
    // Isolated read-only runtimes use a messages-only store wrapper; skip trace persistence safely.
  }
}

function conversationMeta(store: Pick<Store, 'list' | 'get'>, conversationId: string): { title: string; kind: string } {
  if (conversationId === 'main') return { title: '主对话（pi 总调度官）', kind: 'main' };
  if (conversationId === 'supervisor') return { title: '后台督办（Supervisor）', kind: 'supervisor' };
  const projectMatch = conversationId.match(/^project:([^:]+):(work|memory)$/);
  if (projectMatch) {
    const project = store.get<Project>('projects', projectMatch[1]!);
    const name = project?.name || projectMatch[1]!;
    return { title: `${name} · ${projectMatch[2] === 'memory' ? '记忆整理' : '项目对话'}`, kind: 'project' };
  }
  if (conversationId.startsWith('bot:')) return { title: `飞书机器人 · ${conversationId.slice(4, 20)}`, kind: 'bot' };
  if (conversationId.startsWith('inbox-handling:')) return { title: `收件处理 · ${conversationId.slice(15, 25)}`, kind: 'inbox' };
  return { title: conversationId, kind: 'other' };
}

export function listTraceSessions(store: Pick<Store, 'list' | 'get'>) {
  const traces = store.list<AgentTurnTrace>(TRACE_COLLECTION);
  const messages = store.list<Message>('messages');
  const ids = new Set<string>(['main']);
  for (const t of traces) ids.add(t.conversationId);
  for (const m of messages) {
    if (m.conversationId && !m.conversationId.startsWith('inbox-classifier:')) ids.add(m.conversationId);
  }
  const sessions = [...ids].map(conversationId => {
    const ownTraces = traces
      .filter(t => t.conversationId === conversationId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const ownMessages = messages
      .filter(m => m.conversationId === conversationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = ownTraces[0];
    const meta = conversationMeta(store, conversationId);
    const lastAt = latest?.startedAt ?? ownMessages[0]?.createdAt ?? '';
    return {
      conversationId,
      title: meta.title,
      kind: meta.kind,
      turnCount: ownTraces.length,
      messageCount: ownMessages.length,
      lastAt,
      latestTurnId: latest?.id,
      latestStatus: latest?.status ?? null,
      latestTokens: latest?.usage.totalTokens ?? 0,
      contextWindow: latest?.contextWindow ?? 128000,
      provider: latest?.provider ?? 'pi',
      model: latest?.model ?? '未记录',
      latestSummary: latest?.summary ?? null,
    };
  }).filter(s => s.conversationId === 'main' || s.turnCount > 0 || s.messageCount > 0);

  sessions.sort((a, b) => {
    if (a.conversationId === 'main' && b.conversationId !== 'main') return -1;
    if (b.conversationId === 'main' && a.conversationId !== 'main') return 1;
    return b.lastAt.localeCompare(a.lastAt);
  });
  return sessions;
}

export function readTraceSession(store: Pick<Store, 'list' | 'get'>, conversationId: string) {
  const meta = conversationMeta(store, conversationId);
  const turns = store.list<AgentTurnTrace>(TRACE_COLLECTION)
    .filter(t => t.conversationId === conversationId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const messages = store.list<Message>('messages')
    .filter(m => m.conversationId === conversationId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-200)
    .map(m => ({
      id: m.id,
      role: m.role,
      origin: m.origin ?? null,
      status: m.status ?? 'done',
      text: m.text,
      createdAt: m.createdAt,
      hasTrace: Boolean(store.get<AgentTurnTrace>(TRACE_COLLECTION, m.id)),
    }));

  return {
    conversationId,
    title: meta.title,
    kind: meta.kind,
    turns: turns.map((t, index) => ({
      index: index + 1,
      id: t.id,
      userMessageId: t.userMessageId,
      status: t.status,
      provider: t.provider,
      model: t.model,
      contextWindow: t.contextWindow,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt ?? null,
      durationMs: t.durationMs ?? null,
      userPreview: t.userText.slice(0, 140),
      assistantPreview: t.assistantText.slice(0, 180),
      usage: t.usage,
      summary: t.summary,
      thinkingCount: t.thinkingBlocks.length,
      toolCallCount: t.toolCalls.length,
    })),
    messages,
  };
}

export function readTurnTrace(store: Pick<Store, 'get'>, turnId: string): AgentTurnTrace | undefined {
  const trace = store.get<AgentTurnTrace>(TRACE_COLLECTION, turnId);
  return trace && publicTurnTrace(trace);
}

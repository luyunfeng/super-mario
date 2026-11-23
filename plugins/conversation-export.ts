import { nativeSource } from './native-conversation-source.ts';
import type { Extension, Json, Store } from '../packages/plugin-sdk/src/index.ts';
import type { ExecutionProgress, Message, NativeExportSource, Project } from '../packages/protocol/src/index.ts';

const phases: Record<ExecutionProgress['phase'], string> = {
  starting: '正在启动', thinking: '正在分析', tool: '正在调用工具', responding: '正在输出', waiting: '等待后续事件',
};

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

type ToolObservation = { name: string; startedAt?: string; finishedAt?: string; isError?: boolean };
type TurnObservations = { id: string; conversationId: string; userMessageId: string; toolCalls?: ToolObservation[] };

// Headings contain display names, which may literally include Markdown syntax.
function headingText(name: string) {
  return name.replace(/[\\`*_\[\]<>~&]/g, '\\$&');
}

function timestamp(value?: string): string {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function workSteps(store: Store, message: Message, userIds: Set<string>): string[] {
  const lines: string[] = [];
  const progress = message.progress;
  if (progress && Object.hasOwn(phases, progress.phase)) {
    const at = timestamp(progress.observedAt);
    lines.push(`> 工作进度：${phases[progress.phase]}${at ? ' · ' + at : ''}`, '');
  }
  if (!message.replyTo || !userIds.has(message.replyTo)) return lines;
  // Read only this turn, and bind it to both persisted messages before using it.
  // Runtime metadata, reasoning, raw tool input and output are private to the inspector.
  const trace = store.get<TurnObservations>('agent.traces', message.id);
  if (trace?.id !== message.id || trace.conversationId !== message.conversationId
    || trace.userMessageId !== message.replyTo || !Array.isArray(trace.toolCalls)) return lines;
  for (const call of trace.toolCalls) {
    if (!call || typeof call !== 'object') continue;
    const name = typeof call.name === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(call.name) ? call.name : '工具';
    const start = timestamp(call.startedAt);
    const end = timestamp(call.finishedAt);
    const status = call.isError === true ? '失败' : end && call.isError === false ? '成功' : '未记录结果';
    lines.push(`- 工具 \`${name}\` · ${status}${start ? ' · 开始 ' + start : ''}${end ? ' · 结束 ' + end : ''}`);
  }
  if (trace.toolCalls.length) lines.push('');
  return lines;
}

type ReadNative = (source: NativeExportSource, includeWork: boolean, signal: AbortSignal) =>
  Promise<{ markdown: string; filename: string; count: number; hasContent?: boolean }>;

type ReadAssistant = () => Promise<{ name: string } | undefined>;

async function markdown(store: Store, input: Json, signal: AbortSignal, readNative?: ReadNative, readAssistant?: ReadAssistant) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.includeWork !== 'boolean'
    || Object.keys(input).some(key => key !== 'projectId' && key !== 'includeWork' && key !== 'native'))
    fail(400, '对话导出参数无效');
  if (Object.hasOwn(input, 'native')) {
    if (Object.hasOwn(input, 'projectId')) fail(400, '原生会话不能同时指定项目');
    const source = nativeSource(input.native);
    if (!readNative) fail(503, '原生会话导出未配置');
    return readNative(source, input.includeWork, signal);
  }
  let title = '主对话';
  let conversationId = 'main';
  if (input.projectId !== undefined) {
    if (typeof input.projectId !== 'string' || !input.projectId.trim()) fail(400, '项目 ID 无效');
    const project = store.get<Project>('projects', input.projectId);
    if (!project) fail(404, '项目不存在');
    conversationId = `project:${project.id}:work`;
    title = `项目工作对话 · ${project.name.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()}`;
  }

  const profile = conversationId === 'main' ? await readAssistant?.() : undefined;
  signal.throwIfAborted();
  const speaker = conversationId === 'main' ? profile?.name ?? '主 Agent' : '项目助手';

  // Store.list reads the complete SQLite collection in insertion order. Updates
  // to pending messages keep their original position, including timestamp ties.
  const messages = store.list<Message>('messages').filter(message =>
    message.conversationId === conversationId && (input.projectId === undefined || message.projectId === undefined || message.projectId === input.projectId)
    && (message.role === 'user' || message.role === 'assistant'));
  const userIds = new Set(input.includeWork ? messages.filter(message => message.role === 'user').map(message => message.id) : []);
  const lines = [`# ${headingText(title)}`, '', `导出时间：${new Date().toISOString()}`, '', `共 ${messages.length} 条消息`, ''];
  for (const message of messages) {
    const author = message.origin === 'result' ? '执行结果' : message.origin === 'notification' ? '系统提醒'
      : message.role === 'assistant' ? speaker : '用户';
    const status = message.status === 'failed' ? ' · 失败' : message.status === 'pending' ? ' · 未完成' : '';
    lines.push(`## ${headingText(author)} · ${message.createdAt}${status}`, '', message.text, '');
    if (input.includeWork && message.role === 'assistant') {
      for (const line of workSteps(store, message, userIds)) lines.push(line);
    }
  }
  // A fixed prefix avoids device names. At 48 code points even four-byte
  // characters leave room for the prefix and extension on common filesystems.
  const stem = Array.from(title.replace(/[^\p{L}\p{N}_-]+/gu, '-')).slice(0, 48).join('').replace(/-+$/, '');
  return { filename: `super-mario-${stem}.md`, markdown: lines.join('\n'), count: messages.length };
}

export function createConversationExport(readNative?: ReadNative, readAssistant?: ReadAssistant): Extension {
  return {
    id: 'conversation-export', name: '对话导出', capabilities: ['conversation.export'],
    permissions: ['service.provide:conversation-export.markdown', 'store.read'],
    activate(context) {
      context.provide('conversation-export.markdown', (input, signal) => markdown(context.store, input, signal, readNative, readAssistant));
    },
  };
}

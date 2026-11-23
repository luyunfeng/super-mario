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

type ReadPrivate = (botId: string, threadId: string) => { title: string; messages: Message[] };
type ReadWeb = (threadId:string, projectId?:string) => { title:string; messages:Message[] };
type ReadAssistant = () => Promise<{ name: string } | undefined>;

async function markdown(store: Store, input: Json, signal: AbortSignal, readNative?: ReadNative, readAssistant?: ReadAssistant, readPrivate?: ReadPrivate, readWeb?: ReadWeb) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.includeWork !== 'boolean'
    || Object.keys(input).some(key => key !== 'projectId' && key !== 'includeWork' && key !== 'native' && key !== 'botId' && key !== 'threadId' && key !== 'webThreadId'))
    fail(400, '对话导出参数无效');
  let thread: ReturnType<ReadPrivate> | undefined;
  const web = Object.hasOwn(input, 'webThreadId');
  if (web) {
    if (Object.hasOwn(input, 'native') || Object.hasOwn(input, 'botId') || Object.hasOwn(input, 'threadId')
        || typeof input.webThreadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.webThreadId)
        || (input.projectId !== undefined && (typeof input.projectId !== 'string' || !input.projectId.trim())))
      fail(400, '独立 Web 对话导出参数无效');
    if (!readWeb) fail(503, '独立 Web 对话服务尚未连接');
    thread = readWeb(input.webThreadId.toLowerCase(), input.projectId);
  }
  if (Object.hasOwn(input, 'botId') || Object.hasOwn(input, 'threadId')) {
    if (Object.hasOwn(input, 'projectId') || Object.hasOwn(input, 'native')
      || typeof input.botId !== 'string' || !input.botId.trim()
      || typeof input.threadId !== 'string' || !/^[a-f0-9]{64}$/.test(input.threadId))
      fail(400, '独立对话导出参数无效');
    if (!readPrivate) fail(503, '飞书独立对话服务尚未连接');
    thread = readPrivate(input.botId, input.threadId);
  }
  if (Object.hasOwn(input, 'native')) {
    if (Object.hasOwn(input, 'projectId')) fail(400, '原生会话不能同时指定项目');
    const source = nativeSource(input.native);
    if (!readNative) fail(503, '原生会话导出未配置');
    return readNative(source, input.includeWork, signal);
  }
  let workspace: Project['workspace'];
  let title = thread?.title ?? '主对话';
  let conversationId = 'main';
  if (!web && input.projectId !== undefined) {
    if (typeof input.projectId !== 'string' || !input.projectId.trim()) fail(400, '项目 ID 无效');
    const project = store.get<Project>('projects', input.projectId);
    if (!project) fail(404, '项目不存在');
    conversationId = `project:${project.id}:work`;
    workspace = project.workspace;
    title = `项目工作对话 · ${project.name.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()}`;
  }

  const profile = !thread && conversationId === 'main' ? await readAssistant?.() : undefined;
  signal.throwIfAborted();
  const speaker = thread ? '助手' : conversationId === 'main' ? profile?.name ?? '主 Agent' : '项目助手';

  // Store.list reads the complete SQLite collection in insertion order. Updates
  // to pending messages keep their original position, including timestamp ties.
  const messages = thread?.messages ?? store.list<Message>('messages').filter(message =>
    message.conversationId === conversationId && (input.projectId === undefined || message.projectId === undefined || message.projectId === input.projectId)
    && (message.role === 'user' || message.role === 'assistant'));
  const userIds = new Set(input.includeWork ? messages.filter(message => message.role === 'user').map(message => message.id) : []);
  const lines = [`# ${headingText(title)}`, '', `导出时间：${new Date().toISOString()}`, ''];
  if (workspace) {
    // This binding can change during the life of a project. It describes the export's context.
    const label = (value: string) => headingText(value.replace(/[\p{Cc}\p{Cf}]/gu, ' '));
    lines.push('导出时绑定的电脑：' + label(workspace.machineId), '', '导出时绑定的目录：' + label(workspace.cwd), '');
  }
  lines.push(`共 ${messages.length} 条消息`, '');
  for (const message of messages) {
    const author = message.origin === 'result' ? '执行结果' : message.origin === 'notification' ? '系统提醒'
      : message.role === 'assistant' ? speaker : '用户';
    const status = message.status === 'failed' ? ' · 失败' : message.status === 'pending' ? ' · 未完成' : '';
    lines.push(`## ${headingText(author)} · ${message.createdAt}${status}`, '', message.text, '');
    if (input.includeWork && message.role === 'assistant') {
      const steps = workSteps(store, message, userIds);
      if (steps.length) {
        lines.push('<details><summary>公开工作步骤</summary>', '');
        for (const line of steps) lines.push(line);
        lines.push('</details>', '');
      }
    }
  }
  // A fixed prefix avoids device names. At 48 code points even four-byte
  // characters leave room for the prefix and extension on common filesystems.
  const stem = Array.from(title.replace(/[^\p{L}\p{N}_-]+/gu, '-')).slice(0, 48).join('').replace(/-+$/, '');
  return { filename: `super-mario-${stem}.md`, markdown: lines.join('\n'), count: messages.length };
}

export function createConversationExport(readNative?: ReadNative, readAssistant?: ReadAssistant, readPrivate?: ReadPrivate, readWeb?: ReadWeb): Extension {
  return {
    id: 'conversation-export', name: '对话导出', capabilities: ['conversation.export'],
    permissions: ['service.provide:conversation-export.markdown', 'store.read'],
    activate(context) {
      context.provide('conversation-export.markdown', (input, signal) => markdown(context.store, input, signal, readNative, readAssistant, readPrivate, readWeb));
    },
  };
}

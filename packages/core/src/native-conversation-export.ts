import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { MachineClient } from '../../plugin-sdk/src/index.ts';
import type { NativeExportSource, NativeFavoriteMessage } from '../../protocol/src/index.ts';
import { readNativeRecords } from './native-transcript-reader.ts';

// Progress belongs to the requesting export, including overlapping reads of the same session.
type ExportProgress = (bytes: number, total: number, messages: number) => void;
export const nativeExportProgress = new AsyncLocalStorage<ExportProgress>();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type ToolStep = { name: string; result: '未记录结果' | '已返回结果' | '失败' | '成功' | '结果无法唯一对应' };
type Part = string | ToolStep;

// Tool names reach the export only after the public-name check below.
function toolBlock(step: ToolStep) {
  return '<details><summary>公开工作步骤</summary>\n\n> 工具调用：' + step.name + ' · ' + step.result + '\n\n</details>';
}

/** Read an already persisted session through the node's exact, read-only lookup. */
async function readConversation(
  machines: MachineClient | undefined, source: NativeExportSource, signal: AbortSignal,
  message: (index: number, role: 'user' | 'assistant', parts: Part[], createdAt: string | null, raw: unknown) => void,
  tool?: (step: ToolStep, at: string | null) => void,
  progress?: ExportProgress,
) {
  const { machineId, executorId, nativeSessionId, cwd } = source;
  const machine = machines?.list().find(item => item.id === machineId && item.online);
  if (!machines || !machine) throw Object.assign(new Error('执行机离线'), { status: 503 });
  if (!machine.capabilities.includes('agents.transcript')) throw Object.assign(new Error('执行机尚不支持完整会话读取'), { status: 409 });
  let count = 0;
  function publicToolName(value: unknown): value is string {
    return typeof value === 'string' && /^[\w.:-]{1,80}$/.test(value);
  }
  // Keep references to public steps so a later receipt can update the original position.
  const calls = new Map<string, ToolStep>();
  function observeCall(name: string, kind: string, id: unknown) {
    const step: ToolStep = { name, result: '未记录结果' };
    if (typeof id === 'string' && id) {
      const key = kind + ':' + id, previous = calls.get(key);
      if (previous) previous.result = step.result = '结果无法唯一对应';
      calls.set(key, step);
    }
    return step;
  }
  function observeResult(kind: string, id: unknown, isError?: unknown) {
    if (typeof id !== 'string' || !id) return;
    const step = calls.get(kind + ':' + id);
    if (step) step.result = step.result !== '未记录结果' ? '结果无法唯一对应'
      : isError === true ? '失败' : isError === false ? '成功' : '已返回结果';
  }
  function checkConnection() {
    const current = machines?.list().find(item => item.id === machineId);
    if (!current?.online || current.connectedAt !== machine?.connectedAt || current.agentInstanceId !== machine?.agentInstanceId) {
      throw new Error('执行机连接已改变，请重新导出');
    }
  }
  await readNativeRecords(async (offset, snapshot) => {
    checkConnection();
    const page=await machines.call(machineId, 'agents.transcript', { executorId, nativeSessionId, cwd, offset, ...(snapshot && { snapshot }) });
    checkConnection();
    return page;
  }, raw => {
    const row = record(raw);
    const time = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    const at = Number.isFinite(time) ? new Date(time).toISOString() : null;
    let role: unknown, content: unknown;
    if (executorId === 'codex') {
      if (row.type === 'session_meta' && record(row.payload).id !== nativeSessionId) throw new Error('会话标识已改变');
      if (row.type !== 'response_item') return;
      const payload = record(row.payload);
      if (tool && (payload.type === 'function_call' || payload.type === 'custom_tool_call') && publicToolName(payload.name)) {
        tool(observeCall(payload.name, payload.type, payload.call_id), at);
      }
      if (tool && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')) {
        observeResult(payload.type.slice(0, -'_output'.length), payload.call_id);
      }
      if (payload.type !== 'message') return;
      role = payload.role; content = payload.content;
    } else {
      if (row.sessionId !== nativeSessionId || row.isMeta === true || row.isSidechain === true) return;
      role = row.type; content = record(row.message).content;
    }
    if (role !== 'user' && role !== 'assistant') return;
    const paragraphs: Part[] = [];
    let hasMessage = false;
    function appendText(text: string) {
      paragraphs.push(text);
      if (text.trim()) hasMessage = true;
    }
    if (typeof content === 'string') appendText(content);
    if (Array.isArray(content)) for (const item of content) {
      const block = record(item);
      if (['input_text', 'output_text', 'text'].includes(String(block.type)) && typeof block.text === 'string') appendText(block.text);
      if (['input_image', 'output_image', 'image'].includes(String(block.type))) appendText('[图像附件]');
      if (tool && role === 'user' && block.type === 'tool_result') observeResult('tool_use', block.tool_use_id, block.is_error);
      if (tool && role === 'assistant' && block.type === 'tool_use' && publicToolName(block.name)) {
        // Mixed records retain their block order under a single message heading.
        paragraphs.push(observeCall(block.name, 'tool_use', block.id));
      }
    }
    if (!hasMessage) {
      for (const part of paragraphs) if (typeof part !== 'string') tool?.(part, at);
      return;
    }
    message(count++, role, paragraphs, at, row);
  }, signal, (bytes, total) => { if (bytes < total) progress?.(bytes, total, count); });
  return { count, machineName: machine.name };
}

// Bind positional records to both the source and the raw record. Replacing a row at
// the same index cannot silently retarget a favorite or a previously selected excerpt.
function nativeFingerprint(source: NativeExportSource, index: number, raw: unknown) {
  return createHash('sha256').update(JSON.stringify([
    source.machineId, source.executorId, source.nativeSessionId, source.cwd, index, raw,
  ])).digest('hex');
}

export async function readNativeShareMessages(
  machines: MachineClient | undefined, source: NativeExportSource,
  selection: {offset:number} | {ids:string[]}, signal: AbortSignal,
) {
  const wanted = 'ids' in selection ? new Set(selection.ids) : undefined;
  const offset = 'offset' in selection ? selection.offset : 0;
  const items: {id:string;index:number;role:'user'|'assistant';text:string}[] = [];
  let selectedBytes = 0;
  const {count:total} = await readConversation(machines,source,signal,(index,role,parts,_at,raw)=>{
    if (!wanted && (index < offset || index >= offset + 25)) return;
    const id = nativeFingerprint(source,index,raw);
    if (wanted && !wanted.has(id)) return;
    const text = parts.join('\n');
    if (wanted) {
      selectedBytes += Buffer.byteLength(text);
      if (selectedBytes > 262144) throw Object.assign(new Error('分享摘录超过 256 KiB，请减少所选消息'),{status:400});
    }
    items.push({id,index,role,text});
  });
  return {items,total};
}

export async function readNativeFavoritePage(
  machines: MachineClient | undefined, source: NativeExportSource, offset: number, signal: AbortSignal,
) {
  const items: NativeFavoriteMessage[] = [];
  const { count: total } = await readConversation(machines, source, signal, (index, role, parts, createdAt, raw) => {
    if (index < offset || index - offset >= 25) return;
    const fingerprint = nativeFingerprint(source,index,raw);
    items.push({ index, fingerprint, role, text: parts.join('\n'), createdAt });
  });
  return { items, total };
}

export async function exportNativeConversation(
  machines: MachineClient | undefined, source: NativeExportSource, includeWork: boolean, signal: AbortSignal,
) {
  const { machineId, executorId, nativeSessionId, cwd } = source;
  const lines: Part[] = [];
  const agentName = executorId === 'codex' ? 'Codex' : 'Claude Code';
  let lastRole: 'user' | 'assistant' | undefined;
  function heading(role: 'user' | 'assistant', at: string | null) {
    // Native agents can emit several text and tool records within a single reply.
    if (role === 'assistant' && lastRole === role) return;
    lines.push('## ' + (role === 'user' ? '用户' : agentName) + (at ? ' · ' + at : ''), '');
    lastRole = role;
  }
  const { count, machineName } = await readConversation(machines, source, signal, (_, role, parts, at) => {
    heading(role, at);
    for (const part of parts) lines.push(part);
    lines.push('');
  }, includeWork ? (step, at) => {
    heading('assistant', at);
    lines.push(step, '');
  } : undefined, nativeExportProgress.getStore());
  const stem = Array.from(nativeSessionId.replace(/[^\p{L}\p{N}_-]+/gu, '-')).slice(0, 48).join('');
  const label = machineName?.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().replace(/[\\`*_\[\]<>~&]/g, '\\$&');
  return { filename: `super-mario-${executorId}-${stem}.md`, count, hasContent: lines.length > 0, markdown: [
    '# 原生会话 · ' + executorId, '', '会话：' + nativeSessionId, '电脑：' + (label || machineId), '电脑 ID：' + machineId, '目录：' + cwd, '导出时间：' + new Date().toISOString(), '', `共 ${count} 条消息`, '', lines.map(part => typeof part === 'string' ? part : '\n' + toolBlock(part) + '\n').join('\n'),
  ].join('\n') };
}

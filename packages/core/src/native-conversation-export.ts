import { createHash } from 'node:crypto';
import type { MachineClient } from '../../plugin-sdk/src/index.ts';
import type { NativeExportSource, NativeFavoriteMessage } from '../../protocol/src/index.ts';
import { readNativeRecords } from './native-transcript-reader.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Tool names reach the export only after the public-name check below.
function toolBlock(name: string) {
  return '<details><summary>公开工作步骤</summary>\n\n> 工具调用：' + name + '\n\n</details>';
}

/** Read an already persisted session through the node's exact, read-only lookup. */
async function readConversation(
  machines: MachineClient | undefined, source: NativeExportSource, signal: AbortSignal,
  message: (index: number, role: 'user' | 'assistant', text: string, createdAt: string | null, raw: unknown) => void,
  tool?: (name: string) => void,
) {
  const { machineId, executorId, nativeSessionId, cwd } = source;
  const machine = machines?.list().find(item => item.id === machineId && item.online);
  if (!machines || !machine) throw Object.assign(new Error('执行机离线'), { status: 503 });
  if (!machine.capabilities.includes('agents.transcript')) throw Object.assign(new Error('执行机尚不支持完整会话读取'), { status: 409 });
  let count = 0;
  function publicToolName(value: unknown): value is string {
    return typeof value === 'string' && /^[\w.:-]{1,80}$/.test(value);
  }
  await readNativeRecords((offset, snapshot) => {
    const current = machines.list().find(item => item.id === machineId);
    if (!current?.online || current.connectedAt !== machine.connectedAt || current.agentInstanceId !== machine.agentInstanceId) {
      throw new Error('执行机连接已改变，请重新导出');
    }
    return machines.call(machineId, 'agents.transcript', { executorId, nativeSessionId, cwd, offset, ...(snapshot && { snapshot }) });
  }, raw => {
    const row = record(raw);
    let role: unknown, content: unknown;
    if (executorId === 'codex') {
      if (row.type === 'session_meta' && record(row.payload).id !== nativeSessionId) throw new Error('会话标识已改变');
      if (row.type !== 'response_item') return;
      const payload = record(row.payload);
      if ((payload.type === 'function_call' || payload.type === 'custom_tool_call') && publicToolName(payload.name)) tool?.(payload.name);
      if (payload.type !== 'message') return;
      role = payload.role; content = payload.content;
    } else {
      if (row.sessionId !== nativeSessionId || row.isMeta === true || row.isSidechain === true) return;
      role = row.type; content = record(row.message).content;
    }
    if (role !== 'user' && role !== 'assistant') return;
    const paragraphs: string[] = [];
    const steps: string[] = [];
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
      if (tool && role === 'assistant' && block.type === 'tool_use' && publicToolName(block.name)) {
        // Mixed records retain their block order under a single message heading.
        steps.push(block.name);
        paragraphs.push('\n' + toolBlock(block.name) + '\n');
      }
    }
    if (!hasMessage) {
      for (const name of steps) tool?.(name);
      return;
    }
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    message(count++, role, paragraphs.join('\n'), Number.isFinite(at) ? new Date(at).toISOString() : null, row);
  }, signal);
  return count;
}

export async function readNativeFavoritePage(
  machines: MachineClient | undefined, source: NativeExportSource, offset: number, signal: AbortSignal,
) {
  const items: NativeFavoriteMessage[] = [];
  const total = await readConversation(machines, source, signal, (index, role, text, createdAt, raw) => {
    if (index < offset || index - offset >= 25) return;
    // Bind positional records to their source and content. A replacement at
    // the same index must never inherit the original favorite's identity.
    const fingerprint = createHash('sha256').update(JSON.stringify([
      source.machineId, source.executorId, source.nativeSessionId, source.cwd, index, raw,
    ])).digest('hex');
    items.push({ index, fingerprint, role, text, createdAt });
  });
  return { items, total };
}

export async function exportNativeConversation(
  machines: MachineClient | undefined, source: NativeExportSource, includeWork: boolean, signal: AbortSignal,
) {
  const { machineId, executorId, nativeSessionId, cwd } = source;
  const lines: string[] = [];
  const count = await readConversation(machines, source, signal, (_, role, text, at) => {
    lines.push('## ' + (role === 'user' ? '用户' : 'Agent 回复') + (at ? ' · ' + at : ''), '', text, '');
  }, includeWork ? name => lines.push(toolBlock(name), '') : undefined);
  const stem = Array.from(nativeSessionId.replace(/[^\p{L}\p{N}_-]+/gu, '-')).slice(0, 48).join('');
  return { filename: `super-mario-${executorId}-${stem}.md`, count, hasContent: lines.length > 0, markdown: [
    '# 原生会话 · ' + executorId, '', '会话：' + nativeSessionId, '电脑：' + machineId, '目录：' + cwd, '导出时间：' + new Date().toISOString(), '', `共 ${count} 条消息`, '', ...lines,
  ].join('\n') };
}

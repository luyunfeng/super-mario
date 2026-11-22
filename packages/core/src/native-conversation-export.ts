import type { MachineClient } from '../../plugin-sdk/src/index.ts';
import type { NativeExportSource } from '../../protocol/src/index.ts';
import { readNativeRecords } from './native-transcript-reader.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Read an already persisted session through the node's exact, read-only lookup. */
export async function exportNativeConversation(
  machines: MachineClient | undefined, source: NativeExportSource, includeWork: boolean, signal: AbortSignal,
) {
  const { machineId, executorId, nativeSessionId, cwd } = source;
  const machine = machines?.list().find(item => item.id === machineId && item.online);
  if (!machines || !machine) throw Object.assign(new Error('执行机离线'), { status: 503 });
  if (!machine.capabilities.includes('agents.transcript')) throw Object.assign(new Error('执行机尚不支持完整会话读取'), { status: 409 });
  const lines: string[] = [];
  let count = 0;
  function step(name: unknown) {
    if (includeWork && typeof name === 'string' && /^[\w.:-]{1,80}$/.test(name)) lines.push('> 工具调用：' + name, '');
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
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') step(payload.name);
      if (payload.type !== 'message') return;
      role = payload.role; content = payload.content;
    } else {
      if (row.sessionId !== nativeSessionId || row.isMeta === true || row.isSidechain === true) return;
      role = row.type; content = record(row.message).content;
    }
    if (role !== 'user' && role !== 'assistant') return;
    const paragraphs: string[] = [];
    if (typeof content === 'string') paragraphs.push(content);
    if (Array.isArray(content)) for (const item of content) {
      const block = record(item);
      if (['input_text', 'output_text', 'text'].includes(String(block.type)) && typeof block.text === 'string') paragraphs.push(block.text);
      if (['input_image', 'output_image', 'image'].includes(String(block.type))) paragraphs.push('[图像附件]');
      if (block.type === 'tool_use') step(block.name);
    }
    if (!paragraphs.some(text => text.trim())) return;
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    lines.push('## ' + (role === 'user' ? '用户' : 'Agent 回复') + (Number.isFinite(at) ? ' · ' + new Date(at).toISOString() : ''), '', ...paragraphs, '');
    count++;
  }, signal);
  const stem = Array.from(nativeSessionId.replace(/[^\p{L}\p{N}_-]+/gu, '-')).slice(0, 48).join('');
  return { filename: `super-mario-${executorId}-${stem}.md`, count, markdown: [
    '# 原生会话 · ' + executorId, '', '会话：' + nativeSessionId, '电脑：' + machineId, '目录：' + cwd, '', `共 ${count} 条消息`, '', ...lines,
  ].join('\n') };
}

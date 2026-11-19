import { h } from '../lib/dom.js';
const labels = { starting: '正在启动', thinking: '正在分析', tool: '正在调用工具', responding: '正在输出', waiting: '等待后续事件' };
/** Only explicitly observed progress. Raw reasoning and tool payloads stay private. */
export function agentProgress(message) {
  const progress = message?.status === 'pending' && message.progress;
  if (!progress) return null;
  return h('p', { class: 'small muted', role: 'status', dataset: { agentProgress: message.id }, style: { overflowWrap: 'anywhere' } },
    labels[progress.phase] ?? '正在处理', progress.toolName ? ` · ${progress.toolName}` : '', progress.detail ? ` · ${progress.detail}` : '');
}

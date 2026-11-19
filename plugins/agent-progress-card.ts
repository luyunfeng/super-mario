import type { ExecutionProgress } from '../packages/protocol/src/index.ts';

export type AgentProgressCardOptions = {
  title: string;
  /** Reply transport completion is distinct from business execution completion. */
  subject?: 'reply' | 'execution';
  /** Full latest public response snapshot, not an unprocessed event or a delta. */
  text?: string;
  /** Only the caller's verified execution terminal may set this. */
  finished?: boolean;
  /** Caller-owned status takes precedence over finished, including pending.
   * done/failed/cancelled/unknown must come from a verified execution terminal.
   */
  status?: 'pending' | 'done' | 'failed' | 'cancelled' | 'unknown';
};

type PlainText = { tag: 'plain_text'; content: string; text_size?: 'normal' | 'notation'; text_color?: 'grey' };
type TextBlock = { tag: 'div'; element_id: string; text: PlainText };

/** Card 2.0 payload; pass directly as FeishuSendContext.card, without a message envelope. */
export type AgentProgressCard = {
  schema: '2.0';
  config: { update_multi: true; width_mode: 'default' };
  header: {
    title: PlainText;
    template: 'blue' | 'orange' | 'green' | 'red' | 'grey';
    text_tag_list: { tag: 'text_tag'; text: PlainText; color: 'blue' | 'orange' | 'green' | 'red' | 'neutral' }[];
  };
  body: { direction: 'vertical'; elements: TextBlock[] };
};

const phases: Record<ExecutionProgress['phase'], string> = {
  starting: '正在启动', thinking: '正在分析', tool: '正在调用工具', responding: '正在输出', waiting: '等待后续事件',
};
const terminalStatuses = {
  done: { label: '执行完成', color: 'green', template: 'green' },
  failed: { label: '执行失败', color: 'red', template: 'red' },
  cancelled: { label: '执行已取消', color: 'orange', template: 'orange' },
  unknown: { label: '执行结果未知', color: 'orange', template: 'orange' },
} as const;
const replyTerminalLabels = { done: '回复完成', failed: '回复失败', cancelled: '回复已取消', unknown: '回复结果未知' } as const;

/** Defense in depth for common credential formats, not a general secret detector.
 * The adapter must select PUBLIC summaries/output and redact secrets at source.
 * Never pass raw reasoning, system prompts, tool environments or event dumps.
 */
function publicText(value: string | undefined, limit: number): string {
  const clean = (value ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[凭证已隐藏]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [凭证已隐藏]')
    .replace(/((?:["']?)(?:[\w-]*(?:token|secret|password)|api[_-]?key|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&,;}<>]+)/gi, '$1[凭证已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[凭证已隐藏]')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim();
  // Count Unicode code points so truncation never splits an emoji surrogate pair.
  const chars = Array.from(clean);
  return chars.length <= limit ? clean : `${chars.slice(0, limit - 1).join('')}…`;
}

function block(id: string, content: string, secondary = false): TextBlock {
  return { tag: 'div', element_id: id, text: {
    tag: 'plain_text', content,
    ...(secondary ? { text_size: 'notation', text_color: 'grey' } as const : {}),
  } };
}

/** Pure snapshot builder. No sending, clocks, stored state or inferred completion.
 * Plain text deliberately keeps tool output/mentions/HTML inert. Stable element
 * IDs also allow a future transport to replace text instead of posting new cards.
 */
export function buildAgentProgressCard(progress: ExecutionProgress, options: AgentProgressCardOptions): AgentProgressCard {
  const reply = options.subject === 'reply';
  const terminalStatus = options.status && options.status !== 'pending' ? {
    ...terminalStatuses[options.status],
    label: reply ? replyTerminalLabels[options.status] : terminalStatuses[options.status].label,
  } : undefined;
  const terminal = terminalStatus !== undefined || (options.finished === true && options.status !== 'pending');
  const status = terminal
    ? (terminalStatus ?? { label: reply ? '本轮回复已结束' : '执行已结束', color: 'neutral', template: 'grey' } as const)
    : { label: phases[progress.phase], color: progress.phase === 'waiting' ? 'orange' : 'blue', template: progress.phase === 'waiting' ? 'orange' : 'blue' } as const;
  const elements = [block('progress_status', status.label)];
  const tool = publicText(progress.toolName, 120);
  const detail = publicText(progress.detail, 1000);
  const text = publicText(options.text, 4000);
  // Keep the last observed stage distinct from the verified terminal outcome.
  if (terminal) elements.push(block('progress_phase', `最后观察阶段：${phases[progress.phase]}`, true));
  if (tool) elements.push(block('progress_tool', `工具：${tool}`));
  if (detail) elements.push(block('progress_detail', `公开摘要：${detail}`));
  if (text) elements.push(block('progress_text', text));
  elements.push(block('progress_observed', `观察时间：${publicText(progress.observedAt, 80) || '未知'}`, true));
  if (reply && progress.recentSteps?.length) {
    const steps = progress.recentSteps.slice(-8).map(step => publicText(step, 160)).filter(Boolean);
    if (steps.length) {
      elements.splice(0, elements.length,
        ...(text ? [block('progress_text', text)] : []),
        block('progress_history', '处理经过\n' + steps.map(step => '· ' + step).join('\n'), true));
    }
  }
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      title: { tag: 'plain_text', content: publicText(options.title, 120) || (reply ? 'Agent 回复进度' : 'Agent 执行进度') },
      template: status.template,
      text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: status.label }, color: status.color }],
    },
    body: { direction: 'vertical', elements },
  };
}

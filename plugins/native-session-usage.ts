// The native JSONL is the usage ledger. Only counts leave the execution machine.
type Counts = Record<string, number>;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function counts(raw: unknown, fields: Record<string, string>): Counts {
  const result: Counts = {};
  if (object(raw)) for (const [name, field] of Object.entries(fields)) {
    const n = raw[field];
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) result[name] = n;
  }
  return result;
}
const codexFields = { input: 'input_tokens', cached: 'cached_input_tokens', output: 'output_tokens', reasoning: 'reasoning_output_tokens', total: 'total_tokens' };
const claudeFields = { input: 'input_tokens', cached: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens', output: 'output_tokens' };

export function summarizeNativeUsage(text: string, executor: string, sessionId: string, partial: boolean) {
  const records: Counts[] = [];
  const claude = new Map<string, Counts>();
  let cumulative: Counts = {}, windowTokens: number | null = null;
  let userMessages = 0, assistantMessages = 0, toolCalls = 0;
  const toolNames = new Map<string, number>();
  function countTool(name: unknown) {
    toolCalls++;
    if (typeof name === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(name) && (toolNames.has(name) || toolNames.size < 64)) {
      toolNames.set(name, (toolNames.get(name) ?? 0) + 1);
    }
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { partial = true; continue; }
    if (!object(row)) continue;
    if (executor === 'codex' && object(row.payload)) {
      const p = row.payload;
      if (row.type === 'response_item') {
        if (p.type === 'message' && p.role === 'user') userMessages++;
        if (p.type === 'message' && p.role === 'assistant') assistantMessages++;
        if (p.type === 'function_call' || p.type === 'custom_tool_call') countTool(p.name);
      }
      if (row.type !== 'event_msg' || p.type !== 'token_count' || !object(p.info)) continue;
      const info = p.info;
      cumulative = counts(info.total_token_usage, codexFields);
      windowTokens = counts(info, { window: 'model_context_window' }).window ?? null;
      const last = counts(info.last_token_usage, codexFields);
      if (Object.keys(last).length) records.push(last);
    } else if (executor === 'claude-code' && row.sessionId === sessionId && object(row.message)) {
      const msg = row.message;
      const blocks = Array.isArray(msg.content) ? msg.content.filter(object) : [];
      if (row.type === 'user' && !blocks.some(b => b.type === 'tool_result')) userMessages++;
      if (row.type !== 'assistant') continue;
      assistantMessages++;
      for (const block of blocks) if (block.type === 'tool_use') countTool(block.name);
      const usage = counts(msg.usage, claudeFields);
      if (!Object.keys(usage).length) continue;
      if (typeof msg.id !== 'string' || !msg.id) { partial = true; continue; }
      const prev = claude.get(msg.id);
      claude.set(msg.id, { ...prev, ...usage });
    }
  }
  if (executor === 'claude-code') {
    for (const usage of claude.values()) records.push(usage);
    for (const field of Object.keys(claudeFields)) {
      if (records.length && records.every(record => field in record)) cumulative[field] = records.reduce((sum, record) => sum + record[field]!, 0);
    }
  }
  return { partial, cumulative, windowTokens, userMessages, assistantMessages, toolCalls, tools: [...toolNames].map(([name, calls]) => ({ name, calls })), records: records.slice(-20).reverse() };
}

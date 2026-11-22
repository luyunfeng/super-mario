import { randomUUID } from 'node:crypto';
import { readNativeRecords } from '../../../packages/core/src/native-transcript-reader.ts';
import { analyzeSession } from '../../../packages/core/src/agent-runtime/session-analysis.ts';
import type { AppConfig, Json } from '../../../packages/protocol/src/index.ts';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';

type Source = { machineId: string; executorId: string; nativeSessionId: string; cwd: string };
type Job = Source & { id: string; status: 'reading' | 'analysing' | 'done' | 'failed' | 'unknown'; detail: string; text: string; readBytes: number; totalBytes: number; records: number; createdAt: string };
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
/** Select only public dialogue/actions; never send raw reasoning/system records to a model. */
export function transcriptRecord(raw: unknown, executor: string, sessionId: string): string {
  const row = object(raw), p = object(row.payload);
  const render = (blocks: unknown): string => typeof blocks === 'string' ? blocks : Array.isArray(blocks) ? blocks.map(value => {
    const b = object(value);
    if (['text', 'input_text', 'output_text'].includes(b.type)) return typeof b.text === 'string' ? b.text : '';
    if (['input_image', 'output_image', 'image'].includes(b.type)) return '[图像附件：未解析视觉内容]';
    if (b.type === 'tool_use') return `工具调用 ${b.name}: ${JSON.stringify(b.input)}`;
    if (b.type === 'tool_result') return `工具结果 ${b.tool_use_id}: ${render(b.content)}`;
    if (['thinking', 'reasoning', 'redacted_thinking'].includes(b.type)) return '';
    return JSON.stringify(value);
  }).filter(Boolean).join('\n') : '';
  if (executor === 'codex') {
    if (row.type !== 'response_item') return '';
    if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) return `[${row.timestamp ?? ''} ${p.role}]\n${render(p.content)}`;
    if (['function_call', 'custom_tool_call'].includes(p.type)) return `[工具调用 ${p.name} ${p.call_id ?? ''}]\n${typeof p.arguments === 'string' ? p.arguments : p.input ?? ''}`;
    if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) return `[工具结果 ${p.call_id ?? ''}]\n${typeof p.output === 'string' ? p.output : Array.isArray(p.output) ? render(p.output) : JSON.stringify(p.output)}`;
  } else if (executor === 'claude-code' && row.sessionId === sessionId && ['user', 'assistant'].includes(row.type)) {
    const text = render(object(row.message).content);
    if (text) return `[${row.timestamp ?? ''} ${row.type}]\n${text}`;
  }
  return '';
}

export function createSessionAnalysis(options: {
  store: Store; config: AppConfig; available(): boolean;
  call(machineId: string, method: string, params: any): Promise<Json>;
  analyze?: typeof analyzeSession;
}) {
  const { store } = options, active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  let closed = false;
  for (const job of store.list<Job>('session.analysis')) if (['reading', 'analysing'].includes(job.status)) store.put('session.analysis', job.id, { ...job, status: 'unknown', detail: '服务重启，分析中断；请重新分析。' });
  const save = (job: Job) => store.put('session.analysis', job.id, structuredClone(job));
  function call(job: Job, method: string, params: any, signal: AbortSignal): Promise<Json> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('完整会话分析已取消'));
      signal.addEventListener('abort', abort, { once: true });
      options.call(job.machineId, method, params).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  async function run(job: Job, signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      await call(job, 'agents.session', { executorId: job.executorId, nativeSessionId: job.nativeSessionId, cwd: job.cwd }, signal);
      const records: string[] = [];
      await readNativeRecords((offset, snapshot) => call(job, 'agents.transcript', {
        executorId: job.executorId, nativeSessionId: job.nativeSessionId, cwd: job.cwd, offset, ...(snapshot && { snapshot }),
      }, signal), raw => {
        const text = transcriptRecord(raw, job.executorId, job.nativeSessionId);
        if (text) { records.push(text); job.records++; }
      }, signal, (offset, total) => {
        job.readBytes = offset; job.totalBytes = total;
        job.detail = `正在读取完整会话：${offset} / ${total} 字节`; save(job);
      });
      if (!records.length) throw new Error('完整会话没有可分析的公开对话或工具记录');
      signal.throwIfAborted(); job.status = 'analysing'; job.detail = `已完整读取 ${job.records} 条记录，正在分段分析`; save(job);
      const text = await (options.analyze ?? analyzeSession)(records.join('\n\n'), options.config, detail => { job.detail = detail; save(job); }, { signal });
      signal.throwIfAborted();
      job.text = `覆盖范围：当前会话截至 ${job.createdAt} 读取时的日志快照，${job.totalBytes} 字节、${job.records} 条公开对话及工具记录。原始推理和系统指令不纳入分析；不包含其他独立子会话。\n\n${text}`;
      job.status = 'done'; job.detail = '完整会话分析完成'; save(job);
    } catch (error) {
      job.status = closed ? 'unknown' : 'failed';
      const reason = error instanceof Error ? error.message : '分析失败';
      job.detail = options.config.model?.apiKey ? reason.replaceAll(options.config.model.apiKey, '[REDACTED]') : reason; save(job);
    }
  }
  return {
    start(input: Record<string, unknown>) {
      if (closed) throw new Error('分析服务已关闭');
      if (!options.available()) throw new Error('主模型不可用，请先完成模型配置');
      for (const key of ['machineId', 'executorId', 'nativeSessionId', 'cwd']) if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`缺少完整会话标识：${key}`);
      if (!['codex', 'claude-code'].includes(String(input.executorId))) throw new Error('当前 Agent 尚不支持完整会话分析');
      const source = Object.fromEntries(['machineId', 'executorId', 'nativeSessionId', 'cwd'].map(key => [key, input[key]])) as Source;
      const previous = store.list<Job>('session.analysis').find(job => active.has(job.id) && Object.entries(source).every(([key, value]) => job[key as keyof Source] === value));
      if (previous) return previous;
      const job: Job = { ...source, id: randomUUID(), status: 'reading', detail: '正在定位完整原生会话', text: '', records: 0, readBytes: 0, totalBytes: 0, createdAt: new Date().toISOString() }; save(job);
      const controller = new AbortController();
      const task = run(job, controller.signal).finally(() => active.delete(job.id)); active.set(job.id, { controller, task });
      return structuredClone(job);
    },
    get(id: string) { return store.get<Job>('session.analysis', id); },
    async close() { closed = true; for (const job of active.values()) job.controller.abort(); await Promise.allSettled([...active.values()].map(job => job.task)); },
  };
}

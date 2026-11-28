import { randomUUID } from 'node:crypto';
import { readNativeRecords } from '../../../packages/core/src/native-transcript-reader.ts';
import { analyzeSession } from '../../../packages/core/src/agent-runtime/session-analysis.ts';
import type { AppConfig, Json } from '../../../packages/protocol/src/index.ts';
import type { Store } from '../../../packages/plugin-sdk/src/index.ts';

type Source = { machineId: string; executorId: string; nativeSessionId: string; cwd: string; mode?: 'recent' | 'full' | 'screen'; paneId?: string; terminalId?: string };
type Job = Source & { id: string; status: 'reading' | 'analysing' | 'done' | 'failed' | 'unknown'; detail: string; text: string; readBytes: number; totalBytes: number; records: number; createdAt: string };
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
/** Select only public dialogue/actions; never send raw reasoning/system records to a model. */
export function transcriptRecord(raw: unknown, executor: string, sessionId: string): string {
  const row = object(raw), p = object(row.payload);
  const render = (blocks: unknown): string => typeof blocks === 'string' ? blocks : Array.isArray(blocks) ? blocks.map(value => {
    const b = object(value);
    if (['text', 'input_text', 'output_text'].includes(b.type)) return typeof b.text === 'string' ? b.text : '';
    if (['input_image', 'output_image', 'image'].includes(b.type)) return '[图像附件：未解析视觉内容]';
    if (b.type === 'input_file' || b.type === 'document') return '[文件附件：未解析正文]';
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
  } else if (executor === 'pi' && row.type === 'message') {
    const msg = object(row.message);
    if (['user', 'assistant'].includes(msg.role)) {
      const text = render(msg.content);
      if (text) return `[${row.timestamp ?? ''} ${msg.role}]\n${text}`;
    }
  } else if (executor === 'agy') {
    if (row.type === 'USER_INPUT' && typeof row.content === 'string' && row.content.trim()) {
      return `[${row.created_at ?? ''} user]\n${row.content}`;
    }
    if (row.type === 'PLANNER_RESPONSE') {
      const parts: string[] = [];
      if (typeof row.content === 'string' && row.content.trim()) parts.push(row.content);
      if (Array.isArray(row.tool_calls) && row.tool_calls.length) {
        parts.push(`工具调用：${row.tool_calls.map((tc: Record<string, unknown>) => String(tc?.name ?? tc?.tool ?? 'tool')).join('、')}`);
      }
      if (parts.length) return `[${row.created_at ?? ''} assistant]\n${parts.join('\n')}`;
    }
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
      const records: string[] = [];
      if (job.mode === 'screen') {
        const sumKey = `${job.machineId}:pane:${job.terminalId || job.nativeSessionId}`;
        const prev = store.get<{ lastHash?: string; summary: string; updatedAt: string }>('session.summaries', sumKey);
        job.detail = '正在只读读取当前终端最近画面…'; save(job);
        const res = await call(job, 'terminal.live.read', {
          paneId: job.paneId, terminalId: job.terminalId, cwd: job.cwd,
        }, signal) as { text?: string };
        const clean = String(res.text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').trim();
        if (!clean) throw new Error('当前终端没有可读的画面输出');
        const tail = clean.slice(-10_000);
        const lastHash = `${tail.length}:${tail.slice(0, 120)}:${tail.slice(-120)}`;
        if (prev?.summary && prev.lastHash === lastHash) {
          job.text = `${prev.summary}\n\n（终端画面无新变化，已复用 ${prev.updatedAt} 的缓存结论。）`;
          job.status = 'done'; job.detail = '画面无变化，已复用上次结论'; save(job);
          return;
        }
        job.readBytes = Buffer.byteLength(tail, 'utf8');
        job.totalBytes = job.readBytes;
        signal.throwIfAborted(); job.status = 'analysing'; job.detail = '已读取终端最近画面，正在生成简明总结…'; save(job);
        const promptInput = prev?.summary
          ? `【上次结论】\n${prev.summary}\n\n【当前终端最近输出（${job.executorId}）】\n${tail}\n\n请结合上次结论与最新画面，用不超过 10 句大白话更新当前进展（在做什么、刚完成什么、有无卡点或报错、下一步是什么）。`
          : `【当前终端最近输出（${job.executorId}）】\n${tail}\n\n请用不超过 10 句大白话说清当前进展（在做什么、刚完成什么、有无卡点或报错、下一步是什么）。`;
        const text = await (options.analyze ?? analyzeSession)(promptInput, options.config, detail => { job.detail = detail; save(job); }, { signal });
        signal.throwIfAborted();
        const updatedAt = new Date().toISOString();
        store.put('session.summaries', sumKey, { lastHash, summary: text, updatedAt });
        job.text = `${text}\n\n（基于 ${job.executorId} 终端最近 300 行只读画面总结。）`;
        job.status = 'done'; job.detail = '终端进展总结完成'; save(job);
        return;
      }
      if (job.mode === 'recent') {
        const sumKey = `${job.machineId}:${job.executorId}:${job.nativeSessionId}`;
        const prev = store.get<{ lastOffset: number; summary: string; updatedAt: string }>('session.summaries', sumKey);
        job.detail = '正在只读抓取最近 16KB 对话…'; save(job);
        // Strictly read-only tail read (O_RDONLY on execution node); original session files are never modified.
        const page = await call(job, 'agents.transcript', {
          executorId: job.executorId, nativeSessionId: job.nativeSessionId, cwd: job.cwd, tailBytes: 16 * 1024,
        }, signal) as { data?: string; startOffset?: number; nextOffset?: number; snapshot?: { size?: number } };
        const totalBytes = page.snapshot?.size ?? 0;
        job.totalBytes = totalBytes;
        if (prev?.summary && totalBytes > 0 && totalBytes <= prev.lastOffset) {
          job.text = `${prev.summary}\n\n（会话无新增内容，直接复用 ${prev.updatedAt} 的缓存结论；原始会话未改动。）`;
          job.status = 'done'; job.detail = '无新增内容，已复用上次结论'; save(job);
          return;
        }
        const buf = Buffer.from(String(page.data ?? ''), 'base64');
        const textChunk = buf.toString('utf8');
        const lines = textChunk.split('\n');
        // Drop the first line when jumping into the middle of the file so JSON parsing stays clean.
        const startIdx = (page.startOffset ?? 0) > 0 ? 1 : 0;
        for (let i = startIdx; i < lines.length; i++) {
          const line = lines[i]?.trim();
          if (!line) continue;
          try {
            const parsed = transcriptRecord(JSON.parse(line), job.executorId, job.nativeSessionId);
            if (parsed) { records.push(parsed); job.records++; }
          } catch { /* ignore partial trailing line */ }
        }
        job.readBytes = buf.length;
        if (!records.length) {
          if (prev?.summary) {
            job.text = `${prev.summary}\n\n（最近 16KB 无新增公开对话，沿用上次结论。）`;
            job.status = 'done'; job.detail = '已沿用上次结论'; save(job);
            return;
          }
          throw new Error('最近 16KB 日志中没有可总结的公开对话记录');
        }
        signal.throwIfAborted(); job.status = 'analysing'; job.detail = `已只读最近 ${job.records} 条记录，正在生成简明总结…`; save(job);
        const recentBody = records.join('\n\n').slice(-10_000);
        const promptInput = prev?.summary
          ? `【上次结论】\n${prev.summary}\n\n【最新对话片段】\n${recentBody}\n\n请结合上次结论与最新片段，用不超过 10 句大白话更新当前进展（在做什么、刚完成什么、有无卡点或报错、下一步是什么）。`
          : `【最近对话片段】\n${recentBody}\n\n请用不超过 10 句大白话说清当前进展（在做什么、刚完成什么、有无卡点或报错、下一步是什么）。`;
        const text = await (options.analyze ?? analyzeSession)(promptInput, options.config, detail => { job.detail = detail; save(job); }, { signal });
        signal.throwIfAborted();
        const updatedAt = new Date().toISOString();
        store.put('session.summaries', sumKey, { lastOffset: totalBytes || buf.length, summary: text, updatedAt });
        job.text = text;
        job.status = 'done'; job.detail = '最新进展总结完成'; save(job);
        return;
      }
      await call(job, 'agents.session', { executorId: job.executorId, nativeSessionId: job.nativeSessionId, cwd: job.cwd }, signal);
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
      const mode = input.mode === 'screen' ? 'screen' : input.mode === 'recent' ? 'recent' : 'full';
      if (mode === 'screen') {
        for (const key of ['machineId', 'paneId', 'terminalId', 'cwd']) if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`缺少终端标识：${key}`);
      } else {
        for (const key of ['machineId', 'executorId', 'nativeSessionId', 'cwd']) if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`缺少完整会话标识：${key}`);
        if (!['codex', 'claude-code', 'pi', 'agy'].includes(String(input.executorId))) throw new Error('当前 Agent 尚不支持完整会话分析');
      }
      const source: Source = {
        machineId: String(input.machineId),
        executorId: String(input.executorId || 'terminal'),
        nativeSessionId: String(input.nativeSessionId || input.terminalId || ''),
        cwd: String(input.cwd),
        mode,
        ...(mode === 'screen' ? { paneId: String(input.paneId), terminalId: String(input.terminalId) } : {}),
      };
      const previous = store.list<Job>('session.analysis').find(job => active.has(job.id) && Object.entries(source).every(([key, value]) => job[key as keyof Source] === value));
      if (previous) return previous;
      const job: Job = { ...source, id: randomUUID(), status: 'reading', detail: mode === 'screen' ? '正在读取终端最近画面…' : mode === 'recent' ? '正在读取最近对话片段…' : '正在定位完整原生会话', text: '', records: 0, readBytes: 0, totalBytes: 0, createdAt: new Date().toISOString() }; save(job);
      const controller = new AbortController();
      const task = run(job, controller.signal).finally(() => active.delete(job.id)); active.set(job.id, { controller, task });
      return structuredClone(job);
    },
    get(id: string) { return store.get<Job>('session.analysis', id); },
    async close() { closed = true; for (const job of active.values()) job.controller.abort(); await Promise.allSettled([...active.values()].map(job => job.task)); },
  };
}

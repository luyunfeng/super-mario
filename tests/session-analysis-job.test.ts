import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createSessionAnalysis, transcriptRecord } from '../apps/server/src/session-analysis.ts';
import type { Json } from '../packages/protocol/src/index.ts';
const source = { machineId: 'm', executorId: 'codex', nativeSessionId: 'session', cwd: '/project' };
async function fixture(t: test.TestContext, text: string | Buffer, failPage = false) {
  const dir = mkdtempSync(join(tmpdir(), 'mario-full-analysis-')), store = createStore(join(dir, 'test.sqlite'));
  const bytes = Buffer.from(text), snapshot = { size: bytes.length, dev: 1, ino: 2 }; let captured = '', calls = 0;
  const service = createSessionAnalysis({ store, config: { host: '127.0.0.1', port: 0, dataDir: dir, demo: true }, available: () => true,
    async call(_id, method, input) {
      if (method === 'agents.session') return {};
      calls++; const offset = input.offset ?? 0, end = Math.min(offset + 137, bytes.length);
      return { data: bytes.subarray(offset, end).toString('base64'), nextOffset: failPage && offset ? end + 1 : end, snapshot, eof: end === bytes.length } as Json;
    },
    async analyze(value, _config, progress) { captured = value; progress('正在汇总所有分段'); return '完整总结'; },
  });
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  async function finish(id: string) { for (let n = 0; n < 1000; n++) { const job = service.get(id)!; if (['done', 'failed'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 1)); } throw Error('timeout'); }
  return { service, finish, captured: () => captured, calls: () => calls };
}
const row = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
test('完整读取超过300行的会话：前中后都进入分析，跨UTF8页不丢字', async t => {
  const text = Array.from({ length: 1001 }, (_, i) => row(`第${i}条完整记录🙂`)).join('\n') + '\n';
  const f = await fixture(t, text), start = f.service.start(source), job = await f.finish(start.id);
  assert.equal(job.status, 'done'); assert.equal(job.records, 1001); assert.equal(job.readBytes, Buffer.byteLength(text));
  for (const i of [0, 500, 1000]) assert.ok(f.captured().includes(`第${i}条完整记录🙂`));
  assert.ok(!f.captured().includes('�')); assert.ok(f.calls() > 300); assert.match(job.text, /1001 条公开对话/);
});
test('保留工具证据，去掉raw reasoning和系统消息；损坏日志不能宣称全量分析成功', async t => {
  const reasoning = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', content: 'PRIVATE_REASONING' } });
  const tools = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: '真实验证结果' } });
  const f = await fixture(t, row('最初目标')+'\n'+reasoning+'\n'+tools+'\n');
  assert.equal((await f.finish(f.service.start(source).id)).status, 'done');
  assert.match(f.captured(), /最初目标/); assert.match(f.captured(), /真实验证结果/); assert.doesNotMatch(f.captured(), /PRIVATE_REASONING/);
  const bad = await fixture(t, row('目标')+'\n{"broken":');
  const failed = await bad.finish(bad.service.start(source).id); assert.equal(failed.status, 'failed'); assert.equal(failed.text, ''); assert.equal(bad.captured(), '');
});
test('原文含无效 UTF-8 时停止处理，避免输出被替换的正文', async t => {
  const bytes = Buffer.from(row('source-text'));
  bytes[bytes.indexOf('source-text')] = 0xff;
  const f = await fixture(t, bytes);
  const job = await f.finish(f.service.start(source).id);
  assert.equal(job.status, 'failed');
  assert.match(job.detail, /UTF-8/);
  assert.equal(f.captured(), '');
});
test('分页不连续明确失败；不会总结已读尾部或前缀冒充完整会话', async t => {
  const f = await fixture(t, Array.from({length:10}, (_,i)=>row(String(i))).join('\n'), true);
  const job = await f.finish(f.service.start(source).id); assert.equal(job.status, 'failed'); assert.match(job.detail, /分页不连续/); assert.equal(f.captured(), '');
});
test('Claude只提取匹配会话的公开消息与工具结果', () => {
  const raw = { type: 'assistant', sessionId: 'a', message: { content: [{ type: 'thinking', thinking: 'PRIVATE' }, {type:'text', text:'公开回复'}, {type:'tool_use', name:'read', input:{path:'file'}}] } };
  assert.match(transcriptRecord(raw, 'claude-code', 'a'), /公开回复/); assert.doesNotMatch(transcriptRecord(raw, 'claude-code', 'a'), /PRIVATE/);
  assert.equal(transcriptRecord(raw, 'claude-code', 'b'), '');
});


test('工具输出中的图像保留附件标记，不把编码图片当对话正文喂给模型', () => {
  const raw = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'image', output: [
    { type: 'input_text', text: '截图说明' }, { type: 'input_image', image_url: 'data:image/png;base64,PRIVATE_BINARY' }, { type: 'input_file', file_data: 'PRIVATE_FILE' }, { passed: 42 },
  ] } };
  const text = transcriptRecord(raw, 'codex', 'session');
  assert.match(text, /截图说明/); assert.match(text, /图像附件/); assert.match(text, /passed.*42/); assert.match(text, /文件附件：未解析正文/); assert.doesNotMatch(text, /PRIVATE_BINARY|PRIVATE_FILE/);
});

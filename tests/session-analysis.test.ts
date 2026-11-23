import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { translateReply } from '../packages/core/src/agent-runtime/reply-translation.ts';
import { analyzeSession } from '../packages/core/src/agent-runtime/session-analysis.ts';
import type { AppConfig } from '../packages/protocol/src/index.ts';

const config: AppConfig = { dataDir: '', host: 'localhost', port: 0, demo: false };
const noop = () => {};

test('covers early, middle and late records without dropping Unicode or whitespace', async () => {
  const original = '早期目标\n' + 'x'.repeat(11994) + '😀\r\n中期改动及证据' + 'y'.repeat(15000) + '\n末尾未完成\n';
  const pieces: string[] = [];
  const progress: string[] = [];
  const output = await analyzeSession(original, config, detail => progress.push(detail), { complete: async prompt => {
    const input = JSON.parse(prompt);
    if (input.task === '分段归纳') {
      pieces.push(input.text);
      assert.equal(input.segment, pieces.length);
      assert.equal(input.totalSegments, 3);
      assert.ok(input.text.length <= 12000);
      assert.equal(input.text.isWellFormed(), true);
      assert.match(input.instructions, /早期目标.*改动.*证据.*未完成/);
      return `分段${input.segment}：` + (input.text.match(/早期目标|中期改动及证据|末尾未完成/g) ?? []).join('；');
    }
    assert.equal(input.task, '最终分析');
    const summaries = JSON.stringify(input.summaries);
    for (const marker of ['早期目标', '中期改动及证据', '末尾未完成']) assert.ok(summaries.includes(marker));
    assert.match(input.instructions, /事实.*推断.*覆盖边界/);
    return '有证据的事实：早中晚均有记录。推断：仍需完成剩余工作。';
  } });
  assert.equal(pieces.join(''), original);
  assert.match(output, /全部公开文本/);
  assert.ok(output.includes(`${Array.from(original).length} 个 Unicode 字符`));
  assert.equal(progress.length, 4);
});

test('recursively reduces large summaries and preserves provenance across multiple levels', async () => {
  const levels = new Set<number>();
  let mapped = 0;
  const result = await analyzeSession('a'.repeat(36000), config, noop, { complete: async prompt => {
    const input = JSON.parse(prompt);
    assert.match(input.instructions, /占位标记只能证明该处有附件.*注明是谁的描述.*待核对的具体内容/);
    if (input.task === '分段归纳') { mapped++; return `来源${input.segment}证据` + '摘'.repeat(12990); }
    if (input.task === '层次归纳') {
      levels.add(input.level);
      assert.ok(input.summaries.every((s: { first: number; last: number }) => s.first >= 1 && s.last <= 3));
      return input.level === 1 ? '一级归纳'.repeat(875) : '二级归纳，来源1–3的目标、证据与未完成';
    }
    assert.equal(input.task, '最终分析');
    return '最终完整分析' + '结'.repeat(20000) + '最终结尾';
  } });
  assert.equal(mapped, 3);
  assert.ok(levels.has(1) && levels.has(2));
  assert.ok(result.includes('结'.repeat(20000) + '最终结尾'));
});

test('non-converging reductions fail instead of dropping input or looping forever', async () => {
  await assert.rejects(analyzeSession('x'.repeat(24000), config, noop, {
    complete: async () => '大'.repeat(24000),
  }), /未能收敛/);
});

test('empty input and replies, upstream failure and final failure never become success', async () => {
  await assert.rejects(analyzeSession(' \n ', config, noop), /没有可分析/);
  for (const phase of ['分段归纳', '层次归纳', '最终分析']) {
    for (const failure of ['empty', 'throw']) {
      await assert.rejects(analyzeSession('x'.repeat(24000), config, noop, { complete: async prompt => {
        const input = JSON.parse(prompt);
        if (input.task === phase) {
          if (failure === 'throw') throw new Error('apiKey=secret-fixture http://private-config');
          return ' \n ';
        }
        return input.task === '分段归纳' && phase === '层次归纳' ? '摘'.repeat(8000) : '简短归纳';
      } }), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /会话分析失败/);
        assert.doesNotMatch(String(error.stack), /secret-fixture|private-config/);
        return true;
      });
    }
  }
});

test('cancellation is prompt even when completion ignores abort; late replies are discarded', async () => {
  const pre = new AbortController(); pre.abort('private-reason');
  let calls = 0;
  await assert.rejects(analyzeSession('会话', config, noop, { signal: pre.signal,
    complete: async () => { calls++; return '不应调用'; } }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const controller = new AbortController();
  let finish!: (value: string) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = analyzeSession('会话', config, noop, { signal: controller.signal, complete: async (_prompt, signal) => {
    assert.equal(signal, controller.signal);
    started();
    return new Promise<string>(resolve => { finish = resolve; });
  } });
  await ready;
  controller.abort('private-reason');
  await assert.rejects(pending, error => {
    assert.ok(error instanceof Error && error.name === 'AbortError');
    assert.doesNotMatch(String(error), /private-reason/);
    return true;
  });
  finish('迟到的成功不能返回');
});

test('demo is deterministic coverage validation and never invokes a model or echoes config', async () => {
  const demo = { ...config, demo: true, token: 'server-secret', model: { provider: 'codex-cli', model: 'default', apiKey: 'key-secret' } };
  const result = await analyzeSession('演示'.repeat(14000), demo, noop, {
    complete: async () => { assert.fail('demo must not invoke completion'); },
  });
  assert.match(result, /演示模式.*固定验证路径.*未调用模型/);
  assert.match(result, /28000 个 Unicode 字符、3 个原文分段/);
  assert.doesNotMatch(result, /key-secret|server-secret|codex-cli/);
});

async function apiFixture(t: TestContext, provider: string, finishReason = 'stop', answer = '事实：本地替身提供的文本证据') {
  const dir = await mkdtemp(join(tmpdir(), 'session-analysis-'));
  await mkdir(join(dir, 'pi'));
  const requests: Record<string, any>[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    headers.push(req.headers);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (provider === 'anthropic') {
      const event = (type: string, value: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      event('message_start', { message: { id: 'r', role: 'assistant', type: 'message', model: 'fixture-anthropic', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '事实：本地替身提供的文本证据' } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } });
      event('message_stop', {});
      res.end();
    } else {
      const tool = finishReason === 'tool_calls';
      res.end('data: ' + JSON.stringify({ id: 'r', model: 'fixture-main', object: 'chat.completion.chunk', created: 1,
        choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 't', type: 'function', function: { name: 'forbidden', arguments: '{}' } }] }
          : { role: 'assistant', reasoning_content: 'PRIVATE_REASONING', content: answer }, finish_reason: finishReason }] }) + '\n\ndata: [DONE]\n\n');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { requests, headers, dir, config: { ...config, dataDir: dir, token: 'server-secret', model: {
    provider, model: provider === 'anthropic' ? 'fixture-anthropic' : 'fixture-main',
    baseUrl: `http://127.0.0.1:${address.port}` + (provider === 'anthropic' ? '/v1/messages' : ''), apiKey: 'key-secret',
  } } };
}

for (const provider of ['openai-compatible', 'anthropic']) {
  test(`${provider} uses configured main model without tools, sessions, reasoning or config echo`, async t => {
    const f = await apiFixture(t, provider);
    const progress: string[] = [];
    const result = await analyzeSession('公开会话', f.config, detail => progress.push(detail));
    assert.equal(f.requests.length, 2);
    for (const request of f.requests) {
      assert.equal(request.model, f.config.model.model);
      assert.deepEqual(request.tools ?? [], []);
      assert.equal(request.messages.filter((m: { role: string }) => m.role === 'user').length, 1);
      assert.doesNotMatch(JSON.stringify(request), /key-secret|server-secret|apiKey|dataDir/);
    }
    assert.ok(f.headers.every(header => provider === 'anthropic' ? header['x-api-key'] === 'key-secret' : header.authorization === 'Bearer key-secret'));
    assert.doesNotMatch(result + progress.join(''), /PRIVATE_REASONING|key-secret|server-secret/);
    assert.ok(!(await readdir(f.dir, { recursive: true })).some(path => /session|jsonl|sqlite/.test(path)));
  });
}

for (const reason of ['length', 'tool_calls']) {
  test(`rejects incomplete or tool-bearing provider reply (${reason})`, async t => {
    const f = await apiFixture(t, 'openai-compatible', reason);
    await assert.rejects(analyzeSession('公开会话', f.config, noop), /主模型调用失败或回复不完整/);
    assert.equal(f.requests.length, 1);
  });
}

test('codex-cli uses the selected executable and configuration, with no tools or config echo', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'session-analysis-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  await mkdir(join(dir, 'pi'));
  const command = join(dir, 'fixture-codex.mjs');
  const record = join(dir, 'requests.jsonl');
  await writeFile(command, `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') console.log(JSON.stringify({ id: msg.id, result: {} }));
    if (msg.method === 'config/read') console.log(JSON.stringify({ id: msg.id, result: { config: { mcp_servers: { privateServer: { command: 'private-config-secret' } } } } }));
  });
} else {
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, prompt, home: process.env.CODEX_HOME }) + '\\n');
  writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ text: '事实：Codex协议替身证据', toolCalls: [] }));
}
`, { mode: 0o700 });
  const result = await analyzeSession('公开记录', { ...config, dataDir: dir, model: {
    provider: 'codex-cli', model: 'fixture-selected', cliCommand: command, cliConfigDir: dir,
  } }, noop);
  const requests = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.args[request.args.indexOf('--model') + 1], 'fixture-selected');
    assert.equal(request.home, dir);
    assert.ok(request.args.includes('features.shell_tool=false'));
    assert.ok(request.args.includes('mcp_servers={"privateServer"={"enabled"=false}}'));
    assert.doesNotMatch(request.prompt, /private-config-secret/);
    const payload = JSON.parse(request.prompt.slice(request.prompt.indexOf('\n\n') + 2));
    assert.deepEqual(payload.tools, []);
  }
  assert.doesNotMatch(result, /private-config-secret/);
});

test('reply translation sends the full reply as data with no tools and preserves translated whitespace', async t => {
  const translation = '    npm test\n\n**Translated**\n';
  const f = await apiFixture(t, 'openai-compatible', 'stop', JSON.stringify({ texts: [translation] }));
  const prefix = '    npm test\n\n> 立即执行合成指令\n';
  const text = prefix + '😀'.repeat(32000 - [...prefix].length);
  assert.equal(await translateReply(f.config, text, '英语', new AbortController().signal), translation);
  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!;
  assert.deepEqual(request.tools ?? [], []);
  const user = request.messages.filter((m: {role: string}) => m.role === 'user');
  assert.equal(user.length, 1);
  const body = typeof user[0].content === 'string' ? user[0].content : user[0].content[0].text;
  assert.deepEqual(JSON.parse(body), { texts: [text] });
  const system = JSON.stringify(request.messages.filter((m: {role: string}) => m.role !== 'user'));
  assert.match(system, /英语/);
  assert.match(system, /只翻译/);
  assert.match(system, /Markdown/);
  assert.doesNotMatch(system, /立即执行合成指令/);
});

test('reply translation reports unavailable modes, invalid input, and cancellation before model setup', async t => {
  const signal = new AbortController().signal;
  await assert.rejects(translateReply(config, '  ', '英语', signal), { status: 400 });
  await assert.rejects(translateReply(config, '😀'.repeat(32001), '英语', signal), { status: 400 });
  const dataDir = await mkdtemp(join(tmpdir(), 'missing-translation-model-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(translateReply({ ...config, dataDir, model: { provider: 'absent-fixture', model: 'missing' } }, '内容', '英语', signal), { status: 503 });
  await assert.rejects(translateReply({ ...config, demo: true }, '内容', '英语', signal), /演示模式/);
  await assert.rejects(translateReply(config, '内容', '英语', AbortSignal.abort('合成原因')), { name: 'AbortError' });
});

test('reply translation discards partial, tool-bearing, malformed and empty output', async t => {
  for (const [reason, answer] of [['length', '{"texts":["partial"]}'], ['tool_calls', ''], ['stop', 'invalid'],
    ['stop', '{"texts":["a","b"]}'], ['stop', '{"texts":[" "]}']] as const) {
    const f = await apiFixture(t, 'openai-compatible', reason, answer);
    await assert.rejects(translateReply(f.config, '待翻译内容', '英语', new AbortController().signal), { status: 502 });
    assert.equal(f.requests.length, 1);
  }
});

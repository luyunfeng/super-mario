import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { conversationModels } from '../packages/core/src/agent-runtime/model-catalog.ts';
import { createStore } from '../packages/core/src/store.ts';
import type { AppConfig } from '../packages/protocol/src/index.ts';
import { createWorkbench } from '../packages/core/src/workbench.ts';

async function customGateway(t: test.TestContext, demo = false, simulate?: (messages: Array<{ role: string; content: unknown }>) => {
    overflow?: boolean; tokens?: number; text?: string;
  }) {
  const requests: Array<{ model: string; path: string }> = [];
  const gateway = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const { model, messages } = JSON.parse(body);
    const reply = simulate?.(messages);
    requests.push({ model, path: req.url! });
    if (model === 'fixture-rejected' || reply?.overflow) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: { message: reply?.overflow ? 'prompt is too long: 40000 tokens > 32768 maximum' : 'fixture model rejected' },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const deltas = [{ role: 'assistant', content: reply?.text ?? '合成回复' }, {}];
    for (const [index, delta] of deltas.entries()) {
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model,
        ...(reply?.tokens && { usage: { prompt_tokens: reply.tokens, completion_tokens: 1, total_tokens: reply.tokens + 1 } }),
        choices: [{ index: 0, delta, finish_reason: index === 0 ? null : 'stop' }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = 'http://127.0.0.1:' + address.port;
  const model = { provider: 'openai-compatible', model: 'fixture-default', apiKey: 'fixture-api-key' };
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-custom-models-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, demo, model: { ...model, baseUrl: baseUrl + '/a/v1' } };
  let app = await createWorkbench(config);
  t.after(async () => {
    try { await app.close(); } finally {
      gateway.closeAllConnections();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  return { get app() { return app; }, requests,
    async useEndpoint(name: string) { await app.configureModel({ mode: 'api', ...model, baseUrl: baseUrl + '/' + name + '/v1' }); },
    async restart(whileClosed?: (dataDir: string) => Promise<void>) {
      await app.close(); await whileClosed?.(dataDir); app = await createWorkbench(config);
    } };
}

test('同接入共享成功使用的自定义型号，删除保留选型，重启与换端点分别恢复对应历史', { timeout: 90000 }, async t => {
  const f = await customGateway(t);
  assert.equal(f.app.modelCatalog().typed, true);
  const history = (botId?: string) => f.app.modelCatalog(botId).custom ?? [];
  assert.deepEqual(history(), []);
  await f.app.agent.ask('仅使用默认模型');
  assert.deepEqual(history(), []);
  await assert.rejects(f.app.pickConversationModel('fixture-new'));
  for (const invalid of ['a'.repeat(257), '两字', 'fixture\nmodel']) {
    await assert.rejects(f.app.pickConversationModel(invalid, undefined, true));
  }
  await f.app.pickConversationModel('a'.repeat(256), undefined, true);
  assert.deepEqual(history(), []);
  await f.app.pickConversationModel('fixture-rejected', undefined, true);
  await assert.rejects(f.app.agent.ask('验证拒绝路径'));
  assert.deepEqual(history('bot-a'), []);
  const customModel = 'fixture-accepted';
  await f.app.pickConversationModel(customModel, undefined, true);
  assert.deepEqual(history(), []);
  await f.restart();
  assert.equal(f.app.modelCatalog().current, customModel);
  assert.deepEqual(history(), []);
  await f.app.agent.ask('只读判断', { readOnly: true });
  assert.deepEqual(history('bot-a'), []);
  const reply = await f.app.agent.ask('使用新型号');
  assert.equal(reply.text, '合成回复');
  assert.deepEqual(f.requests.at(-1), { model: customModel, path: '/a/v1/chat/completions' });
  assert.deepEqual(history('bot-a'), [customModel]);
  assert.equal(f.app.modelCatalog('bot-a').current, 'fixture-default');
  await f.app.pickConversationModel(customModel, 'bot-a');
  await f.useEndpoint('b');
  assert.deepEqual(history('bot-a'), []);
  await f.app.pickConversationModel('fixture-other-endpoint', undefined, true);
  await f.app.agent.ask('使用接入 B');
  assert.deepEqual(history(), ['fixture-other-endpoint']);
  await f.useEndpoint('a');
  assert.deepEqual(history(), [customModel]);
  await f.restart();
  assert.deepEqual(history(), [customModel]);
  await f.app.pickConversationModel(customModel);
  assert.deepEqual(await f.app.forgetConversationModel(customModel, 'bot-a'), { forgotten: true });
  assert.equal(f.app.modelCatalog().current, customModel);
  assert.deepEqual(history(), []);
  assert.deepEqual(await f.app.forgetConversationModel(customModel), { forgotten: false });
  await f.app.agent.ask('再次使用已从历史移除的型号');
  assert.deepEqual(history('bot-a'), [customModel]);
});

test('演示模式可选择型号，固定回复不写入已用历史', async t => {
  const f = await customGateway(t, true);
  await f.app.pickConversationModel('fixture-demo', undefined, true);
  const reply = await f.app.agent.ask('本地演示');
  assert.match(reply.text, /本地演示/);
  assert.deepEqual(f.app.modelCatalog().custom ?? [], []);
  assert.equal(f.requests.length, 0);
});


test('成功型号历史按最近使用排序，每个接入最多 8 条，全部接入最多 256 条', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-custom-history-'));
  const store = createStore(join(dataDir, 'history.sqlite'));
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  function access(index: number) {
    const config: AppConfig = { dataDir, host: '127.0.0.1', port: 0, demo: false,
      model: { provider: 'openai-compatible', model: 'default', baseUrl: 'http://127.0.0.1/v1/' + index } };
    return conversationModels(config, store, 'main');
  }
  function record(index: number, id: string) {
    const models = access(index);
    models.pick(id, true);
    models.rememberUsed(id);
  }
  for (let item = 0; item < 9; item++) record(0, 'model-' + item);
  record(0, 'model-1');
  assert.deepEqual(access(0).catalog().custom, [
    'model-1', 'model-8', 'model-7', 'model-6', 'model-5', 'model-4', 'model-3', 'model-2',
  ]);
  for (let index = 1; index < 32; index++) {
    for (let item = 0; item < 8; item++) record(index, 'model-' + item);
  }
  record(32, 'last-model');
  const history = Array.from({ length: 33 }, (_, index) => access(index).catalog().custom ?? []);
  assert.equal(history.flat().length, 256);
  assert.deepEqual(history[32], ['last-model']);
  assert.deepEqual(history[0], ['model-1', 'model-8', 'model-7', 'model-6', 'model-5', 'model-4', 'model-3']);
});

test('型号输入仅向支持自定义型号的接入开放', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-custom-capability-'));
  const store = createStore(join(dataDir, 'history.sqlite'));
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const baseUrl = 'http://127.0.0.1/fixture';
  for (const [setting, allowed] of [
    [{ provider: 'openai-compatible', model: 'default', baseUrl }, true],
    [{ provider: 'anthropic', model: 'default', baseUrl }, true],
    [{ provider: 'codex-cli', model: 'default' }, true],
    [{ provider: 'openai', model: 'default' }, false],
    [{ provider: 'anthropic', model: 'default' }, false],
    [undefined, false],
  ] as const) {
    const models = conversationModels({ host: '127.0.0.1', port: 0, dataDir, demo: false, model: setting }, store, 'test');
    assert.equal(Boolean(models.catalog().typed), allowed);
    if (!allowed) assert.throws(() => models.pick('fixture-outside', true));
  }
});

test('pi 在阈值处持久化摘要，并在上下文溢出后恢复同一回合', async t => {
  let summaries = 0;
  let overflow = false;
  let tokens = 100;
  let reusedSummary = false;
  const f = await customGateway(t, false, messages => {
    if (JSON.stringify(messages[0]).includes('context summarization assistant')) {
      summaries++;
      return { text: 'SYNTHETIC_HISTORY_SUMMARY' };
    }
    reusedSummary = messages.some(message => JSON.stringify(message.content).includes('SYNTHETIC_HISTORY_SUMMARY'));
    if (overflow) { overflow = false; return { overflow: true }; }
    return { tokens };
  });
  const ask = (text: string) => f.app.agent.ask(text);
  await ask('较早对话');
  await ask('A'.repeat(30000));
  assert.equal(summaries, 0);
  tokens = 21_000;
  await ask('超过小窗口的阈值');
  assert.ok(summaries > 0);
  tokens = 100;
  await f.restart();
  await ask('B'.repeat(30000));
  assert.ok(reusedSummary);
  const previous = summaries;
  overflow = true;
  const answer = await ask('继续当前任务');
  assert.equal(answer.text, '合成回复');
  assert.ok(summaries > previous);
  assert.ok(reusedSummary);

  await ask('C'.repeat(30000));
  await ask('模拟旧会话的最后一次失败');
  await f.restart(async dataDir => {
    const dir = join(dataDir, 'pi/sessions/main');
    const files = (await readdir(dir)).filter(name => name.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const path = join(dir, files[0]!);
    const entries = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    const last = entries.at(-1).message;
    assert.equal(last.role, 'assistant');
    Object.assign(last, { stopReason: 'error', content: [], errorMessage: 'prompt is too long: 40000 tokens > 32768 maximum' });
    await writeFile(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  });
  const beforeResume = summaries;
  assert.equal((await ask('恢复失败会话')).text, '合成回复');
  assert.ok(summaries > beforeResume);
  assert.ok(reusedSummary);
});

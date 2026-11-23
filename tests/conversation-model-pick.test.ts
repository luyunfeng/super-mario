import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkbench } from '../packages/core/src/workbench.ts';

async function fixture(t: test.TestContext, demo = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-conversation-model-'));
  const config = { host: '127.0.0.1', port: 0, dataDir, demo,
    model: { provider: 'groq', model: 'llama-3.1-8b-instant', apiKey: 'fixture-model-key' } };
  let app = await createWorkbench(config);
  t.after(async () => {
    try { await app.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  return { get app() { return app; }, async restart() { await app.close(); app = await createWorkbench(config); } };
}

test('会话模型独立持久化，忙或无效选择保留原值，提供方变更后使用新默认', async t => {
  const f = await fixture(t);
  const first = 'llama-3.3-70b-versatile', second = 'openai/gpt-oss-20b';
  const defaultModel = f.app.modelStatus().model;
  assert.deepEqual(await f.app.pickConversationModel(first), { current: first });
  assert.equal(f.app.modelStatus().model, defaultModel);
  assert.equal(f.app.modelCatalog('bot-a').current, defaultModel);
  assert.deepEqual(await f.app.pickConversationModel(second, 'bot-a'), { current: second });
  assert.equal(f.app.modelCatalog('bot-b').current, defaultModel);
  await assert.rejects(f.app.pickConversationModel('fixture-no-such-model', 'bot-a'));
  assert.equal(f.app.modelCatalog('bot-a').current, second);
  await f.app.postScoped('合成机器人对话输入', { kind: 'global' }, 'bot-a');
  await assert.rejects(f.app.pickConversationModel(first, 'bot-a'), { status: 409 });
  assert.equal(f.app.modelCatalog('bot-a').current, second);
  await f.app.agent.post('合成主对话输入');
  await assert.rejects(f.app.pickConversationModel(second), { status: 409 });
  assert.equal(f.app.modelCatalog().current, first);
  await f.restart();
  assert.equal(f.app.modelCatalog().current, first);
  assert.equal(f.app.modelCatalog('bot-a').current, second);
  assert.equal(f.app.modelCatalog('bot-b').current, defaultModel);
  await f.app.configureModel({ mode: 'api', provider: 'groq', model: defaultModel, apiKey: 'fixture-rotated' });
  assert.equal(f.app.modelCatalog('bot-a').current, second);
  await f.app.configureModel({ mode: 'api', provider: 'openai', model: 'gpt-4o' });
  assert.equal(f.app.modelCatalog().current, 'gpt-4o');
  assert.equal(f.app.modelCatalog('bot-a').current, 'gpt-4o');
});

test('首聊前的模型选择经重启生效，后续切换型号保留已对话的上下文', { timeout: 60000 }, async t => {
  // Intercept the complete HTTP transport before any SDK instance is constructed.
  const requests: string[] = [];
  const messages: Array<{ role: string; content: unknown }[]> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    assert.equal(req.method, 'POST');
    assert.equal(new URL(req.url).pathname, '/openai/v1/chat/completions');
    const body = await req.json();
    const model = body.model;
    messages.push(body.messages);
    requests.push(model);
    const chunks = [{ role: 'assistant', content: '合成回复' }, {}].map((delta, index) => 'data: ' + JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', model, created: 1,
      choices: [{ index: 0, delta, finish_reason: index ? 'stop' : null }],
    }));
    return new Response([...chunks, 'data: [DONE]', ''].join('\n\n'), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const f = await fixture(t, false);
  const selected = 'llama-3.3-70b-versatile';
  const next = 'openai/gpt-oss-20b';
  await f.app.pickConversationModel(selected);
  const botModel = 'openai/gpt-oss-120b';
  await f.app.pickConversationModel(botModel, 'bot-a');
  await f.restart();
  assert.deepEqual(requests, []);
  await f.app.agent.ask('合成历史消息：核对青色文件');
  assert.deepEqual(requests, [selected]);
  await f.app.pickConversationModel(next);
  const reply = await f.app.agent.ask('合成主对话模型验证');
  assert.equal(reply.text, '合成回复');
  assert.deepEqual(requests, [selected, next]);
  const conversation = messages[1].filter(message => ['user', 'assistant'].includes(message.role));
  assert.deepEqual(conversation.map(message => message.role), ['user', 'assistant', 'user']);
  assert.match(JSON.stringify(conversation[0].content), /核对青色文件/);
  assert.match(JSON.stringify(conversation[1].content), /合成回复/);
  assert.match(JSON.stringify(conversation[2].content), /合成主对话模型验证/);
  await f.app.postScoped('合成机器人模型验证', { kind: 'global' }, 'bot-a');
  await f.app.scopedAgents.close();
  assert.deepEqual(requests, [selected, next, botModel]);
  assert.doesNotMatch(JSON.stringify(messages[2]), /核对青色文件/);
});

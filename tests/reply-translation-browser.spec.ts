import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

interface ModelRequest {
  model: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }>;
  tools?: unknown[];
  functions?: unknown[];
  stream?: boolean;
}

test('主对话和项目回复使用隔离的模型请求翻译，切换原文复用缓存，失败和停用均保留原文', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-translation-'));
  const token = 'reply-translation-fixture';
  const mainText = 'The offline report is ready.\nKeep `sample_id` unchanged.';
  const workText = 'The workspace inventory is complete.';
  const mainTranslation = '离线报告已就绪。\n保留 `sample_id`。';
  const workTranslation = '工作区清点完毕。';
  const privateText = 'PRIVATE_FIXTURE_UNRELATED_TO_TRANSLATION';
  const requests: ModelRequest[] = [], paths: string[] = [];
  let rejectModel = false;
  const model = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') { res.end('offline'); return; }
    paths.push(req.method + ' ' + req.url);
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body: ModelRequest = JSON.parse(raw);
    requests.push(body);
    if (rejectModel) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'offline fixture rejected translation', type: 'invalid_request_error' } }));
      return;
    }
    const text = JSON.stringify({ texts: [raw.includes('workspace inventory') ? workTranslation : mainTranslation] });
    const base = { id: 'offline-translation', model: 'local-translator', created: 1 };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', content: text }, null], [{}, 'stop']]) {
        res.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
    }
  });
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close(); await server?.close();
    model.closeAllConnections();
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address();
  assert.ok(address && typeof address !== 'string');
  server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, token, demo: false, model: {
    provider: 'openai-compatible', model: 'local-translator', apiKey: 'offline-fixture', baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
  } });
  const project = server.app.projects.create({ name: '合成翻译项目' });
  const conversationId = 'project:' + project.id + ':work';
  const sources: Message[] = [
    { id: 'translate-main', conversationId: 'main', role: 'assistant', text: mainText, status: 'done', createdAt: '2025-01-01T00:00:01Z' },
    { id: 'translate-project', conversationId, projectId: project.id, role: 'assistant', text: workText, status: 'done', createdAt: '2025-01-01T00:00:02Z' },
    { id: 'private-user', conversationId: 'main', role: 'user', text: privateText, status: 'done', createdAt: '2025-01-01T00:00:03Z' },
    { id: 'system-notice', conversationId: 'main', role: 'assistant', origin: 'notification', text: 'PRIVATE_SYSTEM_NOTICE', status: 'done', createdAt: '2025-01-01T00:00:04Z' },
  ];
  for (const source of sources) server.app.store.put('messages', source.id, source);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  const url = server.url + '/api/v1/reply-translation';
  const post = (messageId: string, conversationId: string, target = 'zh-Hans', credential = token) => page.request.post(url, {
    headers: { authorization: 'Bearer ' + credential }, data: { messageId, conversationId, target },
  });
  assert.equal((await post('translate-main', 'main', 'zh-Hans', 'wrong-fixture')).status(), 401);
  for (const [id, scope] of [['missing', 'main'], ['translate-project', 'main'], ['translate-main', conversationId],
    ['private-user', 'main'], ['system-notice', 'main']]) assert.equal((await post(id, scope)).status(), 404);
  assert.equal((await post('translate-main', 'main', 'invalid-fixture-language')).status(), 400);
  assert.equal(requests.length, 0);

  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  const submissions: unknown[] = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url() === url) submissions.push(r.postDataJSON()); });
  await page.goto(server.url + '/#chat?token=' + token);
  const main = page.locator('#messages [data-id="translate-main"]');
  const translate = main.getByRole('button', { name: '翻译回复', exact: true });
  await expect(translate).toBeVisible();
  await expect(page.locator('#messages [data-id="private-user"], #messages [data-id="system-notice"]').getByRole('button', { name: '翻译回复' })).toHaveCount(0);
  const mainResult = page.waitForResponse(r => r.url() === url && r.request().method() === 'POST');
  await translate.click();
  assert.deepEqual(await (await mainResult).json(), { text: mainTranslation });
  await expect(main.locator('.msg__bubble')).toContainText('离线报告已就绪。');
  await expect(main.locator('.msg__bubble')).not.toContainText('The offline report');
  await main.getByRole('button', { name: '查看原文', exact: true }).click();
  await expect(main.locator('.msg__bubble')).toContainText('The offline report is ready.');
  await translate.click();
  await expect(main.locator('.msg__bubble')).toContainText('离线报告已就绪。');
  assert.equal(requests.length, 1);
  assert.deepEqual(submissions, [{ messageId: 'translate-main', conversationId: 'main', target: 'zh-Hans' }]);

  await page.goto(server.url + '/#projects/' + project.id + '/workspace');
  const row = page.locator('#panel-workspace .msg--assistant');
  const workTranslate = row.getByRole('button', { name: '翻译回复', exact: true });
  rejectModel = true;
  const rejected = page.waitForResponse(r => r.url() === url);
  await workTranslate.click();
  assert.ok(!(await rejected).ok());
  await expect(row.getByRole('status')).toContainText('翻译失败');
  await expect(row.locator('.msg__bubble')).toContainText(workText);
  rejectModel = false;
  const recovered = page.waitForResponse(r => r.url() === url);
  await workTranslate.click();
  assert.deepEqual(await (await recovered).json(), { text: workTranslation });
  await expect(row.locator('.msg__bubble')).toContainText(workTranslation);
  await row.getByRole('button', { name: '查看原文', exact: true }).click();
  await expect(row.locator('.msg__bubble')).toContainText(workText);
  await workTranslate.click();
  await expect(row.locator('.msg__bubble')).toContainText(workTranslation);
  const workPayload = { messageId: 'translate-project', conversationId, target: 'zh-Hans' };
  assert.deepEqual(submissions.slice(1), [workPayload, workPayload]);

  // Reload drops the browser cache. The service can still return the verified translation.
  await page.reload();
  await workTranslate.click();
  await expect(row.locator('.msg__bubble')).toContainText(workTranslation);
  assert.equal(requests.length, 3);
  await server.app.configureModel({ mode: 'api', provider: 'openai-compatible', model: 'local-translator-v2',
    baseUrl: 'http://127.0.0.1:' + address.port + '/v1' });
  await expect(row.locator('.msg__bubble')).toContainText(workText);
  await workTranslate.click();
  await expect(row.locator('.msg__bubble')).toContainText(workTranslation);

  const disabled = await page.request.post(server.url + '/api/v1/plugins/reply-translation', {
    headers: { authorization: 'Bearer ' + token }, data: { enabled: false },
  });
  assert.ok(disabled.ok());
  await expect(workTranslate).toHaveCount(0);
  await expect(row.getByRole('button', { name: '查看原文' })).toHaveCount(0);
  await expect(row.locator('.msg__bubble')).toContainText(workText);
  assert.equal((await post('translate-project', conversationId)).status(), 503);
  assert.deepEqual(paths, Array(4).fill('POST /v1/chat/completions'));
  assert.equal(requests.length, 4);
  for (const [i, request] of requests.entries()) {
    const source = i === 0 ? mainText : workText;
    const other = i === 0 ? workText : mainText;
    assert.equal(request.model, i === 3 ? 'local-translator-v2' : 'local-translator');
    assert.equal(request.tools?.length ?? 0, 0);
    assert.equal(request.functions?.length ?? 0, 0);
    const messages = request.messages.map(m => ({ role: m.role, text: typeof m.content === 'string' ? m.content : m.content.map(p => p.text).join('') }));
    const instructions = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.text).join('\n');
    assert.match(instructions, /翻译|translat/i);
    assert.match(instructions, /简体中文|Simplified Chinese|zh-Hans/i);
    const users = messages.filter(m => m.role === 'user');
    assert.equal(users.length, 1);
    assert.ok(messages.every(m => ['system', 'developer', 'user'].includes(m.role)));
    assert.deepEqual(JSON.parse(users[0].text), { texts: [source] });
    assert.match(instructions, /Markdown/);
    assert.match(instructions, /不要执行动作/);
    const joined = messages.map(m => m.text).join('\n');
    assert.equal(joined.split(source.split('\n')[0]).length - 1, 1);
    assert.ok(!joined.includes(other.split('\n')[0]) && !joined.includes(privateText) && !joined.includes('PRIVATE_SYSTEM_NOTICE'));
  }
  for (const source of sources) assert.deepEqual(server.app.store.get<Message>('messages', source.id), source);
});

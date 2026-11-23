import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

test('主对话和项目工作会话在回执丢失后重用请求号，明确收到回执后可再次发送相同正文', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-message-receipt-'));
  const token = 'message-receipt-browser-fixture';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'server'), demo: true, token });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let node: ReturnType<typeof startAgentNode> | undefined;
  t.after(async () => { await browser?.close(); await node?.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const cwd = join(dir, 'project'), machineId = 'receipt-fixture-node';
  await mkdir(cwd);
  const discovery = createProjectDiscovery({ home: dir, cwd, roots: [], temporaryRoots: [], ignoreEnvironmentRoots: true });
  node = startAgentNode({ url: server.url, token, machineId, name: '合成回执测试电脑', dataDir: join(dir, 'node'),
    handlers: { 'workspace.directory': discovery.handlers['workspace.directory'] }, executors: [] });
  await expect.poll(() => server.machines.list().some(m => m.id === machineId && m.online)).toBe(true);
  const project = await server.app.createProject({ name: '合成回执项目', workspace: { machineId, cwd } });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  const requests: { url: string; key: string | undefined; text: string }[] = [];
  page.on('request', r => {
    if (r.method() === 'POST' && /\/api\/v1\/(projects\/[^/]+\/)?messages$/.test(r.url()))
      requests.push({ url: r.url(), key: r.headers()['idempotency-key'], text: r.postDataJSON().text });
  });
  await page.goto(server.url + '/#chat?token=' + token);
  const body = '请记录合成回执测试。';
  for (const ctx of [
    { route: 'chat', conversation: 'main', api: '/messages', input: '给 Agent 的消息', submit: '发送' },
    { route: 'projects/' + project.id + '/workspace', conversation: 'project:' + project.id + ':work',
      api: '/projects/' + project.id + '/messages', input: '项目目标', submit: '发送目标' },
  ]) {
    await page.goto(server.url + '/#' + ctx.route);
    const input = page.getByLabel(ctx.input), send = page.getByRole('button', { name: ctx.submit, exact: true });
    const url = server.url + '/api/v1' + ctx.api;
    const submissions = () => requests.filter(r => r.url === url);
    const rows = () => server.app.store.list<Message>('messages').filter(m => m.conversationId === ctx.conversation);
    const users = () => rows().filter(m => m.role === 'user');
    const replies = () => rows().filter(m => m.role === 'assistant' && m.origin !== 'notification');
    const confirmedSend = async () => {
      const receipt = page.waitForResponse(r => r.request().method() === 'POST' && r.url() === url);
      await send.click();
      const response = await receipt;
      assert.ok(response.ok(), '服务应确认受理手动提交');
      return (await response.json()) as Message;
    };

    // 让服务端真正处理第一次请求；浏览器只看到连接中断。
    let accepted: Message | undefined, status = 0;
    await page.route(url, async route => {
      const response = await route.fetch();
      status = response.status();
      accepted = await response.json();
      await route.abort('connectionreset');
    }, { times: 1 });
    const lost = page.waitForEvent('requestfailed', r => r.method() === 'POST' && r.url() === url);
    await input.fill(body);
    await send.click();
    await lost;
    assert.ok(status >= 200 && status < 300);
    assert.ok(accepted?.id);
    const firstId = accepted.id;
    await expect(input).toHaveValue(body);
    await expect.poll(() => replies().filter(m => m.status === 'done').map(m => m.replyTo)).toEqual([firstId]);
    assert.deepEqual(users().map(m => m.id), [firstId]);

    await page.reload();
    await expect(input).toHaveValue(body);
    await expect(send).toBeEnabled();
    const first = submissions();
    assert.equal(first.length, 1);
    const key = first[0].key;
    assert.ok(key?.trim(), '首次发送必须携带请求号');
    assert.equal(accepted.requestId, key);
    const recovered=page.waitForResponse(r=>r.request().method()==='GET' && r.url()===url+'/receipts/'+key);
    await send.click();
    const actual=await recovered;
    assert.equal(actual.status(),200);
    const retry=await actual.json() as Message;
    assert.deepEqual(submissions().map(r => r.key), [key]);
    assert.equal(retry.id, firstId);
    assert.equal(retry.requestId, key);
    await expect(input).toHaveValue('');
    assert.deepEqual(users().map(m => m.id), [firstId]);
    assert.deepEqual(replies().map(m => m.replyTo), [firstId]);

    await input.fill(body);
    const newMessage = await confirmedSend();
    assert.notEqual(newMessage.id, firstId);
    const all = submissions();
    assert.equal(all.length, 2);
    assert.ok(all[1].key?.trim());
    assert.notEqual(all[1].key, key);
    assert.equal(newMessage.requestId, all[1].key);
    assert.deepEqual(all.map(r => r.text), [body, body]);
    await expect(input).toHaveValue('');
    await expect.poll(() => replies().filter(m => m.status === 'done').map(m => m.replyTo).sort())
      .toEqual([firstId, newMessage.id].sort());
    assert.equal(replies().length, 2);
    assert.deepEqual(users().map(m => [m.id, m.text, m.requestId]), [[firstId, body, key], [newMessage.id, body, all[1].key]]);

    const check = page.getByRole('button', { name: '核对发送回执', exact: true });
    for (const editDuringSend of [false, true]) {
      const submitted = editDuringSend ? '回执在途时继续编辑。' : '只读查询这条已发送消息。';
      const nextDraft = '回执在途期间输入的新草稿。';
      const beforeCount = submissions().length;
      let release!: () => void;
      const releaseReceipt = new Promise<void>(resolve => { release = resolve; });
      await page.route(url, async route => {
        await route.fetch();
        await releaseReceipt;
        await route.abort('connectionreset');
      }, { times: 1 });
      const interrupted = page.waitForEvent('requestfailed', r => r.method() === 'POST' && r.url() === url);
      await input.fill(submitted);
      await send.click();
      try {
        await expect.poll(() => users().filter(m => m.text === submitted).length).toBe(1);
        if (editDuringSend) await input.fill(nextDraft);
      } finally { release(); }
      await interrupted;
      await expect(check).toBeVisible();
      const record = users().find(m => m.text === submitted)!;
      const receiptUrl = url + '/receipts/' + record.requestId;
      const lookup = page.waitForResponse(r => r.request().method() === 'GET' && r.url() === receiptUrl);
      await check.click();
      const response = await lookup;
      assert.equal(response.status(), 200);
      const checked = (await response.json()) as Message;
      assert.equal(checked.id, record.id);
      assert.equal(checked.requestId, record.requestId);
      await expect(check).toBeHidden();
      await expect(input).toHaveValue(editDuringSend ? nextDraft : '');
      assert.equal(submissions().length, beforeCount + 1);
      await expect.poll(() => replies().filter(m => m.replyTo === record.id && m.status === 'done').length).toBe(1);
      assert.equal(users().filter(m => m.text === submitted).length, 1);
    }
  }
});

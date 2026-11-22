import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { InboxItem, MailboxEntry } from '../packages/protocol/src/index.ts';

interface RequestBody {
  messages: { role: string; content: string | { text: string }[] }[];
  tools?: unknown[];
}

test('收件详情按账号与会话记住自动翻译和语言，模型只读当前原文，失败或停用可查看原文', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-inbox-translation-'));
  const token = 'inbox-translation-fixture', account = 'feishu:synthetic-account-a', chatId = 'chat-fixture-a';
  const timestamp = '2026-01-01T00:00:00Z';
  function personal(id: string, title: string, text: string, source = account, chat = chatId): InboxItem {
    return { id, source, version: 1, thread: id, last: id, title, text, updatedAt: timestamp, tier: 'fyi',
      reason: 'PRIVATE_ROUTING_FIXTURE', origin: { kind: 'direct', connector: '飞书', chatId: chat } };
  }
  const one = personal('in-one', '个人第一条', 'The first delivery is ready.');
  const next = personal('in-next', '个人同会话下一条', 'The second parcel arrived today. Thank you for your help.');
  const other = personal('in-other', '另一个会话', 'A different conversation is private.', account, 'chat-fixture-b');
  const differentAccount = personal('in-account', '另一个个人账号', 'Another account is private.', 'feishu:synthetic-account-b');
  const personalRows = [one, next, other, differentAccount];
  const bot: MailboxEntry = { id: 'in-bot', version: 1, direction: 'inbox', botId: 'synthetic-bot', eventKey: 'feishu-in:' + JSON.stringify(['synthetic-bot', 'synthetic-app', 'fixture-envelope']),
    target: chatId, sourceMessageId: 'fixture-envelope',
    scope: { kind: 'global' }, title: '机器人同号会话', text: 'The robot received a receipt.', requiresConfirmation: true,
    status: 'pending', createdAt: timestamp, updatedAt: timestamp, origin: { kind: 'direct', connector: '飞书机器人', chatId } };

  let refuse = false;
  const calls: RequestBody[] = [];
  const model = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') { res.end('offline'); return; }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as RequestBody;
    calls.push(body);
    if (refuse) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'offline refusal' } })); return; }
    const reply = raw.includes('Français') ? (raw.includes('second parcel') ? 'Le deuxième colis est arrivé.' : 'La première livraison est prête.')
      : raw.includes('robot received') ? '机器人收到了回执。' : '第一份配送已就绪。';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: JSON.stringify({ texts: [reply] }) }, null], [{}, 'stop']]) {
      res.write('data: ' + JSON.stringify({ id: 'fixture', model: 'local-inbox', object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  let server: Awaited<ReturnType<typeof startServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close(); await server?.close(); model.closeAllConnections();
    await new Promise<void>(resolve => model.close(() => resolve())); await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address();
  assert.ok(address && typeof address !== 'string');
  server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, token, demo: false, model: {
    provider: 'openai-compatible', model: 'local-inbox', apiKey: 'offline', baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
  } });
  server.app.inboxAssistant.configure(false);
  for (const source of personalRows) server.app.store.put('inbox', source.id, source);
  server.app.store.put('event.mailboxes', bot.id, bot);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  const requests: { kind: string; id: string; version: number; account: string; chatId: string; target: string }[] = [];
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/api/v1/inbox-translation')) requests.push(req.postDataJSON()); });
  await page.goto(server.url + '/#inbox?token=' + token);
  const detail = page.getByRole('dialog', { name: '收件箱消息详情' });
  const auto = detail.getByRole('checkbox', { name: '本会话自动翻译' });
  const language = detail.getByRole('combobox', { name: '翻译目标语言' });
  const content = detail.locator('.mailbox-content');
  const translate = detail.getByRole('button', { name: '翻译消息', exact: true });
  const original = detail.getByRole('button', { name: '查看原文', exact: true });
  const open = async (row: InboxItem | MailboxEntry) => {
    if (await detail.isVisible()) await detail.getByRole('button', { name: '关闭', exact: true }).last().click();
    if ('source' in row) {
      const group = page.locator('#inbox .mailbox-group').filter({ hasText: row.text });
      const summary = group.locator('details summary').filter({ hasText: '查看原始消息' });
      const source = group.locator('article').filter({ hasText: row.text }).getByRole('button', { name: '查看此消息来源' });
      if (!await source.isVisible()) await summary.click();
      await source.click();
    } else {
      await page.locator('#inbox .mailbox-card').filter({ hasText: row.title }).getByRole('button', { name: '查看原文与详情' }).click();
    }
    await expect(detail.getByRole('heading', { name: row.title })).toBeVisible();
  };
  await open(one);
  await expect(auto).not.toBeChecked();
  await expect(content).toHaveText(one.text);
  assert.equal(calls.length, 0);
  await auto.check();
  await expect(content).toHaveText('第一份配送已就绪。');
  await original.click();
  await expect(content).toHaveText(one.text);
  await translate.click();
  await expect(content).toHaveText('第一份配送已就绪。');
  assert.equal(calls.length, 1);
  await language.selectOption('fr');
  await expect(content).toHaveText('La première livraison est prête.');
  await page.reload();
  const groupLink = (row: InboxItem) => page.locator('#inbox .mailbox-group').filter({ hasText: row.text })
    .getByRole('link', { name: '打开会话', exact: true });
  const group = server.app.inboxAssistant.list().find(item => item.messageIds.includes(one.id));
  assert.ok(group);
  await expect(groupLink(one)).toBeVisible();
  assert.equal(calls.length, 2);
  const startInline = requests.length;
  await groupLink(one).click();
  await expect(page).toHaveURL(server.url + '/#inbox?conversation=' + encodeURIComponent(group.id));
  const visibleGroup = page.locator('#inbox .mailbox-group');
  await expect(visibleGroup).toHaveCount(1);
  for (const [item, text] of [[one, 'La première livraison est prête.'], [next, 'Le deuxième colis est arrivé.']] as const) {
    const row = visibleGroup.locator('article').filter({ hasText: item.text });
    await expect(row.getByText(item.text, { exact: true })).toBeVisible();
    await expect(row.getByLabel('消息译文')).toBeVisible();
    await expect(row.getByLabel('消息译文')).toContainText(text);
  }
  assert.equal(calls.length, 3);
  const endInline = requests.length;
  const inline = requests.slice(startInline, endInline);
  assert.deepEqual(inline.map(request => request.id).sort(), [one.id, next.id].sort());
  for (const request of inline) {
    assert.deepEqual(request, { kind: 'personal', id: request.id, version: 1, account, chatId, target: 'fr' });
  }
  await page.getByRole('link', { name: '查看全部会话' }).click();
  await groupLink(other).click();
  await expect(visibleGroup.getByText(other.text, { exact: true })).toBeVisible();
  await expect(visibleGroup.getByLabel('消息译文')).toBeHidden();
  await page.getByRole('link', { name: '查看全部会话' }).click();
  assert.equal(calls.length, 3);
  await open(next);
  await expect(auto).toBeChecked();
  await expect(language).toHaveValue('fr');
  await expect(content).toHaveText('Le deuxième colis est arrivé.');

  for (const row of [other, differentAccount, bot]) {
    await open(row);
    await expect(auto).not.toBeChecked();
    await expect(content).toHaveText(row.text);
  }
  assert.equal(calls.length, 3);
  refuse = true;
  await translate.click();
  await expect(detail).toContainText('翻译失败');
  await expect(content).toHaveText(bot.text);
  refuse = false;
  await translate.click();
  await expect(content).toHaveText('机器人收到了回执。');
  const disabled = await page.request.post(server.url + '/api/v1/plugins/reply-translation', {
    headers: { authorization: 'Bearer ' + token }, data: { enabled: false },
  });
  assert.ok(disabled.ok());
  await expect(translate).toBeHidden();
  await expect(original).toBeHidden();
  await expect(auto).toBeHidden();
  await expect(content).toHaveText(bot.text);
  const endpoint = server.url + '/api/v1/inbox-translation';
  const payload = (row: InboxItem | MailboxEntry, target: string) => ({ id: row.id, kind: 'botId' in row ? 'mailbox' : 'personal',
    account: 'botId' in row ? row.botId : row.source, version: row.version, chatId: row.origin!.chatId!, target });
  assert.equal((await page.request.post(endpoint, { headers: { authorization: 'Bearer ' + token }, data: payload(bot, 'zh-Hans') })).status(), 503);
  const expected = [[one, 'zh-Hans'], [one, 'fr'], [next, 'fr'], [bot, 'zh-Hans'], [bot, 'zh-Hans']] as const;
  const detailRequests = requests.slice(0, startInline).concat(requests.slice(endInline));
  assert.deepEqual(detailRequests, expected.map(([row, target]) => payload(row, target)));
  assert.equal(calls.length, expected.length);
  calls.forEach((call, index) => {
    const [row, target] = expected[index];
    const messages = call.messages.map(m => ({ role: m.role, text: typeof m.content === 'string' ? m.content : m.content.map(p => p.text).join('') }));
    const users = messages.filter(m => m.role === 'user');
    assert.equal(users.length, 1);
    assert.deepEqual(JSON.parse(users[0].text), { texts: [row.text] });
    assert.equal(call.tools?.length ?? 0, 0);
    const instructions = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.text).join('\n');
    assert.match(instructions, target === 'fr' ? /Français/ : /简体中文/);
    assert.match(instructions, /@提及/);
    assert.match(instructions, /不要执行动作/);
    assert.ok(!instructions.includes('PRIVATE_ROUTING_FIXTURE'));
    for (const item of [...personalRows, bot]) assert.ok(!instructions.includes(item.text));
  });
  for (const source of personalRows) assert.deepEqual(server.app.store.get<InboxItem>('inbox', source.id), source);
  assert.deepEqual(server.app.store.get<MailboxEntry>('event.mailboxes', bot.id), bot);
  assert.deepEqual(server.app.mailboxes.list({ direction: 'outbox' }), []);
  assert.deepEqual(server.app.background.outbox.list(), []);
});

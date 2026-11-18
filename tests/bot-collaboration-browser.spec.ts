import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, expect, type Page } from '@playwright/test';

// 只加载被测模块。所有接口均为本机假 API，不接模型、飞书或真实执行机。
async function withBots(run: (page: Page, writes: any[]) => Promise<void>) {
  const source = await readFile(new URL('../apps/web/js/legacy/bot-mailboxes.js', import.meta.url), 'utf8');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/module.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/module.js' ? source : '<!doctype html><html><body><main></main></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const writes: any[] = [], errors: string[] = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('recordWrite', (value: any) => writes.push(value));
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}/#channels`);
    await page.evaluate(async () => {
      const w = window as any;
      const modulePath = '/module.js';
      const { createBotMailboxesUI } = await import(modulePath);
      w.bots = [
        { id: 'a', name: '机器人甲', appId: 'app-a', enabled: false, scope: { kind: 'unmarked' }, requireConfirmation: true, executorId: 'missing', groupChats: [{ chatId: 'shared', mentionOnly: false, allowedSenderIds: ['owner', 'member'] }, { chatId: 'a-only', mentionOnly: true, allowedSenderIds: [] }], collaboration: { peerBotIds: ['b'] }, replyTarget: 'private-a' },
        { id: 'b', name: '机器人乙', appId: 'app-b', scope: { kind: 'global' }, groupChats: [{ chatId: 'shared', mentionOnly: true, allowedSenderIds: [] }], collaboration: { peerBotIds: ['a'] }, replyTarget: 'private-b' },
        { id: 'c', name: '单向机器人', appId: 'app-c', scope: { kind: 'unmarked' }, collaboration: { peerBotIds: ['a'] } },
      ];
      w.state = { projects: [], todos: [], executors: [{ id: 'exec', name: '执行者甲', machineId: 'machine', available: true }], machines: [{ id: 'machine', name: '电脑甲', online: false }] };
      w.entries = []; w.relayFailure = ''; w.reads = 0;
      w.ui = createBotMailboxesUI({ element: document.querySelector('main'), getState: () => w.state, api: async (path: string, init?: any) => {
        if (!init) {
          if (path === '/feishu/bots') { w.reads++; return structuredClone(w.bots); }
          if (path.startsWith('/mailboxes')) return structuredClone(w.entries);
          return [];
        }
        const body = JSON.parse(init.body || '{}');
        await w.recordWrite({ path, method: init.method, body });
        if (path.endsWith('/relay')) {
          if (w.relayGate) await w.relayGate;
          if (w.relayFailure) { const error: any = new Error('test error'); if (w.relayFailure === 'server') error.status = 502; throw error; }
          w.entries = [{ id: 'entry', botId: body.targetBotId, direction: 'inbox', scope: { kind: 'global' }, title: '内部请求', text: body.text, status: 'pending', version: 1, requiresConfirmation: true }];
          return { status: 'pending' };
        }
        if (path.startsWith('/feishu/bots/')) Object.assign(w.bots.find((bot: any) => path.endsWith('/' + bot.id)), body);
        return path === '/feishu/registrations' ? { id: 'qr', status: 'completed' } : {};
      } });
      w.ui.open();
    });
    await expect(page.locator('.bot-list article')).toHaveCount(3);
    await run(page, writes);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

const formOf = (page: Page) => page.locator('.bot-form');
const editA = (page: Page) => page.locator('[data-bot-id=a]').getByRole('button', { name: '编辑', exact: true }).click();

test('机器人编辑保留高级字段；后台刷新不覆盖草稿；显式清空和取消', { timeout: 30000 }, async () => {
  await withBots(async (page, writes) => {
    const form = formOf(page);
    await editA(page);
    await expect(form.locator('[name=executorId]')).toHaveValue('missing');
    await expect(form.locator('[name=executorId] option[value=exec]')).toContainText('电脑甲 · 离线');
    await expect(form.locator('[name=mentionOnly]').first()).not.toBeChecked();
    assert.deepEqual(await form.locator('[name=peerBotIds]').evaluate((el: HTMLSelectElement) => [...el.selectedOptions].map(o => o.value)), ['b']);
    assert.equal(await form.locator('[name=peerBotIds] option[value=a]').count(), 0);
    await form.locator('[name=name]').fill('草稿名称');
    await form.locator('[name=allowedSenderIds]').first().fill('owner,member\nnew，owner');
    await page.evaluate(async () => { const w = window as any; const before = w.reads; w.ui.update(w.state); while (w.reads === before) await new Promise(r => setTimeout(r, 1)); });
    await expect(form.locator('[name=name]')).toHaveValue('草稿名称');
    await expect(form.locator('[name=allowedSenderIds]').first()).toHaveValue('owner,member\nnew，owner');
    assert.equal(writes.length, 0);
    await form.getByRole('button', { name: '保存手动接入' }).click();
    await expect(form.locator('[name=name]')).toHaveValue('');
    assert.equal(writes[0].method, 'PATCH');
    assert.equal(writes[0].body.executorId, 'missing');
    assert.deepEqual(writes[0].body.collaboration, { peerBotIds: ['b'] });
    assert.deepEqual(writes[0].body.groupChats, [{ chatId: 'shared', mentionOnly: false, allowedSenderIds: ['owner', 'member', 'new'] }, { chatId: 'a-only', mentionOnly: true, allowedSenderIds: [] }]);
    await editA(page);
    await form.locator('[name=executorId]').selectOption('');
    await form.getByRole('button', { name: '删除此群' }).first().click();
    await form.getByRole('button', { name: '删除此群' }).click();
    await form.locator('[name=peerBotIds]').selectOption([]);
    await form.getByRole('button', { name: '保存手动接入' }).click();
    await expect(form.locator('[name=name]')).toHaveValue('');
    assert.deepEqual(writes[1].body.groupChats, []); assert.deepEqual(writes[1].body.collaboration, { peerBotIds: [] }); assert.equal(writes[1].body.executorId, '');
    await editA(page); await form.getByText('群协作（默认关闭）', { exact: true }).click();
    await form.getByRole('button', { name: '添加群', exact: true }).click();
    await expect(form.locator('[name=mentionOnly]')).toBeChecked();
    await form.getByRole('button', { name: '取消编辑 / 新建' }).click();
    await expect(form.locator('[name=chatId]')).toHaveCount(0);
    assert.equal(writes.length, 2);
  });
});

test('手动新建 POST 保存高级字段；扫码只提交基础契约并提示后续编辑', { timeout: 30000 }, async () => {
  await withBots(async (page, writes) => {
    const form = formOf(page);
    await form.locator('[name=name]').fill('新机器人');
    await form.locator('[name=appId]').fill('fake-app'); await form.locator('[name=appSecret]').fill('fake-secret');
    await form.locator('[name=executorId]').selectOption('exec');
    await form.getByText('群协作（默认关闭）', { exact: true }).click();
    await form.getByRole('button', { name: '添加群', exact: true }).click();
    await form.locator('[name=chatId]').fill('new-group');
    await form.locator('[name=peerBotIds]').selectOption(['b']);
    await form.getByRole('button', { name: '保存手动接入' }).click();
    await expect(form.locator('[name=name]')).toHaveValue('');
    assert.equal(writes[0].path, '/feishu/bots'); assert.equal(writes[0].method, 'POST');
    assert.equal(writes[0].body.executorId, 'exec'); assert.deepEqual(writes[0].body.groupChats, [{ chatId: 'new-group', mentionOnly: true, allowedSenderIds: [] }]);
    await form.locator('[name=name]').fill('扫码机器人'); await form.locator('[name=executorId]').selectOption('exec');
    await form.getByRole('button', { name: '扫码添加机器人' }).click();
    await expect(page.locator('.bot-registration')).toContainText('创建完成后，请点编辑');
    assert.deepEqual(writes[1].body, { name: '扫码机器人', scope: { kind: 'unmarked' }, requireConfirmation: true });
    assert.equal(writes.length, 2);
  });
});

test('草稿只允许配对私聊和已配置群，切机器人清空目标，始终待确认', { timeout: 30000 }, async () => {
  await withBots(async (page, writes) => {
    const draft = page.locator('.mailbox-draft');
    await draft.locator('[name=botId]').selectOption('a');
    await expect(draft.locator('[name=target] option')).toHaveCount(4);
    await draft.locator('[name=target]').selectOption('a-only');
    await draft.locator('[name=botId]').selectOption('b');
    await expect(draft.locator('[name=target]')).toHaveValue('');
    assert.equal(await draft.locator('[name=target] option[value="a-only"]').count(), 0);
    assert.equal(writes.length, 0);
    await draft.locator('[name=target]').selectOption('shared');
    await draft.locator('[name=title]').fill('群草稿'); await draft.locator('[name=text]').fill('仅保存草稿');
    await draft.getByRole('button', { name: '保存待发草稿' }).click();
    await expect.poll(() => writes.length).toBe(1);
    assert.deepEqual(writes[0].body, { direction: 'outbox', botId: 'b', target: 'shared', title: '群草稿', text: '仅保存草稿', requiresConfirmation: true });
  });
});

async function fillRelay(page: Page) {
  const form = page.locator('.bot-relay');
  await form.locator('[name=sourceBotId]').selectOption('a');
  assert.equal(await form.locator('[name=targetBotId] option[value=c]').count(), 0);
  await form.locator('[name=targetBotId]').selectOption('b');
  await expect(form.locator('[name=relayChatId] option')).toHaveCount(2);
  await form.locator('[name=relayChatId]').selectOption('shared');
  await form.locator('[name=relayText]').fill('完整协作请求\n包含上下文');
  return form;
}

test('协作仅点击提交；请求 key 固定；成功刷新信箱显示各状态，不触发飞书发送', { timeout: 30000 }, async () => {
  await withBots(async (page, writes) => {
    const form = await fillRelay(page); assert.equal(writes.length, 0);
    await page.evaluate(() => { const w = window as any; w.relayGate = new Promise(resolve => { w.releaseRelay = resolve; }); });
    await form.getByRole('button', { name: '提交协作请求' }).click();
    await expect.poll(() => writes.length).toBe(1);
    const key = writes[0].body.key; assert.match(key, /^[0-9a-f-]{36}$/);
    await page.evaluate(() => { const w = window as any; w.ui.update(w.state); document.querySelector('.bot-relay')!.dispatchEvent(new Event('submit', { cancelable: true })); });
    assert.equal(writes.length, 1); assert.equal(writes[0].body.key, key);
    assert.deepEqual(writes[0], { path: '/feishu/bots/a/relay', method: 'POST', body: { targetBotId: 'b', text: '完整协作请求\n包含上下文', key, chatId: 'shared' } });
    await page.evaluate(() => (window as any).releaseRelay());
    await expect(form).toContainText('协作请求已进入目标信箱');
    await expect(page.locator('.mailbox-list')).toContainText('待确认');
    for (const [status, label] of [['ready', '待处理'], ['completed', '已完成'], ['unknown', '结果未知']]) {
      await page.evaluate(status => { (window as any).entries[0].status = status; }, status);
      await form.getByRole('button', { name: '只读刷新信箱核对' }).click();
      await expect(page.locator('.mailbox-list')).toContainText(label);
    }
    assert.equal(writes.length, 1);
  });
});

for (const failure of ['server', 'network']) test(`协作 ${failure} unknown 锁定重复提交，刷新和切页均不重放`, { timeout: 30000 }, async () => {
  await withBots(async (page, writes) => {
    const form = await fillRelay(page);
    await page.evaluate(failure => { (window as any).relayFailure = failure; }, failure);
    await form.getByRole('button', { name: '提交协作请求' }).click();
    await expect(form).toContainText('unknown'); await expect(form.getByRole('button', { name: '提交协作请求' })).toBeDisabled();
    const key = writes[0].body.key;
    await form.getByRole('button', { name: '只读刷新信箱核对' }).click();
    await page.evaluate(() => { const w = window as any; location.hash = '#settings'; w.ui.open(); w.ui.update(w.state); document.querySelector('.bot-relay')!.dispatchEvent(new Event('submit', { cancelable: true })); });
    await expect(form.getByRole('button', { name: '提交协作请求' })).toBeDisabled();
    assert.equal(writes.length, 1); assert.equal(writes[0].body.key, key);
    await expect(form.locator('[name=relayText]')).toHaveValue('完整协作请求\n包含上下文');
  });
});


test('内部协作空群省略 chatId，取消选择与渲染均不创建请求', { timeout: 30000 }, async () => {
  await withBots(async (page, writes) => {
    const form = await fillRelay(page);
    await form.locator('[name=relayChatId]').selectOption('');
    await page.evaluate(() => { const w = window as any; w.ui.render(w.state); });
    assert.equal(writes.length, 0);
    await form.getByRole('button', { name: '提交协作请求' }).click();
    await expect(form).toContainText('协作请求已进入目标信箱');
    assert.equal(writes.length, 1); assert.equal('chatId' in writes[0].body, false);
  });
});

test('开发机HTTP环境缺少randomUUID时仍能提交带稳定标识的协作请求', {timeout:30000},async()=>{
 await withBots(async(page,writes)=>{
  await page.evaluate(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));
  const relay=page.locator('.bot-relay');
  await relay.locator('[name=sourceBotId]').selectOption('a');await relay.locator('[name=targetBotId]').selectOption('b');await relay.locator('textarea').fill('在开发机HTTP入口提交');
  await relay.getByRole('button',{name:'提交协作请求',exact:true}).click();
  await expect.poll(()=>writes.length).toBe(1);assert.ok(writes[0].body.key.length>=32);
  assert.equal(writes[0].path,'/feishu/bots/a/relay');
 });
});

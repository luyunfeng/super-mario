import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';

test('已授权账号配置 /ai、查看触发结果和已关联草稿，失去授权时关闭设置', async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const personal = { status: 'disconnected', enabled: false, account: { name: '测试账号' } };
    const config = { enabled: false, prefix: '/ai', contextCount: 5, chatIds: [], triggerSenderIds: [] };
    const turns = [{ messageId: 'm/1', status: 'completed', inboxId: 'item/1' }, { messageId: 'm/2', status: 'unknown', error: '没有回执' }];
    let accountKey = 'account-a';
    const handlingPath = '/api/v1/inbox-handling/personal/item%2F1';
    const suggestion = { id: 'draft', version: 1, sourceVersion: 1, status: 'draft', action: { kind: 'reply', text: '待审核' } };
    const approvals: unknown[] = [];
    const writes: unknown[] = [];
    let reads = 0;
    await page.route('http://fixture/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<body></body>' });
      if (path.startsWith('/js/')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../apps/web' + path, import.meta.url)) });
      if (path === '/api/v1/feishu/personal') return route.fulfill({ json: personal });
      if (path === '/api/v1/feishu/personal/ai') {
        if (route.request().method() === 'PUT') {
          const { expectedAccountKey, ...changes } = route.request().postDataJSON();
          writes.push({ expectedAccountKey, ...changes });
          if (accountKey !== expectedAccountKey) return route.fulfill({ status: 409, json: { error: '账号已切换' } });
          Object.assign(config, changes);
        }
        else reads++;
        return route.fulfill({ json: { ...config, accountKey, turns } });
      }
      if (path === handlingPath) return route.fulfill({ json: {
        source: { id: 'item/1', kind: 'personal', title: '样例', text: '问题', active: true, replyAvailable: true, version: 1 },
        suggestions: [suggestion], messages: [], requests: [], available: false
      } });
      if (path === handlingPath + '/suggestions') {
        suggestion.action = route.request().postDataJSON().action;
        suggestion.version++;
        return route.fulfill({ json: suggestion });
      }
      if (path === handlingPath + '/suggestions/draft/confirm') {
        approvals.push(route.request().postDataJSON());
        suggestion.status = 'submitted';
        return route.fulfill({ json: { id: 'approval' } });
      }
      return route.fulfill({ status: 404, json: { error: '测试未提供此记录' } });
    });
    await page.goto('http://fixture/');
    await page.evaluate(async () => {
      const feature = '/js/features/personal-messages.js', client = '/js/lib/api.js';
      const { createPersonalMessagesUI } = await import(feature);
      const { createApi } = await import(client);
      const ui = createPersonalMessagesUI({ api: createApi(), store: { view: {}, subscribe: () => () => {} },
        router: { current: { page: 'channels' }, href: () => '#inbox' } });
      Object.assign(window, { refreshAccount: ui.refresh });
      document.body.append(ui.el); await ui.refresh();
    });
    const settings = page.getByRole('button', { name: '个人消息 /ai 设置' });
    const dialog = page.getByRole('dialog', { name: '个人消息 /ai 设置' });
    const refresh = () => page.evaluate(() => (window as unknown as { refreshAccount(): Promise<void> }).refreshAccount());
    await expect(settings).toHaveCount(0);
    personal.status = 'connected'; await refresh();
    assert.equal(reads, 0);
    await settings.click();
    await expect(dialog).toContainText('采集已停止');
    await expect(dialog).toContainText('结果未知');
    await expect(dialog.getByRole('button', { name: '查看草稿与建议' })).toHaveCount(1);
    await dialog.getByLabel('启用 /ai').check();
    await dialog.getByLabel('触发前缀').fill('/问');
    await dialog.getByLabel('上下文条数').fill('3');
    await dialog.getByLabel('群 ID 白名单').fill('oc_one\noc_two\noc_one');
    await dialog.getByRole('button', { name: '刷新触发结果' }).click();
    await expect(dialog).toContainText('近期触发结果已更新');
    await expect(dialog.getByLabel('触发前缀')).toHaveValue('/问');
    await dialog.getByRole('button', { name: '保存设置' }).click();
    await expect(dialog).toContainText('设置已保存');
    assert.deepEqual(writes, [{ expectedAccountKey: 'account-a', enabled: true, prefix: '/问', contextCount: 3, chatIds: ['oc_one', 'oc_two'], triggerSenderIds: [] }]);
    assert.equal(reads, 2);
    const request = page.waitForRequest(req => req.url().endsWith('/inbox-handling/personal/item%2F1'));
    await dialog.getByRole('button', { name: '查看草稿与建议' }).click();
    await request;
    const handling = page.getByRole('dialog', { name: '处理与建议' });
    await handling.getByRole('button', { name: '编辑建议' }).click();
    await handling.getByLabel('回复内容').fill('已编辑的草稿');
    await handling.getByRole('button', { name: '保存建议（不执行）' }).click();
    await handling.getByRole('button', { name: '检查并提交审批' }).click();
    await expect(handling.getByText('核对当前完整建议')).toBeVisible();
    assert.equal(approvals.length, 0);
    await handling.getByRole('button', { name: '提交当前建议审批' }).click();
    await expect(handling).toContainText('未执行、未发送');
    assert.equal(suggestion.action.text, '已编辑的草稿');
    assert.deepEqual(approvals, [{ sourceVersion: 1, version: 2 }]);
    await handling.getByRole('button', { name: '关闭', exact: true }).first().click();
    await settings.click(); await expect(dialog.getByLabel('触发前缀')).toHaveValue('/问');
    accountKey = 'account-b';
    await dialog.getByRole('button', { name: '保存设置' }).click();
    await expect(dialog).toContainText('账号已切换');
    assert.equal((writes.at(-1) as { expectedAccountKey: string }).expectedAccountKey, 'account-a');
    await expect(dialog.getByLabel('启用 /ai')).toHaveCount(0);
    await dialog.getByRole('button', { name: '关闭' }).click();
    accountKey = '';
    await settings.click();
    await expect(dialog).toContainText('没有可核验的飞书个人账号');
    await expect(dialog.getByRole('button', { name: '保存设置' })).toHaveCount(0);
    personal.status = 'expired'; await refresh();
    await expect(dialog).toHaveCount(0);
    await expect(settings).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

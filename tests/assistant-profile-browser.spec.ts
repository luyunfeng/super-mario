import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect, type Page } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('Agent 页修改主助手名称后同步到已有气泡，并发冲突保留草稿，插件停用恢复默认署名', { timeout: 45000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-assistant-profile-'));
  const token = 'assistant-profile-browser-fixture';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, token, demo: true });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const project = server.app.projects.create({ name: '合成署名项目' });
  const put = (message: Pick<Message, 'id' | 'text'> & Partial<Message>) => server.app.store.put('messages', message.id, {
    role: 'assistant', status: 'done', createdAt: '2026-03-01T10:00:00.000Z', conversationId: 'main', ...message,
  });
  put({ id: 'fixture-reply', text: '需要核对署名的既有回复。' });
  put({ id: 'fixture-result', text: '执行结果样例。', origin: 'result' });
  put({ id: 'fixture-project', text: '项目助手的既有回复。', conversationId: `project:${project.id}:work`, projectId: project.id });

  const schedule = async (key: string, title: string, at: string, approved: boolean) => {
    const post = async (path: string, body: unknown) => {
      const response = await fetch(server.url + '/api/v1' + path, { method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.ok(response.ok);
      return response.json();
    };
    const approval = await post('/scheduled-work', { key, title, schedule: key === 'early' ? { kind: 'interval', everySec: 86400, anchorAt: at } : { kind: 'once', at }, action: { kind: 'brief' } });
    if (approved) await post('/approvals/' + approval.id + '/approve', { version: approval.version });
  };
  await schedule('later', '下午复核', '2099-01-02T15:00:00Z', true);
  await schedule('pending', '待批准简报', '2099-01-01T08:00:00Z', false);
  await schedule('early', '上午简报', '2099-01-02T09:00:00Z', true);
  await schedule('archived-brief', '已生成简报', '2001-01-01T00:00:00Z', true);
  await server.app.background.tick();
  await server.app.background.eventbox.drain();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const chat = await browser.newPage(), first = await browser.newPage(), second = await browser.newPage();
  for (const [page, route] of [[chat, 'chat'], [first, 'agent'], [second, 'agent']] as const) {
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    await page.goto(server.url + '/#' + route + '?token=' + token);
  }
  const label = chat.locator('[data-id="fixture-reply"] .msg__label');
  const resultLabel = chat.locator('[data-id="fixture-result"] .msg__label');
  await expect(label).toHaveText('主 Agent');
  await expect(resultLabel).toHaveText('执行结果');
  const card = (page: Page) => page.locator('#assistant-profile');
  const editor = (page: Page) => page.getByRole('dialog', { name: '修改主助手名称', exact: true });
  const name = (page: Page) => editor(page).getByLabel('主助手名称', { exact: true });
  const action = (page: Page, text: string) => editor(page).getByRole('button', { name: text, exact: true });
  await expect(card(first)).toContainText('演示模式 · 可用');
  const upcoming = card(first).getByRole('region', { name: '接下来的定时工作' });
  await expect(upcoming).toContainText(/上午简报.*下午复核/s);
  await expect(upcoming).not.toContainText('待批准简报');
  await upcoming.getByRole('button', { name: '查看定时工作' }).click();
  await expect(first.locator('#agent-scheduled-work').getByRole('button', { name: '创建定时工作' })).toBeFocused();
  const plans = first.locator('#agent-scheduled-work');
  const frequency = plans.getByLabel('筛选计划频率');
  await frequency.selectOption('once');
  await expect(plans.locator('article')).toHaveCount(3);
  await expect(plans.locator('article .item__title')).toHaveText(['已生成简报', '待批准简报', '下午复核']);
  await frequency.selectOption('repeating');
  await expect(plans.locator('article .item__title')).toHaveText(['上午简报']);
  await expect(upcoming).toContainText(/上午简报.*下午复核/s);
  await frequency.selectOption('');
  await expect(plans.locator('article')).toHaveCount(4);
  const early = first.locator('#agent-scheduled-work article').filter({ hasText: '上午简报' });
  await early.getByRole('button', { name: '跳过下一次' }).click();
  await expect(early).toContainText('将跳过');
  await expect(early).toContainText('跳过后预计触发：');
  await expect(upcoming).toContainText(/下午复核.*上午简报/s);
  await early.getByRole('button', { name: '撤销跳过' }).click();
  await expect(upcoming).toContainText(/上午简报.*下午复核/s);
  await early.getByRole('button', { name: '暂停计划' }).click();
  await expect(early).toContainText('恢复前不会触发');
  await expect(upcoming).not.toContainText('上午简报');
  await early.getByRole('button', { name: '恢复计划' }).click();
  await expect(upcoming).toContainText(/上午简报.*下午复核/s);
  const past = first.locator('#agent-scheduled-work article').filter({ hasText: '已生成简报' }).filter({ has: first.getByText('已生成简报', { exact: true }) });
  await past.locator('summary').click();
  await past.getByRole('button', { name: '查看简报原文' }).click();
  const brief = first.getByRole('dialog', { name: '简报原文' });
  await expect(brief.locator('pre')).toContainText('开放待办：');
  await expect(brief).toContainText('生成时间');
  await brief.getByRole('button', { name: '关闭', exact: true }).click();
  const pending = first.locator('#agent-scheduled-work article').filter({ hasText: '待批准简报' });
  await pending.locator('summary').click();
  await pending.getByRole('link', { name: '查看待处理审批' }).click();
  const selected = first.locator('#attention article').filter({ hasText: '待批准简报' });
  await expect(selected).toBeFocused();
  await expect(selected.getByRole('button', { name: '批准', exact: true })).toBeVisible();
  await first.goBack();
  await expect(card(first)).toContainText('0 台');
  await expect(card(first)).toContainText('0 个');
  for (const page of [first, second]) {
    await expect(card(page)).toContainText('主 Agent');
    await card(page).getByRole('button', { name: '修改名称', exact: true }).click();
    await expect(name(page)).toHaveValue('主 Agent');
  }
  const draft = '合成甲助手', remote = '合成乙助手';
  await name(first).fill(draft);
  await name(second).fill(remote);
  await action(second, '保存').click();
  await expect(label).toHaveText(remote);
  await expect(resultLabel).toHaveText('执行结果');
  await expect(name(first)).toHaveValue(draft);
  const rejected = first.waitForResponse(r => r.url().endsWith('/api/v1/assistant-profile')
    && r.request().postDataJSON()?.action === 'save');
  await action(first, '保存').click();
  assert.equal((await rejected).status(), 409);
  await expect(editor(first)).toContainText(remote);
  await expect(name(first)).toHaveValue(draft);
  await action(first, '保存我的名称').click();
  await expect(label).toHaveText(draft);
  await expect(card(second)).toContainText(draft);

  await second.goto(server.url + `/#projects/${project.id}/workspace`);
  await expect(second.getByRole('log', { name: '项目对话' }).locator('.msg__label')).toHaveText('项目助手');
  const toggle = async (enabled: boolean) => {
    const response = await first.request.post(server.url + '/api/v1/plugins/assistant-profile', {
      headers: { Authorization: 'Bearer ' + token }, data: { enabled },
    });
    assert.ok(response.ok());
  };
  await toggle(false);
  await expect(label).toHaveText('主 Agent');
  await expect(card(first)).toBeHidden();
  await expect(editor(first)).toBeHidden();
  await expect(resultLabel).toHaveText('执行结果');
  await toggle(true);
  await expect(card(first)).toContainText(draft);
  await expect(label).toHaveText(draft);
  assert.equal(server.app.store.list('runs').length, 0);
});

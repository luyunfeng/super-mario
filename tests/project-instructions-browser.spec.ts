import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect, type Page } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('项目工作指令独立保存，编辑冲突时保留草稿，清除和停用后状态正确', { timeout: 45000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-project-instructions-'));
  const token = 'isolated-instructions-browser';
  const start = () => startServer({ host: '127.0.0.1', port: 0, dataDir, token, demo: true });
  let server = await start();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const alpha = server.app.projects.create({ name: '合成项目甲' });
  const beta = server.app.projects.create({ name: '合成项目乙' });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const first = await browser.newPage(), second = await browser.newPage();
  for (const page of [first, second]) {
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  }
  const open = (page: Page) => page.getByRole('button', { name: '工作指令', exact: true });
  const drawer = (page: Page) => page.getByRole('dialog', { name: '工作指令', exact: true });
  const body = (page: Page) => drawer(page).getByLabel('项目所有者说明', { exact: true });
  const enter = async (page: Page, projectId: string) => {
    await page.goto(server.url + '/#projects/' + projectId + '/workspace?token=' + token);
    await open(page).click();
    await expect(body(page)).toBeEnabled();
  };
  const action = (page: Page, name: string) => drawer(page).getByRole('button', { name, exact: true });
  const alphaText = '交付前说明已核对的样例。\n保留换行。';
  const betaText = '只报告项目乙的样例。';
  await enter(first, alpha.id);
  await expect(drawer(first)).toContainText('尚无已保存的版本');
  await body(first).fill(alphaText);
  await action(first, '保存').click();
  await expect(drawer(first)).toContainText('工作指令已保存');
  await enter(first, beta.id);
  await expect(body(first)).toHaveValue('');
  await body(first).fill(betaText);
  await action(first, '保存').click();
  await expect(drawer(first)).toContainText('工作指令已保存');

  await enter(first, alpha.id);
  await enter(second, alpha.id);
  for (const page of [first, second]) await expect(body(page)).toHaveValue(alphaText);
  const local = '第一个窗口尚未提交的草稿。';
  const remote = '第二个窗口已提交的说明。';
  await body(first).fill(local);
  await body(second).fill(remote);
  await action(second, '保存').click();
  await expect(drawer(second)).toContainText('工作指令已保存');
  await expect(body(first)).toHaveValue(local);
  await expect(action(first, '核对最新版本')).toBeVisible();
  const rejected = first.waitForResponse(r => r.url().endsWith('/api/v1/project-instructions') && r.request().postDataJSON()?.action === 'save');
  await action(first, '保存').click();
  assert.equal((await rejected).status(), 409);
  await expect(body(first)).toHaveValue(local);
  await expect(drawer(first)).toContainText(remote);
  const stored = server.app.store.get<{ updatedAt: string }>('project-instructions', alpha.id)!;
  await expect(drawer(first)).toContainText(/草稿基于版本 1 · 保存于 \d{4}-/);
  await expect(drawer(first).getByRole('region', { name: '服务端当前版本' })).toContainText('版本 2 · 保存于 ' + stored.updatedAt);
  await action(first, '保存我的草稿').click();
  await expect(drawer(first)).toContainText('工作指令已保存');
  await expect(body(second)).toHaveValue(local);
  // The second window starts typing while the automatic read is still in flight.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = second.waitForRequest(request => request.url().endsWith('/api/v1/project-instructions'));
  await second.route('**/api/v1/project-instructions', async route => {
    await gate;
    await route.continue();
  }, { times: 1 });
  const revised = local + '已复核。';
  await body(first).fill(revised);
  await action(first, '保存').click();
  await started;
  try {
    await body(second).fill('读取期间输入的草稿。');
  } finally { release(); }
  await expect(drawer(second).getByRole('region', { name: '服务端当前版本' })).toContainText(revised);
  await expect(body(second)).toHaveValue('读取期间输入的草稿。');
  await action(second, '采用服务端版本').click();
  await expect(body(second)).toHaveValue(revised);
  await first.reload();
  await open(first).click();
  await expect(body(first)).toHaveValue(revised);

  await action(first, '清空草稿').click();
  await expect(body(first)).toHaveValue('');
  await action(first, '保存').click();
  await expect(drawer(first)).toContainText('工作指令已清除');
  await first.reload();
  await open(first).click();
  await expect(body(first)).toBeEnabled();
  await expect(body(first)).toHaveValue('');
  await enter(first, beta.id);
  await expect(body(first)).toHaveValue(betaText);

  const disabled = await first.request.post(server.url + '/api/v1/plugins/project-instructions', {
    headers: { Authorization: 'Bearer ' + token }, data: { enabled: false },
  });
  assert.ok(disabled.ok());
  await expect(drawer(first)).toBeHidden();
  await expect(open(first)).toHaveCount(0);
  await expect(drawer(second)).toBeHidden();
  await expect(open(second)).toHaveCount(0);

  await first.goto('about:blank');
  await second.goto('about:blank');
  await server.close();
  server = await start();
  const enabled = await first.request.post(server.url + '/api/v1/plugins/project-instructions', {
    headers: { Authorization: 'Bearer ' + token }, data: { enabled: true },
  });
  assert.ok(enabled.ok());
  await enter(first, alpha.id);
  await expect(body(first)).toHaveValue('');
  await enter(first, beta.id);
  await expect(body(first)).toHaveValue(betaText);
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('settings removes a project only after confirmation and restores the same history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-remove-project-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'app'), demo: true });
  const file = join(dir, 'work.txt');
  await writeFile(file, '原文件');
  const project = server.app.projects.create({ name: '设计图', workspace: { machineId: 'offline', cwd: dir } });
  const todo = server.app.createTodo({ title: '核对图纸', projectId: project.id });
  const savedTodo = server.app.store.get('todos', todo.id);
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(async () => { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  // Keep reporting the archived folder on every scan, alongside an unrelated candidate.
  const peer = dir + '-peer';
  const homeDir = tmpdir();
  const machineId = project.workspace!.machineId;
  await page.route('**/api/v1/state', async route => {
    const response = await route.fetch();
    const state = await response.json();
    state.machines = [{ id: machineId, name: '测试电脑', online: true, capabilities: ['workspace.projects', 'workspace.directory'] }];
    await route.fulfill({ response, json: state });
  });
  let scans = 0;
  await page.route('**/api/v1/machines/*/projects*', async route => {
    scans++;
    await route.fulfill({ json: { homeDir, roots: [], warnings: [], truncated: false, projects: [
      { name: '原目录', cwd: dir, exists: true, sources: ['codex'] },
      { name: '其他目录', cwd: peer, exists: true, sources: ['codex'] },
    ] } });
  });
  await page.goto(server.url + '/#projects/' + project.id + '/settings');
  const item = page.getByRole('navigation', { name: '项目列表' }).getByRole('link', { name: /设计图/ });
  const remove = page.getByRole('button', { name: '移除项目', exact: true });
  await remove.click();
  const dialog = page.getByRole('dialog', { name: '移除“设计图”？' });
  await expect(dialog).toContainText('文件夹和文件保持原样');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(item).toBeVisible();
  assert.equal(server.app.projects.list()[0].archivedAt, undefined);
  await remove.click();
  await dialog.getByRole('button', { name: '确认移除' }).click();
  await expect(page).toHaveURL(/#projects\/all\/todos$/);
  await expect(item).toHaveCount(0);
  const discovered = page.locator('.project-discovered');
  const visiblePeer = discovered.getByRole('button', { name: '添加 其他目录' });
  await expect(visiblePeer).toBeVisible();
  await expect(discovered).not.toContainText('原目录');
  const before = scans;
  await discovered.getByRole('button', { name: '刷新目录' }).click();
  await expect.poll(() => scans).toBeGreaterThan(before);
  await expect(discovered).not.toContainText('原目录');
  await page.reload();
  await expect(visiblePeer).toBeVisible();
  await expect(discovered).not.toContainText('原目录');
  await discovered.getByRole('button', { name: '更多文件夹 / 手动绑定' }).click();
  const picker = page.locator('dialog.drawer');
  await expect(picker.locator('.folder-results')).toContainText('其他目录');
  await expect(picker.locator('.folder-results')).not.toContainText('原目录');
  await picker.getByLabel('显示已隐藏').check();
  await expect(picker.locator('.folder-results')).toContainText('原目录');
  await picker.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByText('已移除的项目', { exact: true }).click();
  await expect(item).toHaveCount(0);
  assert.ok(server.app.projects.list()[0].archivedAt);
  assert.equal(await readFile(file, 'utf8'), '原文件');
  await page.getByRole('button', { name: '重新添加 设计图' }).click();
  await expect(item).toBeVisible();
  assert.equal(server.app.projects.list().length, 1);
  const restored = server.app.projects.list()[0];
  assert.deepEqual({ ...restored, updatedAt: project.updatedAt }, project);
  assert.deepEqual(server.app.store.get('todos', todo.id), savedTodo);
});

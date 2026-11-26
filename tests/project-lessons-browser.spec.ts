import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('项目跟进页可查看项目经验，改正后保存并保留主人措辞，删除后不再出现', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-project-lessons-'));
  const server = await startServer({ dataDir, token: 'test-lessons', demo: true, port: 0, host: '127.0.0.1' });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      try { await server.close(); }
      finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  });
  const { app } = server;
  const { id } = app.projects.create({ name: '结算重构' });
  const lesson = { id: 'lesson-1', projectId: id, kind: 'missing_context' as const, text: '先确认对账口径',
    seen: 2, firstSeenAt: '2026-11-01T00:00:00.000Z', lastSeenAt: '2026-11-20T00:00:00.000Z',
    sources: [{ todoId: 'todo-1', title: '对账脚本', runId: 'run-00000000-0000-0000' }], edited: false, stale: false, version: 1 };
  app.store.put('project.lessons', lesson.id, lesson);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(`${server.url}/#projects/${id}/settings?token=test-lessons`);

  await page.getByRole('button', { name: '查看项目经验' }).click();
  const drawer = page.getByRole('dialog', { name: '项目经验' });
  await expect(drawer.getByText('先确认对账口径', { exact: true })).toBeVisible();
  await expect(drawer.getByText(/缺少背景 · 模型记录 · 出现 2 次/)).toBeVisible();
  await drawer.getByText('来自 1 项已验收任务').click();
  await expect(drawer.getByText(/对账脚本/)).toBeVisible();

  await drawer.getByRole('button', { name: '改正' }).click();
  const editor = drawer.getByRole('textbox', { name: '经验正文' });
  await editor.fill('  先和对账口径的负责人确认  ');
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(drawer.getByText('先和对账口径的负责人确认', { exact: true })).toBeVisible();
  await expect(drawer.getByText(/缺少背景 · 主人改过/)).toBeVisible();
  await expect(editor).toHaveCount(0);
  // The owner's wording survives a reload from the server.
  await page.reload();
  await page.getByRole('button', { name: '查看项目经验' }).click();
  await expect(drawer.getByText('先和对账口径的负责人确认', { exact: true })).toBeVisible();

  // A lesson changed elsewhere while the owner was editing. The write is refused and the
  // current version is shown. The change is made as the write leaves the page, so the page
  // cannot have polled the new version first.
  await page.route('**/api/v1/projects/*/lessons', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const body = JSON.parse(String(route.request().postData()));
    // The page shows version 2, the one it saved above.
    assertVersion(body.version, 2);
    app.store.put('project.lessons', lesson.id, { ...lesson, text: '另一窗口改过的措辞', edited: true, version: 3 });
    await route.continue();
  });
  await drawer.getByRole('button', { name: '改正' }).click();
  await drawer.getByRole('textbox', { name: '经验正文' }).fill('基于旧版本的修改');
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(drawer.getByText('另一窗口改过的措辞', { exact: true })).toBeVisible();

  await drawer.getByRole('button', { name: '删除' }).click();
  await page.getByRole('dialog', { name: '删除这条经验？' }).getByRole('button', { name: '删除' }).click();
  await expect(drawer.getByText('还没有项目经验。验收这个项目的任务后会出现在这里。')).toBeVisible();
  assertEmpty(app.store.list<{ projectId: string }>('project.lessons').filter(item => item.projectId === id));
});

function assertEmpty<T>(items: T[]) { if (items.length) throw new Error('expected no lessons, found ' + items.length); }
function assertVersion(version: unknown, expected: number) { if (version !== expected) throw new Error('expected version ' + expected + ', sent ' + version); }

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Browser } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Todo } from '../packages/protocol/src/index.ts';

for (const timezoneId of ['Asia/Shanghai', 'America/Los_Angeles']) {
  test(`待办时间闭环：${timezoneId} 编辑、认领不重复、清空和重启`, { timeout: 60000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mario-todo-time-'));
    let server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
      const context = await browser.newContext({ timezoneId, viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      const dialog = page.getByRole('dialog', { name: '编辑待办' });
      page.on('pageerror', error => errors.push(error.message));
      const dueAt = '2099-01-02T01:02:33.456Z';
      const reminderAt = '2099-01-02T03:04:55.678Z';
      const created = await fetch(server.url + '/api/v1/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '时间闭环', dueAt, reminderAt }) });
      assert.equal(created.status, 201);
      const todo: Todo = await created.json();
      // A previous reminder claim must survive an unrelated title edit.
      const claimedAt = '2026-01-01T00:00:00Z';
      server.app.store.put('todos', todo.id, { ...todo, remindedAt: claimedAt });
      const read = () => server.app.store.get<Todo>('todos', todo.id)!;
      const edit = async (title: string) => {
        await page.locator('.todo .item__title', { hasText: title }).click();
        await expect(page.getByRole('heading', { name: '编辑待办' })).toBeVisible();
      };
      const save = async () => {
        const reply = page.waitForResponse(response => response.url().endsWith(`/todos/${todo.id}`) && response.request().method() === 'PATCH');
        await page.getByRole('button', { name: '保存', exact: true }).click();
        assert.equal((await reply).status(), 200);
        await expect(page.getByRole('heading', { name: '编辑待办' })).toHaveCount(0);
      };
      await page.goto(server.url + '/#projects/all/todos');
      await edit('时间闭环');
      await expect(dialog.getByLabel('截止日期', { exact: true })).toHaveValue(timezoneId === 'Asia/Shanghai' ? '2099-01-02' : '2099-01-01');
      await expect(dialog.getByLabel('提醒时间', { exact: true })).toHaveValue(timezoneId === 'Asia/Shanghai' ? '2099-01-02T11:04' : '2099-01-01T19:04');
      if (timezoneId === 'America/Los_Angeles') {
        // Spring-forward wall times do not exist; rejecting them avoids silent +1h changes.
        await dialog.getByLabel('提醒时间', { exact: true }).fill('2026-03-08T02:30');
        await page.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.getByText('提醒时间无效，请检查本机时区和夏令时', { exact: true })).toBeVisible();
        assert.equal(read().reminderAt, reminderAt);
        await dialog.getByLabel('提醒时间', { exact: true }).fill('2099-01-01T19:04');
      }
      await dialog.getByRole('textbox', { name: '标题', exact: true }).fill('只改标题');
      await save();
      assert.equal(read().dueAt, dueAt);
      assert.equal(read().reminderAt, reminderAt);
      assert.equal(read().remindedAt, claimedAt);

      await edit('只改标题');
      await dialog.getByLabel('截止日期', { exact: true }).fill('2099-02-03');
      await dialog.getByLabel('提醒时间', { exact: true }).fill('2099-02-03T10:20');
      if (timezoneId === 'Asia/Shanghai') {
        await page.route(`**/todos/${todo.id}`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'test unavailable' }) }), { times: 1 });
        await page.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.getByText('test unavailable', { exact: true })).toBeVisible();
        await expect(dialog.getByLabel('提醒时间', { exact: true })).toHaveValue('2099-02-03T10:20');
        assert.equal(read().reminderAt, reminderAt);
      }
      await save();
      // Changing the date keeps the explicit local cutoff shown in the time field.
      const expected = timezoneId === 'Asia/Shanghai'
        ? { due: '2099-02-03T01:02:00.000Z', reminder: '2099-02-03T02:20:00.000Z' }
        : { due: '2099-02-04T01:02:00.000Z', reminder: '2099-02-03T18:20:00.000Z' };
      assert.equal(read().dueAt, expected.due);
      assert.equal(read().reminderAt, expected.reminder);
      assert.equal(read().remindedAt, undefined);
      await expect(page.locator('.todo', { hasText: '只改标题' })).toContainText('提醒');
      await server.close();
      server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
      assert.equal(read().reminderAt, expected.reminder);
      await page.goto(server.url + '/#projects/all/todos');
      await edit('只改标题');
      await expect(dialog.getByLabel('提醒时间', { exact: true })).toHaveValue('2099-02-03T10:20');
      if (timezoneId === 'Asia/Shanghai') await page.screenshot({ path: '/tmp/super-mario-todo-reminder-editor.png', fullPage: true, animations: 'disabled' });
      // A past local reminder exercises the real existing tick/claim/event path without sending.
      await dialog.getByLabel('提醒时间', { exact: true }).fill('2020-01-02T10:20');
      await save();
      server.app.supervision.tick();
      const claim = read().remindedAt;
      assert.ok(claim);
      const signals = () => server.app.supervision.signals().filter(signal => signal.kind === 'reminder' && signal.todoId === todo.id);
      assert.equal(signals().length, 1);
      await edit('只改标题');
      await dialog.getByRole('textbox', { name: '标题', exact: true }).fill('已提醒后修改');
      await save();
      assert.equal(read().remindedAt, claim);
      server.app.supervision.tick();
      assert.equal(signals().length, 1);

      await edit('已提醒后修改');
      await dialog.getByLabel('截止日期', { exact: true }).fill('');
      await dialog.getByLabel('提醒时间', { exact: true }).fill('');
      await save();
      assert.equal(read().dueAt, undefined);
      assert.equal(read().reminderAt, undefined);
      assert.equal(read().remindedAt, undefined);
      await server.close();
      server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
      server.app.supervision.tick();
      assert.equal(read().dueAt, undefined);
      assert.equal(read().reminderAt, undefined);
      assert.equal(signals().length, 1);
      await page.goto(server.url + '/#projects/all/todos');
      await edit('已提醒后修改');
      await expect(dialog.getByLabel('截止日期', { exact: true })).toHaveValue('');
      await expect(dialog.getByLabel('提醒时间', { exact: true })).toHaveValue('');
      assert.deepEqual(errors, []);
      assert.equal(server.app.store.list('runs').length, 0);
      assert.equal(server.app.store.list('effects').length, 0);
    } finally {
      await browser?.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

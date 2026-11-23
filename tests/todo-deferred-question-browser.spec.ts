import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message, Todo } from '../packages/protocol/src/index.ts';

test('Web 待办详情保留超时原提问，明确提交后原会话受理，完成后封闭答复入口', { timeout: 40000 }, async t => {
  const token = 'offline-deferred-question';
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-deferred-question-web-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, demo: true, token, dataDir });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { app } = server;
  const project = app.projects.create({ name: '合成表格项目' });
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  async function expireQuestion(title: string, body: string) {
    const first = await fetch(server.url + '/api/v1/messages', { method: 'POST', headers,
      body: JSON.stringify({ text: '请核对：' + title, projectId: project.id }) });
    assert.equal(first.status, 202);
    const input = await first.json() as Message;
    const card = app.interactions.open({ kind: 'question', title, body }, input);
    app.interactions.expireTick(Date.parse(card.expiresAt) + 1);
    const converted = () => app.store.list<Todo>('todos').find(todo => todo.deferredQuestion?.cardId === card.id);
    await expect.poll(() => converted()?.id).toBeTruthy();
    return { input, todo: converted()! };
  }
  const body = '请确认导出时使用哪组列名？\n甲组和乙组各有四列。';
  const { input, todo } = await expireQuestion('核对导出的列名', body);

  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(`${server.url}/#projects/${project.id}/todos/detail/${todo.id}?token=${token}`);
  const panel = page.getByRole('heading', { name: '超时提问', exact: true }).locator('..');
  await expect(panel).toContainText(body);
  await expect(panel).toContainText('等待你的回答');
  await page.getByRole('button', { name: '编辑待办', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑待办' });
  const updatedNotes = '跟进备注改为检查页脚。';
  await editor.getByLabel('标题').fill('查看新一轮备注');
  await editor.getByLabel('备注').fill(updatedNotes);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  const notes = page.getByRole('heading', { name: '待办备注', exact: true }).locator('..');
  await expect(notes).toContainText(updatedNotes);
  await expect(panel).toContainText('核对导出的列名');
  await expect(panel).toContainText(body);
  await expect(panel).not.toContainText(updatedNotes);
  await expect(panel).not.toContainText('查看新一轮备注');
  const answer = panel.getByRole('textbox', { name: '回答原提问' });
  const submit = panel.getByRole('button', { name: '提交回答' });
  await expect(submit).toBeDisabled();
  await answer.fill('采用乙组。');
  const posted = page.waitForResponse(res => res.url().endsWith('/todos/' + todo.id + '/question-answer') && res.request().method() === 'POST');
  await submit.click();
  const receipt = await posted;
  assert.ok(receipt.ok(), '回答应由原会话受理');
  assert.deepEqual(receipt.request().postDataJSON(), { text: '采用乙组。' });
  const { messageId, todoId } = await receipt.json();
  assert.equal(todoId, todo.id);
  const postedMessage = app.store.get<Message>('messages', messageId);
  assert.equal(postedMessage?.conversationId, input.conversationId);
  assert.ok(postedMessage?.text.includes('核对导出的列名'));
  assert.ok(!postedMessage?.text.includes(updatedNotes));
  assert.ok(app.store.get<Todo>('todos', todo.id)?.completedAt);
  await expect(panel).toContainText('原会话已受理你的回答。');
  await expect(submit).toBeHidden();
  await page.reload();
  await expect(panel).toContainText('待办已完成');
  await expect(panel).toContainText(body);
  await expect(answer).toBeHidden();

  const manual = await expireQuestion('是否保留旧表头？', '请确认历史表格的列名。');
  app.updateTodo(manual.todo.id, { completed: true });
  await page.goto(`${server.url}/#projects/${project.id}/todos/detail/${manual.todo.id}`);
  await expect(panel).toContainText('待办已完成');
  await expect(panel).toContainText('请确认历史表格的列名。');
  await expect(answer).toBeHidden();
  await expect(panel).not.toContainText('原会话已受理');

  // An older incomplete record can keep notes even when its original card is unavailable.
  const incomplete = app.createTodo({ projectId: project.id, title: '找不到原卡的旧待办', notes: updatedNotes });
  app.store.put('todos', incomplete.id, { ...incomplete, deferredQuestion: { cardId: 'missing-card', askedAt: incomplete.createdAt } });
  await page.goto(`${server.url}/#projects/${project.id}/todos/detail/${incomplete.id}`);
  await page.reload();
  await expect(panel).toContainText('无法核对原提问。');
  await expect(panel).not.toContainText(updatedNotes);
  await expect(notes).toContainText(updatedNotes);
  await expect(answer).toBeHidden();
});

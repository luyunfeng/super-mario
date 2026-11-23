import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect, type Locator } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message, Todo } from '../packages/protocol/src/index.ts';

const questions = [
  { header: '格式', question: '采用哪种导出格式？', options: [{ label: 'CSV', description: '便于读取表格。' }, { label: 'JSON', description: '保留对象结构。' }] },
  { header: '列名', question: '保留哪些列？', multiSelect: true, options: [{ label: '名称' }, { label: '日期' }] },
  { header: '排序', question: '如何排列数据？', options: [{ label: '正序' }, { label: '倒序' }] },
];
const answers = [{ selected: ['JSON'] }, { selected: ['名称', '日期'], text: '日期用本地时区' }, { selected: [], text: '按负责人分组' }];

test('主对话及超时待办逐题回答，提交完整有序答案，空题不发送', { timeout: 45000 }, async t => {
  const token = 'fixture-structured-questions';
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-structured-question-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, demo: true, token, dataDir });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = server.app.projects.create({ name: '结构化提问演示' });
  async function open(title: string) {
    const res = await fetch(server.url + '/api/v1/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '请整理这批示例表格。', projectId: project.id }) });
    assert.equal(res.status, 202);
    const input: Message = await res.json();
    return server.app.interactions.open({ kind: 'question', title, body: '请确认三项导出设置。', questions }, input);
  }
  const first = await open('导出配置');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#chat?token=' + token);
  async function submit(panel: Locator, path: string, label: string) {
    const format = panel.getByRole('group', { name: questions[0].question });
    const columns = panel.getByRole('group', { name: questions[1].question });
    const order = panel.getByRole('group', { name: questions[2].question });
    const button = panel.getByRole('button', { name: label, exact: true });
    await expect(format).toContainText('保留对象结构。');
    await format.getByLabel('CSV', { exact: true }).check();
    await format.getByLabel('JSON', { exact: true }).check();
    await expect(format.getByLabel('CSV', { exact: true })).not.toBeChecked();
    await columns.getByLabel('名称', { exact: true }).check();
    await columns.getByLabel('日期', { exact: true }).check();
    await columns.getByLabel('文字回答').fill('日期用本地时区');
    const sent: unknown[] = [];
    page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith(path)) sent.push(req.postDataJSON()); });
    await button.click();
    await expect(panel).toContainText('请回答每一道题。');
    assert.deepEqual(sent, []);
    await order.getByLabel('正序', { exact: true }).check();
    await order.getByLabel('仅填写文字').check();
    await order.getByLabel('文字回答').fill('按负责人分组');
    const accepted = page.waitForResponse(res => res.url().endsWith(path) && res.request().method() === 'POST');
    await button.click();
    const response = await accepted;
    assert.equal(response.ok(), true, await response.text());
    assert.equal(sent.length, 1);
    return response.request().postDataJSON();
  }
  const card = page.locator('[data-id="interaction:' + first.id + '"]');
  await expect(card).toBeVisible();
  const version = server.app.interactions.list().find(row => row.id === first.id)!.version;
  const live = await submit(card, '/interactions/' + first.id + '/answer', '回答');
  assert.deepEqual(live, { version, answers });
  await expect(card).toHaveCount(0);

  const second = await open('下次导出的三项设置');
  server.app.interactions.expireTick(Date.parse(second.expiresAt) + 1);
  const deferred = () => server.app.store.list<Todo>('todos').find(row => row.deferredQuestion?.cardId === second.id);
  await expect.poll(() => deferred()?.id).toBeTruthy();
  const todo = deferred()!;
  await page.goto(server.url + '/#projects/' + project.id + '/todos/detail/' + todo.id);
  const panel = page.getByRole('heading', { name: '超时提问', exact: true }).locator('..');
  const late = await submit(panel, '/todos/' + todo.id + '/question-answer', '提交回答');
  assert.deepEqual(late, { answers });
  await expect(panel).toContainText('原会话已受理你的回答。');
  await expect(panel.getByRole('button', { name: '提交回答' })).toBeHidden();
  await page.reload();
  await expect(panel).toContainText('待办已完成');
  await expect(panel.getByLabel('JSON', { exact: true })).toBeDisabled();
});

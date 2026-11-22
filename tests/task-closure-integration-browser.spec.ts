// 真实 Chromium → startServer HTTP → 临时 SQLite。唯一执行替身是本地 Executor；
// mode: real 用于验证真实派发/finishRun 路径，不代表已验收模型、飞书或真实 CLI。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect, type Locator, type Page } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message, Project, Run, Todo } from '../packages/protocol/src/index.ts';
import type { RunReview } from '../packages/core/src/run-review.ts';
import type { TodoReportingState } from '../packages/core/src/todo-reporting.ts';

type Closure = { reporting: TodoReportingState; review: RunReview | null };
const token = 'offline-closure-browser-test-only';
const executorId = 'controlled-local-closure-fixture';
const doneWhen = '返回明确标为本地替身的验证证据';

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-closure-browser-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  // 启动浏览器前注册；即使服务或浏览器启动失败，也必须清理已创建的资源。
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      try { await server?.close(); }
      finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  });
  server = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, token });
  const runningServer = server;
  const calls: string[] = [];
  runningServer.app.contributions.add('executors', executorId, {
    id: executorId, name: '受控本地 Executor（测试替身）', kind: 'fixture',
    machineId: 'local-test-fixture', mode: 'real', available: true,
    description: '只返回本地测试证据，不调用模型、飞书或 CLI',
    async execute({ prompt }) {
      calls.push(prompt);
      return { text: `本地 Executor 测试替身证据 #${calls.length}：${prompt}` };
    },
  });
  async function api<T>(path: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
    const response = await fetch(runningServer.url + '/api/v1' + path, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`);
    return value as T;
  }
  // 独立只读 SQLite 连接提供落盘证据；不通过 store.put 注入业务状态。
  function stored<T>(collection: string, id: string): T | undefined {
    const db = new DatabaseSync(join(dataDir, 'workbench.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT value FROM documents WHERE collection = ? AND id = ?').get(collection, id);
      return row ? JSON.parse(row.value as string) as T : undefined;
    } finally { db.close(); }
  }
  const project = await api<Project>('/projects', 'POST', { name: '本地闭环验收项目' }, 201);
  const todo = await api<Todo>('/todos', 'POST', { title: '核对交付与真实答复', projectId: project.id }, 201);
  const base = '/todos/' + todo.id;
  const state = () => api<Closure>(base + '/closure');
  async function settled(runId: string) {
    await expect.poll(() => stored<Message>('messages', 'run-result:' + runId)?.status,
      { timeout: 10000, message: 'finishRun 必须实际保存结果 Message' }).toBe('done');
    const run = stored<Run>('runs', runId)!;
    const message = stored<Message>('messages', 'run-result:' + runId)!;
    assert.equal(run.status, 'completed');
    assert.equal(run.resultSource, 'real');
    assert.equal(run.todoId, todo.id);
    assert.equal(run.projectId, project.id);
    assert.equal(message.todoId, todo.id);
    assert.equal(message.projectId, project.id);
    assert.equal(message.origin, 'result');
    assert.equal(message.role, 'assistant');
    assert.ok(message.text.includes(run.output));
    assert.match(run.output, /本地 Executor 测试替身证据/);
    return { run, message };
  }
  async function launch() {
    const run = await api<Run>('/runs', 'POST', {
      executorId, prompt: '生成闭环验收的本地替身证据', projectId: project.id,
      todoId: todo.id, doneWhen, expectMinutes: 1,
    }, 202);
    return settled(run.id);
  }
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const row = page.locator(`#panel-todos [data-id="${todo.id}"]`);
  const drawer = page.getByRole('dialog', { name: '答复与验收', exact: true });
  async function open() {
    await page.goto(`${runningServer.url}/#projects/${project.id}/todos?token=${token}`);
    await row.getByRole('button', { name: '答复与验收', exact: true }).click();
    await expect(drawer.getByRole('checkbox', { name: '关闭前需答复', exact: true })).toBeEnabled();
  }
  return { api, stored, state, base, todo, project, calls, settled, launch, page, row, drawer, open, errors };
}

// 只观察实际 HTTP 响应，不拦截、不 fulfill，也不 mock closure API。
async function clickWrite(page: Page, button: Locator, path: string, method: string, status = 200) {
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1' + path
      && response.request().method() === method),
    button.click(),
  ]);
  const body = await response.json();
  assert.equal(response.status(), status, `${method} ${path}: ${JSON.stringify(body)}`);
  return { body, request: response.request().postDataJSON() };
}

test('Chromium 真实闭环：需答复阻止假完成，记录 finishRun Message 后验收，重开拒用旧证据', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const { run, message } = await f.launch();
  assert.equal(f.stored<Todo>('todos', f.todo.id)!.completedAt, undefined, '执行完成不能代替用户验收');
  await f.open();
  const d = f.drawer;
  await d.getByRole('checkbox', { name: '关闭前需答复', exact: true }).check();
  await clickWrite(f.page, d.getByRole('button', { name: '保存答复要求', exact: true }), f.base + '/reporting', 'PUT');
  assert.equal((await f.state()).reporting.required, true);
  await d.getByLabel('选择交付', { exact: true }).selectOption(run.id);
  await clickWrite(f.page, d.getByRole('button', { name: '关联所选交付', exact: true }), f.base + '/review', 'POST');
  await expect(d).toContainText(run.output);
  await expect(d).toContainText(doneWhen);
  const accept = d.getByRole('button', { name: '验收通过并完成待办', exact: true });
  await clickWrite(f.page, accept, f.base + '/review/decide', 'POST', 409);
  await expect(d.getByRole('alert')).toContainText('尚未记录有效答复');
  let closure = await f.state();
  assert.equal(closure.review!.status, 'pending', '拒绝完成时必须回滚验收');
  assert.equal(closure.reporting.report, undefined);
  assert.equal(f.stored<RunReview>('run-reviews', f.todo.id)!.status, 'pending');
  assert.equal(f.stored<Todo>('todos', f.todo.id)!.completedAt, undefined);
  // 409 后用户只读刷新，重新按服务端版本提交，不能自动重放失败决定。
  await clickWrite(f.page, d.getByRole('button', { name: '只读刷新', exact: true }), f.base + '/closure', 'GET');
  await d.getByLabel('选择真实答复', { exact: true }).selectOption(message.id);
  await clickWrite(f.page, d.getByRole('button', { name: '记录所选答复', exact: true }), f.base + '/report', 'POST');
  await expect(d).toContainText('已记录答复');
  closure = await f.state();
  assert.equal(closure.reporting.report!.messageId, message.id);
  assert.equal(closure.reporting.report!.outboxId, undefined, '本地 Message 不表示渠道送达');
  assert.equal(closure.reporting.requireDelivery, false);
  await clickWrite(f.page, accept, f.base + '/review/decide', 'POST');
  await expect(d).toContainText('验收 accepted');
  assert.ok(f.stored<Todo>('todos', f.todo.id)!.completedAt);
  assert.equal(f.stored<TodoReportingState>('todo.reporting', f.todo.id)!.report!.messageId, message.id);
  assert.equal(f.stored<RunReview>('run-reviews', f.todo.id)!.runId, run.id);
  assert.equal(f.calls.length, 1);

  await d.getByRole('button', { name: '关闭', exact: true }).click();
  await f.page.reload();
  await f.page.getByText('已完成 1', { exact: true }).click();
  await clickWrite(f.page, f.row.getByRole('checkbox', { name: '重新打开：' + f.todo.title, exact: true }), f.base, 'PATCH');
  await f.row.getByRole('button', { name: '答复与验收', exact: true }).click();
  await expect(d).toContainText('周期 2');
  await expect(d).toContainText('未记录答复');
  closure = await f.state();
  assert.equal(closure.review!.status, 'reopened');
  assert.equal(closure.reporting.report, undefined);
  await expect(accept).toBeDisabled();
  // 无论 UI 是否过滤历史候选，后端都必须拒用上周期的来源和 Run。
  await f.api(f.base + '/report', 'POST', { version: closure.reporting.version, messageId: message.id }, 409);
  await f.api(f.base + '/review', 'POST', { version: closure.review!.version, runId: run.id }, 409);
  await f.api(f.base, 'PATCH', { completed: true }, 409);
  assert.equal(f.stored<Todo>('todos', f.todo.id)!.completedAt, undefined);
  assert.equal(f.stored<TodoReportingState>('todo.reporting', f.todo.id)!.cycle, 2);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.errors, []);
  await d.getByRole('button', { name: '关闭', exact: true }).click();
  await f.row.getByRole('button', { name: '执行历史', exact: true }).click();
  const round = f.page.getByRole('dialog', { name: '执行历史' }).locator('[data-round="1"]');
  await expect(round).toContainText('当前验收状态：已重开');
  await expect(round).toContainText('历史决定：用户已验收');
  t.diagnostic(`SQLite: Run ${run.id} → Message ${message.id} → accepted → reopened cycle=2；未报告验收及旧证据复用均为 409；本地替身执行 1 次`);
});

test('Chromium 用户返工只创建一个新 Run，重复 HTTP 决定不双发', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.api('/task-closure/settings', 'PUT', { maxReworks: 1 });
  const { run } = await f.launch();
  await f.open();
  const d = f.drawer;
  await d.getByLabel('选择交付', { exact: true }).selectOption(run.id);
  await clickWrite(f.page, d.getByRole('button', { name: '关联所选交付', exact: true }), f.base + '/review', 'POST');
  await d.getByLabel('返工缺陷', { exact: true }).fill('补充本地替身的第二轮验证证据');
  await expect(d).toContainText('首次交付');
  await d.getByRole('button', { name: '要求返工', exact: true }).click();
  const confirmation = f.page.getByRole('dialog', { name: '确认返工？', exact: true });
  await expect(confirmation).toContainText('第 1 轮返工');
  await expect(confirmation).toContainText(doneWhen);
  assert.equal(f.calls.length, 1, '打开确认框不能派发');
  const confirmed = await clickWrite(f.page,
    f.page.getByRole('dialog', { name: '确认返工？', exact: true }).getByRole('button', { name: '确认派发返工', exact: true }),
    f.base + '/review/decide', 'POST');
  const next = confirmed.body as RunReview;
  assert.notEqual(next.runId, run.id);
  assert.equal(next.round, 1);
  const { run: reworked } = await f.settled(next.runId);
  assert.equal(reworked.doneWhen, run.doneWhen);
  assert.match(reworked.prompt, /补充本地替身的第二轮验证证据/);
  const repeated = await f.api<RunReview>(f.base + '/review/decide', 'POST', confirmed.request);
  assert.equal(repeated.runId, next.runId);
  assert.equal(repeated.round, 1);
  assert.equal(f.calls.length, 2, '重复决定必须使用已有回执');
  const closure = await f.state();
  await f.api(f.base + '/review/decide', 'POST', {
    ...confirmed.request, version: closure.review!.version,
    runId: next.runId, evidenceVersion: closure.review!.evidenceVersion,
  }, 409);
  assert.equal(f.calls.length, 2, '达到返工上限后不得派发');
  assert.equal(f.stored<Todo>('todos', f.todo.id)!.completedAt, undefined);
  assert.equal(f.stored<RunReview>('run-reviews', f.todo.id)!.round, 1);
  assert.deepEqual(f.errors, []);
  await d.getByRole('button', { name: '关闭', exact: true }).click();
  await f.row.getByRole('button', { name: '执行历史', exact: true }).click();
  const history = f.page.getByRole('dialog', { name: '执行历史', exact: true });
  const link = history.locator('[data-round="1"]').getByRole('link', { name: '打开本次返工执行' });
  await expect(link).toHaveAttribute('href', '#projects/' + f.project.id + '/runs/' + next.runId);
  await link.click();
  await expect(history).toHaveCount(0);
  await expect(f.page).toHaveURL(new RegExp('/runs/' + next.runId + '$'));
  assert.equal(f.calls.length, 2);
  t.diagnostic(`SQLite: 首轮 ${run.id} → 返工 ${next.runId}；重复决定返回同一 Run，上限后 409；本地替身总执行 2 次`);
});

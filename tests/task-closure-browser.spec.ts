// 本地 mock HTTP + 实际 Web 模块；不代表模型、执行机或外部渠道的真实验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, expect, type Page } from '@playwright/test';

const todo = { id: 'todo', title: '修复登录', projectId: 'p' };
const run = { id: 'run', todoId: 'todo', projectId: 'p', prompt: '修复交付', doneWhen: '登录测试通过', status: 'completed', executorId: 'custom', nativeResultSources: ['plugin-proof'], resultSource: 'plugin-proof', output: '真实插件结果', createdAt: '2026-11-17T01:00:00Z', updatedAt: '2026-11-17T01:00:00Z' };
const initialReview = { todoId: 'todo', version: 3, runId: 'run', evidenceVersion: 'proof-v1', status: 'pending', doneWhen: run.doneWhen, round: 0 };
const initialReporting = { todoId: 'todo', version: 0, cycle: 1, required: false, requireDelivery: false };
const snapshot = { todos: [todo, { ...todo, id: 'other', title: '其他待办' }], projects: [{ id: 'p', name: '项目' }], runs: [run, { ...run, id: 'wrong-project', projectId: 'other', prompt: '错误项目交付' }, { ...run, id: 'legacy', doneWhen: undefined, prompt: '旧执行' }], messages: [
  { id: 'answer', todoId: 'todo', projectId: 'p', role: 'assistant', status: 'done', text: '已修复登录并验证通过' },
  { id: 'stream', todoId: 'todo', projectId: 'p', role: 'assistant', status: 'streaming', text: '未完成答复' },
  { id: 'wrong', todoId: 'other', projectId: 'p', role: 'assistant', status: 'done', text: '其他待办答复' },
  { id: 'user', todoId: 'todo', projectId: 'p', role: 'user', status: 'done', text: '用户请求' },
], executors: [] };

type Request = { path: string; method: string; body: any };
async function fixture(fn: (ctx: { page: Page; requests: Request[]; setHandler: (handler: (request: Request) => any) => void }) => Promise<void>) {
  const html = `<!doctype html><meta charset="utf-8"><body><script type="module">
    import { createApi } from '/js/lib/api.js';
    import { createRouter } from '/js/lib/router.js';
    import { createTodosTab } from '/js/features/todos-tab.js';
    import { createRunsTab } from '/js/features/runs.js';
    const snapshot = ${JSON.stringify(snapshot)};
    const store = {view: {snapshot}, refresh: async () => {}};
    const api = createApi(), router = createRouter();
    const todos = createTodosTab({api, store, router}); document.body.append(todos.el); todos.show('all');
    const runs = createRunsTab({api, store, router, consoleDrawer: {}, markRunSeen: () => {}}); document.body.append(runs.el);
    window.showRun = id => runs.show('all', id);
    window.changeRun = patch => Object.assign(snapshot.runs[0], patch);
    window.eventRefresh = () => { todos.update(snapshot); runs.update(snapshot); };
  </script>`;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
      const path = new URL(req.url!, 'http://localhost').pathname;
      if (!path.startsWith('/js/') || path.includes('..')) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(new URL(`../apps/web${path}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const requests: Request[] = [];
    let handler = (_request: Request): any => undefined;
    await page.route('**/api/v1/**', async route => {
      const req = route.request();
      const request = { path: new URL(req.url()).pathname.replace('/api/v1', ''), method: req.method(), body: req.postDataJSON() };
      requests.push(request);
      const override = await handler(request);
      if (override === 'abort') { await route.abort(); return; }
      let body: any = override?.body;
      if (body === undefined) {
        if (request.path.endsWith('/closure')) body = { reporting: { ...initialReporting, todoId: request.path.split('/')[2] }, review: null };
        else if (request.path === '/todos') body = { sections: { 今天: snapshot.todos } };
        else body = [];
      }
      await route.fulfill({ status: override?.status ?? 200, json: body });
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await expect(page.getByRole('button', { name: '答复与验收', exact: true })).toHaveCount(2);
    await fn({ page, requests, setHandler: value => { handler = value; } });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const open = (page: Page) => page.getByRole('button', { name: '答复与验收', exact: true }).first().click();
const dialog = (page: Page) => page.getByRole('dialog', { name: '答复与验收', exact: true });
const writes = (requests: Request[]) => requests.filter(item => item.method !== 'GET');

test('答复：只读打开不配置，选择真实内容，独立保存送达要求且不假送达', { timeout: 30000 }, async () => fixture(async ({ page, requests, setHandler }) => {
  setHandler(req => {
    if (req.path.endsWith('/report')) return { body: { ...initialReporting, version: 1, report: { messageId: req.body.messageId } } };
    if (req.method === 'PUT') return { body: { ...initialReporting, ...req.body, version: req.body.version + 1 } };
  });
  await open(page); const drawer = dialog(page);
  await expect(drawer).toContainText('答复版本 0');
  assert.equal(writes(requests).length, 0);
  await expect(drawer.getByRole('checkbox', { name: '需要渠道送达', exact: true })).not.toBeChecked();
  await expect(drawer.getByLabel('选择真实答复').locator('option')).toHaveText(['选择真实答复', '已修复登录并验证通过']);
  await drawer.getByLabel('选择真实答复').selectOption('answer');
  await drawer.getByRole('button', { name: '记录所选答复' }).click();
  await expect(drawer).toContainText('已记录答复');
  assert.deepEqual(writes(requests)[0]?.body, { version: 0, messageId: 'answer' });
  await drawer.getByRole('checkbox', { name: '需要渠道送达', exact: true }).check();
  await drawer.getByRole('button', { name: '保存答复要求' }).click();
  await expect(drawer.getByRole('button', { name: '保存答复要求' })).toBeDisabled();
  assert.deepEqual(writes(requests)[1]?.body, { required: false, requireDelivery: true, version: 1 });
  await expect(drawer).toContainText('必须选择实际 sent 出站回执');
  await expect(drawer.getByRole('button', { name: '记录所选答复' })).toBeDisabled();
  await expect(drawer.getByRole('link', { name: /打开高级账本/ })).toHaveAttribute('href', '#agent/advanced');
}));

test('交付：明确关联，插件原生证据可验收，409显示具体原因并固定证据版本', { timeout: 30000 }, async () => fixture(async ({ page, requests, setHandler }) => {
  setHandler(req => {
    if (req.path.endsWith('/review')) return { body: initialReview };
    if (req.path.endsWith('/decide')) return { status: 409, body: { error: '答复尚无真实 outbox sent 送达证据' } };
  });
  await open(page); const drawer = dialog(page);
  await expect(drawer).toContainText('尚未关联交付');
  await expect(drawer.getByLabel('选择交付').locator('option')).toHaveText(['选择交付', '修复交付 · completed · 登录测试通过']);
  await drawer.getByLabel('选择交付').selectOption('run');
  assert.equal(writes(requests).length, 0);
  await drawer.getByRole('button', { name: '关联所选交付' }).click();
  await expect(drawer).toContainText('proof-v1');
  await drawer.getByRole('button', { name: '验收通过并完成待办' }).click();
  await expect(drawer).toContainText('答复尚无真实 outbox sent 送达证据');
  assert.deepEqual(writes(requests).map(item => item.body), [{ runId: 'run', version: 0 }, { version: 3, runId: 'run', evidenceVersion: 'proof-v1', action: 'accept' }]);
  await expect(drawer.getByRole('button', { name: '验收通过并完成待办' })).toBeDisabled();
}));

test('返工：缺陷和确认必需，网络未知跨重开锁定，只读刷新不重放', { timeout: 30000 }, async () => fixture(async ({ page, requests, setHandler }) => {
  setHandler(req => {
    if (req.path.endsWith('/closure')) return { body: { reporting: initialReporting, review: initialReview } };
    if (req.path.endsWith('/decide')) return 'abort';
  });
  await open(page); let drawer = dialog(page);
  await expect(drawer.getByRole('button', { name: '要求返工' })).toBeDisabled();
  await drawer.getByLabel('返工缺陷').fill('登录失败时缺少错误提示');
  await drawer.getByRole('button', { name: '要求返工' }).click();
  assert.equal(writes(requests).length, 0);
  await page.getByRole('dialog', { name: '确认返工？' }).getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(writes(requests).length, 0);
  await drawer.getByRole('button', { name: '要求返工' }).click();
  await page.getByRole('button', { name: '确认派发返工' }).click();
  await expect(drawer).toContainText('请求结果未知');
  await drawer.getByRole('button', { name: '只读刷新' }).click();
  await expect(drawer.getByRole('button', { name: '要求返工' })).toBeDisabled();
  await drawer.getByRole('button', { name: '关闭', exact: true }).click(); await open(page); drawer = dialog(page);
  await expect(drawer).toContainText('请求结果未知');
  await expect(drawer.getByRole('button', { name: '验收通过并完成待办' })).toBeDisabled();
  assert.equal(writes(requests).length, 1);
  assert.deepEqual(writes(requests)[0]?.body, { version: 3, runId: 'run', evidenceVersion: 'proof-v1', action: 'rework', defects: '登录失败时缺少错误提示' });
}));

test('刷新隔离：快照不丢编辑，只读读取保留未保存开关和缺陷，切待办隔离迟到响应', { timeout: 30000 }, async () => fixture(async ({ page, requests, setHandler }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let delay = false;
  setHandler(async req => {
    if (req.path === '/todos/todo/closure') {
      if (delay) await pending;
      return { body: { reporting: initialReporting, review: initialReview } };
    }
  });
  await open(page); const drawer = dialog(page);
  await expect(drawer).toContainText('proof-v1');
  await drawer.getByLabel('返工缺陷').fill('保留用户输入的缺陷');
  await drawer.getByRole('checkbox', { name: '关闭前需答复', exact: true }).check();
  await page.evaluate(() => (window as any).eventRefresh());
  await drawer.getByRole('button', { name: '只读刷新' }).click();
  await expect(drawer.getByLabel('返工缺陷')).toHaveValue('保留用户输入的缺陷');
  await expect(drawer.getByRole('checkbox', { name: '关闭前需答复', exact: true })).toBeChecked();
  delay = true;
  await drawer.getByRole('button', { name: '只读刷新' }).click({ noWaitAfter: true });
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '答复与验收', exact: true }).nth(1).click();
  await expect(dialog(page)).toContainText('其他待办');
  release();
  await expect(dialog(page)).toContainText('尚未关联交付');
  await expect(dialog(page).getByRole('checkbox', { name: '关闭前需答复', exact: true })).not.toBeChecked();
  assert.equal(writes(requests).length, 0);
}));

test('Run入口：有标准进入共用验收抽屉，旧执行保留人工完成', { timeout: 30000 }, async () => fixture(async ({ page, requests }) => {
  await page.evaluate(() => (window as any).showRun('run'));
  await page.getByRole('button', { name: '验收交付', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '验收交付', exact: true });
  await expect(drawer.getByLabel('选择交付')).toHaveValue('run');
  assert.equal(writes(requests).length, 0);
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() => (window as any).showRun('legacy'));
  await page.getByRole('button', { name: '标记待办已完成：修复登录', exact: true }).click();
  await expect.poll(() => writes(requests).length).toBe(1);
  assert.deepEqual(writes(requests)[0], { path: '/todos/todo', method: 'PATCH', body: { completed: true } });
}));

test('验收成功显示服务端确认；unknown交付禁止通过与返工', { timeout: 30000 }, async () => fixture(async ({ page, requests, setHandler }) => {
  setHandler(req => {
    if (req.path.endsWith('/closure')) return { body: { reporting: initialReporting, review: initialReview } };
    if (req.path.endsWith('/decide')) return { body: { ...initialReview, version: 4, status: 'accepted' } };
  });
  await open(page); const drawer = dialog(page);
  await expect(drawer).toContainText('真实插件结果');
  await drawer.getByRole('button', { name: '验收通过并完成待办' }).click();
  await expect(drawer).toContainText('验收 accepted');
  await expect(drawer.getByRole('button', { name: '验收通过并完成待办' })).toBeDisabled();
  await expect(drawer.getByRole('button', { name: '要求返工' })).toBeDisabled();
  assert.equal(writes(requests).length, 1);
  setHandler(req => req.path.endsWith('/closure') ? { body: { reporting: initialReporting, review: { ...initialReview, status: 'unknown', error: '派发结果未知，不自动重试' } } } : undefined);
  await drawer.getByRole('button', { name: '只读刷新' }).click();
  await expect(drawer).toContainText('派发结果未知，不自动重试');
  await drawer.getByLabel('返工缺陷').fill('需要补充登录错误提示');
  await expect(drawer.getByRole('button', { name: '要求返工' })).toBeDisabled();
  await expect(drawer.getByRole('button', { name: '验收通过并完成待办' })).toBeDisabled();
  assert.equal(writes(requests).length, 1);
}));

test('写请求在途关闭重开也不能重复提交，迟到确认不污染新抽屉', { timeout: 30000 }, async () => fixture(async ({ page, requests, setHandler }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  setHandler(async req => {
    if (req.path.endsWith('/report')) { await pending; return { body: { ...initialReporting, version: 1, report: { messageId: 'answer' } } }; }
  });
  await open(page); let drawer = dialog(page);
  await expect(drawer).toContainText('答复版本 0');
  await drawer.getByLabel('选择真实答复').selectOption('answer');
  await drawer.getByRole('button', { name: '记录所选答复' }).click();
  await expect.poll(() => writes(requests).length).toBe(1);
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await open(page); drawer = dialog(page);
  await expect(drawer).toContainText('答复版本 0');
  await drawer.getByLabel('选择真实答复').selectOption('answer');
  await expect(drawer.getByRole('button', { name: '记录所选答复' })).toBeDisabled();
  release();
  await expect(drawer).toContainText('未记录答复');
  assert.equal(writes(requests).length, 1);
}));


const robotAnswer = { ...snapshot.messages[0], id: 'robot-answer', conversationId: 'robot:reviewer', text: '机器人真实答复' };
const receipt = { id: 'receipt', channel: 'custom-channel', target: 'team-room', content: { text: robotAnswer.text }, status: 'sent', relatedTo: { kind: 'todo', id: 'todo' } };

test('渠道送达：sent 可单独记录，非 main 答复可联合记录，刷新保留所选来源', { timeout: 30000 }, async () => fixture(async ({ page, requests, setHandler }) => {
  let version = 0;
  setHandler(req => {
    if (req.path.endsWith('/closure')) return { body: { reporting: { ...initialReporting, version, requireDelivery: true }, review: null, sources: { messages: [robotAnswer], outbox: [receipt] } } };
    if (req.path.endsWith('/report')) return { body: { ...initialReporting, requireDelivery: true, version: ++version, report: req.body } };
  });
  await open(page); const drawer = dialog(page);
  await expect(drawer.getByLabel('选择真实答复').locator('option')).toHaveText(['选择真实答复', '机器人真实答复 · 会话：robot:reviewer']);
  await expect(drawer.getByLabel('选择渠道回执').locator('option')).toHaveText(['不选择渠道回执', 'custom-channel → team-room · 已送达（sent） · 机器人真实答复']);
  await drawer.getByLabel('选择渠道回执').selectOption('receipt');
  await drawer.getByRole('button', { name: '记录所选答复' }).click();
  await expect(drawer).toContainText('答复版本 1');
  assert.deepEqual(writes(requests)[0]?.body, { version: 0, outboxId: 'receipt' });
  await drawer.getByLabel('选择真实答复').selectOption('robot-answer');
  await page.evaluate(() => (window as any).eventRefresh());
  await drawer.getByRole('button', { name: '只读刷新' }).click();
  await expect(drawer.getByLabel('选择真实答复')).toHaveValue('robot-answer');
  await expect(drawer.getByLabel('选择渠道回执')).toHaveValue('receipt');
  await drawer.getByRole('button', { name: '记录所选答复' }).click();
  await expect(drawer).toContainText('答复版本 2');
  assert.deepEqual(writes(requests).map(item => item.path), ['/todos/todo/report', '/todos/todo/report']);
  assert.deepEqual(writes(requests)[1]?.body, { version: 1, messageId: 'robot-answer', outboxId: 'receipt' });
}));

test('渠道送达：queued / unknown 禁选，sent 迟变 unknown 阻止提交，空 sources 不回退快照', { timeout: 30000 }, async () => fixture(async ({ page, requests, setHandler }) => {
  let status = 'sent';
  setHandler(req => req.path.endsWith('/closure') ? { body: { reporting: { ...initialReporting, requireDelivery: true }, review: null, sources: { messages: [], outbox: [
    { ...receipt, status }, { ...receipt, id: 'queued', status: 'queued' }, { ...receipt, id: 'unknown', status: 'unknown' },
  ] } } } : undefined);
  await open(page); const drawer = dialog(page), select = drawer.getByLabel('选择渠道回执');
  await expect(drawer.getByLabel('选择真实答复').locator('option')).toHaveCount(1);
  for (const id of ['queued', 'unknown']) {
    await expect(select.locator(`option[value="${id}"]`)).toBeDisabled();
    await expect(select.locator(`option[value="${id}"]`)).toContainText(`未确认送达（${id}）`);
  }
  await expect(drawer.getByRole('button', { name: '记录所选答复' })).toBeDisabled();
  await select.selectOption('receipt');
  await expect(drawer.getByRole('button', { name: '记录所选答复' })).toBeEnabled();
  status = 'unknown';
  await drawer.getByRole('button', { name: '只读刷新' }).click();
  await expect(select.locator('option[value="receipt"]')).toBeDisabled();
  await expect(drawer).toContainText('未确认送达（unknown），不能作为送达证据');
  await expect(drawer.getByRole('button', { name: '记录所选答复' })).toBeDisabled();
  assert.equal(writes(requests).length, 0);
}));

test('回执归属：关联 Message 需联合选择，正文不匹配由服务端明确拒绝', { timeout: 30000 }, async () => fixture(async ({ page, requests, setHandler }) => {
  setHandler(req => {
    if (req.path.endsWith('/closure')) return { body: { reporting: initialReporting, review: null, sources: { messages: [robotAnswer], outbox: [{ ...receipt, relatedTo: { kind: 'message', id: robotAnswer.id } }] } } };
    if (req.path.endsWith('/report')) return { status: 400, body: { error: '答复 outbox 正文或来源归属不匹配' } };
  });
  await open(page); const drawer = dialog(page);
  await expect(drawer.getByLabel('选择渠道回执').locator('option[value="receipt"]')).toBeDisabled();
  await drawer.getByLabel('选择真实答复').selectOption(robotAnswer.id);
  await drawer.getByLabel('选择渠道回执').selectOption(receipt.id);
  await drawer.getByRole('button', { name: '记录所选答复' }).click();
  await expect(drawer).toContainText('答复 outbox 正文或来源归属不匹配');
  await expect(drawer).toContainText('未记录答复');
  assert.deepEqual(writes(requests)[0]?.body, { version: 0, messageId: robotAnswer.id, outboxId: receipt.id });
}));

test('验收来源：执行者名含 demo 可通过，声明不可洗白观察证据，来源不猜 provider', { timeout: 30000 }, async () => fixture(async ({ page, requests, setHandler }) => {
  setHandler(req => {
    if (req.path.endsWith('/closure')) return { body: { reporting: initialReporting, review: initialReview } };
    if (req.path.endsWith('/decide')) return { body: { ...initialReview, status: 'accepted', version: 4 } };
  });
  await page.evaluate(() => (window as any).changeRun({ executorId: 'my-demo-named-executor' }));
  await open(page); const drawer = dialog(page), accept = drawer.getByRole('button', { name: '验收通过并完成待办' });
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(drawer).toContainText('验收 accepted');
  assert.equal(writes(requests).length, 1);
  for (const source of ['demo', 'screen', 'runner', 'terminal-idle', 'idle', 'unknown', 'codex-json']) {
    await page.evaluate(source => (window as any).changeRun({ resultSource: source, nativeResultSources: source === 'codex-json' ? [] : [source] }), source);
    await drawer.getByRole('button', { name: '只读刷新' }).click();
    await expect(drawer).toContainText('验收 pending');
    await expect(accept).toBeDisabled();
  }
  await page.evaluate(() => (window as any).changeRun({ resultSource: 'real', nativeResultSources: ['other-proof'] }));
  await drawer.getByRole('button', { name: '只读刷新' }).click();
  await expect(accept).toBeEnabled();
  assert.equal(writes(requests).length, 1);
}));

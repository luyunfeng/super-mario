import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Run, Todo } from '../packages/protocol/src/index.ts';

const decision = '本轮只交付带列名的 CSV';
const doneWhen = '核对导出文件的行数';
const dueAt = '2034-05-06T09:08:07.654Z';

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-todo-detail-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      try { await server?.close(); }
      finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  });
  const token = 'offline-todo-detail';
  server = await startServer({ dataDir, token, demo: true, host: '127.0.0.1', port: 0 });
  const { app } = server;
  const project = app.projects.create({ name: '导出工具' });
  const todo = app.createTodo({ projectId: project.id, title: '核对导出清单', notes: '使用样例订单', dueAt });
  app.taskClosure.reporting.configure({ todoId: todo.id, required: true, version: 0 });
  // 保留一轮已有的待验收交付，才能发现派单意外覆盖验收标准或关联执行。
  const previous = app.dispatch({ executorId: 'demo', projectId: project.id, todoId: todo.id,
    prompt: '生成首版导出清单', doneWhen, expectMinutes: 1 });
  await expect.poll(() => app.store.get<Run>('runs', previous.id)?.status).toBe('completed');
  app.taskClosure.review.attach({ todoId: todo.id, runId: previous.id });
  const { reporting, review } = app.taskClosure.state(todo.id);
  const runs = () => app.store.list<Run>('runs').filter(run => run.todoId === todo.id && run.id !== previous.id);
  function checkTodo() {
    const stored = app.store.get<Todo>('todos', todo.id)!;
    assert.equal(stored.dueAt, dueAt);
    assert.equal(stored.completedAt, undefined);
    const current = app.taskClosure.state(todo.id);
    assert.deepEqual(current.reporting, reporting);
    assert.deepEqual(current.review, review);
  }
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(`${server.url}/#projects/${project.id}/todos?token=${token}`);
  return { page, todo, runs, checkTodo, app, previous };
}

test('待办详情记录及撤回决定，两次显式派单各自使用当时的决定并保留截止日与验收', { timeout: 40000 }, async t => {
  const { page, todo, runs, checkTodo } = await fixture(t);
  const row = page.locator('#panel-todos').locator(`[data-id="${todo.id}"]`);
  const open = row.getByRole('button', { name: '详情', exact: true });
  const detail = page.getByRole('dialog', { name: '待办详情', exact: true });

  async function dispatchDemo() {
    const before = new Set(runs().map(run => run.id));
    await detail.getByRole('button', { name: '交给 Agent', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '选择派单方式', exact: true });
    await dialog.getByLabel('执行器', { exact: true }).selectOption('demo');
    assert.equal(runs().length, before.size, '选择执行器后必须等待用户确认');
    const [response] = await Promise.all([
      page.waitForResponse(res => new URL(res.url()).pathname === `/api/v1/todos/${todo.id}/delegate`
        && res.request().method() === 'POST'),
      dialog.getByRole('button', { name: '确认派单', exact: true }).click(),
    ]);
    assert.equal(response.status(), 202);
    assert.equal(response.request().postDataJSON().executorId, 'demo');
    await expect(dialog).toHaveCount(0);
    const newRuns = () => runs().filter(run => !before.has(run.id));
    await expect.poll(() => newRuns().map(run => run.status)).toEqual(['completed']);
    const [run] = newRuns();
    assert.ok(run);
    assert.equal(run.executorId, 'demo');
    assert.equal(run.projectId, todo.projectId);
    assert.equal(run.resultSource, 'demo');
    // 内置 demo 直接回显 execute 收到的 prompt，包含派发时注入的上下文。
    const echo = /^演示输入：([\s\S]+)$/m.exec(run.output);
    assert.ok(echo, '内置 demo 应回显执行器输入');
    const executorPrompt = echo[1]!;
    assert.ok(executorPrompt.includes(todo.title));
    checkTodo();
    return { id: run.id, output: run.output, executorPrompt };
  }

  await open.click();
  await expect(detail.getByRole('heading', { name: todo.title, exact: true })).toBeVisible();
  await expect(detail).toContainText(todo.notes);
  await detail.getByLabel('新决策', { exact: true }).fill(decision);
  await detail.getByRole('button', { name: '添加决策', exact: true }).click();
  await expect(detail).toContainText(decision);
  await expect(detail).toContainText('生效中');
  assert.equal(runs().length, 0);
  checkTodo();
  const first = await dispatchDemo();
  assert.ok(first.executorPrompt.includes(decision), '首次执行器输入应包含已记录的决定');

  await open.click();
  await detail.getByRole('button', { name: '撤回', exact: true }).click();
  await expect(detail).toContainText('已撤回');
  assert.equal(runs().length, 1);
  checkTodo();
  const second = await dispatchDemo();
  assert.ok(!second.executorPrompt.includes(decision), '再次派单的执行器输入应排除已撤回的决定');
  assert.equal(runs().find(run => run.id === first.id)?.output, first.output, '撤回应保留首轮交付记录');
});

test('等你处理按待办名称打开原详情，回答后两处同步移除', { timeout: 30000 }, async t => {
  const { page, todo, app, previous } = await fixture(t);
  const card = app.interactions.open({ kind: 'review', runId: previous.id, title: '核对合成交付', body: '确认列名是否完整' });
  const chat = new URL('/#chat', page.url()).toString();
  await page.goto(chat);
  const selector = '[data-id="interaction:' + card.id + '"]';
  const globalCard = page.locator('#attention').locator(selector);
  const link = globalCard.getByRole('link', { name: '查看待办：' + todo.title, exact: true });
  await expect(link).toHaveAttribute('href', '#projects/' + todo.projectId + '/todos/detail/' + todo.id);
  await link.click();
  const scoped = page.getByRole('region', { name: '本事项等你处理' }).locator(selector);
  await expect(page.getByRole('heading', { name: todo.title, exact: true }).first()).toBeVisible();
  await expect(scoped.getByRole('link')).toHaveCount(0);
  await scoped.getByRole('textbox').fill('列名完整');
  await scoped.getByRole('button', { name: '回答', exact: true }).click();
  await expect(scoped).toHaveCount(0);
  await page.goto(chat);
  await expect(globalCard).toHaveCount(0);
  assert.equal(app.interactions.list().find(item => item.id === card.id)?.status, 'answered');
});

test('待办详情确认后解除指定版本的话题，冲突时显示当前绑定', { timeout: 30000 }, async t => {
  const { page, app } = await fixture(t);
  const todo = app.createTodo({ title: '核对合成话题' });
  const path = '/api/v1/todos/' + todo.id + '/thread';
  const first = { channel: 'feishu', botName: '合成机器人', chatName: '合成交付群', chatId: 'oc_team', threadId: 'omt_first', title: '季度合成验收', version: 'v1' };
  let thread: typeof first | null = first;
  const writes: unknown[] = [];
  await page.route('**' + path, async route => {
    if (route.request().method() === 'DELETE') {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (body.expectedVersion !== thread?.version) {
        await route.fulfill({ status: 409, json: { error: '版本冲突' } });
        return;
      }
      thread = null;
    }
    await route.fulfill({ json: { thread } });
  });
  await page.goto(new URL('/#projects/all/todos/detail/' + todo.id, page.url()).toString());
  const panel = page.getByRole('region', { name: '飞书话题', exact: true });
  await expect(panel).toContainText(first.botName);
  await expect(panel).toContainText(first.chatName);
  await expect(panel).toContainText(first.chatId);
  await expect(panel).toContainText(first.threadId);
  await expect(panel).toContainText(first.title);
  const unbind = panel.getByRole('button', { name: '解除话题绑定', exact: true });
  const confirm = page.getByRole('dialog', { name: '解除飞书话题绑定？', exact: true });
  await unbind.click();
  await expect(confirm).toContainText(first.threadId);
  await expect(confirm).toContainText(first.title);
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  assert.deepEqual(writes, []);
  thread = { ...first, threadId: 'omt_new', version: 'v2' };
  await unbind.click();
  await confirm.getByRole('button', { name: '确认解除', exact: true }).click();
  await expect(panel).toContainText('绑定已变化，请核对最新话题。');
  await expect(panel).toContainText('omt_new');
  await expect(panel).not.toContainText(first.threadId);
  assert.deepEqual(writes, [{ expectedProjectId: null, expectedVersion: 'v1' }]);
  await unbind.click();
  await expect(confirm).toContainText('omt_new');
  await confirm.getByRole('button', { name: '确认解除', exact: true }).click();
  await expect(panel).toContainText('未绑定飞书话题');
  await expect(unbind).toHaveCount(0);
  assert.deepEqual(writes, [{ expectedProjectId: null, expectedVersion: 'v1' }, { expectedProjectId: null, expectedVersion: 'v2' }]);
  // A second window binds another thread while this detail remains open.
  thread = { ...first, threadId: 'omt_live', version: 'v3' };
  app.events.publish('todo-thread.changed', { todoId: todo.id });
  await expect(panel).toContainText('omt_live');
  await unbind.click();
  thread = { ...first, threadId: 'omt_recent', version: 'v4' };
  app.events.publish('todo-thread.changed', { todoId: todo.id });
  await expect(panel).toContainText('omt_recent');
  await confirm.getByRole('button', { name: '确认解除', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  assert.deepEqual(writes, [{ expectedProjectId: null, expectedVersion: 'v1' }, { expectedProjectId: null, expectedVersion: 'v2' }]);
});

test('待办详情手工绑定、改标题与换绑按当前配对和版本保存', {timeout:40000}, async t => {
  const { page, app, todo } = await fixture(t);
  const path = '/api/v1/todos/' + todo.id + '/thread';
  type Thread = {channel:string; botId:string; botName:string; chatId:string; threadId:string; title?:string; version:string};
  let thread: Thread | null = null;
  const writes: Record<string, unknown>[] = [];
  let blocked = false;
  await page.route('**/api/v1/feishu/bots', route => route.fulfill({json:[
    {id:'owner',name:'合成机器人',enabled:!blocked,paired:true,scope:{kind:'global'}},
    {id:'off',name:'停用机器人',enabled:false,paired:true,scope:{kind:'global'}},
    {id:'project',name:'项目机器人',enabled:true,paired:true,scope:{kind:'project'}},
    {id:'unpaired',name:'未配对机器人',enabled:true,paired:false,scope:{kind:'global'}},
  ]}));
  await page.route('**/api/v1/feishu/bots/owner/topic-chats', route => route.fulfill({json:{binding:'owner-generation',
    version:8,items:[{chatId:'oc_team',name:'合成群'},{chatId:'oc_next',name:'另一个群'}]}}));
  await page.route('**'+path, async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (body.expectedVersion !== (thread?.version ?? null)) { await route.fulfill({status:409,json:{error:'冲突'}}); return; }
      thread = { channel:'feishu', botId:body.botId, botName:'合成机器人', chatId:body.chatId, threadId:body.threadId,
        title:body.title, version:thread && body.threadId === thread.threadId ? thread.version : 'v' + writes.length };
    }
    await route.fulfill({json:{thread}});
  });
  await page.goto(new URL('/#projects/'+todo.projectId+'/todos/detail/'+todo.id,page.url()).toString());
  const panel = page.getByRole('region',{name:'飞书话题',exact:true});
  await panel.getByRole('button',{name:'绑定飞书话题',exact:true}).click();
  await expect(panel.getByLabel('飞书机器人').locator('option')).toHaveCount(2);
  await panel.getByLabel('话题 ID').fill('omt_first');
  await panel.getByLabel('话题标题（可选）').fill('初始标题');
  const save = panel.getByRole('button',{name:'保存绑定',exact:true});
  await save.click();
  const confirm = page.getByRole('dialog',{name:'确认绑定飞书话题？'});
  await confirm.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(writes.length,0);
  await expect(panel.getByLabel('话题 ID')).toHaveValue('omt_first');
  await save.click();
  await confirm.getByRole('button',{name:'确认绑定',exact:true}).click();
  await expect(panel).toContainText('初始标题');
  assert.deepEqual(writes[0],{channel:'feishu',botId:'owner',chatId:'oc_team',threadId:'omt_first',title:'初始标题',
    expectedProjectId:todo.projectId,expectedVersion:null,expectedBotBinding:'owner-generation',expectedRegistryVersion:8});
  await panel.getByRole('button',{name:'修改话题标题'}).click();
  await expect(panel.getByLabel('已登记的话题群')).toBeDisabled();
  await expect(panel.getByLabel('话题 ID')).toHaveAttribute('readonly','');
  await panel.getByLabel('话题标题（可选）').fill('');
  await panel.getByRole('button',{name:'保存标题'}).click();
  await expect(panel).toContainText('已保存话题标题。');
  assert.deepEqual(writes[1],{...writes[0],expectedVersion:'v1',titleOnly:true,expectedTitle:'初始标题',title:''});
  await panel.getByRole('button',{name:'更换话题绑定'}).click();
  await panel.getByLabel('已登记的话题群').selectOption('oc_next');
  await panel.getByLabel('话题 ID').fill('omt_next');
  await save.click();
  const change = page.getByRole('dialog',{name:'确认更换飞书话题？'});
  await expect(change).toContainText('oc_next');
  thread = { channel:'feishu', botId:'owner', botName:'合成机器人', chatId:'oc_team', threadId:'omt_other', version:'concurrent' };
  await change.getByRole('button',{name:'确认更换',exact:true}).click();
  await expect(panel).toContainText('绑定或群登记已变化');
  await expect(panel).toContainText('omt_other');
  assert.equal(writes.length,3);
  await panel.getByRole('button',{name:'更换话题绑定'}).click();
  await panel.getByLabel('已登记的话题群').selectOption('oc_next');
  await panel.getByLabel('话题 ID').fill('omt_next');
  await save.click();
  await change.getByRole('button',{name:'确认更换',exact:true}).click();
  await expect(panel).toContainText('omt_next');
  assert.equal(writes[3].expectedVersion,'concurrent');
  await panel.getByRole('button',{name:'更换话题绑定'}).click();
  await panel.getByLabel('话题 ID').fill('omt_obsolete');
  await save.click();
  app.events.publish('todo-thread.changed', { todoId: todo.id });
  await expect(panel.getByRole('button',{name:'修改话题标题'})).toBeAttached();
  await change.getByRole('button',{name:'确认更换',exact:true}).click();
  assert.equal(writes.length,4, '详情刷新后旧确认不得写入');
  blocked = true;
  await panel.getByRole('button',{name:'修改话题标题'}).click();
  await expect(panel).toContainText('原机器人已停用或配对已变化');
  await expect(panel.getByRole('button',{name:'保存标题'})).toHaveCount(0);
});

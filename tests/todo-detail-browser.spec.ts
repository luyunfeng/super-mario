import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { recordTodoOrigin } from '../packages/core/src/todo-brief.ts';
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

test('已打开的待办实时显示执行会话决定、替代链与依据，主人可撤回', {timeout:30000}, async t => {
  const { page, app, todo, previous } = await fixture(t);
  const path = '/api/v1/todos/' + todo.id + '/decisions';
  const run: Run = { ...previous, id:'fixture-run', machineId:'fixture-machine',sessionId:'fixture-session', status:'running' };
  app.store.put('runs',run.id,run);
  app.store.put('todos',todo.id,{...todo,responsibleSession:{machineId:run.machineId,sessionId:run.sessionId,runId:run.id}});
  const base = app.todoDecisions.addAgent(todo.id,run,{question:'如何存储合成条目？',choice:'保存为 CSV',reason:'下游读取表格'});
  await page.goto(new URL('/#projects/'+todo.projectId+'/todos/detail/'+todo.id,page.url()).toString());
  const first = page.locator('[data-decision-id="'+base.id+'"]');
  await expect(first).toContainText('执行会话');
  await expect(first).toContainText(run.id);
  await expect(first).toContainText('依据 · 下游读取表格');
  await expect(first).toContainText(String(new Date(base.createdAt).getFullYear()));
  await page.getByLabel('新决策',{exact:true}).fill('尚未提交的草稿');
  const revision = app.todoDecisions.addAgent(todo.id,run,{question:base.question, choice:'保存为 JSON',reason:'需要保留嵌套字段',supersedesId:base.id});
  app.events.publish('todo-decisions.changed',{todoId:todo.id});
  const next = page.locator('[data-decision-id="'+revision.id+'"]');
  await expect(next).toContainText('问题 · 如何存储合成条目？');
  await expect(next).toContainText('选择 · 保存为 JSON');
  await expect(next).toContainText('依据 · 需要保留嵌套字段');
  await expect(first).toContainText('已被替代');
  await expect(first).toContainText('由后续决定替代 · 保存为 JSON');
  await expect(next).toContainText('替代了 · 保存为 CSV');
  await expect(first.getByRole('button',{name:'撤回',exact:true})).toHaveCount(0);
  await expect(page.getByLabel('新决策',{exact:true})).toHaveValue('尚未提交的草稿');
  const [withdrawal] = await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === path+'/'+encodeURIComponent(revision.id)+'/withdraw'),
    next.getByRole('button',{name:'撤回',exact:true}).click()]);
  await expect(next).toContainText('已撤回');
  await expect(first).toContainText('已被替代');
  assert.equal(withdrawal.status(),200);
  assert.deepEqual(withdrawal.request().postDataJSON(),{expectedProjectId:todo.projectId});
  assert.equal(app.todoDecisions.list(todo.id).find(item => item.id === revision.id)?.active,false);
});

test('创建续办在回执丢失并刷新后使用原请求，前序链接只在同一范围展示', {timeout:30000}, async t => {
  const {page,app,todo} = await fixture(t);
  const detail = '/#projects/'+todo.projectId+'/todos/detail/'+todo.id;
  const apiPath = '/api/v1/todos/'+todo.id+'/continue';
  const bodies: Array<{requestId:string;title:string;continuationReason:string;expectedProjectId:string}> = [];
  await page.route('**'+apiPath, async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      const response = await route.fetch();
      assert.equal(response.ok(),true);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.goto(new URL(detail,page.url()).toString());
  const open = page.getByRole('button',{name:'创建续办',exact:true});
  const editor = page.getByRole('dialog',{name:'创建续办',exact:true});
  await open.click();
  await expect(editor.getByRole('button',{name:'确认创建续办'})).toBeDisabled();
  await editor.getByLabel('续办标题').fill('核对第二批导出');
  await editor.getByLabel('交接说明').fill('使用已核对的列名，补上第二批样例。');
  await editor.getByRole('button',{name:'确认创建续办'}).click();
  await expect(editor).toContainText('创建结果尚未确认');
  await page.reload();
  await open.click();
  await expect(editor.getByLabel('交接说明')).toHaveValue('使用已核对的列名，补上第二批样例。');
  await expect(editor.getByLabel('续办标题')).toHaveAttribute('readonly','');
  await editor.getByRole('button',{name:'用原请求重试'}).click();
  await expect(page.getByRole('heading',{name:'核对第二批导出',exact:true})).toBeVisible();
  assert.equal(bodies.length,2);
  assert.deepEqual(bodies[0],bodies[1]);
  assert.equal(bodies[0].expectedProjectId,todo.projectId);
  assert.match(bodies[0].requestId,/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  const successors = app.store.list<Todo & {continuesTodoId?:string}>('todos').filter(item => item.continuesTodoId === todo.id);
  assert.equal(successors.length,1);
  const successor = successors[0];
  assert.ok(page.url().endsWith('/todos/detail/'+successor.id));
  const previous = page.getByRole('link',{name:todo.title,exact:true});
  await expect(previous).toHaveAttribute('href',detail.slice(1));
  await expect(page.getByText(bodies[0].continuationReason,{exact:true})).toBeVisible();
  await previous.click();
  await expect(page.getByRole('heading',{name:todo.title,exact:true}).first()).toBeVisible();
  const branch = app.continueTodo(todo.id,{title:'另一项直接续办',continuationReason:'并行验收',expectedProjectId:todo.projectId,requestId:'fixture-other'});
  const later = app.continueTodo(successor.id,{title:'间接续办',continuationReason:'下一阶段验收',expectedProjectId:todo.projectId,requestId:'fixture-later'});
  const invalid = app.createTodo({projectId:todo.projectId,title:'其他根的待办'});
  app.store.put('todos',invalid.id,{...invalid,continuesTodoId:todo.id,continuationRootId:'different-root'});
  await page.reload();
  const following = page.locator('section').filter({has:page.getByRole('heading',{name:'后续待办',exact:true})}).last();
  await expect(following.getByRole('link')).toHaveCount(2);
  await expect(following.getByRole('link',{name:branch.title})).toBeVisible();
  await expect(following).not.toContainText(later.title);
  await expect(following).not.toContainText(invalid.title);
  await following.getByRole('link',{name:successor.title}).click();
  await expect(page.getByRole('link',{name:later.title})).toBeVisible();
  app.store.put('todos',successor.id,{...successor,continuationRootId:'different-root'});
  await page.reload();
  await expect(previous).toHaveCount(0);
  await expect(page.getByRole('link',{name:later.title})).toHaveCount(0);
  app.store.put('todos',successor.id,successor);
  app.store.put('todos',todo.id,{...todo,projectId:undefined});
  await page.goto(new URL('/#projects/'+todo.projectId+'/todos/detail/'+successor.id,page.url()).toString());
  await page.reload();
  await expect(page.getByText('当前范围内找不到前序待办。')).toBeVisible();
  await expect(previous).toHaveCount(0);
});

test('从分支末端查看全链、切到兄弟分支并刷新历程', {timeout:30000}, async t => {
  const {page,app,todo:root} = await fixture(t);
  const href = (id: string) => new URL('/#projects/'+root.projectId+'/todos/detail/'+id,page.url()).toString();
  await page.goto(href(root.id));
  const panel = page.locator('details[aria-label="续办历程"]');
  await expect(panel).toBeHidden();
  const next = (from: string, title: string, key: string) => app.continueTodo(from,{
    title, continuationReason:'交接 '+title,expectedProjectId:root.projectId,requestId:key
  });
  const first = next(root.id,'阶段甲','first');
  const peer = next(root.id,'阶段乙','peer');
  const leaf = next(first.id,'阶段丙','leaf');
  const session = {machineId:'fixture-machine',sessionId:'fixture-session',runId:'fixture-run'};
  app.store.put('todos',first.id,{...first,responsibleSession:session,completedAt:'2030-06-01T12:00:00Z'});
  await page.goto(href(leaf.id));
  const [lineageResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/todos/'+leaf.id+'/lineage'),
    panel.locator('summary').click(),
  ]);
  assert.equal(new URL(lineageResponse.url()).searchParams.get('expectedProjectId'),root.projectId);
  const rows = panel.getByRole('listitem');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText(root.title);
  await expect(panel.locator('[aria-current="step"]')).toHaveText('阶段丙（正在查看）');
  await expect(rows.filter({hasText:'交接说明 · 交接 阶段丙'})).toContainText('直接前序 · 阶段甲');
  const firstRow = rows.filter({hasText:'负责会话 · fixture-machine / fixture-session'});
  await expect(firstRow).toContainText('创建于');
  await expect(firstRow).toContainText('完成于');
  await panel.getByRole('link',{name:peer.title}).click();
  await expect(page.getByRole('heading',{name:peer.title,exact:true})).toBeVisible();
  await panel.locator('summary').click();
  await expect(panel.locator('[aria-current="step"]')).toHaveText('阶段乙（正在查看）');
  const extra = next(first.id,'新增分支','extra');
  await expect(panel.getByRole('link',{name:extra.title})).toBeVisible();
  await expect(rows).toHaveCount(5);
  await panel.getByRole('link',{name:root.title}).click();
  await expect(page.getByRole('heading',{name:root.title,exact:true}).first()).toBeVisible();
});

test('交办依据显示原始登记与各轮标准，分支隔离并在重连时核对来源', {timeout:30000}, async t => {
  const { page, app, todo } = await fixture(t);
  const response = await page.request.post(new URL('/api/v1/todos',page.url()).href, {
    headers:{Authorization:'Bearer offline-todo-detail'},data:{projectId:todo.projectId,title:'原登记标题',notes:'起初登记的交接备注'}
  });
  assert.equal(response.status(),201);
  const root = await response.json() as Todo;
  app.updateTodo(root.id,{title:'后来修改标题',notes:'后来改的备注'});
  const child = app.continueTodo(root.id,{title:'子阶段',continuationReason:'接手原登记任务',expectedProjectId:todo.projectId,requestId:'child'});
  const other = app.continueTodo(root.id,{title:'旁支阶段',continuationReason:'另行验收',expectedProjectId:todo.projectId,requestId:'peer'});
  const dispatch = (id:string, requirement:string) => app.dispatch({executorId:'demo',projectId:todo.projectId,todoId:id,
    prompt:'离线测试派单',doneWhen:requirement,expectMinutes:3});
  const first = dispatch(root.id,'核对原始列名');
  dispatch(other.id,'仅旁支的验收条件');
  await page.goto(new URL('/#projects/'+todo.projectId+'/todos/detail/'+child.id,page.url()).toString());
  const panel = page.locator('details[aria-label="交办依据"]');
  const [loaded] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/todos/'+child.id+'/brief'),
    panel.locator('summary').click()
  ]);
  assert.equal(new URL(loaded.url()).searchParams.get('expectedProjectId'),todo.projectId);
  await expect(panel).toContainText('主人在 Web 填写');
  await expect(panel).toContainText('原登记标题');
  await expect(panel).toContainText('起初登记的交接备注');
  await expect(panel).not.toContainText('后来改的备注');
  await expect(panel).toContainText('核对原始列名');
  await expect(panel).toContainText('预计 3 分钟');
  await expect(panel).not.toContainText('仅旁支的验收条件');
  await expect(panel.getByRole('link',{name:'来源执行 · '+first.id})).toHaveAttribute('href','#projects/'+todo.projectId+'/runs/'+first.id);
  dispatch(child.id,'核对续办阶段总数');
  await expect(panel).toContainText('核对续办阶段总数');
  // A legacy installation can have no original registration. Reconnection must replace the cached attribution.
  app.store.remove('todo.brief-origins',root.id);
  await page.evaluate(() => { window.dispatchEvent(new Event('offline')); });
  await page.evaluate(() => { window.dispatchEvent(new Event('online')); });
  await expect(panel).toContainText('根据现有待办记录重建');
  await expect(panel).toContainText('后来修改标题');
  await expect(panel).not.toContainText('主人在 Web 填写');
  recordTodoOrigin(app.store,root,'assistant',{id:'source-fixture',conversationId:'main',text:'按合成批次核对。'});
  await panel.locator('summary').click();
  await panel.locator('summary').click();
  await expect(panel).toContainText('助手登记');
  await expect(panel).toContainText('交办时的原话');
  await expect(panel).toContainText('按合成批次核对。');
  await expect(panel).toContainText('起初登记的交接备注');
  await expect(panel).toContainText('来源消息 · source-fixture');
});

test('飞书交办标明正文已去除命令和机器人点名，仅展示服务端提供的摘录', {timeout:30000}, async t => {
  const { page, todo } = await fixture(t);
  const requestText = '核对样例中的 /ai 用法。';
  const origin = {todoId:todo.id,title:todo.title,notes:'独立登记备注',kind:'feishu',createdAt:todo.createdAt,sourceMessageId:'fixture-source'};
  let showExcerpt = true;
  await page.route('**/api/v1/todos/'+todo.id+'/brief?*', route => route.fulfill({json:{
    origin:{...origin,...(showExcerpt && {requestText})}, criteria:[],reconstructed:false
  }}));
  await page.goto(new URL('/#projects/'+todo.projectId+'/todos/detail/'+todo.id,page.url()).toString());
  const panel = page.locator('details[aria-label="交办依据"]');
  await panel.locator('summary').click();
  await expect(panel).toContainText('主人在飞书交办');
  await expect(panel).toContainText('交办正文摘录（已去除命令和机器人点名）');
  await expect(panel.getByText(requestText,{exact:true})).toBeVisible();
  await expect(panel).not.toContainText('交办时的原话');
  showExcerpt = false;
  await panel.locator('summary').click();
  await panel.locator('summary').click();
  await expect(panel).toContainText('独立登记备注');
  await expect(panel).not.toContainText('交办正文摘录');
  await expect(panel).not.toContainText(requestText);
});

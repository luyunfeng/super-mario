import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Page, type Route } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

const suggestion = (extra: any = {}) => ({ id: 's1', version: 2, source: { kind: 'personal', id: 'raw-a' }, sourceVersion: 3, conversationId: 'c1', action: { kind: 'todo', title: '旧标题', notes: '原备注' }, status: 'draft', ...extra });
const view = (extra: any = {}) => ({ source: { kind: 'personal', id: 'raw-a', version: 3, title: '原消息', text: '<img src=x onerror=alert(1)>', projectId: 'p1', active: true, replyAvailable: true }, conversationId: 'c1', available: true, messages: [], requests: [], suggestions: [], ...extra });
type Call = { path: string; method: string; body: any };
type Reply = { data?: any; status?: number; abort?: boolean };
async function fixture(run: (f: { page: Page; calls: Call[]; setHandler: (fn: (c: Call) => Reply | Promise<Reply>) => void }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-inbox-handling-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(5000);
    const errors: string[] = [], calls: Call[] = []; page.on('pageerror', e => errors.push(e.message));
    let handler: (c: Call) => Reply | Promise<Reply> = () => ({ data: view() });
    await page.route('**/js/main.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/api/v1/**', async (r: Route) => {
      const c = { path: new URL(r.request().url()).pathname.replace('/api/v1', ''), method: r.request().method(), body: r.request().postDataJSON() };
      calls.push(c); const reply = await handler(c);
      if (reply.abort) await r.abort('failed');
      else await r.fulfill({ status: reply.status || 200, contentType: 'application/json', body: JSON.stringify(reply.data ?? {}) });
    });
    await page.goto(server.url);
    await page.evaluate(async () => {
      const a = '/js/lib/api.js', m = '/js/features/inbox-handling.js';
      const { createApi } = await import(a); const { openInboxHandlingDrawer } = await import(m);
      const api = createApi(), listeners = new Set<any>();
      const store = { view: { snapshot: { projects: [{ id: 'p1', name: '项目一' }], executors: [{ id: 'offline', name: '真实离线执行者', available: false }] } }, subscribe(fn: any) { listeners.add(fn); return () => listeners.delete(fn); } };
      // The normal shell already owns one draft store before opening a drawer.
      const drafts = '/js/lib/conversation-drafts.js';
      (await import(drafts)).createConversationDrafts({ api, store });
      const baseline = listeners.size;
      (window as any).handling = { api, store, open: (source = { kind: 'personal', id: 'raw-a' }) => openInboxHandlingDrawer({ api, store, source }), emit: (changed = true) => { if (changed) store.view.snapshot = { ...store.view.snapshot }; for (const fn of listeners) fn(store.view); }, count: () => listeners.size - baseline };
    });
    await run({ page, calls, setHandler(fn) { handler = fn; } }); assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
}
const drawer = (page: Page) => page.getByRole('dialog', { name: '处理与建议', exact: true });
const open = (page: Page, kind = 'personal', id = 'raw-a') => page.evaluate(({ kind, id }) => { (window as any).handling.open({ kind, id }); }, { kind, id });
const emit = (page: Page, changed = true) => page.evaluate(v => (window as any).handling.emit(v), changed);
const close = (page: Page) => drawer(page).locator('.drawer__foot').getByRole('button', { name: '关闭', exact: true }).click();

test('只读打开、JSON answer、安全渲染、桌面与390px；missing模型仍手写四类建议', { timeout: 30000 }, async () => fixture(async ({ page, calls, setHandler }) => {
  let data = view({ source: { ...view().source, replyAvailable: false, replyReason: '没有回复通道' }, available: false, reason: 'missing', messages: [{ role: 'assistant', text: JSON.stringify({ answer: '请先检查', suggestions: [{ secret: '机器内容' }] }) }] });
  setHandler(c => c.method === 'GET' ? { data } : { data: suggestion({ action: c.body.action }), status: 201 });
  await open(page); await expect(drawer(page)).toContainText('主模型不可用');
  await expect(drawer(page)).toContainText('请先检查'); await expect(drawer(page)).not.toContainText('机器内容');
  await expect(drawer(page).locator('img')).toHaveCount(0); await expect(drawer(page)).toContainText('<img');
  await expect(page.getByRole('button', { name: '发送处理指令' })).toBeDisabled();
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
  await page.getByRole('button', { name: '手工新建建议' }).click();
  await page.getByLabel('待办标题', { exact: true }).fill('手工待办');
  await page.getByLabel('待办备注', { exact: true }).fill('备注');
  await page.getByRole('button', { name: '保存建议（不执行）' }).click();
  await expect(drawer(page)).toContainText('已保存建议版本');
  assert.deepEqual(calls.find(c => c.method === 'POST')!.body, { sourceVersion: 3, action: { kind: 'todo', title: '手工待办', notes: '备注' } });
  for (const kind of ['dispatch', 'reply', 'conclusion']) {
    await page.getByRole('button', { name: '手工新建建议' }).click(); await page.getByLabel('建议类型', { exact: true }).selectOption(kind);
    if (kind === 'dispatch') {
      await page.getByLabel('执行者', { exact: true }).selectOption('offline'); await page.getByLabel('执行内容', { exact: true }).fill('运行检查');
      await page.getByLabel('验收要求', { exact: true }).fill('检查通过'); await page.getByLabel('预计分钟', { exact: true }).fill('0');
      const before = calls.filter(c=>c.method==='POST').length; await page.getByRole('button', { name: '保存建议（不执行）' }).click(); await expect(drawer(page)).toContainText('有效正数'); assert.equal(calls.filter(c=>c.method==='POST').length, before);
      await page.getByLabel('预计分钟', { exact: true }).fill('15');
    } else await page.getByLabel(kind === 'reply' ? '回复内容' : '结论内容', { exact: true }).fill('x'.repeat(800));
    await page.getByRole('button', { name: '保存建议（不执行）' }).click(); await expect(page.getByLabel('建议类型', { exact: true })).toHaveCount(0);
  }
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await drawer(page).evaluate(el => el.scrollWidth > el.clientWidth), false);
  }
  assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => c.body.action.kind), ['todo', 'dispatch', 'reply', 'conclusion']);
  assert.ok(calls.filter(c => c.method === 'POST').every(c => c.path.endsWith('/suggestions')));
}));

test('派发建议随执行回执更新，失去对应记录后关闭详情入口', async () => fixture(async ({ page, calls, setHandler }) => {
  const item = suggestion({ status: 'applied', action: { kind: 'dispatch', executorId: 'fixture', prompt: '核对收件', doneWhen: '完成核对', expectMinutes: 1 },
    result: { runId: 'r1' }, run: { status: 'running', webPath: '#projects/p1/runs/r1' } });
  setHandler(() => ({ data: view({ suggestions: [item] }) }));
  await open(page);
  await expect(drawer(page)).toContainText('派发执行 · 执行中');
  const link = drawer(page).getByRole('link', { name: '查看实际执行记录' });
  await expect(link).toHaveAttribute('href', '#projects/p1/runs/r1');
  item.run.blockedBy = [{ id: 'q1', title: '确认材料日期', href: '#chat?interaction=q1' }]; await emit(page);
  await expect(drawer(page).getByRole('link', { name: '确认材料日期' })).toHaveAttribute('href', '#chat?interaction=q1');
  item.run.blockedBy = []; item.run.status = 'failed'; await emit(page);
  await expect(drawer(page).getByRole('link', { name: '确认材料日期' })).toHaveCount(0);
  await expect(drawer(page)).toContainText('派发执行 · 失败');
  delete item.run; await emit(page);
  await expect(drawer(page)).toContainText('当前无法核对这次派发');
  await expect(link).toHaveCount(0);
  assert.ok(calls.every(call => call.method === 'GET'));
}));

test('未知的投递回执能打开对应个人或机器人发件记录', async () => fixture(async ({ page, calls, setHandler }) => {
  for (const kind of ['personal', 'mailbox']) {
    setHandler(() => ({ data: view({ source: { ...view().source, kind }, suggestions: [
      suggestion({ status: 'unknown', action: { kind: 'reply', text: '合成回复' }, delivery: { id: 'receipt-1', status: 'unknown' } }),
    ] }) }));
    await open(page, kind);
    await expect(drawer(page)).toContainText('回复投递 · 结果未知');
    await expect(drawer(page).getByRole('link', { name: '查看实际发件记录' })).toHaveAttribute('href',
      '#outbox?receipt=' + encodeURIComponent((kind === 'personal' ? 'delivery:' : 'mailbox:') + 'receipt-1'));
    await close(page);
  }
  assert.ok(calls.every(call => call.method === 'GET'));
}));

test('编辑旧版本显式action，409保留草稿且手动核对；submitted新版旧审批失效', { timeout: 30000 }, async () => fixture(async ({ page, calls, setHandler }) => {
  let data = view({ suggestions: [suggestion({ status: 'submitted', approvalId: 'old-approval' })] }), conflict = true;
  setHandler(c => {
    if (c.method === 'GET') return { data };
    if (conflict) { data = view({ source: { ...data.source, version: 4 }, suggestions: [suggestion({ version: 3 })] }); return { status: 409, data: { error: 'conflict' } }; }
    return { data: suggestion({ version: 4, sourceVersion: 4, action: c.body.action }) };
  });
  await open(page); await page.getByRole('button', { name: '编辑建议', exact: true }).click();
  await expect(drawer(page)).toContainText('旧审批失效'); await page.getByLabel('待办标题', { exact: true }).fill('用户草稿');
  await page.getByLabel('处理指令', { exact: true }).fill('未发送聊天');
  await page.getByRole('button', { name: '保存建议（不执行）' }).click(); await expect(drawer(page)).toContainText('版本冲突');
  await expect(drawer(page)).toContainText('当前来源版本：4'); await emit(page);
  await expect(page.getByLabel('待办标题', { exact: true })).toHaveValue('用户草稿'); await expect(page.getByLabel('处理指令', { exact: true })).toHaveValue('未发送聊天');
  await expect(page.getByRole('button', { name: '保存建议（不执行）' })).toBeDisabled();
  assert.deepEqual(calls.find(c => c.method === 'POST')!.body, { sourceVersion: 3, id: 's1', version: 2, action: { kind: 'todo', title: '用户草稿', notes: '原备注' } });
  conflict = false; await page.getByRole('button', { name: '已检查新版本，保留草稿继续编辑' }).click();
  await page.getByRole('button', { name: '保存建议（不执行）' }).click(); await expect(drawer(page)).toContainText('已保存建议版本 4');
  const posts = calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 2); assert.equal(posts[1]!.body.version, 3); assert.equal(posts[1]!.body.sourceVersion, 4);
}));

test('完整确认当前内容，只建审批；reply不可用可存不可确认，stale与执行状态禁用', { timeout: 30000 }, async () => fixture(async ({ page, calls, setHandler }) => {
  const data = view({ source: { ...view().source, replyAvailable: false, replyReason: '没有回复通道' }, suggestions: [suggestion(), suggestion({ id: 'reply', action: { kind: 'reply', text: '回复草稿' } }), ...['stale', 'executing', 'unknown', 'applied'].map(status => suggestion({ id: status, status }))] });
  setHandler(c => {
    if (c.method === 'GET') return { data };
    Object.assign(data.suggestions[0], { status: 'submitted', approvalId: 'actual-approval-id', approvalStatus: 'pending' });
    return { data: { id: 'actual-approval-id', status: 'pending' }, status: 201 };
  });
  await open(page); await expect(drawer(page)).toContainText('没有回复通道');
  await expect(page.getByRole('button', { name: '检查并提交审批' }).nth(1)).toBeDisabled();
  await expect(page.getByRole('button', { name: '检查并提交审批' }).nth(2)).toBeDisabled();
  for (const status of ['执行中', '结果未知', '已应用（不代表待办完成）']) await expect(drawer(page).locator('.card').filter({ has: page.getByText(status, { exact: true }) }).getByRole('button', { name: '编辑建议' })).toBeDisabled();
  await page.getByRole('button', { name: '检查并提交审批' }).first().click();
  const confirm = drawer(page).locator('.card').filter({ hasText: '核对当前完整建议' });
  await expect(confirm).toContainText('personal/raw-a'); await expect(confirm).toContainText('项目一'); await expect(confirm).toContainText('原备注');
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
  await confirm.getByRole('button', { name: '提交当前建议审批' }).click(); await expect(drawer(page)).toContainText('审批 ID：actual-approval-id');
  assert.deepEqual(calls.find(c => c.method === 'POST'), { path: '/inbox-handling/personal/raw-a/suggestions/s1/confirm', method: 'POST', body: { sourceVersion: 3, version: 2 } });
  await expect(page.getByRole('link', { name: '去对话审批' }).last()).toHaveAttribute('href', '#chat?approval=actual-approval-id');
  Object.assign(data.suggestions[0], { approvalStatus: 'rejected' }); await emit(page);
  await expect(drawer(page)).toContainText('已拒绝');
  await expect(page.getByRole('link', { name: '去对话审批' })).toHaveCount(0);
}));

test('202只受理、unknown不重放，GET请求事实；仅快照变化debounce读取', { timeout: 30000 }, async () => fixture(async ({ page, calls, setHandler }) => {
  let data = view(), abort = true;
  setHandler(c => {
    if (c.method === 'GET') return { data };
    data = view({ requests: [{ id: 'durable-request', key: c.body.key, conversationId: 'c1', status: 'pending' }] });
    return abort ? { abort: true } : { data: data.requests[0], status: 202 };
  });
  await open(page); await expect(page.getByRole('button', { name: '发送处理指令' })).toBeEnabled();
  const reads = calls.length; await emit(page, false); await page.waitForTimeout(150); assert.equal(calls.length, reads);
  await page.getByLabel('处理指令').fill('请分析'); await page.getByRole('button', { name: '发送处理指令' }).click(); await expect(drawer(page)).toContainText('写入结果未知');
  await expect(page.getByRole('button', { name: '发送处理指令' })).toBeDisabled();
  await emit(page); await expect(drawer(page)).toContainText('durable-request'); await expect(drawer(page)).toContainText('已持久受理，等待模型处理');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  const key = calls.find(c => c.method === 'POST')!.body.key; assert.ok(key);
  data = view({ requests: [{ id: 'durable-request', key, conversationId: 'c1', status: 'failed', error: '模型失败' }] }); await emit(page); await expect(drawer(page)).toContainText('模型请求失败');
  await expect(page.getByRole('button', { name: '发送处理指令' })).toBeEnabled(); abort = false;
  await page.getByRole('button', { name: '发送处理指令' }).click(); await expect(drawer(page)).toContainText('受理不代表模型已完成');
  const posts = calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 2); assert.notEqual(posts[0]!.body.key, posts[1]!.body.key);
}));

test('未知分析需核对后显式发起新请求；不重放旧请求或审批', { timeout:30000 }, async()=>fixture(async({page,calls,setHandler})=>{
  let data=view({requests:[{id:'unknown-old',key:'old-key',status:'unknown'}]});
  setHandler(c=>c.method==='GET'?{data}:{data:{id:'new-analysis',key:c.body.key,status:'pending'},status:202});
  await open(page);await expect(page.getByRole('button',{name:'发送处理指令'})).toBeDisabled();
  await page.getByRole('button',{name:'核对后发起新分析'}).click();
  await page.getByRole('dialog',{name:'发起新的只读分析'}).getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.getByRole('button',{name:'发送处理指令'})).toBeDisabled();assert.equal(calls.filter(c=>c.method==='POST').length,0);
  await page.getByRole('button',{name:'核对后发起新分析'}).click();
  await page.getByRole('button',{name:'已核对，允许新分析'}).click();
  await expect(page.getByRole('button',{name:'发送处理指令'})).toBeEnabled();
  await page.getByLabel('处理指令').fill('新的一次只读分析');await page.getByRole('button',{name:'发送处理指令'}).click();
  await expect.poll(()=>calls.filter(c=>c.method==='POST').length).toBe(1);
  const post=calls.find(c=>c.method==='POST')!;assert.ok(post.path.endsWith('/messages'));assert.notEqual(post.body.key,'old-key');
}));

test('关闭/token与两来源隔离迟到GET/POST；清理订阅，旧API仍可关闭', { timeout: 30000 }, async () => fixture(async ({ page, calls, setHandler }) => {
  for (const operation of ['GET', 'POST']) for (const change of ['close', 'token', 'source']) {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let started = false;
    setHandler(async c => {
      if (c.path.includes('/mailbox/')) return { data: view({ source: { ...view().source, kind: 'mailbox', id: 'raw-b', title: '来源乙' } }) };
      if (c.method === operation) { started = true; await gate; }
      return { data: c.method === 'GET' ? view({ source: { ...view().source, title: '迟到来源甲' } }) : { id: 'late-request', status: 'pending' } };
    });
    await open(page);
    if (operation === 'POST') { await expect(page.getByRole('button', { name: '发送处理指令' })).toBeEnabled(); await page.getByLabel('处理指令').fill('甲指令'); await page.getByRole('button', { name: '发送处理指令' }).click(); }
    await expect.poll(() => started).toBe(true);
    if (change === 'token') await page.evaluate(() => (window as any).handling.api.setToken(crypto.randomUUID()));
    else await close(page);
    if (change === 'source') { await open(page, 'mailbox', 'raw-b'); await expect(drawer(page)).toContainText('来源乙'); }
    release(); await page.waitForTimeout(150);
    if (change === 'source') { await expect(drawer(page)).not.toContainText('late-request'); await expect(drawer(page)).not.toContainText('迟到来源甲'); await expect(page.getByLabel('处理指令')).toHaveValue(''); await close(page); }
    await expect(drawer(page)).toHaveCount(0); await expect.poll(() => page.evaluate(() => (window as any).handling.count())).toBe(0);
    // 每轮使用新令牌，避免把前轮故意留下的未知请求作为新请求重放。
    await page.evaluate(() => (window as any).handling.api.setToken(crypto.randomUUID()));
  }
  setHandler(() => ({ status: 404, data: { error: 'old API' } }));
  await open(page); await expect(drawer(page)).toContainText('当前服务不支持'); await close(page);
  const count = calls.length; await emit(page); await page.waitForTimeout(150); assert.equal(calls.length, count);
}));

test('收件详情保留旧动作并跳转新抽屉，personal/mailbox均使用raw.id', { timeout: 30000 }, async () => fixture(async ({ page, calls, setHandler }) => {
  const now = '2026-11-17T01:00:00Z';
  const mail = { id: 'bot-original', direction: 'inbox', title: '机器人原消息', text: '机器人正文', status: 'pending', updatedAt: now, scope: { kind: 'personal' } };
  setHandler(c => {
    if (c.path === '/mailboxes') return { data: [mail] };
    const kind = c.path.includes('/mailbox/') ? 'mailbox' : 'personal';
    return { data: view({ source: { ...view().source, kind, id: kind === 'mailbox' ? 'bot-original' : 'person-original' } }) };
  });
  await page.evaluate(async now => {
    const modulePath = '/js/pages/mailbox.js'; const { createMailboxPage } = await import(modulePath);
    const f = (window as any).handling;
    f.store.view.snapshot.inbox = [{ id: 'person-original', version: 1, title: '个人原消息', text: '个人正文', tier: 'action', updatedAt: now }];
    const component = createMailboxPage({ api: f.api, store: f.store, router: { current: { page: 'inbox' }, href: (route: string) => '#' + route }, direction: 'inbox' });
    component.el.classList.add('is-active'); document.body.append(component.el); component.onShow();
  }, now);
  for (const [title, kind, id] of [['个人原消息', 'personal', 'person-original'], ['机器人原消息', 'mailbox', 'bot-original']]) {
    await page.locator('.mailbox-card').filter({ hasText: title }).getByRole('button', { name: '查看原文与详情' }).click();
    const old = page.getByRole('dialog', { name: '收件箱消息详情', exact: true });
    if (kind === 'personal') { await expect(old.getByRole('button', { name: '转为待办', exact: true })).toBeVisible(); await expect(old.getByLabel('归入项目', { exact: true })).toBeVisible(); }
    await old.getByRole('button', { name: '处理与建议', exact: true }).click();
    await expect(old).toHaveCount(0); await expect(drawer(page)).toContainText(`${kind}/${id}`);
    assert.ok(calls.some(c => c.path === `/inbox-handling/${kind}/${id}`));
    await close(page);
  }
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
}));

test('建议保存结果未知锁定请求，关闭再开不重放；建议执行后禁用现有编辑器', { timeout: 30000 }, async () => fixture(async ({ page, calls, setHandler }) => {
  let data = view({ suggestions: [suggestion()] });
  setHandler(c => c.method === 'GET' ? { data } : { abort: true });
  await open(page); await page.getByRole('button', { name: '编辑建议', exact: true }).click();
  await page.getByLabel('待办备注', { exact: true }).fill('保留未知结果草稿');
  await page.getByRole('button', { name: '保存建议（不执行）' }).click(); await expect(drawer(page)).toContainText('写入结果未知');
  await expect(page.getByLabel('待办备注', { exact: true })).toHaveValue('保留未知结果草稿');
  await expect(page.getByRole('button', { name: '保存建议（不执行）' })).toBeDisabled();
  await emit(page); await expect(page.getByRole('button', { name: '编辑建议', exact: true })).toBeDisabled();
  await close(page); await open(page); await expect(page.getByRole('button', { name: '编辑建议', exact: true })).toBeDisabled();
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  await close(page); await page.evaluate(() => (window as any).handling.api.setToken('fresh-isolated-token'));
  await open(page); await page.getByRole('button', { name: '编辑建议', exact: true }).click();
  await page.getByLabel('待办备注', { exact: true }).fill('运行前草稿');
  data = view({ suggestions: [suggestion({ status: 'executing' })] }); await emit(page);
  await expect(page.getByLabel('待办备注', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('待办备注', { exact: true })).toHaveValue('运行前草稿');
  await expect(page.getByRole('button', { name: '保存建议（不执行）' })).toBeDisabled();
}));


test('处理指令可在本来源回取，改绑后关闭搜索且不能读取旧会话', async () => fixture(async ({ page, calls, setHandler }) => {
  await page.evaluate(() => {
    const { api, store } = (window as any).handling;
    store.view.snapshotOwner = api.draftOwner();
    store.view.snapshot.plugins = [{ id: 'conversation-drafts', status: 'active' }];
  });
  let conversationId = 'first';
  setHandler(c => c.method === 'GET' ? { data: view({ conversationId }) } :
    { status: 202, data: { id: 'receipt', key: c.body.key, conversationId, status: 'pending' } });
  await open(page);
  const input = page.getByLabel('处理指令', { exact: true });
  await input.fill('先整理交付要求');
  await page.getByRole('button', { name: '发送处理指令' }).click();
  await expect(input).toHaveValue('');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('先整理交付要求');
  await input.press('ArrowDown');
  await input.press('Control+r');
  const search = page.getByRole('dialog', { name: '已发送内容' });
  await expect(search.getByRole('option', { name: '先整理交付要求' })).toBeVisible();
  conversationId = 'second';
  await emit(page);
  await expect(search).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送处理指令' })).toBeEnabled();
  await input.press('ArrowUp');
  await expect(input).toHaveValue('');
  await input.press('Control+r');
  await expect(search).toContainText('没有匹配的已发送内容');
  await search.getByLabel('搜索已发送内容').press('Escape');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
}));

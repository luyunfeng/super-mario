import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect, type Browser } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('顶部搜索可保存、套用和管理检索，关闭插件后收回入口与 API', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-saved-searches-'));
  const token = 'saved-search-fixture';
  const server = await startServer({ dataDir, port: 0, host: '127.0.0.1', demo: true, token });
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const api = (path: string, body?: unknown) => fetch(server.url + '/api/v1' + path, {
    headers, method: body === undefined ? 'GET' : 'POST', body: JSON.stringify(body),
  });
  let browser: Browser | undefined;
  try {
    const project = await api('/projects', { name: '季度复核项目' });
    assert.ok(project.ok);
    const projectId = (await project.json()).id;
    const now = new Date().toISOString();
    server.app.store.put('runs', 'synthetic-report', {
      id: 'synthetic-report', conversationId: 'main', executorId: 'fixture', projectId,
      status: 'completed', prompt: '生成账单', doneWhen: '逐行核对留存签收单', output: '月报准备就绪', createdAt: now, updatedAt: now,
    });
    for (let i = 0; i < 26; i++) {
      const id = 'search-run-' + i;
      server.app.store.put('runs', id, { id, projectId, conversationId: 'main', executorId: 'fixture', status: 'completed',
        prompt: i === 0 ? '复核凭证明细' : '核对合成事项 ' + i, output: '已核对复核凭证', createdAt: now, updatedAt: now });
    }
    const archived = await server.app.createProject({ name: '归档测试' });
    server.app.projects.archive(archived.id);
    const keyword = '合成[定位]';
    const putMessage = (id: string, conversationId: string, text: string, scope = projectId) =>
      server.app.store.put('messages', id, { id, projectId: scope, conversationId, role: 'user', text, createdAt: now, status: 'done' });
    const work = 'project:' + projectId + ':work';
    putMessage('historic', work, '季度复核旧记录 ' + keyword);
    for (let i = 0; i < 75; i++) putMessage('later-' + i, work, '后续记录 ' + i);
    putMessage('archived', 'project:' + archived.id + ':work', keyword, archived.id);
    putMessage('wrong-scope', work, keyword, archived.id);
    putMessage('bot-private', 'bot:fixture', keyword);
    const historical = await (await api('/project-message-search', { query: keyword })).json();
    const citation = historical.hits[0].webCitation;
    server.app.store.put('messages', 'historical-answer', { id: 'historical-answer', conversationId: 'main', role: 'assistant',
      text: '依据见' + citation + '。另见[查看原文](https://example.invalid)。', createdAt: now, status: 'done' });
    const listRuns = server.app.contributions.list('tools').find(item => item.value.name === 'runs_list')!.value;
    server.app.store.put('runs', 'personal-review', { id: 'personal-review', conversationId: 'main', executorId: 'fixture',
      status: 'completed', prompt: '独立核验', output: '', createdAt: now, updatedAt: now });
    const [personal] = await listRuns.execute({ id: 'personal-review' }, new AbortController().signal) as {webCitation: string}[];
    const [run] = await listRuns.execute({ id: 'synthetic-report' }, new AbortController().signal) as {webCitation: string}[];
    server.app.store.put('messages', 'run-answer', { id: 'run-answer', conversationId: 'main', role: 'assistant',
      text: run.webCitation + ' ' + personal.webCitation + ' [查看执行](https://example.invalid)', createdAt: now, status: 'done' });
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    await page.goto(server.url + '/#chat?token=' + token);

    const search = page.locator('#workspace-search');
    const results = page.locator('#search-results');
    const drawer = page.getByRole('dialog', { name: '保存的检索', exact: true });
    const button = (name: string) => drawer.getByRole('button', { name, exact: true });
    const manage = results.getByRole('button', { name: '管理保存的检索', exact: true });
    const saveQuery = results.getByRole('button', { name: '保存当前检索', exact: true });
    await expect(search).toHaveAccessibleName(/搜索对话/);
    const runLink = page.getByRole('link', { name: '查看执行', exact: true });
    await expect(runLink).toHaveCount(2);
    await runLink.last().click();
    await expect(page.getByRole('heading', { name: '独立核验', exact: true })).toBeVisible();
    await page.goBack();
    await runLink.first().click();
    await expect(page.getByRole('heading', { name: '生成账单', exact: true })).toBeVisible();
    await page.goBack();
    const sourceLink = page.getByRole('link', { name: '查看原文', exact: true });
    await expect(sourceLink).toHaveCount(1);
    await sourceLink.click();
    const cited = page.locator('#panel-workspace .msg.is-search-hit');
    await expect(cited).toBeFocused();
    await expect(cited).toContainText(keyword);
    const changed = page.getByText('原消息在引用后已修改，当前显示最新正文。');
    await expect(changed).toBeHidden();
    putMessage('historic', work, '季度复核旧记录 ' + keyword + ' 已调整期限');
    server.app.events.publish('messages.changed', { conversationId: work, messageId: 'historic' });
    await expect(changed).toBeVisible();
    await expect(cited).toContainText('已调整期限');
    await page.reload();
    await expect(changed).toBeVisible();
    await page.goBack();
    await expect(sourceLink).toBeVisible();
    await search.fill('签收单');
    await expect(results.getByRole('link', { name: '生成账单 · 验收标准 · 逐行核对留存签收单' })).toBeVisible();
    await search.fill('最近七天 复核凭证');
    const runHits = results.getByRole('link');
    await expect(runHits.first()).toHaveText('复核凭证明细');
    await results.getByRole('button', { name: '查看全部匹配执行' }).click();
    const runResults = page.getByRole('dialog', { name: '执行记录搜索结果' });
    await expect(runResults.getByRole('link')).toHaveCount(25);
    await runResults.getByRole('button', { name: '查看更多执行记录' }).click();
    await expect(runResults.getByRole('link')).toHaveCount(26);
    await runResults.getByRole('link', { name: '核对合成事项 25 · 输出 · 已核对复核凭证' }).click();
    await expect(page).toHaveURL(/\/runs\/search-run-25$/);
    await expect(page.getByRole('heading', { name: '核对合成事项 25' })).toBeVisible();
    let finishSearch!: () => void;
    const pendingSearch = new Promise<void>(resolve => { finishSearch = resolve; });
    await page.route('**/api/v1/project-message-search', async route => {
      await pendingSearch;
      await route.continue();
    }, { times: 1 });
    await search.fill('季度复核');
    const projectLink = results.getByRole('link', { name: '季度复核项目', exact: true });
    await search.press('ArrowUp');
    await expect(projectLink).toBeFocused();
    await page.keyboard.press('c');
    await expect(page.locator('#quick-todo')).not.toBeVisible();
    finishSearch();
    const workLink = results.getByRole('link', { name: /季度复核旧记录/ });
    await expect(workLink).toBeVisible();
    await expect(projectLink).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(workLink).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(projectLink).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(results).toBeHidden();
    await search.fill(keyword);
    const hit = results.getByRole('link', { name: /季度复核项目.*旧记录/ });
    await expect(hit).toBeVisible();
    assert.deepEqual((await (await api('/project-message-search', { query: keyword })).json()).hits.map((h: { id: string }) => h.id), ['historic']);
    await search.press('ArrowDown');
    await expect(hit).toBeFocused();
    await page.keyboard.press('Enter');
    const original = page.locator('#panel-workspace .msg.is-search-hit');
    await expect(original).toBeFocused();
    await expect(original).toContainText(keyword);
    await expect(changed).toBeHidden();
    await page.reload();
    await expect(original).toBeFocused();
    await page.getByRole('link', { name: '返回最新消息' }).click();
    await expect(page.locator('#panel-workspace .msg').last()).toContainText('后续记录 74');
    await expect(original).toHaveCount(0);
    const log = page.locator('#panel-workspace .msg');
    const composer = page.getByLabel('项目目标');
    await composer.fill('翻页期间的合成草稿');
    await page.getByRole('link', { name: '较早消息' }).click();
    await expect(log).toHaveCount(16);
    await expect(log.first()).toContainText('旧记录');
    await expect(log.last()).toContainText('后续记录 14');
    await page.reload();
    await expect(log).toHaveCount(16);
    await expect(composer).toHaveValue('翻页期间的合成草稿');
    putMessage('new-arrival', work, '翻页期间到达');
    await page.getByRole('link', { name: '较新消息' }).click();
    await expect(log).toHaveCount(60);
    await expect(log.first()).toContainText('后续记录 15');
    await expect(log.last()).toContainText('后续记录 74');
    await page.getByRole('link', { name: '较新消息' }).click();
    await expect(log).toHaveCount(1);
    await expect(log.first()).toContainText('翻页期间到达');
    await page.goBack();
    await expect(log.first()).toContainText('后续记录 15');
    const workspacePath = '/projects/' + projectId + '/workspace';
    assert.equal((await api(workspacePath + '?before=bot-private')).status, 404);
    assert.equal((await api(workspacePath + '?before=historic&after=historic')).status, 400);
    await expect(composer).toHaveValue('翻页期间的合成草稿');

    // A saved pagination URL can outlive its boundary message. The draft belongs to the project.
    putMessage('removed-boundary', work, '临时翻页位置');
    const oldPage = server.url + '/#projects/' + projectId + '/workspace?before=removed-boundary';
    await page.goto(oldPage);
    await expect(log.last()).toContainText('翻页期间到达');
    server.app.store.remove('messages', 'removed-boundary');
    await page.reload();
    const projectLog = page.getByRole('log', { name: '项目对话' });
    const readNotice = page.locator('#panel-workspace').getByRole('status').filter({ hasText: '重试读取对话' });
    await expect(readNotice).toContainText('当前项目中找不到翻页位置');
    await expect(projectLog).not.toContainText('正在读取');
    await expect(composer).toHaveValue('翻页期间的合成草稿');
    await page.getByRole('link', { name: '返回最新消息' }).click();
    await expect(log.last()).toContainText('翻页期间到达');
    const workspaceUrl = '**/api/v1' + workspacePath;
    await page.route(workspaceUrl, route => route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: '刷新稍后再试' }) }));
    server.app.events.publish('messages.changed', { conversationId: work, messageId: 'new-arrival' });
    await expect(readNotice).toContainText('当前显示上次读取的记录');
    await expect(log.last()).toContainText('翻页期间到达');
    await page.unroute(workspaceUrl);
    await readNotice.getByRole('button', { name: '重试读取对话' }).click();
    await expect(readNotice).toBeHidden();
    // Recovery uses the same page and only repeats a read.
    await page.route('**/workspace?after=new-arrival', route => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: '历史存储暂不可用' }),
    }));
    await page.goto(server.url + '/#projects/' + projectId + '/workspace?after=new-arrival');
    await expect(readNotice).toContainText('历史存储暂不可用');
    await page.unroute('**/workspace?after=new-arrival');
    await readNotice.getByRole('button', { name: '重试读取对话' }).click();
    await expect(projectLog).toContainText('这个位置没有更多消息');
    await expect(composer).toHaveValue('翻页期间的合成草稿');

    await search.fill('后续记录');
    await results.getByRole('button', { name: '查看全部匹配消息' }).click();
    const messageDrawer = page.getByRole('dialog', { name: '消息搜索结果' });
    const dateFilter = messageDrawer.getByLabel(/发言日期/);
    await dateFilter.fill('2019-07-01');
    await expect(messageDrawer.getByRole('status')).toHaveText('已显示 0 条消息');
    await dateFilter.fill('');
    await expect(messageDrawer.getByRole('link')).toHaveCount(25);
    const roleFilter = messageDrawer.getByLabel('发言角色');
    await page.route('**/api/v1/project-message-search', async route => {
      if (route.request().postDataJSON().role !== 'assistant') return route.fallback();
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '读取角色筛选失败' }) });
    });
    await roleFilter.selectOption('assistant');
    await expect(messageDrawer.getByRole('status')).toContainText('读取角色筛选失败');
    await page.unroute('**/api/v1/project-message-search');
    await messageDrawer.getByRole('button', { name: '重试', exact: true }).click();
    await expect(messageDrawer.getByRole('status')).toHaveText('已显示 0 条消息');
    await roleFilter.selectOption('user');
    const moreMessages = messageDrawer.getByRole('button', { name: '查看更多消息' });
    await expect(messageDrawer.getByRole('link')).toHaveCount(25);
    putMessage('concurrent-hit', work, '后续记录 新增');
    await moreMessages.click();
    await expect(messageDrawer.getByRole('link')).toHaveCount(50);
    await moreMessages.click();
    await expect(messageDrawer.getByRole('link')).toHaveCount(75);
    await expect(moreMessages).toBeHidden();
    await messageDrawer.getByRole('link', { name: /后续记录 0$/ }).click();
    await expect(original).toBeFocused();
    await expect(original).toContainText('后续记录 0');

    await search.fill('账单 status:working updated:24h');
    const filtersButton = results.getByRole('button', { name: '筛选执行记录' });
    const filters = page.getByRole('dialog', { name: '筛选执行记录' });
    await filtersButton.click();
    await expect(filters.getByLabel('执行中')).toBeChecked();
    await expect(filters.getByLabel('更新时间')).toHaveValue('24h');
    await filters.getByLabel('执行中').uncheck();
    await filters.getByLabel('已结束').check();
    await filters.getByLabel('季度复核项目').check();
    await filters.getByLabel('更新时间').selectOption('7d');
    await expect(filters.getByRole('status')).toHaveText('匹配 1 条执行记录');
    server.app.store.put('runs', 'arrived-report', { id: 'arrived-report', projectId, conversationId: 'main', executorId: 'fixture',
      prompt: '新增账单核验', status: 'completed', output: '', createdAt: now, updatedAt: now });
    server.app.events.publish('runs.changed', { id: 'arrived-report' });
    await expect(filters.getByRole('status')).toHaveText('匹配 2 条执行记录');
    await filters.getByRole('button', { name: '应用筛选' }).click();
    const builtQuery = '账单 state:completed project:=' + projectId + ' since:7d';
    await expect(search).toHaveValue(builtQuery);
    await expect(results.getByRole('link', { name: '生成账单' })).toBeVisible();
    await filtersButton.click();
    await filters.getByLabel('已结束').uncheck();
    await filters.getByRole('button', { name: '关闭' }).click();
    await expect(search).toHaveValue(builtQuery);
    await search.focus();
    await saveQuery.click();
    await expect(drawer.getByLabel('检索词', { exact: true })).toHaveValue(builtQuery);
    await drawer.getByLabel('名称', { exact: true }).fill('本季复核');
    await button('保存').click();
    await expect(button('套用 本季复核')).toBeVisible();

    await page.reload();
    await expect(search).toHaveAccessibleName(/搜索对话/);
    await search.click();
    await manage.click();
    await button('套用 本季复核').click();
    await expect(search).toHaveValue(builtQuery);
    await expect(results.getByRole('link', { name: '生成账单' })).toBeVisible();

    await search.fill(builtQuery + ' status:working HTTP:503');
    await filtersButton.click();
    await expect(filters.getByRole('status')).toHaveText('匹配 0 条执行记录');
    await filters.getByRole('button', { name: '清除执行状态条件' }).click();
    await expect(filters.getByLabel('已结束')).not.toBeChecked();
    await expect(filters.getByLabel('执行中')).not.toBeChecked();
    await expect(filters.getByLabel('季度复核项目')).toBeChecked();
    await expect(filters.getByLabel('更新时间')).toHaveValue('7d');
    await filters.getByRole('button', { name: '应用筛选' }).click();
    await expect(search).toHaveValue('账单 project:=' + projectId + ' since:7d HTTP:503');
    await filtersButton.click();
    await filters.getByRole('button', { name: '清除全部条件' }).click();
    await expect(filters.getByLabel('更新时间')).toHaveValue('');
    await expect(filters.getByRole('button', { name: '清除全部条件' })).toBeDisabled();
    await filters.getByRole('button', { name: '应用筛选' }).click();
    await expect(search).toHaveValue('账单 HTTP:503');
    await manage.click();
    await button('编辑 本季复核').click();
    await drawer.getByLabel('名称', { exact: true }).fill('复核项目');
    await drawer.getByLabel('检索词', { exact: true }).fill('project:季度复核 state:completed since:7d');
    await button('保存').click();
    await expect(button('套用 复核项目')).toBeVisible();
    await button('新增检索').click();
    await drawer.getByLabel('名称', { exact: true }).fill('下季计划');
    await drawer.getByLabel('检索词', { exact: true }).fill('计划');
    await button('保存').click();

    const saved = drawer.getByRole('button', { name: /^套用 / });
    await expect(saved).toHaveCount(2);
    const list = async () => {
      const response = await api('/saved-searches');
      assert.equal(response.status, 200);
      const state: { searches: { name: string; query: string }[] } = await response.json();
      return state.searches;
    };
    const entries = await list();
    assert.equal(entries.find(entry => entry.name === '复核项目')?.query, 'project:季度复核 state:completed since:7d');
    const before = entries.map(entry => '套用 ' + entry.name);
    await button('下移 ' + entries[0]!.name).click();
    await expect(saved.first()).toHaveAccessibleName(before[1]!);
    await expect(saved.last()).toHaveAccessibleName(before[0]!);

    await button('删除 复核项目').click();
    await expect(button('套用 复核项目')).toHaveCount(0);
    await button('撤销删除').click();
    await expect(saved.first()).toHaveAccessibleName(before[1]!);
    await expect(saved.last()).toHaveAccessibleName(before[0]!);

    await button('套用 复核项目').click();
    await expect(results.getByRole('link', { name: '生成账单' })).toBeVisible();
    await manage.click();
    await expect(button('套用 复核项目')).toBeVisible();

    await button('编辑 复核项目').click();
    const current = await (await api('/saved-searches')).json();
    assert.ok((await api('/saved-searches', {
      action: 'add', revision: current.revision, name: '另一窗口的检索', query: '机器',
    })).ok);
    await drawer.getByLabel('名称', { exact: true }).fill('保留的草稿');
    await button('保存').click();
    await expect(button('刷新列表')).toBeVisible();
    await button('刷新列表').click();
    await expect(drawer.getByLabel('名称', { exact: true })).toHaveValue('保留的草稿');
    await button('保存').click();
    await expect(button('套用 保留的草稿')).toBeVisible();
    await expect(button('套用 另一窗口的检索')).toBeVisible();

    assert.ok((await api('/plugins/conversation-search', { enabled: false })).ok);
    assert.equal((await api('/project-message-search', { query: keyword })).status, 503);
    await expect(drawer).toBeHidden();
    await search.fill('季度复核');
    await expect(results.getByRole('link', { name: '季度复核项目' })).toBeVisible();
    await expect(manage).toHaveCount(0);
    await expect(filtersButton).toHaveCount(0);
    await expect(saveQuery).toHaveCount(0);
    assert.equal((await api('/saved-searches')).status, 503);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('空搜索按保存顺序展示前五项，支持鼠标与键盘套用并在插件停用时清空', {timeout:30000}, async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-top-search-'));
  const token='synthetic-top-search';
  const server=await startServer({dataDir,token,port:0,host:'127.0.0.1',demo:true});
  t.after(async()=>{try{await server.close();}finally{await rm(dataDir,{recursive:true,force:true});}});
  const post=async(path:string,body:object)=>{
    const response=await fetch(server.url+'/api/v1'+path,{method:'POST',
      headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200);return response.json();
  };
  const projectNames=['合成文账甲','合成文账乙'];
  for(const name of projectNames) await server.app.createProject({name});
  const names=['固定甲','固定乙','固定丙','固定丁','固定戊','固定己'];
  let book:{revision:number;searches:{id:string;name:string}[]}={revision:0,searches:[]};
  for(const [i,name] of names.entries()) book=await post('/saved-searches',{
    action:'add',revision:book.revision,name,query:projectNames[i%2]});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#chat?token='+token);
  const search=page.locator('#workspace-search'),results=page.locator('#search-results');
  const quick=results.getByRole('button',{name:/^套用 /});
  await expect(search).toHaveAccessibleName(/搜索对话/);
  await search.click();
  await expect(quick.first()).toHaveAccessibleName('套用 固定甲');
  await post('/saved-searches',{action:'move',revision:book.revision,id:book.searches[5].id,beforeId:book.searches[0].id});
  const expected=['固定己','固定甲','固定乙','固定丙','固定丁'];
  await expect(quick).toHaveCount(5);
  for(const [i,name] of expected.entries()) await expect(quick.nth(i)).toHaveAccessibleName('套用 '+name);
  await expect(results.getByRole('button',{name:'套用 固定戊'})).toHaveCount(0);
  await quick.first().click();
  await expect(search).toHaveValue(projectNames[1]);
  await expect(results.getByRole('link',{name:projectNames[1],exact:true})).toBeVisible();
  await expect(quick).toHaveCount(0);
  await search.fill('');
  await expect(quick).toHaveCount(5);
  await search.press('ArrowDown');
  await expect(quick.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(quick.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(search).toHaveValue(projectNames[0]);
  await expect(results.getByRole('link',{name:projectNames[0],exact:true})).toBeVisible();
  await search.fill('');
  await expect(quick).toHaveCount(5);
  await post('/plugins/conversation-search',{enabled:false});
  await expect(quick).toHaveCount(0);
  await expect(results).toBeHidden();
});

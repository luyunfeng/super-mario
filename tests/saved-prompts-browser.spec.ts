import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

test('本人消息可保存为常用提示词，主对话和项目斜杠菜单只插入草稿，发送时保存编辑后的正文', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-saved-prompts-'));
  const cwd = join(dir, 'project');
  await mkdir(cwd);
  const token = 'saved-prompt-browser-fixture', machineId = 'fixture-prompts-node';
  const server = await startServer({ dataDir: join(dir, 'data'), host: '127.0.0.1', port: 0, demo: true, token });
  const projects = createProjectDiscovery({ home: dir, cwd, roots: [], temporaryRoots: [], ignoreEnvironmentRoots: true });
  const node = startAgentNode({ url: server.url, token, machineId, name: '合成项目电脑', dataDir: join(dir, 'node'),
    handlers: { 'workspace.directory': projects.handlers['workspace.directory'] }, executors: [] });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await node.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await expect.poll(() => server.machines.list().some(item => item.id === machineId && item.online)).toBe(true);
  const project = await server.app.createProject({ name: '合成提示词项目', workspace: { machineId, cwd } });
  const sourceText = '请总结本次讨论。';
  const template = '先列出进展。\n再列出待确认问题。';
  const userTexts = (conversation: string) => server.app.store.list<Message>('messages')
    .filter(m => m.conversationId === conversation && m.role === 'user').map(m => m.text);

  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const sent: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/v1\/(projects\/[^/]+\/)?messages$/.test(request.url())) {
      sent.push(request.postDataJSON().text);
    }
  });
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#chat?token=' + token);
  const main = page.getByLabel('给 Agent 的消息');
  await main.fill(sourceText);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const mine = page.locator('#messages .msg--user').filter({ hasText: sourceText });
  await mine.getByRole('button', { name: '保存为提示词', exact: true }).click();

  const drawer = page.getByRole('dialog', { name: '常用提示词', exact: true });
  const button = (name: string) => drawer.getByRole('button', { name, exact: true });
  const name = drawer.getByLabel('名称', { exact: true });
  const body = drawer.getByLabel('提示词正文', { exact: true });
  await expect(body).toHaveValue(sourceText);
  await name.fill('review');
  await button('保存').click();
  await button('编辑 review').click();
  const longDraft = '𠮷'.repeat(8000);
  await body.fill(longDraft + '甲');
  await expect(body).toHaveAccessibleDescription(/当前 8001 \/ 8000/);
  await body.press('Control+Enter');
  await expect(body).toHaveValue(longDraft + '甲');
  await expect(body).toHaveAttribute('aria-invalid', 'true');
  await body.fill(longDraft);
  await expect(body).toHaveAttribute('aria-invalid', 'false');
  await body.fill(template);
  await body.press('Control+Enter');
  await button('新增提示词').click();
  await name.fill('/REVIEW');
  await expect(name).toHaveAccessibleDescription('提示词名称已被使用。');
  await name.fill('weekly');
  await body.fill('列出本周计划。');
  await button('保存').click();

  const editButtons = drawer.getByRole('button', { name: /^编辑 / });
  await expect(editButtons).toHaveCount(2);
  await expect(editButtons.first()).toHaveAccessibleName('编辑 review');
  await button('下移 review').click();
  await expect(editButtons.first()).toHaveAccessibleName('编辑 weekly');
  await expect(editButtons.last()).toHaveAccessibleName('编辑 review');
  await button('关闭').click();
  await expect(page.locator('dialog.drawer')).toHaveCount(0);
  await expect(page.locator('#messages .msg--assistant').first()).toBeVisible();
  await expect(page.locator('#messages .msg--assistant').getByRole('button', { name: '保存为提示词' })).toHaveCount(0);

  await page.route('**/api/v1/saved-prompts', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法读取提示词' }),
  }), { times: 1 });
  await main.fill('/rev');
  const menu = page.getByRole('group', { name: '提示词候选' });
  await expect(menu.getByRole('alert')).toContainText('暂时无法读取提示词');
  await main.press('Enter');
  await expect(main).toHaveValue('/rev');
  await menu.getByRole('button', { name: '重新读取提示词' }).click();

  await expect(page.getByRole('button', { name: '/review', exact: true })).toBeVisible();
  await main.press('Enter');
  await expect(main).toHaveValue(template);
  assert.deepEqual(sent, [sourceText]);
  assert.deepEqual(userTexts('main'), [sourceText]);
  const mainFinal = template + '\n补充主对话结论。';
  await main.fill(mainFinal);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => userTexts('main')).toEqual([sourceText, mainFinal]);

  await page.goto(server.url + `/#projects/${project.id}/workspace`);
  const projectInput = page.getByLabel('项目目标');
  await projectInput.fill('/rev');
  await page.getByRole('button', { name: '/review', exact: true }).click();
  await expect(projectInput).toHaveValue(template);
  const projectConversation = `project:${project.id}:work`;
  assert.deepEqual(sent, [sourceText, mainFinal]);
  assert.deepEqual(userTexts(projectConversation), []);
  const projectFinal = template + '\n只处理合成项目。';
  await projectInput.fill(projectFinal);
  await page.getByRole('button', { name: '发送目标', exact: true }).click();
  await expect.poll(() => userTexts(projectConversation)).toEqual([projectFinal]);
  assert.deepEqual(sent, [sourceText, mainFinal, projectFinal]);

  await expect(projectInput).toHaveValue('');
  await page.reload();
  await expect(projectInput).toBeEnabled();
  await projectInput.press('ArrowUp');
  await expect(projectInput).toHaveValue(projectFinal);
  await projectInput.press('ArrowDown');
  await expect(projectInput).toHaveValue('');
  await projectInput.fill('正在编辑的草稿');
  await projectInput.press('ArrowUp');
  await expect(projectInput).toHaveValue('正在编辑的草稿');
  await projectInput.press('Control+r');
  const search = page.getByRole('dialog', { name: '已发送内容' });
  await search.getByLabel('搜索已发送内容').fill('补充 进展');
  await expect(search.getByRole('button', { name: /补充主对话结论/ })).toBeVisible();
  await search.getByLabel('搜索已发送内容').press('Escape');
  await expect(projectInput).toHaveValue('正在编辑的草稿');
  await projectInput.press('Control+r');
  await search.getByLabel('搜索已发送内容').fill('补充 进展');
  await search.getByLabel('搜索已发送内容').press('Enter');
  await expect(projectInput).toHaveValue(mainFinal);
  assert.deepEqual(sent, [sourceText, mainFinal, projectFinal]);

  await page.getByRole('button', { name: '常用提示词', exact: true }).click();
  await expect(editButtons.first()).toHaveAccessibleName('编辑 weekly');
  await expect(editButtons.last()).toHaveAccessibleName('编辑 review');
  await button('删除 weekly').click();
  await button('取消 weekly').click();
  await expect(editButtons).toHaveCount(2);
  await button('删除 weekly').click();
  await button('确认删除 weekly').click();
  await expect(editButtons).toHaveCount(1);
  await expect(editButtons).toHaveAccessibleName('编辑 review');
  await button('关闭').click();
  await expect(page.locator('dialog.drawer')).toHaveCount(0);
  await projectInput.fill('/rev');
  const suggestion = page.getByRole('button', { name: '/review', exact: true });
  await expect(suggestion).toBeVisible();
  const disabled = await page.request.post(server.url + '/api/v1/plugins/saved-prompts', {
    headers: { Authorization: 'Bearer ' + token }, data: { enabled: false },
  });
  assert.ok(disabled.ok());
  await expect(suggestion).toHaveCount(0);
  await expect(page.getByRole('button', { name: '常用提示词', exact: true })).toHaveCount(0);
  await expect(projectInput).toHaveValue('/rev');
  assert.deepEqual(sent, [sourceText, mainFinal, projectFinal]);
});

test('插件设置可管理提示词；并发编辑保留草稿，已打开的斜杠菜单收到其他客户端的更新', { timeout: 30000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mario-saved-prompts-conflict-'));
  const token = 'prompt-conflict-fixture';
  const server = await startServer({ dataDir, host: '127.0.0.1', port: 0, demo: true, token });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const first = await browser.newPage(), second = await browser.newPage();
  for (const page of [first, second]) {
    await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    await page.goto(server.url + '/#chat?token=' + token);
  }
  await first.getByRole('button', { name: '插件配置', exact: true }).click();
  const settings = first.getByRole('dialog', { name: '插件配置' });
  await settings.getByLabel('搜索插件').fill('saved-prompts');
  await settings.getByRole('button', { name: '管理常用提示词', exact: true }).click();
  const left = first.getByRole('dialog', { name: '常用提示词', exact: true });
  const right = second.getByRole('dialog', { name: '常用提示词', exact: true });
  const leftBody = left.getByLabel('提示词正文');
  await left.getByRole('button', { name: '新增提示词' }).click();
  await left.getByLabel('名称', { exact: true }).fill('draft');
  await leftBody.fill('初稿。');
  await left.getByRole('button', { name: '保存', exact: true }).click();
  await left.getByRole('button', { name: '编辑 draft' }).click();
  await leftBody.fill('第一窗口的未保存草稿。');

  await second.getByRole('button', { name: '常用提示词', exact: true }).click();
  await right.getByRole('button', { name: '编辑 draft' }).click();
  const rightBody = right.getByLabel('提示词正文');
  await rightBody.fill('第二窗口提交的版本。');
  await right.getByRole('button', { name: '保存', exact: true }).click();
  await expect(right).toContainText('第二窗口提交的版本。');
  await expect(left.getByRole('button', { name: '刷新列表' })).toBeVisible();
  await expect(leftBody).toHaveValue('第一窗口的未保存草稿。');

  const conflict = first.waitForResponse(r => r.url().endsWith('/api/v1/saved-prompts') && r.request().postDataJSON()?.action === 'update');
  await left.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal((await conflict).status(), 409);
  await expect(left.getByRole('alert')).toContainText('已更新');
  await expect(leftBody).toHaveValue('第一窗口的未保存草稿。');
  await left.getByRole('button', { name: '刷新列表' }).click();
  await expect(left.getByRole('region', { name: '当前保存的版本' })).toContainText('第二窗口提交的版本。');
  await expect(leftBody).toHaveValue('第一窗口的未保存草稿。');
  await left.getByRole('button', { name: '取消', exact: true }).click();
  await expect(left).toContainText('第二窗口提交的版本。');
  await left.getByRole('button', { name: '删除 draft', exact: true }).click();
  await expect(left.getByRole('button', { name: '确认删除 draft' })).toBeVisible();
  await right.getByRole('button', { name: '编辑 draft' }).click();
  await rightBody.fill('删除确认期间由第二窗口更新。');
  await right.getByRole('button', { name: '保存', exact: true }).click();
  await expect(left).toContainText('删除确认期间由第二窗口更新。');
  await expect(left.getByRole('button', { name: '确认删除 draft' })).toHaveCount(0);
  await left.getByRole('button', { name: '关闭', exact: true }).click();
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(first.locator('dialog.drawer')).toHaveCount(0);

  const input = first.getByLabel('给 Agent 的消息');
  await input.fill('/');
  const oldItem = first.getByRole('button', { name: '/draft', exact: true });
  await expect(oldItem).toBeVisible();
  await right.getByRole('button', { name: '编辑 draft' }).click();
  await right.getByLabel('名称', { exact: true }).fill('release');
  await rightBody.fill('改名后的提示词正文。');
  await right.getByRole('button', { name: '保存', exact: true }).click();
  const updatedItem = first.getByRole('button', { name: '/release', exact: true });
  await expect(updatedItem).toBeVisible();
  await expect(oldItem).toHaveCount(0);
  await expect(input).toHaveValue('/');
  await updatedItem.click();
  await expect(input).toHaveValue('改名后的提示词正文。');

  // A later exact match must still be found beyond the bare slash menu's display limit.
  const manage = (data: Record<string, unknown>) => first.request.post(server.url + '/api/v1/saved-prompts', {
    headers: { authorization: 'Bearer ' + token }, data,
  });
  const list = await manage({ action: 'list' });
  let { revision } = await list.json();
  const names = ['xplan', 'plan-beta', 'plan-alpha', ...Array.from({ length: 24 }, (_, i) => 'item-' + i), 'plan'];
  for (const name of names) {
    const response = await manage({ action: 'create', revision, name, text: '正文 ' + name });
    assert.equal(response.status(), 200);
    revision = (await response.json()).revision;
  }
  await input.fill('/');
  const rows = first.getByRole('group', { name: '提示词候选' }).getByRole('button');
  await expect(rows).toHaveCount(25);
  await input.fill('/PLAN');
  await expect(rows).toHaveText(['/plan', '/plan-beta', '/plan-alpha', '/xplan']);
  await input.press('ArrowDown');
  await input.press('Tab');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('正文 plan-beta');
});

test('归档独立对话中的本人发言可保存为提示词，斜杠选取只填写当前独立对话的草稿', {timeout:40000}, async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'web-thread-prompts-')),token='synthetic-thread-prompts';
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,demo:true,token});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  const page=await browser.newPage(),headers={Authorization:'Bearer '+token};
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const path=server.url+'/api/v1/web-conversations',archive=randomUUID(),active=randomUUID();
  for(const [id,title] of [[archive,'提供原话的对话'],[active,'使用提示词的对话']]){
    assert.equal((await page.request.post(path,{headers,data:{id,title}})).status(),201);
  }
  const url=(id:string)=>server.url+'/#chat?thread='+id;
  const input=page.getByLabel('给独立对话发消息'),region=page.getByLabel('独立对话内容');
  await page.goto(url(archive)+'&token='+token);
  const template='请先列出**原始证据**。\n再写出尚待核实的问题。';
  await input.fill(template);await input.press('Enter');await expect(input).toHaveValue('');
  const source=region.locator('.msg--user').filter({hasText:'原始证据'});
  await expect(region.locator('.msg--assistant').first()).toBeVisible();
  const meta=await (await page.request.get(path+'/'+archive,{headers})).json();
  assert.equal((await page.request.patch(path+'/'+archive,{headers,data:{version:meta.version,archived:true}})).status(),200);
  await expect(input).toBeHidden();
  const save=source.getByRole('button',{name:'保存为提示词',exact:true});
  await expect(region.locator('.msg--assistant').getByRole('button',{name:'保存为提示词'})).toHaveCount(0);
  await save.click();
  const drawer=page.getByRole('dialog',{name:'常用提示词',exact:true});
  await expect(drawer.getByLabel('提示词正文')).toHaveValue(template);
  await drawer.getByLabel('名称',{exact:true}).fill('verify');
  await drawer.getByRole('button',{name:'保存',exact:true}).click();
  await expect(drawer.getByRole('button',{name:'编辑 verify'})).toBeVisible();
  await drawer.getByRole('button',{name:'关闭',exact:true}).click();
  const posts:string[]=[];
  page.on('request',req=>{if(req.method()==='POST' && new URL(req.url()).pathname.endsWith('/messages'))posts.push(req.url());});
  await page.goto(url(active));await input.fill('/');
  const suggestion=region.getByRole('button',{name:'/verify',exact:true});
  await expect(suggestion).toBeVisible();await input.press('Enter');await expect(input).toHaveValue(template);
  await page.goto(url(archive));await expect(input).toBeHidden();
  await page.goto(url(active));await expect(input).toHaveValue(template);
  assert.deepEqual(posts,[]);
  assert.deepEqual((await (await page.request.get(path+'/'+active+'/messages',{headers})).json()).messages,[]);
  await input.fill('/ver');await expect(suggestion).toBeVisible();
  assert.equal((await page.request.post(server.url+'/api/v1/plugins/saved-prompts',{headers,data:{enabled:false}})).status(),200);
  await expect(suggestion).toBeHidden();await expect(input).toHaveValue('/ver');
  await expect(region.getByRole('button',{name:'常用提示词',exact:true})).toBeHidden();
  await page.goto(url(archive));await expect(source).toBeVisible();await expect(save).toBeHidden();
});

test('自定义助理按名单管理提示词，消息可保存，斜杠菜单仅跟随本助理的更新', {timeout:35000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-roster-prompts-')),token='synthetic-roster-prompts';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,token,demo:true});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});});
  const page=await browser.newPage();
  const post=async(path:string,body:Record<string,unknown>)=>{
    const response=await page.request.post(server.url+'/api/v1/'+path,{headers:{authorization:'Bearer '+token},data:body});
    assert.ok(response.ok(),String(response.status()));return response.json();
  };
  const [a,b]=[randomUUID(),randomUUID()];
  for(const [id,name] of [[a,'审阅'],[b,'整理']])await post('assistant-roster',{action:'create',id,name,instructions:''});
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#chat?token='+token);
  const roster=page.getByRole('dialog',{name:'切换助理'}),drawer=page.getByRole('dialog',{name:'常用提示词',exact:true});
  const switcher=page.getByRole('button',{name:'切换助理',exact:true});
  await switcher.click();
  await roster.getByRole('button',{name:'管理 审阅 的常用提示词'}).click();
  await drawer.getByRole('button',{name:'新增提示词'}).click();
  await drawer.getByLabel('名称',{exact:true}).fill('first');
  await drawer.getByLabel('提示词正文').fill('审阅草稿。');
  await drawer.getByRole('button',{name:'保存',exact:true}).click();
  await expect(drawer.getByText('/first',{exact:true})).toBeVisible();
  await drawer.getByRole('button',{name:'关闭'}).click();
  await roster.getByRole('button',{name:'审阅',exact:true}).click();
  const input=page.getByRole('textbox',{name:'给独立对话发消息'});
  const thread=page.getByLabel('独立对话内容');
  const menu=thread.getByRole('group',{name:'提示词候选'});
  await input.fill('/');
  await expect(menu.getByRole('button',{name:'/first'})).toBeVisible();
  await menu.getByRole('button',{name:'/first'}).click();
  await expect(input).toHaveValue('审阅草稿。');
  await input.fill('/');
  await expect(menu.getByRole('button',{name:'/first'})).toBeVisible();
  let lists=0;
  page.on('request',req=>{if(req.url().endsWith('saved-prompts?assistantId='+a) && req.postDataJSON()?.action==='list')lists++;});
  await post('saved-prompts?assistantId='+b,{action:'create',revision:0,name:'first',text:'另一份草稿'});
  await post('saved-prompts?assistantId='+a,{action:'create',revision:1,name:'second',text:'新增审阅项。'});
  await expect(menu.getByRole('button',{name:'/second'})).toBeVisible();
  assert.equal(lists,1);
  await menu.getByRole('button',{name:'/second'}).click();await expect(input).toHaveValue('新增审阅项。');
  await input.fill('将合成检查说明留作模板');await input.press('Enter');
  await thread.getByRole('button',{name:'保存为提示词'}).click();
  await expect(drawer.getByLabel('提示词正文')).toHaveValue('将合成检查说明留作模板');
  await drawer.getByLabel('名称',{exact:true}).fill('from-message');
  await drawer.getByRole('button',{name:'保存',exact:true}).click();
  await expect(drawer.getByText('/from-message',{exact:true})).toBeVisible();
  await drawer.getByRole('button',{name:'关闭'}).click();
  await switcher.click();await roster.getByRole('button',{name:'整理',exact:true}).click();
  await expect(thread.getByRole('heading',{name:'整理',exact:true})).toBeVisible();
  await input.fill('/');
  await expect(menu.getByRole('button',{name:'/first'})).toBeVisible();
  await expect(menu.getByRole('button',{name:'/from-message'})).toHaveCount(0);
  await menu.getByRole('button',{name:'/first'}).click();
  await expect(input).toHaveValue('另一份草稿');
  assert.deepEqual((await post('saved-prompts',{action:'list'})).items,[]);
});

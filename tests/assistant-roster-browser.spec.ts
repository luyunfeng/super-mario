import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('Web 切换助理按项目恢复独立历史与草稿，主对话仍保留原稿', {timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'assistant-switch-')),token='synthetic-assistant-switch';
  const server=await startServer({dataDir:dir,port:0,host:'127.0.0.1',demo:true,token});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});});
  const project=server.app.projects.create({name:'切换测试项目'});
  const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#chat?token='+token);
  const main=page.locator('#message-text'),thread=page.getByLabel('给独立对话发消息');
  const scope=page.locator('#message-form').getByLabel('项目范围');
  await scope.selectOption(project.id);await main.fill('项目主线未发草稿');
  const open=()=>page.getByRole('button',{name:'切换助理',exact:true}).click();
  const list=page.getByRole('dialog',{name:'切换助理'});
  await open();await list.getByText('新建助理',{exact:true}).click();
  await list.getByLabel('助理名称').fill('审阅助理');await list.getByLabel('助理指令').fill('先列出需要核实的事实。');
  const firstOpen=page.waitForRequest(r=>r.url().endsWith('/assistant-roster') && r.postDataJSON()?.action==='open');
  await list.getByRole('button',{name:'创建并打开助理'}).click();
  assert.equal((await firstOpen).postDataJSON().projectId,project.id);
  await expect(thread).toBeVisible();const projectThread=page.url();
  await thread.fill('项目线的合成记录');await thread.press('Enter');await expect(thread).toHaveValue('');
  await thread.fill('项目助理草稿');
  await open();await list.getByRole('button',{name:'主助手',exact:true}).click();
  await expect(main).toHaveValue('项目主线未发草稿');await expect(scope).toHaveValue(project.id);
  await open();await list.getByRole('button',{name:'审阅助理',exact:true}).click();
  await expect(page).toHaveURL(projectThread);await expect(thread).toHaveValue('项目助理草稿');
  await expect(page.locator('.msg--user:visible .msg__bubble')).toHaveText('项目线的合成记录');
  await open();
  const renamed=await page.request.post(server.url+'/api/v1/assistant-profile',{headers:{authorization:'Bearer '+token},
    data:{action:'save',name:'工作伙伴',revision:0}});
  assert.equal(renamed.status(),200);
  await list.getByRole('button',{name:'主助手 · 工作伙伴',exact:true}).click();
  await scope.selectOption('');await open();await list.getByRole('button',{name:'审阅助理',exact:true}).click();
  await expect(thread).toBeVisible();assert.notEqual(page.url(),projectThread);
  await expect(thread).toHaveValue('');await expect(page.locator('.msg--user:visible')).toHaveCount(0);
  await open();
  const disabled=await fetch(server.url+'/api/v1/plugins/assistant-profile',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({enabled:false})});
  assert.equal(disabled.status,200);await expect(list).toHaveCount(0);
  await expect(page.getByRole('button',{name:'切换助理',exact:true})).toHaveCount(0);
});

test('双标签页编辑助理名称和指令，遇到旧版本保留草稿并显示当前资料', {timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'assistant-edit-')),token='synthetic-assistant-edit';
  const server=await startServer({dataDir:dir,port:0,host:'127.0.0.1',demo:false,token});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});});
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage();
  await context.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const id=crypto.randomUUID();
  const action=(data:unknown)=>fetch(server.url+'/api/v1/assistant-roster',{method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await action({action:'create',id,name:'初始助理',instructions:'先读需求'})).status,200);
  for(const page of [a,b]){
    await page.goto(server.url+'/#chat?token='+token);
    await page.getByRole('button',{name:'切换助理',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'切换助理'})).toContainText('工作台模型暂不可用');
    await page.getByRole('button',{name:'编辑 初始助理',exact:true}).click();
    await expect(page.getByLabel('助理指令')).toHaveValue('先读需求');
  }
  await b.getByLabel('助理名称').fill('保留的新名');await b.getByLabel('助理指令').fill('保留的新指令');
  await a.getByLabel('助理名称').fill('首份已存名称');await a.getByLabel('助理指令').fill('首份已存指令');
  await a.getByRole('button',{name:'保存助理资料'}).click();await expect(a.getByRole('status').filter({hasText:'已保存助理资料'})).toBeVisible();
  const failed=b.waitForResponse(r=>r.url().endsWith('/assistant-roster') && r.request().postDataJSON().action==='update');
  await b.getByRole('button',{name:'保存助理资料'}).click();assert.equal((await failed).status(),409);
  const dialog=b.getByRole('dialog',{name:'切换助理'});
  await expect(dialog.getByText('首份已存指令',{exact:true})).toBeVisible();
  await expect(dialog.getByLabel('助理名称')).toHaveValue('保留的新名');await expect(dialog.getByLabel('助理指令')).toHaveValue('保留的新指令');
  await dialog.getByRole('button',{name:'保存助理资料'}).click();
  await expect(dialog.getByRole('button',{name:'保留的新名',exact:true})).toBeVisible();
  const saved=(await (await action({action:'list'})).json()).items.find((row:{id:string})=>row.id===id);
  assert.equal(saved.instructions,'保留的新指令');assert.equal(saved.name,'保留的新名');assert.equal(saved.revision,2);
});

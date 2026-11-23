import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import type {Run} from '../packages/protocol/src/index.ts';

test('首页简报读取失败收起旧执行记录和无更新结论，手动重试恢复', {timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'home-brief-refresh-')),token='synthetic-brief-refresh';
  const server=await startServer({dataDir:dir,port:0,host:'127.0.0.1',demo:true,token});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});});
  const active=server.app.projects.create({name:'执行项目'});
  const quiet=server.app.projects.create({name:'无动态项目'});
  const now=new Date().toISOString();
  const run:Run={id:'brief-result',projectId:active.id,conversationId:'main',executorId:'demo',prompt:'合成简报执行结果',
    status:'completed',resultSource:'demo',output:'本地合成回执',createdAt:now,updatedAt:now};
  server.app.store.put('runs',run.id,run);
  const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#home?token='+token);
  const result=page.locator('.home-project').filter({has:page.getByRole('heading',{name:active.name})}).getByRole('link',{name:run.prompt,exact:true});
  const quietProject=page.locator('.home-project').filter({has:page.getByRole('heading',{name:quiet.name})});
  await expect(result).toBeVisible();
  await expect(quietProject).toContainText('最近 24 小时没有更新');
  await page.goto(server.url+'/#chat');await expect(page.locator('#message-text')).toBeVisible();
  let unavailable=true,successfulRetries=0;
  await page.route('**/api/v1/brief/current',async route=>{
    if(unavailable)await route.fulfill({status:503,json:{error:'合成简报读取故障'}});
    else {successfulRetries++;await route.continue();}
  });
  await page.goto(server.url+'/#home');
  const retry=page.getByRole('button',{name:'重试读取简报'});
  await expect(retry).toBeVisible();
  await expect(result).toHaveCount(0);
  await expect(quietProject).toBeVisible();
  await expect(quietProject).not.toContainText('没有更新');
  unavailable=false;await retry.click();
  await expect(result).toBeVisible();
  await expect(quietProject).toContainText('最近 24 小时没有更新');
  await expect(retry).toHaveCount(0);
  assert.equal(successfulRetries,1);
});

test('首页项目总结的同名待决定链接准确打开对应审批卡', {timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'home-brief-decision-')),token='synthetic-brief-decision';
  const server=await startServer({dataDir:dir,port:0,host:'127.0.0.1',demo:true,token});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});});
  const selected=server.app.projects.create({name:'目标项目'}),other=server.app.projects.create({name:'另一个项目'});
  const title='核对提交内容';
  const create=(projectId:string,details:string)=>server.app.approvals.propose({kind:'dispatch',title,details,params:{projectId}});
  const decoy=create(other.id,'另一张合成审批'),target=create(selected.id,'本项目合成审批');
  const page=await browser.newPage();
  const writes:string[]=[];
  page.on('request',r=>{if(r.method()!=='GET' && new URL(r.url()).pathname.startsWith('/api/v1/approvals'))writes.push(r.method());});
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#home?token='+token);
  const decisionLink=(project:string)=>page.locator('.home-project').filter({has:page.getByRole('heading',{name:project})})
    .locator('p').filter({hasText:'待决定'}).getByRole('link',{name:title,exact:true});
  await expect(decisionLink(other.name)).toHaveAttribute('href','#chat?approval='+decoy.id);
  await expect(decisionLink(selected.name)).toHaveAttribute('href','#chat?approval='+target.id);
  await decisionLink(selected.name).click();
  await expect(page).toHaveURL(server.url+'/#chat?approval='+target.id);
  const card=page.locator('#attention [data-id="approval:'+target.id+'"]');
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
  await expect(card).toContainText(title);
  await expect(card.getByRole('button',{name:'批准',exact:true})).toBeVisible();
  assert.deepEqual(server.app.approvals.list().map(row=>row.status),['pending','pending']);
  assert.deepEqual(writes,[]);
});

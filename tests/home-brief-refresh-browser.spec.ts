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

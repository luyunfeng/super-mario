import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('飞书个人文件按需读取、失败重试、换账号清空，普通文本不能伪造附件入口',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-file-preview-'));
  const token='test-only-file-preview';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true,token});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const fileId='a'.repeat(64);
  server.app.store.put('messages','attachment-answer',{id:'attachment-answer',conversationId:'main',role:'assistant',status:'done',
    createdAt:new Date().toISOString(),text:'合成附件的出处 [查看原文](#inbox?item='+fileId+')'});
  for(const [id,file] of [[fileId,true],['fake-file',false]] as const){
    const message='om_'+id;
    server.app.store.put('inbox',id,{id,source:'feishu:cli_fixture:ou_fixture',thread:'feishu:message:'+JSON.stringify(['oc_fixture',message]),
      last:message,title:'合成附件',text:'文件附件：样例.pdf',tier:'fyi',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1,
      origin:{kind:'direct',connector:'飞书',chatId:'oc_fixture',...(file && {feishuFile:true})}});
  }
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const text='合成正文 <b>只作文字</b>';
  let reads=0;
  await page.route('**/inbox/'+fileId+'/file-text',r=>++reads===1
    ? r.fulfill({status:403,json:{error:'权限不足'}})
    : r.fulfill({json:{name:'样例.pdf',text,truncated:true}}));
  await page.goto(server.url+'/#inbox?item=fake-file&token='+token);
  const drawer=page.getByRole('dialog',{name:'收件箱消息详情'}),toggle=drawer.getByText('读取附件正文',{exact:true});
  await expect(drawer).toBeVisible();await expect(toggle).toHaveCount(0);
  await page.goto(server.url+'/#chat');
  await page.getByRole('link',{name:'查看原文',exact:true}).click();
  await expect(toggle).toBeVisible();assert.equal(reads,0);
  await toggle.click();await expect(drawer.getByRole('alert')).toContainText('权限不足');
  await drawer.getByRole('button',{name:'重新读取附件'}).click();
  await expect(drawer).toContainText(text);await expect(drawer).toContainText('仅显示部分附件正文');
  await expect(drawer.locator('b')).toHaveCount(0);
  server.app.events.publish('feishu.edit-history.changed',{accountChanged:true});
  await expect(drawer).not.toContainText(text);assert.equal(reads,2);
});

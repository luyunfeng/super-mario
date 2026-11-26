import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('记忆详情可添加和移除关联的知识页，保存后重新打开仍在',{timeout:30000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-knowledge-relations-web-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const backend=server.app.knowledge();
  const deploy=await backend.put({layer:'personal',title:'部署步骤',content:'先核对版本再发布'});
  const rollback=await backend.put({layer:'personal',title:'回滚步骤',content:'保留上一版产物'});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#memory?entry='+deploy.id);
  // A memory link opens the editor for that page directly.
  const editor=page.getByRole('dialog',{name:'编辑记忆'});
  await expect(editor.getByText('还没有关联其他知识页。')).toBeVisible();
  await editor.getByLabel('要关联的知识页').selectOption(rollback.id);
  const linked=editor.getByLabel('已关联的知识页');
  await expect(linked.getByRole('link',{name:'回滚步骤'})).toBeVisible();
  await editor.getByRole('button',{name:'保存',exact:false}).last().click();
  await expect.poll(async()=>(await backend.list()).find(p=>p.id===deploy.id)?.relatedIds).toEqual([rollback.id]);
  // Saving closes the editor.
  await expect(editor).toHaveCount(0);
  await page.goto(server.url+'/#memory',{waitUntil:'domcontentloaded'});
  await page.locator('.item').filter({hasText:'部署步骤'}).first().click({ timeout: 8000 });
  const second=page.getByRole('dialog',{name:'编辑记忆'});
  await expect(second.getByRole('link',{name:'回滚步骤'})).toBeVisible();
  await second.getByRole('button',{name:'移除关联'}).click({ timeout: 5000 });
  await second.getByRole('button',{name:'保存',exact:true}).click({ timeout: 5000 });
  await expect(second).toHaveCount(0);
  const savedLink = async () => (await server.app.knowledge().list()).find(p=>p.id===deploy.id)?.relatedIds;
  await expect.poll(savedLink).toBeUndefined();
  assert.equal((await backend.list()).length,2,'linking never copies or removes a page');
});

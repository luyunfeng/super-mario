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

test('记忆详情列出系统按共同来源建议的关联和来源；主人排除后不再建议，恢复后又建议；编辑中的草稿不丢',{timeout:60000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-knowledge-suggest-web-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const backend=server.app.knowledge();
  const release=await backend.put({layer:'personal',title:'发布例会',content:'定下周四发布'});
  const rollback=await backend.put({layer:'personal',title:'回滚方案',content:'出问题回到上一版'});
  const menu=await backend.put({layer:'personal',title:'食堂菜单',content:'周三有面'});
  // One source made the first two pages.
  server.app.store.put('knowledge.sources','44444444-4444-4444-8444-444444444444',{id:'44444444-4444-4444-8444-444444444444',title:'周一发布会',
    knowledgeIds:[release.id,rollback.id],layer:'personal',status:'completed',createdAt:'2026-11-27T10:00:00.000Z',updatedAt:'2026-11-27T10:00:00.000Z'});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  const pageErrors:string[]=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#memory?entry='+release.id);
  const editor=page.getByRole('dialog',{name:'编辑记忆'});
  // The suggestion names the page and the source it rests on. The unrelated page is not suggested.
  const suggested=editor.getByLabel('系统建议的关联');
  await expect(suggested.getByRole('link',{name:'回滚方案'})).toBeVisible();
  await expect(suggested).toContainText('共同来源：周一发布会');
  await expect(suggested.getByRole('link',{name:'食堂菜单'})).toHaveCount(0);
  // It is kept apart from the owner's own links.
  await expect(editor.getByLabel('已关联的知识页')).toContainText('还没有关联其他知识页');
  // A draft in the text is written first, so that the denial below must not lose it.
  const body = editor.getByRole('textbox', { name: /内容/ });
  await body.fill('定下周四发布，提前一天封版');
  // Denying is at once, and does not save the draft.
  const denied=page.waitForResponse(response=>response.url().endsWith('/api/v1/knowledge/'+release.id)&&response.request().method()==='PATCH');
  await suggested.getByRole('button',{name:'不是关联'}).click();
  const deniedRequest=await denied;
  assert.equal(deniedRequest.status(),200);
  assert.deepEqual(deniedRequest.request().postDataJSON(),{excludedRelatedIds:[rollback.id],expectedUpdatedAt:release.updatedAt});
  await expect(suggested.getByRole('link',{name:'回滚方案'})).toHaveCount(0);
  await expect(suggested).toContainText('已排除：');
  await expect(suggested.getByRole('button',{name:'恢复建议'})).toBeVisible();
  assert.equal((await backend.list()).find(p=>p.id===release.id)!.content,'定下周四发布','the denial did not save the draft');
  // The draft is still there, and saving it now works against the version the denial wrote.
  await expect(body).toHaveValue('定下周四发布，提前一天封版');
  await editor.getByRole('button',{name:'保存',exact:true}).click();
  await expect(editor).toHaveCount(0);
  const afterSave=(await backend.list()).find(p=>p.id===release.id)!;
  assert.equal(afterSave.content,'定下周四发布，提前一天封版');
  assert.deepEqual(afterSave.excludedRelatedIds,[rollback.id]);
  // Opening it again shows the denial and offers to allow it.
  await page.goto(server.url+'/#memory',{waitUntil:'domcontentloaded'});
  await page.locator('.item').filter({hasText:'发布例会'}).first().click({ timeout: 8000 });
  const second=page.getByRole('dialog',{name:'编辑记忆'});
  const again=second.getByLabel('系统建议的关联');
  await expect(again.getByRole('button',{name:'恢复建议'})).toBeVisible();
  await again.getByRole('button',{name:'恢复建议'}).click();
  await expect(again.getByRole('link',{name:'回滚方案'})).toBeVisible();
  await expect(again.getByRole('button',{name:'恢复建议'})).toHaveCount(0);
  await expect.poll(async()=>(await backend.list()).find(p=>p.id===release.id)?.excludedRelatedIds).toBeUndefined();
  // A page with no shared source says so.
  await second.getByRole('button',{name:'取消'}).click();
  await page.locator('.item').filter({hasText:'食堂菜单'}).first().click({ timeout: 8000 });
  await expect(page.getByRole('dialog',{name:'编辑记忆'}).getByLabel('系统建议的关联')).toContainText('系统没有从共同来源找到其他相关的知识页');
  assert.deepEqual(pageErrors,[]);
});


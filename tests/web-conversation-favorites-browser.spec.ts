import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('从归档独立对话收藏消息并精确返回原文，停用插件收起收藏界面',{timeout:40000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'web-thread-favorites-')),token='synthetic-thread-favorites';
  const server=await startServer({dataDir:dir,port:0,host:'127.0.0.1',demo:true,token});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});});
  const page=await browser.newPage(),headers={Authorization:'Bearer '+token};
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const project=server.app.projects.create({name:'收藏核验范围'});
  const path=server.url+'/api/v1/web-conversations',first=randomUUID(),second=randomUUID();
  for(const [id,title] of [[first,'原文所在对话'],[second,'查阅收藏的对话']]){
    assert.equal((await page.request.post(path,{headers,data:{id,title,projectId:project.id}})).status(),201);
  }
  const text='已归档对话中可核验的收藏原文';
  const posted=await page.request.post(path+'/'+first+'/messages',{headers:{...headers,'Idempotency-Key':randomUUID()},data:{text}});
  assert.equal(posted.status(),202);const source=await posted.json();
  await t.waitFor(()=>assert.equal(server.app.store.get<{status:string}>('messages',source.id)?.status,'done'));
  const meta=await (await page.request.get(path+'/'+first,{headers})).json();
  assert.equal((await page.request.patch(path+'/'+first,{headers,data:{version:meta.version,archived:true}})).status(),200);
  const url=(id:string)=>server.url+'/#chat?thread='+id;
  await page.goto(url(first)+'&token='+token);
  const region=page.getByLabel('独立对话内容'),row=region.locator('article[data-id="'+source.id+'"]');
  const list=region.getByRole('button',{name:'消息收藏',exact:true});
  await expect(region).toContainText('已归档');
  const adding=page.waitForRequest(req=>req.url().endsWith('/message-favorites') && req.postDataJSON()?.action==='add');
  await row.getByRole('button',{name:'收藏消息',exact:true}).click();
  assert.deepEqual((await adding).postDataJSON(),{action:'add',messageId:source.id,projectId:project.id,webThreadId:first});
  await expect(row.getByRole('button',{name:'已收藏',exact:true})).toBeVisible();
  await page.goto(url(second));await list.click();
  const drawer=page.getByRole('dialog',{name:'消息收藏',exact:true});
  const saved=drawer.locator('article').filter({hasText:text});
  await saved.getByRole('button',{name:'定位到原会话'}).click();
  await expect(page).toHaveURL(url(first)+'&at='+source.id);
  await expect(row).toHaveAttribute('aria-current','true');await expect(row).toBeFocused();
  await page.reload();await expect(row.getByRole('button',{name:'已收藏',exact:true})).toBeVisible();
  await list.click();await expect(saved).toBeVisible();
  assert.equal((await page.request.post(server.url+'/api/v1/plugins/message-favorites',{headers,data:{enabled:false}})).status(),200);
  await expect(drawer).toHaveCount(0);await expect(list).toBeHidden();
  await expect(row.getByRole('button',{name:'已收藏',exact:true})).toBeHidden();await expect(row).toContainText(text);
});

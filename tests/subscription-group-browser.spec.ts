import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { InboxItem } from '../packages/protocol/src/index.ts';

test('条目订阅可从草案选用整条订阅一张卡，切回话题分卡后保留已有卡', {timeout:35000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-group-web-'));
  const server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,token:'offline-group',demo:true});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const source='group-fixture.changes';
  const entry=(id:string,thread?:string)=>({id,title:'合成条目 '+id,text:'合成内容 '+id,...(thread && {thread})});
  const items=[entry('a','alpha'),entry('b','beta')];
  server.app.plugins.register({id:'group-fixture',name:'离线收件分组',capabilities:['subscription.source'],
    permissions:['contribute:connectors','service.provide:'+source],activate(ctx){
      ctx.contribute('connectors','group-fixture-changes',{kind:'subscription-source',service:source,name:'分组样本来源',resourceLabel:'样本集'});
      ctx.contribute('services','group-fixture-changes',{name:source,version:1,readOnly:true,async handler(){return {items};}});
    }});
  await server.app.plugins.setEnabled('group-fixture',true);
  const draftId='2233456789abcdef',name='来源合卡样本';
  server.app.store.put('source.subscription-drafts',draftId,{id:draftId,sourceId:source,resource:'local',name,
    intervalMinutes:60,destinations:['inbox'],inboxGroup:'source',createdAt:new Date().toISOString()});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();page.setDefaultTimeout(6000);
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#memory?token=offline-group');
  await page.getByRole('button',{name:'来源订阅',exact:true}).click();
  const subs=page.getByRole('dialog',{name:'来源订阅',exact:true});
  await subs.getByLabel('来源连接器').selectOption(source);
  await expect(subs.getByLabel('收件分组')).toHaveValue('thread');
  await subs.getByLabel('来源连接器').selectOption('release-source.repository');
  await expect(subs.getByLabel('收件分组')).toBeHidden();
  await subs.getByText('待核对的订阅草案',{exact:true}).click();
  await subs.getByRole('button',{name:name+' · '+draftId}).click();
  await expect(subs.getByLabel('收件分组')).toHaveValue('source');
  await subs.getByRole('button',{name:'创建订阅'}).click();
  const row=subs.getByRole('article',{name,exact:true});
  await expect(row).toBeVisible();
  const {id}=server.app.subscriptions.service().list()[0]!;
  async function pull(){
    const reply=page.waitForResponse(res=>res.url().endsWith('/'+id+'/pull'));
    await row.getByRole('button',{name:'立即拉取'}).click();
    assert.equal((await reply).status(),200);
  }
  async function inbox():Promise<InboxItem[]> {
    const res=await page.request.get(server.url+'/api/v1/inbox',{headers:{Authorization:'Bearer offline-group'}});
    assert.equal(res.status(),200);
    return (await res.json()).filter((item:InboxItem)=>item.source==='subscription:'+id);
  }
  await pull();
  const original=await inbox();assert.equal(original.length,1);
  assert.match(original[0]!.text,/合成条目 a/);
  assert.match(original[0]!.text,/合成条目 b/);
  await row.getByRole('button',{name:'编辑订阅'}).click();
  const editor=page.getByRole('dialog',{name:'编辑订阅'});
  await expect(editor.getByLabel('收件分组')).toHaveValue('source');
  await editor.getByLabel('收件分组').selectOption('thread');
  await editor.getByRole('button',{name:'保存订阅'}).click();
  await expect(editor).toHaveCount(0);
  await page.reload();await page.getByRole('button',{name:'来源订阅',exact:true}).click();
  await row.getByRole('button',{name:'编辑订阅'}).click();
  await expect(editor.getByLabel('收件分组')).toHaveValue('thread');
  await editor.getByRole('button',{name:'取消'}).click();
  items.push(entry('c','alpha'),entry('d','alpha'),entry('e'),entry('f'));
  await pull();
  const after=await inbox();assert.equal(after.length,4);
  assert.deepEqual(after.find(item=>item.id===original[0]!.id),original[0]);
  const recent=after.filter(item=>item.id!==original[0]!.id);
  const merged=recent.find(item=>item.text.includes('合成条目 c'));assert.ok(merged);
  assert.match(merged.text,/合成条目 d/);
  assert.deepEqual(recent.filter(item=>item.id!==merged.id).map(item=>item.title).sort(),['合成条目 e','合成条目 f']);
});

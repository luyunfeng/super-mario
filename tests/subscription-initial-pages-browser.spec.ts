import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import type {InboxItem,Json,KnowledgeEntry} from '../packages/protocol/src/index.ts';

test('首次分页收录逐页写知识，末页合并普通条目并单独投递未来到期事项', {timeout:40000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'sm-initial-pages-web-'));
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,demo:true,token:'offline-initial-pages'});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const service='initial-pages-fixture.entries';
  const ordinary=['甲','乙','丙','丁','戊'].map((label,i)=>({id:'fixture-'+i,title:'普通条目'+label,text:'合成正文'+label}));
  const due={id:'future',title:'未来到期事项',text:'请核对合成样本',dueAt:new Date(Date.now()+7*86400000).toISOString()};
  const reads:Json[]=[];
  server.app.plugins.register({id:'initial-pages-fixture',name:'离线分页来源',capabilities:['subscription.source'],
    permissions:['contribute:connectors','service.provide:'+service],activate(ctx){
      ctx.contribute('connectors','initial-pages-fixture',{kind:'subscription-source',service,name:'合成分页更新',resourceLabel:'资料集'});
      ctx.contribute('services','initial-pages-fixture',{name:service,version:1,readOnly:true,async handler(input):Promise<Json>{
        reads.push(input);
        if(typeof input==='object' && input && !Array.isArray(input) && input.cursor==='second')
          return {items:[ordinary[1]!,...ordinary.slice(2)]};
        return {items:[ordinary[0]!,ordinary[1]!,due],nextCursor:'second',checkpoint:'first-seen'};
      }});
    }});
  await server.app.plugins.setEnabled('initial-pages-fixture',true);
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const context=await browser.newContext();
  await context.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const page=await context.newPage();page.setDefaultTimeout(6000);
  await page.goto(server.url+'/#memory?token=offline-initial-pages');
  await page.getByRole('button',{name:'来源订阅',exact:true}).click();
  const drawer=page.getByRole('dialog',{name:'来源订阅'});
  const name='两页首次收录';
  await drawer.getByLabel('来源连接器').selectOption(service);
  await drawer.getByLabel('资料集',{exact:true}).fill('sample');
  await drawer.getByLabel('订阅名称').fill(name);
  await drawer.getByLabel('个人记忆').check();
  await drawer.getByRole('button',{name:'创建订阅'}).click();
  const row=drawer.getByRole('article',{name,exact:true});
  await expect(row).toBeVisible();
  const id=server.app.subscriptions.service().list()[0]!.id;
  const headers={Authorization:'Bearer offline-initial-pages'};
  async function get<T>(path:string):Promise<T> {
    const res=await page.request.get(server.url+'/api/v1'+path,{headers});
    assert.equal(res.status(),200);return res.json();
  }
  const inbox=async()=>(await get<InboxItem[]>('/inbox')).filter(item=>item.source==='subscription:'+id);
  const memory=async()=>(await get<KnowledgeEntry[]>('/knowledge')).filter(item=>item.tags?.includes('来源订阅'));
  async function pull() {
    const done=page.waitForResponse(res=>res.url().endsWith('/'+id+'/pull'));
    await row.getByRole('button',{name:'立即拉取'}).click();assert.equal((await done).status(),200);
  }
  await pull();
  await expect(row).toContainText('下次读取第 2 页');
  await expect(row).toContainText('首轮收件等待最后一页 · 已暂存 3 项');
  assert.deepEqual((await memory()).map(item=>item.title).sort(),[ordinary[0]!.title,ordinary[1]!.title,due.title].sort());
  assert.deepEqual(await inbox(),[]);
  await row.getByRole('button',{name:'运行记录'}).click();
  const history=page.getByRole('dialog',{name:'运行记录'}),runs=history.getByRole('article',{name:'手动拉取 · 已完成'});
  await expect(runs.first()).toContainText('已投递 · 收件箱 0，个人记忆 3');
  await expect(runs.first()).toContainText('待投递 · 收件箱 3，个人记忆 0');
  await history.getByRole('button',{name:'关闭'}).click();
  await pull();
  await expect(row).not.toContainText('下次读取第');
  const saved=await inbox(),pages=await memory();
  assert.deepEqual(pages.map(item=>item.title).sort(),[...ordinary,due].map(item=>item.title).sort());
  assert.equal(saved.length,2);
  const digest=saved.find(item=>item.subscriptionMove?.kind==='digest');assert.ok(digest);
  assert.equal(digest.subscriptionMove!.count,5);
  for(const item of ordinary) assert.equal(digest.text.split(item.title).length-1,1);
  assert.ok(!digest.text.includes(due.title));
  assert.equal(saved.find(item=>item.id!==digest.id)?.title,due.title);
  await row.getByRole('button',{name:'运行记录'}).click();
  await expect(runs.first()).toContainText('已投递 · 收件箱 6，个人记忆 3');
  await expect(runs.first()).toContainText('待投递 · 收件箱 0，个人记忆 0');
  await history.getByRole('button',{name:'关闭'}).click();
  await pull();await pull();
  assert.deepEqual(await inbox(),saved);
  assert.deepEqual(await memory(),pages);
  assert.equal(reads.length,4);
  await row.getByRole('button',{name:'运行记录'}).click();
  await expect(runs).toHaveCount(4);
  for(const repeat of [runs.nth(0),runs.nth(1)]) await expect(repeat).toContainText('已投递 · 收件箱 0，个人记忆 0');
});

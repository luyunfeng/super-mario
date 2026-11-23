import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Json } from '../packages/protocol/src/index.ts';

test('两个 Web 窗口按真实运行回执更新，区分读取失败、空页与成功投递', {timeout:40000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-web-sub-runs-'));
  const server=await startServer({dataDir:dir,port:0,host:'127.0.0.1',token:'runs-owner',demo:true});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const source='run-history-fixture.read',items=Array.from({length:16},(_,i)=>({id:'item-'+i,title:'<b>合成标题 '+i+'</b>',text:'离线样本正文'}));
  let readMode:'fail'|'empty'|'full'='fail';
  let unblock:()=>void=()=>{};
  let hold:Promise<void>|undefined;
  server.app.plugins.register({id:'run-history-fixture',name:'运行记录本地来源',capabilities:['subscription.source'],
    permissions:['contribute:connectors','service.provide:'+source],activate(ctx){
      ctx.contribute('connectors','run-history-fixture',{kind:'subscription-source',name:'合成来源',resourceLabel:'资料集',service:source});
      ctx.contribute('services','run-history-fixture',{name:source,version:1,readOnly:true,async handler():Promise<Json>{
        if(hold) await hold;
        if(readMode==='fail') throw new Error('内部合成错误');
        return {items:readMode==='full'?items:[]};
      }});
    }});
  await server.app.plugins.setEnabled('run-history-fixture',true);
  const sub=server.app.subscriptions.service().create({sourceId:source,resource:'sample',name:'合成运行订阅',
    destinations:['inbox','knowledge'],intervalMinutes:60});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const context=await browser.newContext();
  await context.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const viewer=await context.newPage(),operator=await context.newPage();
  for(const page of [viewer,operator]){
    await page.goto(server.url+'/#memory?token=runs-owner');
    await page.getByRole('button',{name:'来源订阅',exact:true}).click();
  }
  await viewer.getByRole('article',{name:sub.name}).getByRole('button',{name:'运行记录'}).click();
  const history=viewer.getByRole('dialog',{name:'运行记录'});
  await expect(history).toContainText('暂无运行记录。');
  const button=operator.getByRole('article',{name:sub.name}).getByRole('button',{name:'立即拉取'});
  async function pull(status:number) {
    const response=operator.waitForResponse(res=>res.url().endsWith('/'+sub.id+'/pull'));
    await button.click();
    assert.equal((await response).status(),status);
  }
  await pull(502);
  const failed=history.getByRole('article',{name:'手动拉取 · 失败'});
  await expect(failed).toContainText('尚无来源读取结果');
  await expect(failed).not.toContainText('内部合成错误');
  readMode='empty';hold=new Promise(resolve=>{unblock=resolve;});
  const empty=pull(200);
  try {
    await expect(history.getByRole('article',{name:'手动拉取 · 运行中'})).toBeVisible();
  } finally {unblock();await empty;hold=undefined;}
  await expect(history.getByRole('article',{name:'手动拉取 · 已完成'})).toContainText('来源返回 0 项 · 新增 0 项');
  readMode='full';await pull(200);
  const latest=history.getByRole('article',{name:'手动拉取 · 已完成'}).first();
  await expect(latest).toContainText('来源返回 16 项 · 新增 16 项');
  await expect(latest).toContainText('已投递 · 收件箱 16，个人记忆 16');
  await expect(latest).toContainText('待投递 · 收件箱 0，个人记忆 0');
  await latest.locator('summary').click();
  await expect(latest).toContainText('<b>合成标题');
  await expect(latest.locator('b')).toHaveCount(0);
  const response=await viewer.request.get(server.url+'/api/v1/source-subscriptions/'+sub.id+'/runs',{headers:{Authorization:'Bearer runs-owner'}});
  const data=await response.json();
  assert.equal(data.items[0].totalEntries,16);
  await expect(latest.getByRole('listitem')).toHaveCount(data.items[0].entries.length);
  if(data.items[0].entries.length<16) await expect(latest.locator('summary')).toContainText('共 16 项');
  const service=server.app.subscriptions.service();
  server.app.store.put('source.subscriptions',sub.id,{...service.list()[0]!,nextRunAt:'2000-01-01T00:00:00.000Z'});
  await service.tick();
  const scheduled=history.getByRole('article',{name:'定时拉取 · 已完成'});
  await expect(scheduled).toContainText('来源返回 16 项 · 新增 0 项');
  await expect(scheduled).toContainText('已投递 · 收件箱 0，个人记忆 0');
  const linked=await context.newPage();
  await linked.goto(server.url+'/#memory?subscriptionRuns='+sub.id);
  await expect(linked.getByRole('dialog',{name:'运行记录'})).toContainText('来源返回 16 项');
  await linked.goto(server.url+'/#memory?subscriptionRuns=fixture-missing-subscription');
  await expect(linked.getByRole('dialog',{name:'来源订阅'})).toContainText('找不到这条订阅');
  await expect(linked.getByRole('dialog',{name:'运行记录'})).toHaveCount(0);
});

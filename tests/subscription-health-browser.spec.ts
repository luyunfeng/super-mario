import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('订阅读取持续失败与投递失败分别显示，收件提醒在实际恢复后归档', {timeout:40000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-health-web-'));
  const server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,token:'offline-health',demo:true});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const source='health-fixture.read',name='合成健康订阅';
  let unavailable=true;
  server.app.plugins.register({id:'health-fixture',name:'本地读取',capabilities:['subscription.source'],
    permissions:['contribute:connectors','service.provide:'+source],activate(ctx){
      ctx.contribute('connectors','fixture-health',{kind:'subscription-source',service:source,name:'合成读取',resourceLabel:'资源'});
      ctx.contribute('services','fixture-health',{name:source,version:1,readOnly:true,async handler(){
        if(unavailable) throw new Error('private source details');
        return {items:[{id:'fixture-row',title:'合成条目',text:'合成摘要'}]};
      }});
    }});
  await server.app.plugins.setEnabled('health-fixture',true);
  const svc=server.app.subscriptions.service();
  const row=svc.create({sourceId:source,resource:'one',name,intervalMinutes:10080,destinations:['knowledge']});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const context=await browser.newContext();await context.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const subs=await context.newPage(),inbox=await context.newPage();
  await subs.goto(server.url+'/#memory?token=offline-health');
  await subs.getByRole('button',{name:'来源订阅',exact:true}).click();
  await inbox.goto(server.url+'/#inbox?token=offline-health');
  const subscription=subs.getByRole('article',{name,exact:true}),pull=subscription.getByRole('button',{name:'立即拉取'});
  const run=async(status:number)=>{
    const response=subs.waitForResponse(res=>res.url().endsWith('/'+row.id+'/pull'));
    await pull.click();assert.equal((await response).status(),status);
  };
  await run(502);
  await expect(subscription).toContainText('来源读取持续失败');
  await expect(subscription).toContainText('读取订阅来源失败');
  await expect(subscription).not.toContainText('private source details');
  await expect(subscription).not.toContainText('已入箱');
  await expect(inbox.locator('#inbox .mailbox-card')).toHaveCount(0);
  const actual=svc.list().find(item=>item.id===row.id)!;
  assert.ok(actual.failingSince);
  await expect(subscription.locator('time')).toHaveAttribute('datetime',actual.failingSince);
  // Move only the synthetic reading failure's start time. Reminder delivery still uses the real scheduler.
  const since=new Date(Date.now()-25*3600000).toISOString();
  server.app.store.put('source.subscriptions',row.id,{...actual,failingSince:since});
  await svc.tick();
  const card=inbox.locator('#inbox .mailbox-card').filter({hasText:name});
  await expect(card).toContainText('来源读取持续失败');
  await expect(card.locator('time')).toHaveAttribute('datetime',since);
  await card.getByRole('button',{name:'查看原文与详情'}).click();
  const detail=inbox.getByRole('dialog',{name:'收件箱消息详情'});
  await expect(detail.locator('time')).toHaveAttribute('datetime',since);
  const disable=await subs.request.post(server.url+'/api/v1/plugins/knowledge-local',{
    headers:{Authorization:'Bearer offline-health'},data:{enabled:false}});
  assert.equal(disable.status(),200);
  unavailable=false;
  await run(502);
  await expect(subscription).not.toContainText('来源读取持续失败');
  await expect(subscription).toContainText('投递');
  await expect(detail).toContainText('来源读取已恢复');
  await expect(detail).toContainText('已归档');
  await detail.getByRole('button',{name:'关闭',exact:true}).last().click();
  await inbox.getByLabel('收件箱状态',{exact:true}).selectOption('archived');
  await expect(card).toContainText('来源读取已恢复');
  await expect(card.locator('time')).toHaveAttribute('datetime',since);
  unavailable=true;
  for(const state of ['paused','deleted'] as const) {
    const next=svc.create({sourceId:source,resource:state,name:'合成订阅 '+state,intervalMinutes:10080,destinations:['inbox']});
    await assert.rejects(svc.pull(next.id,next.version));
    const failed=svc.list().find(item=>item.id===next.id)!;
    server.app.store.put('source.subscriptions',next.id,{...failed,failingSince:since});
    await svc.tick();
    if(state==='paused') svc.update(next.id,{version:next.version,enabled:false});
    else svc.remove(next.id,next.version);
    const closed=inbox.locator('#inbox .mailbox-card').filter({hasText:next.name});
    await expect(closed).toContainText(state==='paused'?'订阅已暂停':'订阅已删除');
    await expect(closed).toContainText('已归档');
    await expect(closed.locator('time')).toHaveAttribute('datetime',since);
  }
});

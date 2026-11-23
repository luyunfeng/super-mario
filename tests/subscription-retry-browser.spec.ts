import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('连接器连续失败后跨资源暂缓，手动查询与补投不提前读取，到期显示自动重试回执', {timeout:40000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-retry-web-'));
  const server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,token:'offline-retry',demo:true});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const requests:string[]=[];
  const source='failure-fixture.read';
  let unavailable=true;
  server.app.plugins.register({id:'failure-fixture',name:'离线失败样本',capabilities:['subscription.source'],
    permissions:['contribute:connectors','service.provide:'+source],activate(ctx){
      ctx.contribute('connectors','failure-test',{kind:'subscription-source',service:source,name:'离线来源',resourceLabel:'资源'});
      ctx.contribute('services','failure-test',{name:source,version:1,readOnly:true,async handler(input){
        requests.push((input as {resource:string}).resource);
        if(unavailable) throw new Error('Synthetic connection failure');
        return {items:[]};
      }});
    }});
  await server.app.plugins.setEnabled('failure-fixture',true);
  const service=server.app.subscriptions.service();
  const create=(name:string,resource:string,intervalMinutes:number)=>service.create({sourceId:source,resource,name,intervalMinutes,destinations:['inbox']});
  const first=create('重试订阅甲','first',1),other=create('重试订阅乙','second',10080);
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();page.setDefaultTimeout(7000);
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#memory?token=offline-retry');
  await page.getByRole('button',{name:'来源订阅',exact:true}).click();
  const drawer=page.getByRole('dialog',{name:'来源订阅'});
  const firstRow=drawer.getByRole('article',{name:first.name,exact:true});
  const secondRow=drawer.getByRole('article',{name:other.name,exact:true});
  async function pull(row:typeof firstRow,id:string) {
    const reply=page.waitForResponse(res=>res.url().endsWith('/'+id+'/pull'));
    await row.getByRole('button',{name:'立即拉取',exact:true}).click();return reply;
  }
  for(let i=1;i<=3;i++){
    const reply=await pull(firstRow,first.id);
    assert.ok(reply.status()>=400);
    await expect(firstRow).toContainText('本订阅已连续失败 '+i+' 次');
  }
  assert.deepEqual(requests,['first','first','first']);
  const nextRetry=service.list().find(row=>row.id===first.id)!.nextRunAt;
  const displayTime=await page.evaluate(value=>new Date(value).toLocaleString('zh-CN'),nextRetry);
  await expect(firstRow).toContainText('下次自动重试 · '+displayTime);
  await expect(secondRow).toContainText('连接器连续调用失败，暂缓读取至');
  await expect(secondRow).not.toContainText('来源限流');
  await expect(secondRow).not.toContainText('本订阅已连续失败');
  await drawer.getByLabel('来源连接器').selectOption(source);
  await drawer.getByLabel('资源',{exact:true}).fill('second');
  const noRead=page.waitForResponse(res=>res.url().endsWith('/source-subscriptions/preview'));
  await drawer.getByRole('button',{name:'预览来源'}).click();
  const blocked=await noRead;
  assert.equal(blocked.status(),429);
  const reason=await blocked.json();
  assert.equal(reason.retryKind,'failures');
  assert.ok(Date.parse(reason.retryAt)>Date.now());
  server.app.store.put('source.subscription-pending',other.id,[{id:'cached',title:'此前已收到的样本',text:'合成正文'}]);
  assert.equal((await pull(secondRow,other.id)).status(),429);
  assert.equal(requests.length,3);
  assert.ok(server.app.inbox.list().some(item=>item.source==='subscription:'+other.id && item.text.includes('此前已收到的样本')));
  unavailable=false;
  const deadline=service.list().find(row=>row.id===first.id)!.nextRunAt;
  t.mock.timers.enable({apis:['Date'],now:Date.parse(deadline)+1000});
  await service.tick();
  assert.equal(requests.filter(resource=>resource==='first').length,4);
  await expect(firstRow).not.toContainText('本订阅已连续失败');
  await expect(secondRow).not.toContainText('连接器连续调用失败');
  await firstRow.getByRole('button',{name:'运行记录'}).click();
  await expect(page.getByRole('dialog',{name:'运行记录'}).getByRole('article',{name:'自动重试 · 已完成'})).toContainText('来源返回 0 项');
});

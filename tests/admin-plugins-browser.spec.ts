import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('管理员按名称和状态诊断本地插件，普通凭据不可查清单，诊断页隐藏配置和异常原文',{timeout:40000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'admin-plugins-'));
  const configMarker='synthetic-private-config-8961',errorMarker='synthetic-private-error-1802';
  async function install(id:string,name:string,dependencies:string[],fail=false){
    const directory=join(dataDir,'extensions',id);
    await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'super-mario.extension.json'),JSON.stringify({
      id,name,version:'2.7.4',apiVersion:1,main:'index.mjs',permissions:['store.read',...(id==='fixture-ready'?['service.provide:fixture-ready.count']:[])],dependencies,
      config:{fixture:configMarker},
    }));
    await writeFile(join(directory,'index.mjs'),
      'export default { id:'+JSON.stringify(id)+',name:'+JSON.stringify(name)+',capabilities:[],activate(ctx){'+
      (id==='fixture-ready'?"ctx.provide('fixture-ready.count',input=>{if(input.fail)throw new Error('synthetic-private-service-error');return 'synthetic-private-service-result';});":'')+
      (fail?'throw new Error('+JSON.stringify(errorMarker)+');':'')+'} };');
  }
  await install('fixture-provider','合成资料来源',[]);
  await install('fixture-ready','合成资料整理',['fixture-provider']);
  await install('fixture-wait','合成资料等待',['fixture-absent']);
  await install('fixture-failed','合成资料异常',[],true);
  const root='synthetic-owner-admin-plugins';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,token:root,demo:true});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const admin=await browser.newContext(),base=server.url+'/api/v1',rootHeaders={authorization:'Bearer '+root};
  const paired=server.app.browserDevices.redeem(server.app.browserDevices.issue('合成设备').code);
  for(const token of [undefined,root,paired.token]){
    for(const route of ['/admin/plugins','/admin/plugins/fixture-ready/metrics','/admin/plugins/fixture-ready/calls']){
      const denied=await fetch(base+route,{headers:token?{authorization:'Bearer '+token}:{}});
      assert.equal(denied.status,401);
      assert.doesNotMatch(await denied.text(),/fixture-ready|synthetic-private-/);
    }
  }
  const code=await admin.request.post(base+'/admin/setup-code',{data:{},headers:rootHeaders});
  assert.equal(code.status(),200);
  const setup=await admin.request.post(base+'/admin/setup',{data:{code:(await code.json()).code,password:'synthetic-fixture-admin-plugins'}});
  assert.equal(setup.status(),200);
  const metricsURL=base+'/admin/plugins/fixture-ready/metrics';
  for(const suffix of ['?window=2h','?window=','?window=1h&window=24h']){
    assert.equal((await admin.request.get(metricsURL+suffix)).status(),400);
  }
  assert.equal((await admin.request.get(base+'/admin/plugins/fixture-absent/metrics')).status(),404);
  assert.equal((await admin.request.get(base+'/admin/plugins/foo%2Fbar/metrics')).status(),400);
  const callsURL=base+'/admin/plugins/fixture-ready/calls';
  assert.deepEqual(await (await admin.request.get(callsURL)).json(),{items:[]});
  assert.equal((await admin.request.get(base+'/admin/plugins/fixture-absent/calls')).status(),404);
  const defaultMetrics=await admin.request.get(metricsURL);
  assert.equal(defaultMetrics.status(),200);
  assert.equal((await defaultMetrics.json()).window,'24h');
  const page=await admin.newPage();
  await page.goto(server.url+'/admin.html');
  const panel=page.getByRole('region',{name:'插件诊断'});
  const loaded=page.waitForResponse(r=>r.url()===base+'/admin/plugins');
  await panel.getByRole('button',{name:'查看插件'}).click();
  const response=await loaded;assert.equal(response.status(),200);
  assert.doesNotMatch(await response.text(),/synthetic-private-/);
  const search=panel.getByRole('searchbox',{name:'搜索插件'}),status=panel.getByRole('combobox',{name:'插件状态'});
  await search.fill('SERVICE.PROVIDE:fixture-ready.count');
  await expect(panel.locator('summary')).toHaveCount(1);
  await expect(panel.locator('summary')).toContainText('合成资料整理');
  await search.fill('合成资料');
  await status.selectOption('active');
  const ready=panel.locator('details').filter({has:page.locator('summary',{hasText:'合成资料整理'})});
  await ready.locator('summary').click();
  for(const evidence of ['fixture-ready','2.7.4','store.read','fixture-provider'])await expect(ready).toContainText(evidence);
  await ready.getByRole('button',{name:'查看调用指标'}).click();
  const metrics=ready.getByRole('region',{name:'调用指标'});
  await expect(metrics).toContainText('此时间范围没有调用记录');
  for(const window of ['7d','1h']){
    const refreshed=page.waitForResponse(r=>r.url()===metricsURL+'?window='+window);
    await metrics.getByRole('combobox',{name:'指标时间范围'}).selectOption(window);
    assert.equal((await (await refreshed).json()).window,window);
    await expect(metrics).toContainText('此时间范围没有调用记录');
  }
  await server.app.plugins.invocations.use('fixture-ready.count',{text:'synthetic-private-service-input'});
  await metrics.getByRole('button',{name:'刷新指标'}).click();
  await expect(metrics).toContainText('service:fixture-ready.count');
  const sample=await (await admin.request.get(metricsURL)).json();
  assert.equal(sample.calls,1);assert.equal(sample.errors,0);
  assert.deepEqual(sample.operations.map((op:{name:string})=>op.name),['service:fixture-ready.count']);
  await assert.rejects(server.app.plugins.invocations.use('fixture-ready.count',{fail:true,text:'synthetic-private-service-input'}));
  const callsReply=page.waitForResponse(r=>r.url()===callsURL);
  await ready.getByRole('button',{name:'查看最近调用'}).click();
  const returned=await callsReply;assert.equal(returned.status(),200);
  assert.doesNotMatch(await returned.text(),/synthetic-private-/);
  const {items}=await returned.json();
  assert.deepEqual(items.map((entry:{status:string})=>entry.status),['error','ok']);
  for(const entry of items){
    assert.deepEqual(Object.keys(entry).sort(),['at','elapsedMs','name','status']);
    assert.equal(entry.name,'service:fixture-ready.count');
    assert.ok(entry.elapsedMs>=0);assert.ok(Number.isFinite(Date.parse(entry.at)));
  }
  const recent=ready.getByRole('region',{name:'最近调用'});
  await expect(recent).toContainText('成功');await expect(recent).toContainText('失败');
  await expect(recent).not.toContainText('synthetic-private-');
  await recent.getByRole('checkbox',{name:'仅失败'}).check();
  const callTable=recent.getByRole('table',{name:'调用记录'});
  await expect(callTable.getByRole('row')).toHaveCount(2);
  await expect(callTable).toContainText('失败');await expect(callTable).not.toContainText('成功');
  await expect(panel.locator('summary',{hasText:'合成资料等待'})).toHaveCount(0);
  await status.selectOption('waiting');
  const waiting=panel.locator('details').filter({has:page.locator('summary',{hasText:'合成资料等待'})});
  await waiting.locator('summary').click();await expect(waiting).toContainText('fixture-absent');
  const {plugins}=await response.json();
  const unavailable=plugins.find((plugin:{id:string})=>plugin.id==='fixture-wait');
  assert.ok(unavailable.reason);await expect(waiting).toContainText(unavailable.reason);
  await status.selectOption('failed');
  await expect(panel.locator('summary',{hasText:'合成资料异常'})).toBeVisible();
  await expect(panel.locator('summary',{hasText:'合成资料等待'})).toHaveCount(0);
});

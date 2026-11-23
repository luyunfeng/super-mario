import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('从记忆订阅插件来源，预览、拉取、暂停恢复和冲突核对', {timeout:40000},async t => {
  const dir = await mkdtemp(join(tmpdir(),'mario-web-subscriptions-'));
  const server = await startServer({dataDir:dir,port:0,host:'127.0.0.1',token:'offline-test',demo:true});
  t.after(async () => {await server.close();await rm(dir,{recursive:true,force:true});});
  let calls = 0, unavailable = false;
  const service = 'offline-releases.changes';
  server.app.plugins.register({id:'offline-releases',name:'合成离线来源',capabilities:['subscription.source'],
    permissions:['contribute:connectors','service.provide:'+service],
    activate(context) {
      context.contribute('connectors','changes',{kind:'subscription-source',name:'离线发布',resourceLabel:'资料集编号',service});
      context.contribute('services','changes',{name:service,version:1,readOnly:true,async handler(){
        calls++;
        if (unavailable) throw new Error('合成来源不可用');
        return {items:[{id:'release-1',title:'离线样本',text:'<b>合成版本正文</b>',url:'https://example.test/v1'}]};
      }});
    }});
  await server.app.plugins.setEnabled('offline-releases',true);
  const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#memory?token=offline-test');
  await page.getByRole('button',{name:'来源订阅'}).click();
  const drawer = page.getByRole('dialog',{name:'来源订阅'});
  await drawer.getByLabel('来源连接器').selectOption(service);
  await drawer.getByLabel('资料集编号').fill('local/item');
  await drawer.getByRole('button',{name:'预览来源'}).click();
  await expect(drawer.getByText('<b>合成版本正文</b>',{exact:true})).toBeVisible();
  await expect(drawer.getByRole('link',{name:'打开来源原文'})).toHaveAttribute('href','https://example.test/v1');
  assert.equal(calls,1);
  await drawer.getByLabel('订阅名称').fill('离线订阅样本');
  await drawer.getByLabel('个人记忆').check();
  await drawer.getByRole('button',{name:'创建订阅'}).click();
  const row = drawer.getByRole('article',{name:'离线订阅样本'});
  await expect(row).toContainText('收件箱、个人记忆');
  await row.getByRole('button',{name:'立即拉取'}).click();
  await expect(row).toContainText('最近拉取');
  assert.equal(calls,2);
  await drawer.getByLabel('订阅名称').fill('未提交的第二条订阅');
  await row.getByRole('button',{name:'暂停订阅'}).click();
  await expect(row).toContainText('已暂停');
  await expect(row.getByRole('button',{name:'立即拉取'})).toBeDisabled();
  await row.getByRole('button',{name:'恢复订阅'}).click();
  await expect(row).toContainText('已启用');
  unavailable = true;
  await row.getByRole('button',{name:'立即拉取'}).click();
  await expect(row).toContainText('读取订阅来源失败');
  await expect(drawer.getByLabel('订阅名称')).toHaveValue('未提交的第二条订阅');
  // A stale version is sent once. The client only reloads the latest list.
  let patches = 0;
  await page.route('**/api/v1/source-subscriptions/*',async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patches++;
    await route.continue({postData:JSON.stringify({...route.request().postDataJSON(),version:1})});
  });
  await row.getByRole('button',{name:'暂停订阅'}).click();
  await expect(drawer.getByRole('status')).toContainText('订阅已变化');
  assert.equal(patches,1);
  await expect(row).toContainText('已启用');
  await expect(drawer.getByLabel('订阅名称')).toHaveValue('未提交的第二条订阅');
  const paths = drawer.locator('details').filter({hasText:'来源关系图'});
  await paths.locator('summary').click();
  await paths.getByLabel('筛选投递路径').selectOption('knowledge');
  await expect(paths.getByText('local/item →',{exact:true})).toBeVisible();
  await paths.getByRole('button',{name:'离线订阅样本'}).click();
  await expect(row).toBeFocused();
  const current = server.app.subscriptions.service().list()[0]!;
  const external = await page.request.patch(server.url+'/api/v1/source-subscriptions/'+current.id,{
    headers:{Authorization:'Bearer offline-test'},data:{version:current.version,enabled:false}});
  assert.equal(external.status(),200);
  await expect(row).toContainText('已暂停');
  await expect(drawer.getByLabel('订阅名称')).toHaveValue('未提交的第二条订阅');
  await page.unroute('**/api/v1/source-subscriptions/*');
  await row.getByRole('button',{name:'编辑订阅'}).click();
  const editor = page.getByRole('dialog',{name:'编辑订阅'});
  await editor.getByLabel('订阅名称').fill('重新命名');
  await editor.getByLabel('拉取间隔（分钟）').fill('30');
  await editor.getByLabel('个人记忆').uncheck();
  const status = server.app.subscriptions.service().list()[0]!;
  const concurrent = await page.request.patch(server.url+'/api/v1/source-subscriptions/'+status.id,{
    headers:{Authorization:'Bearer offline-test'},data:{version:status.version,name:'另一处改名'}});
  assert.equal(concurrent.status(),200);
  await editor.getByRole('button',{name:'保存订阅'}).click();
  await expect(editor).toContainText('另一处改名');
  await expect(editor.getByLabel('订阅名称')).toHaveValue('重新命名');
  await editor.getByRole('button',{name:'已核对当前版本'}).click();
  await editor.getByRole('button',{name:'保存订阅'}).click();
  const renamed=drawer.getByRole('article',{name:'重新命名'});
  await expect(renamed).toContainText('每 30 分钟');
  await expect(renamed).not.toContainText('个人记忆');
  await renamed.getByRole('button',{name:'删除订阅'}).click();
  const confirmation=page.getByRole('dialog',{name:'删除订阅',exact:true});
  await expect(confirmation).toContainText('已经投递的收件箱记录和个人记忆会保留');
  await confirmation.getByRole('button',{name:'取消'}).click();
  await expect(renamed).toBeVisible();
  await renamed.getByRole('button',{name:'删除订阅'}).click();
  await confirmation.getByRole('button',{name:'确认删除订阅'}).click();
  await expect(drawer).toContainText('暂无订阅');
  await expect(renamed).toHaveCount(0);
  const disabled = await page.request.post(server.url+'/api/v1/plugins/source-subscriptions',{
    headers:{Authorization:'Bearer offline-test'},data:{enabled:false}});
  assert.equal(disabled.status(),200);
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('button',{name:'来源订阅',exact:true})).toHaveCount(0);
});

test('主人从对话或草案清单核对、编辑并创建一次订阅', {timeout:30000},async t => {
  const dir=await mkdtemp(join(tmpdir(),'mario-subscription-draft-'));
  const server=await startServer({dataDir:dir,port:0,host:'127.0.0.1',token:'offline-draft',demo:true});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const id='abcd1234abcd1234',createdAt=new Date().toISOString();
  server.app.store.put('source.subscription-drafts',id,{id,sourceId:'release-source.releases',name:'合成草案',
    resource:'sample/repository',intervalMinutes:120,destinations:['knowledge'],createdAt});
  server.app.store.put('messages','draft-link',{id:'draft-link',conversationId:'main',role:'assistant',status:'done',createdAt,
    text:'[核对订阅草案](#memory?subscriptionDraft='+id+')'});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();page.setDefaultTimeout(6000);
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#chat?token=offline-draft');
  await page.getByRole('link',{name:'核对订阅草案'}).click();
  const drawer=page.getByRole('dialog',{name:'来源订阅'});
  await expect(drawer.getByLabel('订阅名称')).toHaveValue('合成草案');
  await expect(drawer.getByLabel('个人记忆')).toBeChecked();
  await expect(drawer.getByLabel('收件箱')).not.toBeChecked();
  assert.equal(server.app.subscriptions.service().list().length,0);
  await drawer.getByRole('button',{name:'关闭'}).click();
  await page.getByRole('button',{name:'来源订阅',exact:true}).click();
  await drawer.getByText('待核对的订阅草案',{exact:true}).click();
  await drawer.getByRole('button',{name:'合成草案 · '+id}).click();
  await expect(drawer.getByLabel('拉取间隔（分钟）')).toHaveValue('120');
  await drawer.getByLabel('订阅名称').fill('主人调整后的名称');
  await drawer.getByRole('button',{name:'创建订阅'}).click();
  await expect(drawer.getByRole('article',{name:'主人调整后的名称'})).toBeVisible();
  assert.equal(server.app.subscriptions.service().list().length,1);
  await page.reload();
  await expect(drawer.getByText(/已使用或过期/)).toBeVisible();
  await expect(drawer.getByLabel('订阅名称')).toHaveValue('');
});

test('限流后的订阅显示来源允许读取的时刻，主人仍可手动补投已收到的条目', {timeout:30_000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-subscription-retry-'));
  const server=await startServer({dataDir:dir,port:0,host:'127.0.0.1',token:'offline-delay',demo:true});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const service='rate-fixture.read';
  let reads=0;
  server.app.plugins.register({id:'rate-fixture',name:'合成限流来源',capabilities:['subscription.source'],
    permissions:['contribute:connectors','service.provide:'+service],activate(context){
      context.contribute('connectors','read',{kind:'subscription-source',name:'离线限流连接器',resourceLabel:'集合',service});
      context.contribute('services','read',{name:service,version:1,readOnly:true,async handler(){
        reads++;
        throw Object.assign(new Error('synthetic rate limit'),{sourceReadCode:'rate_limited',retryAfterSeconds:120,status:429});
      }});
    }});
  await server.app.plugins.setEnabled('rate-fixture',true);
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#memory?token=offline-delay');
  await page.getByRole('button',{name:'来源订阅',exact:true}).click();
  const drawer=page.getByRole('dialog',{name:'来源订阅'});
  await drawer.getByLabel('来源连接器').selectOption(service);
  await drawer.getByLabel('集合').fill('local');
  const limited=page.waitForResponse(res=>res.url().endsWith('/source-subscriptions/preview'));
  await drawer.getByRole('button',{name:'预览来源'}).click();
  const limitedResponse=await limited;
  assert.equal(limitedResponse.status(),429);
  const previewRetryAt=(await limitedResponse.json()).retryAt;
  await expect(drawer.getByRole('status').locator('time')).toHaveAttribute('datetime',previewRetryAt);
  assert.equal(server.app.subscriptions.service().list().length,0);
  const subscription=server.app.subscriptions.service().create({sourceId:service,resource:'local',
    name:'限流样本',destinations:['inbox'],intervalMinutes:60});
  const row=page.getByRole('article',{name:'限流样本'});
  await expect(row).toContainText('等待期间，立即拉取可补投此前已收到的条目');
  const response=await page.request.get(server.url+'/api/v1/source-subscriptions',{
    headers:{Authorization:'Bearer offline-delay'}});
  const retryAt=(await response.json()).subscriptions.find((item:{id:string})=>item.id===subscription.id).retryAt;
  assert.ok(Date.parse(retryAt)>Date.now());
  await expect(row.locator('time')).toHaveAttribute('datetime',retryAt);
  const localTime=await page.evaluate(time=>new Date(time).toLocaleString('zh-CN',{timeZoneName:'short'}),retryAt);
  await expect(row.locator('time')).toHaveText(localTime);
  server.app.store.put('source.subscription-pending',subscription.id,[{id:'cached-item',title:'补投合成样本',text:'合成正文'}]);
  const pull=page.waitForResponse(res=>res.url().endsWith('/'+subscription.id+'/pull'));
  await row.getByRole('button',{name:'立即拉取'}).click();await pull;
  assert.equal(reads,1);
  const inbox=await page.request.get(server.url+'/api/v1/inbox',{headers:{Authorization:'Bearer offline-delay'}});
  assert.ok((await inbox.json()).some((item:{title:string})=>item.title==='补投合成样本'));
});

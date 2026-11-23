import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('主人设置个人采集编辑历史，按需查看旧正文，权限变化立即清空', {timeout:35000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-history-web-'));
  const token='test-only-personal-history';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true,token});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const source='feishu:cli_fixture:ou_fixture';
  const row={id:'synthetic-edit',source,thread:'feishu:message:'+JSON.stringify(['oc_fixture','om_fixture']),last:'om_fixture',sender:'合成人员',
    title:'编辑历史合成消息',text:'当前正文',tier:'fyi',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1,
    origin:{kind:'direct',connector:'飞书',chatId:'oc_fixture'}};
  server.app.store.put('inbox',row.id,row);
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  let config={source,accountKey:'synthetic-a',enabled:false,revision:0},oldReads=0;
  const old='历史样例 <b>旧正文</b>';
  const writes:unknown[]=[];
  await page.route('**/api/v1/feishu/personal',r=>r.fulfill({json:{status:'connected',enabled:false,demo:false,account:{name:'测试账号'}}}));
  await page.route('**/feishu/personal/edit-history',async r=>{
    if(r.request().method()==='PUT'){
      const change=r.request().postDataJSON();writes.push(change);
      config={...config,enabled:change.enabled,revision:config.revision+1};
    }
    await r.fulfill({json:config});
  });
  await page.route('**/inbox/'+row.id+'/edit-history',r=>{
    oldReads++;
    if(oldReads===2) return r.fulfill({json:{versions:[],truncated:false}});
    if(oldReads===3) return r.fulfill({status:403,json:{error:'读取旧版本的权限已失效'}});
    return r.fulfill({json:{versions:[{text:old,replacedAt:'2026-10-01T01:02:03Z'}],truncated:true}});
  });
  await page.goto(server.url+'/#channels?token='+token);
  await page.locator('#channel-collect').getByRole('button',{name:'个人消息编辑历史'}).click();
  const settings=page.getByRole('dialog',{name:'个人消息编辑历史'});
  const enable=settings.getByRole('checkbox',{name:'保留消息编辑历史'});
  await expect(settings).toContainText('关闭并保存会删除该账号已保存的旧版本，重新开启也无法恢复');
  await expect(enable).not.toBeChecked();await enable.check();await settings.getByRole('button',{name:'保存设置'}).click();
  await expect.poll(()=>writes.length).toBe(1);
  assert.deepEqual(writes[0],{accountKey:'synthetic-a',enabled:true,revision:0});
  await settings.getByRole('button',{name:'关闭',exact:true}).click();
  await page.goto(server.url+'/#inbox?item='+row.id);
  const drawer=page.getByRole('dialog',{name:'收件箱消息详情'}),toggle=drawer.getByText('查看消息编辑历史',{exact:true});
  await expect(toggle).toBeVisible();assert.equal(oldReads,0);
  await toggle.click();await expect(drawer).toContainText(old);
  await expect(drawer).toContainText('仅显示部分');await expect(drawer.locator('b')).toHaveCount(0);
  await toggle.click();await expect(drawer).not.toContainText(old);
  await toggle.click();await expect(drawer).toContainText('没有保存的旧版本');
  await toggle.click();await toggle.click();await expect(drawer.getByRole('alert')).toContainText('读取旧版本的权限已失效');
  await drawer.getByRole('button',{name:'重新读取旧版本'}).click();await expect(drawer).toContainText(old);
  config={...config,source:'feishu:cli_fixture:ou_other',accountKey:'synthetic-b'};
  server.app.events.publish('feishu.edit-history.changed',{accountChanged:true});
  await expect(toggle).toBeHidden();await expect(drawer).not.toContainText(old);assert.equal(oldReads,4);
  config={...config,source,accountKey:'synthetic-a'};
  server.app.events.publish('feishu.edit-history.changed',{accountChanged:true});
  await toggle.click();await expect(drawer).toContainText(old);
  const disabled=await page.request.post(server.url+'/api/v1/plugins/feishu-edit-history',{headers:{authorization:'Bearer '+token},data:{enabled:false}});
  assert.equal(disabled.status(),200);await expect(toggle).toBeHidden();await expect(drawer).not.toContainText(old);
});

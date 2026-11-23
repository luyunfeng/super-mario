import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('个人收件按需读取同会话置顶，核对原文、写回执和当前账号',{timeout:35000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-pins-')),token='synthetic-pins-owner';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true,token});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const source='feishu:cli_fixture:ou_fixture',accountKey='synthetic-account',chatId='oc_fixture';
  for(const [id,messageId,title] of [['first','om_first','原始合成收件'],['second','om_local','关联的本地原文']] as const){
    server.app.store.put('inbox',id,{id,source,title,text:title,thread:'feishu:message:'+JSON.stringify([chatId,messageId]),last:messageId,
      createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1,tier:'fyi',origin:{kind:'direct',connector:'飞书',chatId}});
  }
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
  const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  let accountSource=source;
  await page.route('**/api/v1/feishu/personal',r=>r.fulfill({json:{source:accountSource,accountKey,status:'connected'}}));
  let pinned=false,reads=0;const writes:{accountKey:string;action:string;messageId:string;requestId:string}[]=[];
  const access='/api/v1/inbox/first/pins';
  let delayTopic:Promise<void>|undefined, topicReads=0;
  await page.route(server.url+access+'**',async r=>{
    const req=r.request(),url=new URL(req.url());
    if(url.pathname.endsWith('/original')){
      assert.equal(url.searchParams.get('accountKey'),accountKey);
      if(url.pathname.includes('om_hit'))return r.fulfill({json:{chatId,deleted:false,messageId:'om_hit',text:'定位的合成回复',threadId:'omt_topic',inboxId:'second'}});
      return r.fulfill({json:url.pathname.includes('om_local')?{chatId,deleted:false,messageId:'om_local',inboxId:'second'}:
        {chatId,deleted:false,messageId:'om_remote',text:'合成远端置顶原文'}});
    }
    if(url.pathname.endsWith('/topic')){
      topicReads++;
      assert.equal(url.searchParams.get('accountKey'),accountKey);
      if(delayTopic) await delayTopic;
      if(url.searchParams.has('cursor')){
        assert.equal(url.searchParams.get('cursor'),'opaque+page/2');
        return r.fulfill({json:{threadId:'omt_topic',messages:[{messageId:'om_hit',text:'定位的合成回复',deleted:false},{messageId:'om_old',text:'禁止显示的已撤回正文',deleted:true}]}});
      }
      return r.fulfill({json:{threadId:'omt_topic',root:{messageId:'om_root',text:'合成话题发起',deleted:false},
        messages:[{messageId:'om_one',text:'第一页回复',senderName:'合成发言人',createdAt:'2026-10-12T08:00:00Z',deleted:false}],nextCursor:'opaque+page/2'}});
    }
    if(req.method()==='POST'){
      const payload=req.postDataJSON();writes.push(payload);
      pinned=payload.action==='pin';
      if(writes.length===1)return r.fulfill({status:502,json:{error:'合成超时',code:'PIN_DELIVERY_UNKNOWN'}});
      return r.fulfill({json:{confirmed:true,messageId:payload.messageId,action:payload.action}});
    }
    reads++;
    if(url.searchParams.has('cursor')){
      assert.equal(url.searchParams.get('cursor'),'second-page');
      return r.fulfill({json:{accountKey,pins:[{messageId:'om_remote',text:'远端摘要'},{messageId:'om_hit',text:'话题内置顶摘要',inboxId:'second'}]}});
    }
    return r.fulfill({json:{accountKey,pins:[
      ...(pinned?[{messageId:'om_first',text:'原始合成收件'}]:[]),
      {messageId:'om_local',text:'合成本地摘要',inboxId:'second'}],nextCursor:'second-page'}});
  });
  await page.goto(server.url+'/#inbox?token='+token+'&item=first');
  const drawer=page.getByRole('dialog',{name:'收件箱消息详情'}),summary=drawer.getByText('查看会话置顶',{exact:true});
  await expect(summary).toBeVisible();assert.equal(reads,0);
  await summary.click();
  const pins=summary.locator('..'),more=pins.getByRole('button',{name:'加载更多置顶'});
  await more.click();
  await pins.locator('article').filter({hasText:'远端摘要'}).getByRole('button',{name:'查看原文'}).click();
  await expect(pins.getByRole('region',{name:'置顶消息原文'})).toContainText('合成远端置顶原文');
  const locateTopic=pins.locator('article').filter({hasText:'话题内置顶摘要'}).getByRole('button',{name:'查看原文'});
  await locateTopic.click();
  const topic=pins.getByRole('region',{name:'置顶消息话题'});
  await expect(topic).toContainText('合成话题发起');await expect(topic).toContainText('第一页回复');
  await expect(topic).toContainText('合成发言人');await expect(topic.locator('time')).toHaveAttribute('datetime','2026-10-12T08:00:00Z');
  await expect(topic.locator('mark')).toBeFocused();assert.equal(topicReads,1);
  await topic.getByRole('button',{name:'加载更多回复'}).click();
  await expect(topic).toContainText('原消息已撤回。');await expect(topic).not.toContainText('禁止显示的已撤回正文');
  await expect(topic.getByText('定位的合成回复',{exact:true})).toHaveCount(1);
  const pin=pins.getByRole('button',{name:'置顶这条消息'});
  await pin.click();
  const confirm=page.getByRole('dialog',{name:'确认置顶这条消息'});
  await confirm.getByRole('button',{name:'取消',exact:true}).click();assert.equal(writes.length,0);
  await pin.click();await confirm.getByRole('button',{name:'置顶这条消息'}).click();
  await expect(pins).toContainText('操作结果未知');
  await pins.getByRole('button',{name:'刷新置顶列表'}).click();
  const listed=pins.locator('article').filter({hasText:'原始合成收件'});
  await listed.getByRole('button',{name:'取消置顶'}).click();
  await page.getByRole('dialog',{name:'确认取消置顶'}).getByRole('button',{name:'取消置顶'}).click();
  await expect(listed).toHaveCount(0);
  assert.deepEqual(writes.map(({accountKey,action,messageId})=>({accountKey,action,messageId})),[
    {accountKey,action:'pin',messageId:'om_first'},{accountKey,action:'unpin',messageId:'om_first'}]);
  assert.ok(writes.every(w=>!!w.requestId));
  const oldPin=pins.locator('article').filter({hasText:'合成本地摘要'});
  await oldPin.getByRole('button',{name:'取消置顶'}).click();
  await expect(page.getByRole('dialog',{name:'确认取消置顶'})).toBeVisible();
  accountSource='feishu:cli_fixture:ou_other';server.app.events.publish('feishu.edit-history.changed',{accountChanged:true});
  await expect(page.getByRole('dialog',{name:'确认取消置顶'})).toHaveCount(0);
  await expect(summary).toBeHidden();await expect(drawer).not.toContainText('合成本地摘要');
  accountSource=source;server.app.events.publish('feishu.edit-history.changed',{accountChanged:true});
  await summary.click();
  await more.click();
  let release!:()=>void;delayTopic=new Promise(resolve=>{release=resolve;});
  await locateTopic.click();await expect.poll(()=>topicReads).toBe(3);
  accountSource='feishu:cli_fixture:ou_other';server.app.events.publish('feishu.edit-history.changed',{accountChanged:true});
  await expect(summary).toBeHidden();release();await expect(drawer).not.toContainText('合成话题发起');
  accountSource=source;server.app.events.publish('feishu.edit-history.changed',{accountChanged:true});
  await summary.click();
  await pins.locator('article').filter({hasText:'合成本地摘要'}).getByRole('button',{name:'查看原文'}).click();
  await expect(drawer.getByRole('heading',{name:'关联的本地原文'})).toBeVisible();
});

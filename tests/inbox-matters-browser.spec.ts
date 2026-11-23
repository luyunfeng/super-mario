import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('收件会话展示归组原文和独立后续，完成与重开按真实版本写入，筛选隐藏其他事项',{timeout:40000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-matters-web-'));
  const token='offline-matters';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true,token});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const app=server.app,now=new Date().toISOString();
  const contents=['版本甲资料','合同乙资料','合同乙补充'];
  await app.inbox.ingest('feishu:fixture:owner',contents.map((text,i)=>({
    thread:'feishu:message:'+JSON.stringify(['oc_sample','om_'+i]),last:'om_'+i,title:'同一会话',text,receivedAt:now,
    origin:{kind:'direct' as const,chatId:'oc_sample',senderName:'合成联系人',connector:'飞书'},
  })));
  const ids=contents.map(text=>app.inbox.list().find(item=>item.text===text)!.id);
  const group=app.inboxAssistant.list()[0]!;
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#inbox?token='+token);
  const inbox=page.locator('#inbox');
  await expect(inbox.getByText('查看原始消息（3 条）')).toBeVisible();
  await expect(inbox.getByRole('region',{name:'归组事项'})).toHaveCount(0);
  const matters=[{id:'version',title:'甲版本确认',summary:'甲的工作进展',tier:'action',urgent:true,reason:'今日需要确认',messageIds:[ids[0]]},
    {id:'contract',title:'乙合同确认',summary:'乙的工作进展',tier:'fyi',messageIds:ids.slice(1),continues:'version'}];
  app.store.put('inbox.assistant',group.id,{id:group.id,version:1,inputHash:'fixture',status:'watching',tasks:{},updatedAt:now,matters});
  app.events.publish('inbox.assistant.changed',{});
  const region=inbox.getByRole('region',{name:'归组事项'});
  const first=region.getByRole('article',{name:'甲版本确认'}),next=region.getByRole('article',{name:'乙合同确认'});
  await expect(first).toContainText('甲的工作进展');
  await expect(first.getByText('紧急',{exact:true})).toBeVisible();
  await expect(first).toContainText('分级依据：今日需要确认');
  await expect(next.getByText('紧急',{exact:true})).toHaveCount(0);
  await expect(next).not.toContainText('分级依据');
  await expect(next).toContainText('接续事项：甲版本确认（未完成）');
  const search=inbox.getByRole('searchbox',{name:'搜索收件箱'});
  await search.fill('乙的工作进展');
  await expect(next).toBeVisible();await expect(first).toHaveCount(0);
  await search.fill('合同乙');
  await expect(first).toHaveCount(0);
  await expect(next).not.toContainText('甲版本确认');
  await search.fill('合同乙补充');
  await expect(region).toHaveCount(0);
  await search.fill('');
  await next.getByText('事项原文（2 条）',{exact:true}).click();
  await expect(next).toContainText(contents[1]!);await expect(next).not.toContainText(contents[0]!);
  await next.getByRole('button',{name:'打开原始收件'}).first().click();
  const detail=page.getByRole('dialog',{name:'收件箱消息详情'});
  await expect(detail).toContainText(contents[1]!);
  await detail.getByRole('button',{name:'关闭',exact:true}).last().click();

  const target='/inbox/conversations/'+group.id+'/matters/version';
  const firstResponse=page.waitForResponse(response=>response.url().endsWith(target) && response.request().method()==='POST');
  await first.getByRole('button',{name:'标记事项完成'}).click();
  const confirmed=await firstResponse;
  assert.equal(confirmed.status(),200);
  const stale=confirmed.request().postDataJSON().version;
  const headers={Authorization:'Bearer '+token};
  const url=server.url+'/api/v1'+target;
  assert.equal((await page.request.post(url,{headers,data:{version:stale,done:false}})).status(),409);
  assert.equal((await page.request.post(url,{data:{version:stale,done:false}})).status(),401);
  await expect(next).toContainText('接续事项：甲版本确认（已完成）');
  await expect(next.getByRole('button',{name:'标记事项完成'})).toBeVisible();
  await page.reload();
  await expect(first.getByRole('button',{name:'重新打开事项'})).toBeVisible();
  await first.getByRole('button',{name:'重新打开事项'}).click();
  await expect(next).toContainText('接续事项：甲版本确认（未完成）');
  assert.equal(app.inbox.list().filter(item=>item.archivedAt).length,0);
  assert.equal(app.todos().length,0);
  // A malformed old FYI mark cannot turn an informational matter into an urgent one.
  const row=app.store.get<{version:number;matters:typeof matters}>('inbox.assistant',group.id)!;
  app.store.put('inbox.assistant',group.id,{...row,version:row.version+1,
    matters:row.matters.map(matter=>matter.id==='contract'?{...matter,urgent:true,reason:'仅供知会'}:matter)});
  app.events.publish('inbox.assistant.changed',{});
  await expect(next).toContainText('分级依据：仅供知会');
  await expect(next.getByText('紧急',{exact:true})).toHaveCount(0);
});

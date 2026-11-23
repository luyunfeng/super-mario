import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('原始收件分组列出回应，核实本人状态后增删、处理未知与换号',{timeout:35000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-reactions-')),token='synthetic-reaction-owner';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true,token});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const chatId='oc_test',messageId='om_test',source='feishu:cli_test:ou_test',accountKey='fixture-account';
  server.app.store.put('inbox','test',{id:'test',source,title:'合成收件',text:'合成原文',thread:'feishu:message:'+JSON.stringify([chatId,messageId]),
    last:messageId,updatedAt:new Date().toISOString(),createdAt:new Date().toISOString(),version:1,tier:'fyi',origin:{kind:'direct',connector:'飞书',chatId}});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
  const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  let accountSource=source,reads=0,recalled=false,mine: string|undefined;
  const writes:{action:string;emoji:string;requestId:string;accountKey:string}[]=[];
  await page.route('**/api/v1/feishu/personal',r=>r.fulfill({json:{source:accountSource,accountKey}}));
  const other={emoji:'THUMBSUP',operatorId:'ou_synthetic',operatorType:'user',mine:false,reactionId:'r1'};
  await page.route('**/api/v1/inbox/test/reactions**',r=>{
    if(r.request().method()==='POST'){
      const value=r.request().postDataJSON();writes.push(value);mine=value.action==='add'?value.emoji:undefined;
      return writes.length===1?r.fulfill({status:502,json:{error:'合成网络中断',code:'REACTION_DELIVERY_UNKNOWN'}}):
        r.fulfill({json:{confirmed:true,action:value.action,emoji:value.emoji}});
    }
    reads++;
    if(recalled)return r.fulfill({status:410,json:{error:'原消息已撤回'}});
    if(new URL(r.request().url()).searchParams.get('cursor')==='next'){
      return r.fulfill({json:{accountKey,items:[other,...(mine?[{...other,emoji:mine,reactionId:'r2',mine:true,operatorId:'ou_test'}]:[])]}});
    }
    return r.fulfill({json:{accountKey,items:[other],nextCursor:'next'}});
  });
  await page.goto(server.url+'/#inbox?token='+token+'&item=test');
  const summary=page.getByText('表情回应',{exact:true}),panel=summary.locator('..');
  await expect(summary).toBeVisible();assert.equal(reads,0);
  await summary.click();
  const group=panel.getByRole('region',{name:'回应 THUMBSUP'}),more=panel.getByRole('button',{name:'加载更多回应'});
  await expect(group.getByRole('button',{name:'回应 THUMBSUP'})).toBeEnabled();
  await expect(panel.getByRole('button',{name:'添加回应'})).toBeEnabled();
  await more.click();await group.getByText('参与者').click();await expect(group).toContainText('ou_synthetic');
  await expect(group).toContainText('· 1');
  await panel.getByRole('button',{name:'添加回应'}).click();await expect(panel).toContainText('结果未知');
  await panel.getByRole('button',{name:'刷新回应'}).click();await more.click();
  await expect(group).toContainText('· 2 · 我已回应');
  await group.getByRole('button',{name:'撤回我的 THUMBSUP'}).click();await more.click();await expect(group).toContainText('· 1');
  await expect(group).not.toContainText('我已回应');
  assert.deepEqual(writes.map(w=>[w.accountKey,w.emoji,w.action]),[[accountKey,'THUMBSUP','add'],[accountKey,'THUMBSUP','remove']]);
  assert.equal(new Set(writes.map(w=>w.requestId)).size,2);
  const picker=panel.getByRole('combobox',{name:'选择表情'});
  await picker.selectOption('');await panel.getByRole('textbox',{name:'飞书表情名称'}).fill('FISTBUMP');
  await panel.getByRole('button',{name:'添加回应'}).click();await more.click();
  await expect(picker).toHaveValue('FISTBUMP');
  const all=panel.getByText('全部表情',{exact:true});
  await all.click();
  await expect(all.locator('..').getByRole('button')).toHaveCount(182);
  const search=panel.getByRole('searchbox',{name:'搜索表情'});
  await search.fill('灵光');await panel.getByRole('button',{name:'💡 灵光一现'}).click();
  await expect(search).toBeHidden();await expect(picker).toHaveValue('StatusFlashOfInspiration');
  await panel.getByRole('button',{name:'添加回应'}).click();await more.click();
  await expect(picker).toHaveValue('StatusFlashOfInspiration');assert.equal(writes.at(-1)?.emoji,'StatusFlashOfInspiration');
  await panel.getByRole('button',{name:'刷新回应'}).click();await expect(group).toBeVisible();
  recalled=true;await more.click();await expect(panel).toContainText('原消息已撤回');
  await expect(group).toHaveCount(0);await expect(panel).not.toContainText('ou_synthetic');
  accountSource='feishu:cli_test:ou_other';server.app.events.publish('feishu.edit-history.changed',{accountChanged:true});
  await expect(summary).toBeHidden();await expect(group).toHaveCount(0);
});

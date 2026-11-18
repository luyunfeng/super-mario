import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';
import { chromium, expect } from '@playwright/test';

async function fixture(t: test.TestContext) {
 const dataDir=await mkdtemp(join(tmpdir(),'mario-collab-http-'));const adapters=new Map<string,{options:FeishuOptions;sent:string[][]}>();
 const factory:FeishuBotFactory=options=>{const state={options,sent:[] as string[][]};adapters.set(options.appId,state);return {start:async()=>{},close:async()=>{},status:()=>({connected:true}),send:async(target,text)=>{state.sent.push([target,text]);},collect:async()=>[]};};
 const server=await startServer({dataDir,host:'127.0.0.1',port:0,demo:true,token:'local-collab-test-only'},{botFactory:factory});
 t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
 const headers={'Authorization':'Bearer local-collab-test-only','Content-Type':'application/json'};
 const request=async(path:string,method='GET',body?:unknown)=>{const res=await fetch(server.url+'/api/v1'+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json()};};
 const add=async(name:string,n:number)=>{const {status,data}=await request('/feishu/bots','POST',{name,appId:'cli_'+String(n).repeat(16),appSecret:'offline-fixture-'+name,scope:{kind:'global'},executorId:'demo',requireConfirmation:true,groupChats:[{chatId:'oc_shared',mentionOnly:true,allowedSenderIds:[]} ]});assert.equal(status,201);return data;};
 const a=await add('主协作机器人',1),b=await add('代码协作机器人',2);
 await request('/feishu/bots/'+a.id,'PATCH',{collaboration:{peerBotIds:[b.id]}});await request('/feishu/bots/'+b.id,'PATCH',{collaboration:{peerBotIds:[a.id]}});
 const bots=(await request('/feishu/bots')).data;
 for(const bot of bots){await adapters.get(bot.appId)!.options.onMessage(bot.pairingCode,{chatId:'oc_owner_'+bot.id,messageId:'om_pair_'+bot.id,senderId:'ou_owner',senderType:'user',chatType:'p2p'});adapters.get(bot.appId)!.sent.length=0;}
 return {server,request,adapters,a,b};
}
test('real HTTP collaboration uses durable confirmation, deduplicates and never treats an internal request as a group send',async t=>{
 const {server,request,adapters,a,b}=await fixture(t);
 const payload={targetBotId:b.id,text:'检查这个交付的证据，不重复执行',key:'http-collaboration'};
 assert.equal((await fetch(server.url+'/api/v1/feishu/bots/'+a.id+'/relay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).status,401);
 const first=await request('/feishu/bots/'+a.id+'/relay','POST',payload);assert.equal(first.status,201);assert.equal(first.data.status,'pending');
 const duplicate=await request('/feishu/bots/'+a.id+'/relay','POST',payload);assert.equal(duplicate.data.id,first.data.id);
 assert.equal((await request('/feishu/bots/'+a.id+'/relay','POST',{...payload,text:'different action'})).status,409);
 assert.equal((await request('/feishu/bots/'+a.id+'/relay','POST',{...payload,key:'fake-sender',sourceBotId:b.id})).status,400);
 assert.equal((await request('/feishu/bots/'+a.id+'/relay','POST',{...payload,key:'forged-source',sourceMessageId:'fake'})).status,400);
 assert.equal((await request('/feishu/bots/'+a.id+'/relay','POST',{...payload,key:'unapproved-group',chatId:'oc_elsewhere'})).status,409);
 assert.equal([...adapters.values()].flatMap(a=>a.sent).length,0);
 const accepted=await request('/mailboxes/'+first.data.id+'/confirm','POST',{version:first.data.version});assert.equal(accepted.status,200);assert.equal(accepted.data.status,'completed');
 assert.equal(server.app.store.list('feishu.bot.dispatch').length,1);
 assert.equal((await request('/mailboxes/'+first.data.id+'/confirm','POST',{version:first.data.version})).status,409);
 assert.equal([...adapters.values()].flatMap(a=>a.sent).length,0,'No chatId means internal-only, including demo result replies');
});
test('actual Web module saves robot config and submits to the real collaboration endpoint', {timeout:30000},async t=>{
 const {server,a,b,request}=await fixture(t);const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.url+'/#channels?token=local-collab-test-only');
 await page.getByText('高级：手动接入、信箱与事件',{exact:true}).click();
 await expect(page.locator('.bot-list article')).toHaveCount(2);
 const card=page.locator(`[data-bot-id="${a.id}"]`);await card.getByRole('button',{name:'编辑',exact:true}).click();
 const form=page.locator('.bot-form');await expect(form.locator('[name=executorId]')).toHaveValue('demo');
 await form.locator('[name=name]').fill('主机器人已更新');
 await form.getByRole('button',{name:'保存手动接入',exact:true}).click();
 await expect(card.locator('h3')).toHaveText('主机器人已更新');
 assert.equal((await request('/feishu/bots')).data.find((bot:any)=>bot.id===a.id).executorId,'demo');
 const relay=page.locator('.bot-relay');
 await relay.locator('[name=sourceBotId]').selectOption(a.id);await relay.locator('[name=targetBotId]').selectOption(b.id);await relay.locator('textarea').fill('来自真实Web与HTTP链路的协作请求');
 await relay.getByRole('button',{name:'提交协作请求',exact:true}).click();
 await expect(page.locator('.mailbox-list')).toContainText('来自真实Web与HTTP链路的协作请求');
 const entries=(await request('/mailboxes')).data;assert.equal(entries.filter((e:any)=>e.text==='来自真实Web与HTTP链路的协作请求').length,1);assert.equal(entries.find((e:any)=>e.text==='来自真实Web与HTTP链路的协作请求').status,'pending');
 assert.deepEqual(errors,[]);
});

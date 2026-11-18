import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import type {Todo} from '../packages/protocol/src/index.ts';

test('real browser arms observed direct-reply tracking and reflects an actual source callback without completing the Todo',{timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mario-reply-real-web-'));const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'local-web'});const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 try{
  const source='feishu:offline-app:offline-user',createdAt=new Date(Date.now()-60000).toISOString();
  server.app.waitingReplies.observeSource(source,[{source,chatId:'chat',messageId:'question',senderId:'me',senderIdType:'open_id',createdAt,preview:'请确认项目交付',label:'我'},{source,chatId:'chat',messageId:'peer',senderId:'other',senderIdType:'open_id',createdAt,preview:'此前会话',label:'项目同事'}]);
  const todo=server.app.createTodo({title:'等同事确认交付',waitingOn:'项目同事',reminderAt:new Date(Date.now()+3600000).toISOString()});
  const anchor=server.app.waitingReplies.sources(todo.id).items.find(x=>x.messageId==='question')!;
  const page=await browser.newPage({viewport:{width:390,height:844}});await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.url+'/#projects/all/todos?token=local-web');await expect(page.getByRole('button',{name:'跟踪回复',exact:true})).toBeVisible();await page.getByRole('button',{name:'跟踪回复',exact:true}).click();
  const drawer=page.getByRole('dialog',{name:'跟踪回复',exact:true});await drawer.getByRole('searchbox',{name:'查找跟进消息'}).fill('请确认项目交付');await drawer.getByRole('button',{name:'查找消息',exact:true}).click();await drawer.getByLabel('原消息',{exact:true}).selectOption(anchor.id);await drawer.getByLabel('等待谁',{exact:true}).selectOption(JSON.stringify(['open_id','other']));await drawer.getByRole('button',{name:'跟踪所选回复',exact:true}).click();await expect(drawer).toContainText('等待回复 · 第 1 轮');
  await delay(5);const result=server.app.waitingReplies.observeSource(source,[{source,chatId:'chat',messageId:'real-answer',parentId:'question',senderId:'other',senderIdType:'open_id',createdAt:new Date().toISOString()}]);assert.equal(result.matched,1);
  await expect(drawer).toContainText('本轮提醒已停止');await expect(drawer).toContainText('real-answer');assert.equal(server.app.store.get<Todo>('todos',todo.id)!.completedAt,undefined);assert.equal(server.app.store.get<Todo>('todos',todo.id)!.reminderAt,undefined);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 }finally{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});}
});

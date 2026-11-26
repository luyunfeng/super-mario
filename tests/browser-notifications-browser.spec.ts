import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect,type Page} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

// The page reports itself as being in the background, and system notifications are recorded.
type Shown = {title:string;body:string;tag:string;silent:boolean;onclick?:()=>void};
// Runs inside the page: the page reports itself as being in the background, and system
// notifications are recorded instead of being shown by the OS.
const background = () => {
  const w = window as unknown as {__shown:Shown[];Notification:unknown};
  w.__shown=[];
  localStorage.setItem('sm.splash.seen','true');
  Object.defineProperty(document,'visibilityState',{get:()=>'hidden'});
  document.hasFocus=()=>false;
  class FakeNotification {
    static permission='granted';
    title:string;
    constructor(title:string,options:object){this.title=title;Object.assign(this,options);w.__shown.push(this as unknown as Shown);}
    close(){}
  }
  w.Notification=FakeNotification;
};
const shown = (page:Page) => page.evaluate(() => (window as unknown as {__shown:Shown[]}).__shown
  .map(({title,body,tag,silent})=>({title,body,tag,silent})));

test('页面不在前台时弹出系统通知，多标签页只弹一次，点通知回到来源',{timeout:40000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-browser-notice-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const context=await browser.newContext();
  await context.addInitScript(background);
  const notice=(id:string,extra:object={})=>server.app.events.publish('browser.notice',{id,kind:'needed',title:'需要你回答',text:'合成提问\n第二行',href:'#chat?interaction=synthetic',createdAt:new Date().toISOString(),...extra});
  const page=await context.newPage();
  // Results wait 20 s before notifying in the product. Shorten that for the test.
  await page.route('**/js/features/browser-notifications.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:(await response.text()).replace('doneDelayMs = DONE_DELAY_MS','doneDelayMs = 200')});
  });
  await page.goto(server.url+'/#home');
  await page.evaluate(()=>localStorage.setItem('sm.browser-notifications',JSON.stringify({enabled:false})));
  await page.reload();
  notice('disabled');
  await new Promise(resolve=>setTimeout(resolve,600));
  assert.equal((await shown(page)).length,0,'关闭时不弹');

  await page.evaluate(()=>localStorage.setItem('sm.browser-notifications',JSON.stringify({enabled:true,done:'always'})));
  await page.reload();
  notice('needed');
  await expect.poll(async()=>(await shown(page)).length).toBe(1);
  assert.deepEqual(await shown(page),[{title:'需要你回答',body:'合成提问 第二行',tag:'needed',silent:false}]);
  notice('needed');
  notice('done',{kind:'done',title:'执行已结束',text:'合成结果',href:'#projects/all/runs/synthetic'});
  // The duplicate is dropped. The result waits its delay, then shows once.
  await expect.poll(async()=>(await shown(page)).map(n=>n.tag)).toEqual(['needed','done']);

  // Two tabs of one browser receive the same notice. Only one shows it.
  const second=await context.newPage();
  await second.goto(server.url+'/#home');
  notice('two-tabs',{title:'第二条提问'});
  await expect.poll(async()=>(await shown(page)).length+(await shown(second)).length).toBe(2);
  await new Promise(resolve=>setTimeout(resolve,900));
  assert.equal((await shown(page)).length+(await shown(second)).length,3,'过一会儿没看才提醒执行结果，且只提醒一次');

  const before=page.url().split('#')[0];
  await page.evaluate(id=>(window as unknown as {__shown:Shown[]}).__shown.find(n=>n.tag===id)!.onclick!(),'needed');
  assert.equal(page.url(),before+'#chat?interaction=synthetic');
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import type { Json, JsonObject, Run } from '../packages/protocol/src/index.ts';

test('原执行提问可先索要背景，刷新保留勾选及补充文字，并按最新版本手答', {timeout:40000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'run-question-context-web-'));
  const token='fixture-context';
  const server=await startServer({host:'127.0.0.1',port:0,demo:true,dataDir,token});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const {app}=server;
  const writes:JsonObject[]=[];
  const machineId='fixture-context-node';
  app.setMachineClient({
    list:()=>[{id:machineId,name:'合成执行机',online:true,platform:'linux',connectedAt:new Date().toISOString(),capabilities:['executor.start','executor.input'],
      executors:[{id:'codex',machineId,name:'内存替身',kind:'cli',mode:'real',available:true,description:'接收合成数据'}]}],
    async call(_machine,method,params):Promise<Json>{
      if(method==='executor.start') return {sessionId:'synthetic-session'};
      assert.equal(method,'executor.input');writes.push(params);return {requested:true};
    },
  });
  const run=app.dispatch({prompt:'准备草稿',cwd:dataDir,executionMode:'interactive',executorId:machineId+'/codex'});
  await t.waitFor(()=>assert.ok(app.store.get<Run>('runs',run.id)?.sessionId));
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  const form=await page.request.post(server.url+'/api/v1/interactions',{headers:{Authorization:'Bearer '+token},
    data:{kind:'question',title:'草稿顺序',body:'选择排列方式',runId:run.id,reversible:true,deadline:'5m',
      questions:[{question:'排列方式',options:[{label:'按部门'},{label:'按日期'}],recommend:'按日期'}]}});
  assert.equal(form.status(),201,await form.text());
  const card=await form.json() as Card;
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#chat?token='+token);
  const row=page.locator('[data-id="interaction:'+card.id+'"]');
  const chosen=row.getByLabel('按部门',{exact:true});
  const note=row.getByLabel('文字回答');
  const ask=row.getByRole('button',{name:'先告诉我背景',exact:true});
  await chosen.check();await note.fill('草稿先按部门排列');
  const path='/api/v1/interactions/'+card.id+'/context';
  await page.route('**'+path,route=>route.fulfill({status:503,json:{error:'合成暂不可用'}}),{times:1});
  await ask.click();
  await expect(row).toContainText('合成暂不可用');await expect(chosen).toBeChecked();
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  try {
    await page.route('**'+path,async route=>{
      const result=await route.fetch();
      await held;
      await route.fulfill({response:result});
    });
    const received=page.waitForResponse(res=>res.url().endsWith(path));
    await ask.click();
    await expect(row).toContainText('本轮截止默认选择已暂停');
    await expect(ask).toHaveCount(0);
    await expect(row).toContainText('执行目标：准备草稿');
    await expect(note).toBeEditable();
    await expect(chosen).toBeChecked();await expect(note).toHaveValue('草稿先按部门排列');
    app.interactions.expireTick(Date.parse(card.decisionDeadlineAt!)+1);
    assert.equal(writes.length,0);
    // Deliver the same persisted annotation that the supervisor's model would produce.
    const saved=app.store.get<Card>('interactions',card.id)!;
    app.store.put('interactions',card.id,{...saved,decisionExplanation:'本周草稿先用于部门内部核对。'});
    app.events.publish('interactions.changed',{id:card.id});
    await expect(row).toContainText('本周草稿先用于部门内部核对。');
    await expect(chosen).toBeChecked();await expect(note).toHaveValue('草稿先按部门排列');
    const answered=page.waitForResponse(res=>res.url().endsWith('/'+card.id+'/answer'));
    await row.getByRole('button',{name:'回答',exact:true}).click();
    const reply=await answered;
    assert.equal(reply.status(),200,await reply.text());
    assert.deepEqual(reply.request().postDataJSON(),{version:saved.version,answers:[{selected:['按部门'],text:'草稿先按部门排列'}]});
    assert.equal(writes.length,1);
    await expect(row).toHaveCount(0);
    release();
    const res=await received;
    assert.equal(res.status(),200,await res.text());
    assert.deepEqual(res.request().postDataJSON(),{version:card.version});
  } finally { release(); }
});

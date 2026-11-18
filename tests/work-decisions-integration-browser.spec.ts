import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium,expect,type Browser} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import {runWithAgentInput} from '../packages/core/src/agent-input.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('real Web → HTTP → SQLite decisions survive restart and stale cross-entry references are rejected', {timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mario-decisions-browser-'));let browser:Browser|undefined;
 let server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,demo:true,token:'decision-local'});
 try{
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});const page=await browser.newPage({viewport:{width:390,height:844}});await page.addInitScript(()=>{if(location.protocol==='http:')localStorage.setItem('sm.splash.seen','true');});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url+'/#memory?token=decision-local');
  const panel=page.locator('#work-decisions');await expect(panel).toBeVisible();await page.getByRole('button',{name:'新增工作决定',exact:true}).click();
  let editor=page.getByRole('dialog',{name:'新增工作决定',exact:true});await editor.getByLabel('工作决定内容').fill('交付前先检查实际结果');await editor.getByRole('button',{name:'保存决定',exact:true}).click();await expect(editor).toHaveCount(0);await expect(panel).toContainText('交付前先检查实际结果');await expect(panel).toContainText('版本 1');
  let fact=server.app.workDecisions.list().items[0]!;const source=server.app.store.get<Message>('messages',fact.source.messageId)!;assert.equal(source.role,'user');assert.equal(source.status,'done');assert.equal((await server.app.snapshot()).runs.length,0);
  await panel.getByRole('button',{name:'编辑决定',exact:true}).click();editor=page.getByRole('dialog',{name:'编辑工作决定',exact:true});await editor.getByLabel('工作决定内容').fill('交付前先检查实际结果，并附版本依据');await editor.getByRole('button',{name:'保存决定',exact:true}).click();await expect(panel).toContainText('版本 2');
  const input:Message={id:'other-entry',role:'user',conversationId:'main',text:'引用刚才决定',createdAt:new Date().toISOString(),status:'done'};server.app.store.put('messages',input.id,input);
  const reference=server.app.contributions.list('tools').find(item=>item.value.name==='work_decision_reference')!.value;
  await assert.rejects(runWithAgentInput(input,()=>reference.execute({id:fact.id,version:1},new AbortController().signal)),{status:409});
  assert.equal((await runWithAgentInput(input,()=>reference.execute({id:fact.id,version:2},new AbortController().signal)) as any).version,2);
  await page.goto('about:blank');await server.close();server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,demo:true,token:'decision-local'});
  await page.goto(server.url+'/#memory?token=decision-local');await expect(panel).toContainText('版本 2');await expect(panel).toContainText('并附版本依据');
  await panel.getByRole('button',{name:'撤回决定',exact:true}).click();await page.getByRole('button',{name:'确认撤回',exact:true}).click();await expect(panel).toContainText('已撤回');await expect(panel).toContainText('版本 3');
  fact=server.app.workDecisions.list().items[0]!;assert.equal(fact.status,'withdrawn');assert.equal(fact.version,3);assert.equal(server.app.store.list('work.decision-revisions').length,3);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await server.close();await rm(dir,{recursive:true,force:true});}
});

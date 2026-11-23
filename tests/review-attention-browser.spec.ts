import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('首页需要我和对话待验收卡定位原项目交付，打开只读，过时证据链接无法确认',{timeout:40000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'attention-review-')),token='synthetic-attention-review';
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,demo:true,token});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  const page=await browser.newPage(),headers={Authorization:'Bearer '+token},base=server.url+'/api/v1';
  const executorId='synthetic-local-review';
  server.app.contributions.add('executors',executorId,{id:executorId,name:'本地合成执行者',mode:'real',kind:'fixture',machineId:'local-fixture',available:true,description:'仅产生本地合成结果',
    async execute({prompt}){return {text:'合成已交付证据 '+prompt};}});
  const create=async(path:string,data:Record<string,unknown>,status:number)=>{
    const response=await page.request.post(base+path,{headers,data});assert.equal(response.status(),status,await response.text());return response.json();
  };
  const project=await create('/projects',{name:'优先事项验收项目'},201);
  const todo=await create('/todos',{title:'查验原验收依据',projectId:project.id},201);
  const run=await create('/runs',{executorId,projectId:project.id,todoId:todo.id,prompt:'指定的原执行',doneWhen:'原始完成标准',expectMinutes:1},202);
  await expect.poll(()=>server.app.store.get<Message>('messages','run-result:'+run.id)?.status).toBe('done');
  const review=await create('/todos/'+todo.id+'/review',{runId:run.id,version:0},200);
  const writes:string[]=[];
  page.on('request',r=>{if(r.method()!=='GET' && r.url().includes('/todos/'+todo.id+'/'))writes.push(r.url());});
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));await page.goto(server.url+'/#home?token='+token);
  const home=page.locator('#home .card').filter({has:page.getByRole('heading',{name:'需要我',exact:true})});
  const link=home.getByRole('link',{name:'待验收 · '+todo.title});
  await expect(link).toBeVisible();const href=await link.getAttribute('href');assert.ok(href);
  const hash=new URL(href,server.url).hash,query=new URLSearchParams(hash.split('?')[1]);
  assert.equal(hash.split('?')[0],'#projects/'+project.id+'/todos/detail/'+todo.id);
  assert.equal(query.get('reviewRun'),run.id);assert.equal(query.get('reviewEvidence'),review.evidenceVersion);
  await link.click();const drawer=page.getByRole('dialog',{name:'验收交付',exact:true});
  await expect(drawer).toContainText('合成已交付证据 指定的原执行');await expect(drawer.getByLabel('选择交付')).toHaveValue(run.id);
  await expect(drawer.getByRole('button',{name:'验收通过并完成待办'})).toBeEnabled();
  await drawer.getByRole('button',{name:'关闭',exact:true}).click();
  await page.goto(server.url+'/#chat');
  const card=page.locator('#attention [data-id="review:'+todo.id+'"]');
  await card.getByRole('link',{name:'查看待验收交付'}).click();await expect(drawer).toContainText('原始完成标准');
  await drawer.getByRole('button',{name:'关闭',exact:true}).click();
  server.app.store.put('messages','fixture-review-link',{id:'fixture-review-link',role:'assistant',conversationId:'main',
    createdAt:new Date().toISOString(),status:'done',text:'[查看待验收交付]('+href+')'});
  await page.goto(server.url+'/#chat');await page.reload();
  await page.locator('.msg--assistant').getByRole('link',{name:'查看待验收交付'}).click();
  await expect(drawer).toContainText('原始完成标准');
  assert.deepEqual(writes,[]);
  await page.goto(server.url+href.replace(review.evidenceVersion,'synthetic-stale'));
  await expect(drawer).toHaveCount(0);await expect(page.locator('#panel-todos')).toContainText('原交付或验收证据已变化');
  const state=await (await page.request.get(base+'/todos/'+todo.id+'/closure',{headers})).json();
  assert.equal(state.review.status,'pending');assert.equal(state.review.version,review.version);assert.deepEqual(writes,[]);
});

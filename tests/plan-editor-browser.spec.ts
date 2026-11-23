import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('待确认计划可修改各项，关闭保留草稿，最终确认仅提交变更并派发', {timeout:30000}, async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'plan-edits-')),token='synthetic-plan-editor';
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,demo:true,token});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  const page=await browser.newPage(),headers={Authorization:'Bearer '+token};
  const received: Array<string | undefined> = [];
  server.app.contributions.add('executors','plan-model-fixture',{
    id:'plan-model-fixture',name:'测试执行者',machineId:'fixture',kind:'cli',mode:'demo',available:true,description:'',supportsModel:true,
    async execute(request){ received.push(request.model); return {text:'合成回执'}; },
  });
  const tasks=[{prompt:'核对样例',doneWhen:'返回报告',expectMinutes:5,executorId:'plan-model-fixture',model:'model-a'},{prompt:'归纳结论',doneWhen:'有结果',executorId:'plan-model-fixture',model:'model-b'}];
  const proposed=await page.request.post(server.url+'/api/v1/plans',{headers,data:{title:'演示任务计划',tasks}});
  assert.equal(proposed.status(),201);const plan=await proposed.json();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));await page.goto(server.url+'/#chat?token='+token);
  const endpoint=server.url+'/api/v1/plans/'+plan.id+'/start',posts:unknown[]=[];
  page.on('request',req=>{if(req.method()==='POST' && req.url()===endpoint)posts.push(req.postDataJSON());});
  const card=page.locator('#attention [data-id="plan:'+plan.id+'"]'),drawer=page.getByRole('dialog',{name:'修改待执行计划'});
  await card.getByRole('button',{name:'改一下'}).click();
  const first=drawer.getByRole('group',{name:'任务 1'}),second=drawer.getByRole('group',{name:'任务 2'});
  await expect(first.getByLabel('执行内容')).toHaveValue(tasks[0]!.prompt);
  await first.getByLabel('完成标准').fill('逐项对照并记录差异');await second.getByLabel('预计分钟').fill('17');
  await first.getByLabel('本次执行模型').fill('model-c');
  await second.getByLabel('本次执行模型').fill('');
  await drawer.getByRole('button',{name:'保留草稿并关闭'}).click();
  await expect(drawer).toHaveCount(0);
  assert.deepEqual(posts,[]);assert.equal(server.app.plans.get(plan.id).status,'pending');assert.equal(server.app.store.list('runs').length,0);
  await card.getByRole('button',{name:'改一下'}).click();await expect(first.getByLabel('完成标准')).toHaveValue('逐项对照并记录差异');
  await expect(second.getByLabel('预计分钟')).toHaveValue('17');
  await expect(first.getByLabel('本次执行模型')).toHaveValue('model-c');
  await expect(second.getByLabel('本次执行模型')).toHaveValue('');
  const accept=drawer.getByRole('button',{name:'确认并开始执行'});
  await first.getByLabel('工作目录').fill('相对目录');await accept.click();await expect(drawer.getByRole('status')).toContainText('绝对路径');assert.deepEqual(posts,[]);
  await first.getByLabel('工作目录').fill('');
  const response=page.waitForResponse(r=>r.url()===endpoint && r.request().method()==='POST');
  await accept.click();const started=await response;assert.equal(started.status(),200,await started.text());
  assert.deepEqual(posts,[{version:plan.version,edits:[{index:0,doneWhen:'逐项对照并记录差异',model:'model-c'},{index:1,expectMinutes:17,model:''}]}]);
  const accepted=await started.json();assert.equal(accepted.status,'started');
  assert.equal(accepted.tasks[0].doneWhen,'逐项对照并记录差异');assert.equal(accepted.tasks[1].estimateSource,'override');
  await expect(drawer).toHaveCount(0);assert.equal(server.app.store.list('runs').length,2);
  await expect.poll(()=>received.length).toBe(2);
  assert.ok(received.includes('model-c'));assert.ok(received.includes(undefined));
});

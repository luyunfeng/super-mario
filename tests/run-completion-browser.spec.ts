import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Run } from '../packages/protocol/src/index.ts';

test('计划执行和待办按同一份首次回执显示用时，旧执行不推算', {timeout:40000}, async t => {
  const dir = await mkdtemp(join(tmpdir(),'mario-run-completion-web-'));
  const server = await startServer({demo:true,dataDir:dir,host:'127.0.0.1',port:0,token:'offline-timing'});
  t.after(async () => { await server.close(); await rm(dir,{recursive:true,force:true}); });
  const app = server.app, store = app.store;
  const project = app.projects.create({name:'合成计时项目'});
  const todo = app.createTodo({title:'核对首次回执',projectId:project.id});
  const reportedAt = '2025-08-01T00:07:00.000Z';
  const run: Run = {id:'timed',projectId:project.id,todoId:todo.id,conversationId:'main',executorId:'test',
    status:'completed',executionMode:'task',resultSource:'real',output:'合成产出',doneWhen:'核对完成',prompt:'计时样例',
    planEstimate:{planId:'plan',taskIndex:0,source:'override'},expectMinutes:40,
    createdAt:'2025-08-01T00:00:00.000Z',updatedAt:'2025-08-02T00:00:00.000Z'};
  store.put('runs',run.id,run);
  store.put('plans','plan',{id:'plan',version:1,status:'started',tasks:[
    {runId:run.id,todoId:todo.id,projectId:project.id,estimateSource:'override',expectMinutes:10,prompt:run.prompt}]});
  store.put('dispatch-keys','plan:plan:1:0',run.id);
  store.put('messages','run-result:timed',{id:'run-result:timed',role:'assistant',origin:'result',status:'done',
    conversationId:'main',todoId:todo.id,projectId:project.id,text:'合成产出',createdAt:reportedAt});
  store.put('runs','legacy',{...run,id:'legacy',planEstimate:undefined});
  store.put('runs','unverified',{...run,id:'unverified',todoId:undefined,projectId:undefined});

  const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen','true'));
  const reads: string[] = [];
  page.on('request',request => {
    const url = new URL(request.url());
    if (/\/completion$/.test(url.pathname)) reads.push(url.pathname.split('/').at(-2) + '=' + url.searchParams.get('expectedProjectId'));
  });
  await page.goto(server.url+'/#projects/all/runs/timed?token=offline-timing');
  const timing = page.getByRole('region',{name:'计划执行完成回执'});
  await expect(timing).toContainText('实际用时 7 分钟，首派预计 10 分钟，比首派预计少用 3 分钟');
  await expect(timing.locator('time')).toHaveAttribute('datetime',reportedAt);
  await expect(timing).toContainText('real · run-result:timed');
  assert.ok(reads.includes('timed='+project.id));
  await page.goto(server.url+'/#projects/'+project.id+'/todos/detail/'+todo.id);
  const brief = page.locator('details[aria-label="交办依据"]');
  await brief.locator('summary').first().click();
  const criterion = brief.getByRole('listitem').filter({has:page.getByRole('link',{name:'来源执行 · timed',exact:true})});
  await criterion.locator('details[aria-label="验收标准变更"] summary').click();
  await expect(criterion.getByRole('region',{name:'计划执行完成回执'})).toContainText('比首派预计少用 3 分钟');
  await page.goto(server.url+'/#projects/all/runs/unverified');
  await expect(page.getByText('尚无可核实的计划完成计时。')).toBeVisible();
  assert.ok(reads.includes('unverified='));
  await page.goto(server.url+'/#projects/all/runs/legacy');
  await expect(page.getByText('尚无可核实的计划完成计时。')).toHaveCount(0);
  await expect(timing).toHaveCount(0);
  assert.ok(!reads.some(value => value.startsWith('legacy=')));

  // A todo can move without changing the Run row or its timestamps.
  await page.goto(server.url+'/#projects/all/runs/timed');
  await expect(timing).toBeVisible();
  const other = app.projects.create({name:'另一合成项目'});
  app.updateTodo(todo.id,{projectId:other.id});
  await expect(timing).toHaveCount(0);
  let release!: () => void, captured!: () => void;
  const pending = new Promise<void>(resolve => { captured = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/runs/timed/completion?*',async route => {
    const response = await route.fetch();
    assert.equal((await response.json()).completionTiming.actualMinutes,7);
    captured();
    await hold;
    await route.fulfill({response});
  });
  app.updateTodo(todo.id,{projectId:project.id});
  await pending;
  const newScope = page.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== '/api/v1/state') return false;
    const snapshot = await response.json();
    return snapshot.todos.some((item:{id:string;projectId?:string}) => item.id === todo.id && item.projectId === other.id);
  });
  app.updateTodo(todo.id,{projectId:other.id});
  await newScope;
  const completed = page.waitForResponse(response => response.url().includes('/runs/timed/completion?'));
  release();
  await completed;
  await expect(timing).toHaveCount(0);
});

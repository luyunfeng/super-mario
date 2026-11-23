import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, expect, type Page } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Run } from '../packages/protocol/src/index.ts';

async function fixture(t: test.TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'mario-work-recap-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'recap-fixture'});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(7000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  t.after(async()=>{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  const api=async(path:string)=>fetch(server.url+'/api/v1'+path,{headers:{Authorization:'Bearer recap-fixture'}});
  const open=async(hash='chat')=>{await page.goto(server.url+`/#${hash}?token=recap-fixture`);await expect(page.locator('#message-text')).toBeVisible();};
  return{server,page,api,open};
}

test('recent completion remains after viewing, follows project scope and opens actual todo execution rounds', {timeout:45000},async t=>{
 const {server,page,api,open}=await fixture(t);
 const project=server.app.projects.create({name:'验收项目'}),other=server.app.projects.create({name:'另一个项目'});
 const todo=server.app.createTodo({title:'已验收的工作',projectId:project.id});server.app.updateTodo(todo.id,{completed:true});
 const foreign=server.app.createTodo({title:'其他项目的工作',projectId:other.id});server.app.updateTodo(foreign.id,{completed:true});
 const now=new Date().toISOString();
 const run:Run={id:'recap-result',todoId:todo.id,projectId:project.id,executorId:'demo',conversationId:'main',prompt:'隔离执行结果',output:'受控执行结果，不是真实模型',resultSource:'demo',status:'completed',createdAt:now,updatedAt:now};
 server.app.store.put('runs',run.id,run);
 server.app.store.put('runs','uncertain',{...run,id:'uncertain',status:'unknown',prompt:'结果未知不能当完成'});
 await open();await page.getByRole('button',{name:'最近完成 3',exact:true}).click();
 let drawer=page.getByRole('dialog',{name:'最近完成',exact:true});
 await expect(drawer).toContainText('待办完成 2 项 · 执行结束 1 次');await expect(drawer).not.toContainText('结果未知不能当完成');
 await drawer.getByRole('button',{name:'关闭',exact:true}).click();
 await page.locator('#message-form').getByLabel('项目范围',{exact:true}).selectOption(project.id);
 await page.getByRole('button',{name:'最近完成 2',exact:true}).click();drawer=page.getByRole('dialog',{name:'最近完成',exact:true});
 await expect(drawer).not.toContainText('其他项目的工作');
 await drawer.getByRole('link',{name:'隔离执行结果',exact:true}).click();
 await expect(page).toHaveURL(/runs\/recap-result/);
 await page.goto(server.url+'/#chat');await page.getByRole('button',{name:'最近完成 2',exact:true}).click();
 drawer=page.getByRole('dialog',{name:'最近完成',exact:true});await expect(drawer.getByRole('link',{name:'隔离执行结果',exact:true})).toBeVisible();
 await drawer.getByRole('button',{name:'已验收的工作',exact:true}).click();
 const history=page.getByRole('dialog',{name:'执行历史',exact:true});await expect(history).toContainText('共 2 轮 · 待办已确认完成');
 await expect(history).toContainText('结果未知');await history.getByText('查看本轮结果',{exact:true}).first().click();
 await expect(history).toContainText('受控执行结果');
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.equal((await fetch(server.url+`/api/v1/todos/${todo.id}/history`)).status,401);
 assert.equal((await api('/todos/missing/history')).status,404);
 assert.equal((await api(`/todos/${todo.id}/history?before=foreign`)).status,400);
 assert.equal(server.app.todos().find(x=>x.id===todo.id)?.completedAt!==undefined,true);
});

test('next attention cycles and wraps without submitting, preserves drafts, handles removed cards and minimized mobile', {timeout:45000},async t=>{
 const {server,page,open}=await fixture(t);const now=new Date().toISOString();
 for(let i=1;i<=3;i++) server.app.store.put('interactions','q'+i,{id:'q'+i,version:1,kind:'question',title:'待回答问题'+i,body:'受控问题',status:'open',handler:'user',layer:'default',expiresAt:'2099-01-01T00:00:00Z',createdAt:now,updatedAt:now});
 const writes:string[]=[];page.on('request',r=>{if(r.method()!=='GET'&&/\/(answer|approve|confirm|reject)(?:\?|$)/.test(r.url()))writes.push(r.url());});
 await open();const next=page.getByRole('button',{name:'下一件待处理，共 3 件',exact:true});
 const active=()=>page.evaluate(()=>document.activeElement?.getAttribute('data-id'));
 await next.click();assert.equal(await active(),'interaction:q1');
 await page.getByLabel('回答：待回答问题1',{exact:true}).fill('保留未发出的回答');
 await next.click();assert.equal(await active(),'interaction:q2');
 await next.click();assert.equal(await active(),'interaction:q3');
 await next.click();assert.equal(await active(),'interaction:q1');
 await expect(page.getByLabel('回答：待回答问题1',{exact:true})).toHaveValue('保留未发出的回答');
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'最小化',exact:true}).click();
 await next.click();assert.equal(await active(),'interaction:q2');await expect(page.getByLabel('回答：待回答问题2',{exact:true})).toBeVisible();
 server.app.store.remove('interactions','q2');server.app.events.publish('interactions.changed',{});
 await expect(page.getByRole('button',{name:'下一件待处理，共 2 件',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'下一件待处理，共 2 件',exact:true}).click();assert.equal(await active(),'interaction:q1');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(writes,[]);
 for(const id of ['q1','q3'])server.app.store.remove('interactions',id);server.app.events.publish('interactions.changed',{});
 await expect(page.locator('#attention')).toBeHidden();
});

test('history closing invalidates late reads and failed reads expose a retry without business writes', {timeout:45000},async t=>{
 const {server,page,open}=await fixture(t);
 const todo=server.app.createTodo({title:'历史读取边界'});
 await open();await page.goto(server.url+'/#projects/all/todos');
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let slow=true;
 await page.route('**/api/v1/todos/*/history',async route=>{
   if(slow){await gate;await route.fulfill({json:{todo:{id:todo.id,title:todo.title},total:0,rounds:[]}});}
   else await route.fulfill({status:503,json:{error:'隔离读取失败'}});
 });
 await page.getByRole('button',{name:'执行历史',exact:true}).click();
 let dialog=page.getByRole('dialog',{name:'执行历史',exact:true});await expect(dialog).toContainText('正在读取');
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();slow=false;
 await page.getByRole('button',{name:'执行历史',exact:true}).click();dialog=page.getByRole('dialog',{name:'执行历史',exact:true});
 await expect(dialog).toContainText('读取失败');release();
 await expect(dialog).toContainText('隔离读取失败');await expect(dialog).not.toContainText('还没有关联执行记录');
 await page.unroute('**/api/v1/todos/*/history');await dialog.getByRole('button',{name:'重新读取历史',exact:true}).click();
 await expect(dialog).toContainText('还没有关联执行记录');assert.equal(server.app.store.list('runs').length,0);
});

test('execution comparison keeps project boundaries, opens either record and survives reload', async t => {
  const { server, page, open } = await fixture(t);
  const project = server.app.projects.create({ name: '对比项目' });
  const other = server.app.projects.create({ name: '独立项目' });
  const now = new Date().toISOString();
  const first: Run = {
    id: 'first', comparisonRunIds:['first','second'], projectId: project.id, prompt: '第一轮任务', executorId: 'demo', conversationId: 'main',
    status: 'completed', output: '第一轮交付', createdAt: now, updatedAt: now,
  };
  server.app.store.put('runs', first.id, first);
  server.app.store.put('runs', 'second', { ...first, id: 'second', progress:{phase:'tool', observedAt:now, detail:'正在核对第二份清单'}, output: '', error: '校验失败', status: 'failed', usage: { input: 10, output: 0 },
    commitChanges: { base: 'a'.repeat(40), head: 'b'.repeat(40), files: 2, added: 3, deleted: 1 } });
  server.app.store.put('runs', 'outside', { ...first, id: 'outside', projectId: other.id, output: '其他项目交付' });
  await open();
  const base = server.url + '/#projects/all/runs/first';
  await page.goto(base);
  const comparison = page.getByRole('region', { name: '执行对比' });
  await comparison.getByRole('combobox').selectOption('second');
  await expect(page).toHaveURL(/compare=second$/);
  await page.reload();
  await expect(comparison.getByRole('article')).toHaveCount(2);
  await expect(comparison.getByRole('article').first()).toContainText('第一轮交付');
  await expect(comparison.getByRole('article').last()).toContainText('校验失败');
  await expect(comparison.getByRole('article').last()).toContainText('正在核对第二份清单');
  await expect(comparison.getByRole('article').first()).toContainText('未上报结构化进展');
  await expect(comparison.getByRole('article').last()).toContainText('目录内已提交差异：2 个文件 · +3 / −1 行');
  await expect(comparison.getByRole('article').first()).toContainText('目录内已提交差异：未上报');
  await expect(comparison.getByRole('article').first()).toContainText('本次 Token：未上报');
  await expect(comparison.getByRole('article').last()).toContainText('本次 Token：输入 10 · 输出 0');
  await expect(comparison).toContainText('用量差额：有执行未上报 Token。');
  server.app.store.put('runs', first.id, {...first, usage:{input:8, output:4}});
  await page.reload();
  await expect(comparison).toContainText('所选执行相对当前执行的 Token 差额：输入 +2 · 输出 -4');
  await comparison.getByRole('link', { name: '查看执行详情' }).last().click();
  await expect(page).toHaveURL(/runs\/second$/);
  await page.goto(server.url + '/#projects/all/runs/second?compare=group');
  const grouped = comparison.getByRole('article');
  await expect(grouped.last()).toContainText('当前执行（比较基准）');
  await expect(grouped.first()).toContainText('Token 差额：输入 -2 · 输出 +4');
  await grouped.first().getByRole('link', {name:'设为比较基准'}).click();
  await expect(page).toHaveURL(/runs\/first\?compare=group$/);
  await expect(grouped.first()).toContainText('当前执行（比较基准）');
  await expect(grouped.last()).toContainText('Token 差额：输入 +2 · 输出 -4');
  await page.goBack();
  await expect(grouped.last()).toContainText('当前执行（比较基准）');
  await page.goto(base + '?compare=outside');
  await expect(comparison).toContainText('此记录无法与当前执行对比');
  await expect(comparison).not.toContainText('其他项目交付');
  await comparison.getByRole('link', { name: '关闭对比' }).click();
  await expect(page).toHaveURL(base);
  const disabled = await fetch(server.url + '/api/v1/plugins/run-comparison', {
    method: 'POST', headers: { authorization: 'Bearer recap-fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.status, 200);
  await page.goto(base + '?compare=second');
  await page.reload();
  await expect(page.getByRole('heading', { name: '第一轮任务' })).toBeVisible();
  await expect(comparison).toHaveCount(0);
  assert.equal(server.app.store.list('runs').length, 3);
});

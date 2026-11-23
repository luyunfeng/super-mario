import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

const poll=async(fn:()=>boolean)=>{for(let n=0;n<100;n++){if(fn())return;await new Promise(r=>setTimeout(r,20));}assert.fail('代理未就绪');};
test('隔离 Chromium：主/项目共用代码侧栏、Git diff、窄屏、多标签在场与摘要设置', {timeout:60000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-workbench-browser-'));const root=join(dir,'demo-project');await mkdir(root);
  await writeFile(join(root,'greeting.ts'),'export const greeting = "hello";\n');
  const git=(args:string[])=>execFileSync('git',args,{cwd:root,env:{PATH:process.env.PATH,HOME:dir,GIT_CONFIG_NOSYSTEM:'1'}});
  git(['init','-q']);git(['add','.']);git(['-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','fixture']);await writeFile(join(root,'greeting.ts'),'export const greeting = "你好，马里奥";\n');
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:join(dir,'data'),demo:true,token:'isolated-browser-workbench'});
  const node=startAgentNode({url:server.url,token:'isolated-browser-workbench',machineId:'isolated-computer',name:'隔离演示电脑',dataDir:join(dir,'node'),handlers:createProjectDiscovery({home:dir}).handlers});
  try {
    await poll(()=>server.machines.list().some(m=>m.online));
    const project=await server.app.createProject({name:'工作台体验验收（隔离演示）',workspace:{machineId:'isolated-computer',cwd:root}});
    server.app.store.put('messages','fixture-main',{id:'fixture-main',conversationId:'main',role:'assistant',text:'隔离演示：右侧可浏览绑定电脑的代码，读取不会启动模型或执行任务。',createdAt:new Date().toISOString(),status:'done'});
    server.app.store.put('messages','fixture-project',{id:'fixture-project',conversationId:`project:${project.id}:work`,projectId:project.id,role:'assistant',text:'项目对话与主对话复用代码侧栏。待办完成需要单独验收。',createdAt:new Date().toISOString(),status:'done'});
    const updatedAt=new Date().toISOString();
    for(const [id,status,prompt,output] of [['fixture-progress','running','推进代码核验',''],['fixture-ended','completed','完成隔离回归','替身验证通过，待用户验收'],['fixture-failed','failed','检查缺少配置的投递','隔离演示：未配对，不能发送']] as const) server.app.store.put('runs',id,{id,executorId:'demo',conversationId:'main',projectId:project.id,prompt,output,status,createdAt:updatedAt,updatedAt});
    const todo=server.app.createTodo({title:'已验收的隔离待办',projectId:project.id});server.app.updateTodo(todo.id,{completed:true});
    server.app.store.put('notifications.away','fixture-backlog',{id:'fixture-backlog',text:'隔离待路由消息',status:'pending',reason:'积压：没有已连接并配对的事项、项目或全局机器人'});
    const context=await browser.newContext({viewport:{width:1500,height:1000}});await context.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
    const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(7000);
    const requests:string[]=[];page.on('request',r=>{if(r.url().includes('/code?'))requests.push(r.url());});
    await page.goto(server.url+'/#chat?token=isolated-browser-workbench');await page.locator('#message-form').getByLabel('项目范围',{exact:true}).selectOption(project.id);
    await page.getByRole('button',{name:'查看代码',exact:true}).click();const side=page.locator('#chat .code-sidebar');await expect(side).toBeVisible();
    await side.getByRole('button',{name:'greeting.ts',exact:true}).click();await expect(side.locator('pre')).toContainText('你好，马里奥');
    await side.getByRole('button',{name:'Git diff',exact:true}).click();await expect(side.locator('pre')).toContainText('-export const greeting = "hello";');
    const evidence=join(process.cwd(),'docs/evidence/workbench-experience');await mkdir(evidence,{recursive:true});
    await page.screenshot({path:join(evidence,'chat-code.png'),fullPage:true});
    await page.goto(server.url+`/#projects/${project.id}/workspace`);const projectSide=page.locator('#panel-workspace .code-sidebar');
    await page.locator('#panel-workspace').getByRole('button',{name:'查看代码',exact:true}).click();await expect(projectSide).toBeVisible();
    await projectSide.getByRole('button',{name:'greeting.ts',exact:true}).click();await expect(projectSide.locator('pre')).toContainText('你好，马里奥');await page.screenshot({path:join(evidence,'project-code.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await expect(projectSide).toBeVisible();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:join(evidence,'mobile-code.png'),fullPage:true});await projectSide.getByRole('button',{name:'关闭代码'}).click();await page.setViewportSize({width:1500,height:1000});
    // Two documents have independent ids. A hidden one cannot clear the active one's lease.
    const second=await context.newPage();await second.goto(server.url+'/#chat?token=isolated-browser-workbench');await expect.poll(()=>server.app.presence.status().tabs).toBe(2);
    await second.bringToFront();await expect.poll(()=>server.app.presence.status().present).toBe(true);await second.close();await page.bringToFront();await expect.poll(()=>server.app.presence.status().present).toBe(true);
    await page.goto(server.url+'/#agent');await page.getByRole('button',{name:'简报与离场通知设置'}).click();
    const dialog=page.getByRole('dialog',{name:'简报与离场通知'});await expect(dialog).toBeVisible();await dialog.getByLabel('启用间隔简报').check();await dialog.getByLabel('间隔（小时）').fill('3');await dialog.getByLabel('时段结束').fill('20:00');
    await page.screenshot({path:join(evidence,'briefing-settings.png'),fullPage:true});await dialog.getByRole('button',{name:'保存简报设置'}).click();await expect(dialog).toHaveCount(0);
    assert.equal(server.app.briefing.settings().intervalHours,3);assert.equal(server.app.background.schedules.list().filter(s=>s.name==='interval').length,1);assert.deepEqual(server.app.background.outbox.grants(),[]);
    await page.getByRole('button',{name:'查看简报',exact:true}).click();const brief=page.getByRole('dialog',{name:'简报与提醒'});await expect(brief.getByText('推进代码核验',{exact:true})).toBeVisible();await expect(brief.getByText('检查缺少配置的投递',{exact:true})).toBeVisible();await page.screenshot({path:join(evidence,'brief-window.png'),fullPage:true});
    assert.equal(requests.length,5);assert.deepEqual(errors,[]);assert.ok(!page.url().includes('token='));
    await context.close();
  } finally {await browser.close();await node.close();await server.close();await rm(dir,{recursive:true,force:true});}
});

test('保留通知按最近时间展示，项目简报可查看同一通知',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-held-notices-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const project=await server.app.createProject({name:'简报来源项目'});
  const runId='held-source-run';
  const at=new Date(Date.now()-10000).toISOString();
  server.app.store.put('runs',runId,{id:runId,projectId:project.id,conversationId:'main',executorId:'fixture',
    prompt:'核对合成执行来源',status:'completed',output:'已生成合成结果',createdAt:at,updatedAt:at});
  for(const [id,ago] of [['earlier',60000],['latest',10000]] as const){
    server.app.store.put('notifications.away',id,{id,status:'held',projectId:project.id,...(id==='latest' && {runId}),createdAt:new Date(Date.now()-ago).toISOString(),text:'合成通知 '+id});
  }
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.goto(server.url+'/#agent');
  await page.getByRole('button',{name:'简报与离场通知设置'}).click();
  const dialog=page.getByRole('dialog',{name:'简报与离场通知'});
  await dialog.getByText('已保留的通知（2）').click();
  await expect(dialog.locator('details article p')).toHaveText(['合成通知 latest','合成通知 earlier']);
  await expect(dialog.locator('time').first()).toBeVisible();
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'查看简报',exact:true}).click();
  const brief=page.getByRole('dialog',{name:'简报与提醒'});
  await expect(brief).toContainText('低干扰保留通知 2');
  await expect(brief.getByRole('link',{name:'合成通知 earlier'})).toHaveCount(0);
  await brief.getByRole('link',{name:'合成通知 latest'}).click();
  await expect(brief).toBeHidden();
  await expect(page.getByRole('heading',{name:'核对合成执行来源',exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'结果',exact:true}).click();
  await expect(page.getByText('已生成合成结果',{exact:true}).first()).toBeVisible();
});

import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startAgentNode} from '../apps/agent-node/src/index.ts';
import {startServer} from '../apps/server/src/index.ts';
import type {Run} from '../packages/protocol/src/index.ts';

test('从最近完成继续交办只为原电脑、原项目和原生会话创建审批', {timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'recent-work-resume-')),token='synthetic-recent-resume';
  const server=await startServer({dataDir:dir,port:0,host:'127.0.0.1',demo:true,token});
  const machineId='review-node',now=new Date().toISOString(),cwd=join(dir,'project');
  const nativeId='selected-thread',executorId=machineId+'/codex';
  const session=(id:string)=>({id:'codex:'+id,executorId:'codex',nativeSessionId:id,cwd,
    observedAt:now,state:'historical',source:'session-metadata',writable:false});
  let launches=0;
  const lookup:Array<unknown>=[];
  const unexpected=async()=>{launches++;throw Error('审批尚未通过');};
  const node=startAgentNode({url:server.url,token,machineId,name:'合成执行机',dataDir:dir,
    executors:[{id:'codex',name:'协议替身',machineId,kind:'cli',mode:'real',available:true,description:'',nativeResultSources:['codex-json']}],
    handlers:{
      'agents.sessions':async()=>({sessions:[session('first-decoy'),session(nativeId)],roots:[cwd],warnings:[],truncated:false}),
      'agents.session':async input=>{lookup.push(input);return session(nativeId);},
      'executor.start':unexpected,'executor.resume':unexpected,'executor.result':async()=>({}),
    }});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await node.close();await server.close();await rm(dir,{recursive:true,force:true});});
  await expect.poll(()=>server.machines.list().some(row=>row.id===machineId && row.online)).toBeTruthy();
  const project=server.app.projects.create({name:'继续交办项目',workspace:{machineId,cwd}});
  const todo=server.app.createTodo({title:'仍在进行的待办',projectId:project.id});
  const run:Run={id:'recent-run',machineId,nativeSessionId:nativeId,projectId:project.id,todoId:todo.id,executorId,cwd,
    status:'completed',prompt:'再核对这次结果',output:'合成结果',resultSource:'codex-json',conversationId:'main',createdAt:now,updatedAt:now};
  server.app.store.put('runs',run.id,run);
  server.app.store.put('runs','no-thread',{...run,id:'no-thread',nativeSessionId:undefined,prompt:'没有原生会话'});
  const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  let submissions=0;
  page.on('request',request=>{if(request.method()==='POST' && new URL(request.url()).pathname==='/api/v1/agents/sessions/resume')submissions++;});
  await page.goto(server.url+'/#chat?token='+token);
  await page.getByRole('button',{name:'最近完成 2',exact:true}).click();
  const drawer=page.getByRole('dialog',{name:'最近完成',exact:true});
  const unavailable=drawer.locator('[data-recent-id="run:no-thread"]');
  await expect(unavailable).toContainText('没有原生会话');
  await expect(unavailable.getByRole('button',{name:'继续交办'})).toHaveCount(0);
  await drawer.locator('[data-recent-id="run:recent-run"]').getByRole('button',{name:'继续交办'}).click();
  const form=page.getByRole('dialog',{name:'申请恢复 CLI 会话'});
  await expect(form).toContainText(nativeId);
  await expect(form).not.toContainText('first-decoy');
  await expect(form.getByLabel('关联项目（可选）')).toHaveValue(project.id);
  await expect(form.getByLabel('关联待办（可选）')).toHaveValue(todo.id);
  await form.getByLabel('恢复后要做什么').fill('检查边界样例');
  await form.getByLabel('完成标准').fill('提供核对回执');
  await form.getByLabel('预计用时（分钟）').fill('4');
  await form.getByRole('checkbox',{name:'我已确认原终端已停止'}).check();
  await form.getByRole('button',{name:'提交恢复审批'}).click();
  await expect(form).toContainText('尚未执行');
  const approvals=server.app.approvals.list();
  assert.equal(approvals.length,1);
  const [approval]=approvals;
  assert.equal(approval.status,'pending');assert.equal(approval.kind,'dispatch');
  assert.deepEqual(approval.params.nativeResume,{executorId:'codex',nativeSessionId:nativeId});
  assert.equal(approval.params.projectId,project.id);assert.equal(approval.params.todoId,todo.id);
  assert.equal(approval.params.cwd,cwd);assert.equal(approval.params.executorId,executorId);
  assert.ok(lookup.length>0);
  for(const entry of lookup)assert.deepEqual(entry,{executorId:'codex',nativeSessionId:nativeId,cwd});
  await form.getByRole('button',{name:'关闭',exact:true}).click();
  await page.goto(server.url+'/#home');
  const projectSummary=page.locator('.home-project').filter({has:page.getByRole('heading',{name:project.name})});
  const ended=projectSummary.locator('p').filter({has:page.getByRole('link',{name:run.prompt,exact:true})});
  await expect(ended).toContainText('执行结束');
  await ended.getByRole('button',{name:'继续交办',exact:true}).click();
  await expect(form).toContainText(nativeId);
  await expect(form).toContainText(approval.id);
  await expect(form.getByLabel('恢复后要做什么')).toHaveValue('检查边界样例');
  await expect(form.getByRole('button',{name:'提交恢复审批'})).toBeDisabled();
  await form.getByRole('button',{name:'查看审批'}).click();
  await expect(page.getByRole('dialog',{name:'恢复申请审批'})).toContainText(approval.id+' · pending');
  assert.equal(submissions,1);assert.equal(server.app.approvals.list().length,1);
  assert.equal(launches,0);assert.equal(server.app.store.list('runs').length,2);
});

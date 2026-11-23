import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('搜索本对话按当前项目和待办返回原话，翻页后能定位旧发言，停用时关闭搜索', {timeout:45000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-search-thread-')),token='fixture-search-originals';
  const server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,demo:true,token});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  t.after(async()=>{await browser?.close();await server.close();await rm(dir,{recursive:true,force:true});});
  const project=server.app.projects.create({name:'合成历史项目'});
  const other=server.app.projects.create({name:'合成对照项目'});
  const task=server.app.createTodo({projectId:project.id,title:'对照交付'});
  const otherTask=server.app.createTodo({projectId:project.id,title:'另一项交付'});
  const conversationId='project:'+project.id+':work',query='查找标记';
  let serial=0;
  const put=(id:string,text:string,conversationId:string,projectId?:string,todoId?:string,replyTo?:string)=>{
    const message:Message={id,text,conversationId,role:replyTo?'assistant':'user',status:'done', ...(replyTo?{replyTo}:{directWebInput:true}),
      createdAt:new Date(Date.UTC(2026,0,1)+serial++*1000).toISOString(),projectId,todoId};
    server.app.store.put('messages',id,message);
  };
  server.app.store.transaction(()=>{
    for(let i=0;i<30;i++) {
      put('original-main-'+i,query+' 主对话-'+i+'。','main',project.id,undefined,i%2?'original-main-'+(i-1):undefined);
      put('original-task-'+i,query+' 任务-'+i+'。',conversationId,project.id,task.id,i%2?'original-task-'+(i-1):undefined);
    }
    put('main-other',query+' 其他项目主对话','main',other.id);
    put('main-all',query+' 全局主对话','main');
    put('project-other-task',query+' 同项目其他待办',conversationId,project.id,otherTask.id);
    put('project-all',query+' 项目普通发言',conversationId,project.id);
    put('routed-main',query+' 私聊原话','main',project.id);
    server.app.store.put('message.routes','routed-main',{channel:'feishu'});
    put('routed-answer',query+' 私聊回复','main',project.id,undefined,'routed-main');
    put('private',query+' 独立机器人原话','private:fixture');
    put('side',query+' 项目其他对话','project:'+project.id+':memory',project.id);
    put('foreign',query+' 其他项目工作对话','project:'+other.id+':work',other.id);
    // Keep the selected answer outside the project's normal 60-message history window.
    for(let i=0;i<70;i++) put('newer-'+i,'后续记录 '+i,conversationId,project.id,task.id);
  });
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const page=await browser.newPage(),headers={authorization:'Bearer '+token};
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const endpoint=server.url+'/api/v1/conversation-message-search';
  const request=(data:object)=>page.request.post(endpoint,{headers,data:{query,...data}});
  const ids=async(scope:object)=>{
    const result:string[]=[];
    let before:string|undefined;
    do {
      const response=await request({...scope,before});assert.equal(response.status(),200,await response.text());
      const payload=await response.json();
      for(const hit of payload.hits) {
        assert.ok(!result.includes(hit.id));result.push(hit.id);
        assert.ok(['assistant','user'].includes(hit.role) && hit.createdAt && hit.text.includes(query));
      }
      before=payload.nextBefore;
    } while(before);
    return result;
  };
  const mainIds=Array.from({length:30},(_,i)=>'original-main-'+(29-i));
  const taskIds=Array.from({length:30},(_,i)=>'original-task-'+(29-i));
  assert.deepEqual(await ids({conversationId:'main'}),['main-all','main-other',...mainIds]);
  assert.deepEqual(await ids({conversationId,projectId:project.id}),['project-all','project-other-task',...taskIds]);
  assert.ok((await request({conversationId,projectId:other.id})).status()>=400);
  assert.ok((await request({conversationId:'private:fixture'})).status()>=400);
  const open=page.getByRole('button',{name:'搜索本对话',exact:true}),drawer=page.getByRole('dialog',{name:'搜索本对话'});
  for(const isProject of [false,true]){
    const scope=isProject?{conversationId,projectId:project.id,todoId:task.id}:{conversationId:'main',projectId:project.id};
    const url=isProject?'#projects/'+project.id+'/workspace?todo='+task.id:'#chat?token='+token;
    await page.goto(server.url+'/'+url);
    if(!isProject) await page.locator('#message-form').getByLabel('项目范围').selectOption(project.id);
    const selected=isProject?taskIds:mainIds;
    const oldest=selected.at(-1)!;
    if(isProject) await expect(page.getByRole('log',{name:'项目对话'}).locator('[data-id="'+oldest+'"]')).toHaveCount(0);
    await open.click();
    const search=drawer.getByRole('searchbox',{name:'搜索关键词'});
    const load=page.waitForResponse(r=>r.url()===endpoint && r.request().method()==='POST');
    await search.fill(query);await search.press('Enter');
    const first=await load;assert.equal(first.status(),200,await first.text());
    assert.deepEqual(first.request().postDataJSON(),{...scope,query});
    const initial=await first.json();assert.equal(initial.hits.length,25);
    assert.deepEqual(initial.hits.map((item:Message)=>item.id),selected.slice(0,25));
    const links=drawer.getByRole('link');
    await expect(links).toHaveCount(25);
    const more=drawer.getByRole('button',{name:'加载更多'}),next=page.waitForResponse(r=>r.url()===endpoint);
    await more.click();const second=await next;
    assert.equal(second.request().postDataJSON().before,initial.nextBefore);
    assert.deepEqual((await second.json()).hits.map((item:Message)=>item.id),selected.slice(25));
    await expect(links).toHaveCount(30);await expect(more).toBeHidden();
    await links.last().click();await expect(drawer).toBeHidden();
    const log=isProject?page.getByRole('log',{name:'项目对话'}):page.locator('#messages');
    await expect(log.locator('[data-id="'+oldest+'"]')).toHaveClass(/is-search-hit/);
    if(isProject) assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('todo'),task.id);
  }
  await open.click();
  const off=await page.request.post(server.url+'/api/v1/plugins/conversation-search',{headers,data:{enabled:false}});
  assert.equal(off.status(),200);await expect(drawer).toBeHidden();await expect(open).toBeHidden();
  assert.equal((await request({conversationId,projectId:project.id})).status(),503);
});

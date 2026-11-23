import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('独立 Web 对话重试原失败答复，切换后仍定位原受理消息，归档时不可重试',{timeout:35000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'web-thread-retry-')),token='synthetic-thread-retry';
  let calls=0;
  const model=createServer(async(req,res)=>{
    for await(const _chunk of req){ /* Consume the synthetic request. */ }
    if(++calls===1){res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'原轮合成失败'}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,finish_reason] of [[{role:'assistant',content:'原线重试成功'},null],[{},'stop']]){
      res.write('data: '+JSON.stringify({id:'fixture',model:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));const addr=model.address();assert.ok(addr && typeof addr==='object');
  const server=await startServer({dataDir,port:0,host:'127.0.0.1',token,demo:false,
    model:{provider:'openai-compatible',model:'fixture',apiKey:'synthetic',baseUrl:'http://127.0.0.1:'+addr.port+'/v1'}});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await rm(dataDir,{recursive:true,force:true});});
  const page=await browser.newPage(),headers={Authorization:'Bearer '+token};
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const project=server.app.projects.create({name:'精确重试归属'}),path=server.url+'/api/v1/web-conversations',first=randomUUID(),second=randomUUID();
  for(const [id,title] of [[first,'发生失败的线程'],[second,'其他线程']]){
    assert.equal((await page.request.post(path,{headers,data:{id,title,projectId:project.id}})).status(),201);
  }
  const url=(id:string)=>server.url+'/#chat?thread='+id;
  await page.goto(url(first)+'&token='+token);
  const region=page.getByLabel('独立对话内容'),input=region.getByLabel('给独立对话发消息');
  await input.fill('合成重试输入');await input.press('Enter');
  const failed=await t.waitFor(()=>{const msg=server.app.store.list<Message>('messages').find(m=>m.conversationId==='web:'+first && m.retryable);assert.ok(msg);return msg;});
  const row=region.locator('[data-id="'+failed.id+'"]'),retry=row.getByRole('button',{name:'重试本轮'});
  await expect(retry).toBeVisible();
  const archive=async(archived:boolean)=>{
    const meta=await (await page.request.get(path+'/'+first,{headers})).json();
    assert.equal((await page.request.patch(path+'/'+first,{headers,data:{version:meta.version,archived}})).status(),200);
  };
  await archive(true);await expect(input).toBeHidden();await expect(retry).toBeHidden();await archive(false);await expect(retry).toBeVisible();
  const plugin=server.url+'/api/v1/plugins/conversation-retry';
  await page.request.post(plugin,{headers,data:{enabled:false}});await expect(retry).toBeHidden();
  await page.request.post(plugin,{headers,data:{enabled:true}});await expect(retry).toBeVisible();
  await input.fill('原线保留未发送的草稿');
  const ep=server.url+'/api/v1/messages/'+failed.id+'/retry';
  let submissions=0;
  await page.route(ep, async route=>{
    submissions++;
    assert.deepEqual(route.request().postDataJSON(),{conversationId:'web:'+first});
    const response=await route.fetch();
    assert.equal(response.status(),202);
    await route.abort('failed');
  });
  await retry.click();
  const accepted=await t.waitFor(()=>{
    const records=server.app.store.list<Message>('messages').filter(m=>m.retryOf===failed.id);
    assert.equal(records.length,1);
    return records[0];
  });
  assert.equal(accepted.projectId,project.id);
  await expect(row.getByRole('link',{name:'查看重试消息'})).toBeVisible();
  await page.goto(url(second));await expect(input).toHaveValue('');await expect(region.getByRole('link',{name:'查看重试消息'})).toHaveCount(0);
  await page.goto(url(first));await expect(input).toHaveValue('原线保留未发送的草稿');
  const link=row.getByRole('link',{name:'查看重试消息'});
  await expect(link).toHaveAttribute('href','#chat?thread='+first+'&at='+accepted.id);await link.click();
  await expect(region.locator('[data-id="'+accepted.id+'"]')).toHaveAttribute('aria-current','true');
  await expect(region).toContainText('原线重试成功');assert.equal(calls,2);assert.equal(submissions,1);
});

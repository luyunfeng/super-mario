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

test('独立对话停止按钮只中断原线待处理的本人输入，归档及历史输入不能停止',{timeout:35000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'web-thread-stop-')),token='synthetic-thread-stop';
  let started=0,closed=0;
  const model=createServer(async(req,res)=>{
    for await(const _ of req){ /* Hold each request open after consuming its body. */ }
    started++;res.on('close',()=>closed++);res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));const addr=model.address();assert.ok(addr && typeof addr==='object');
  const server=await startServer({dataDir,port:0,host:'127.0.0.1',token,demo:false,
    model:{provider:'openai-compatible',model:'fixture',apiKey:'synthetic',baseUrl:'http://127.0.0.1:'+addr.port+'/v1'}});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();model.closeAllConnections();await server.close();await new Promise<void>(resolve=>model.close(()=>resolve()));await rm(dataDir,{recursive:true,force:true});});
  const page=await browser.newPage(),headers={Authorization:'Bearer '+token};
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const path=server.url+'/api/v1/web-conversations',a=randomUUID(),b=randomUUID(),projectId=server.app.projects.create({name:'合成中断范围'}).id;
  const inputs:Message[]=[];
  for(const [id,title] of [[a,'第一条对话'],[b,'第二条对话']]){
    assert.equal((await page.request.post(path,{headers,data:{id,title,projectId}})).status(),201);
    const res=await page.request.post(path+'/'+id+'/messages',{headers:{...headers,'Idempotency-Key':randomUUID()},data:{text:'等待模型回复：'+title}});
    assert.equal(res.status(),202);inputs.push(await res.json());
  }
  await expect.poll(()=>started).toBe(2);
  const url=(id:string)=>server.url+'/#chat?thread='+id;
  await page.goto(url(a)+'&token='+token);
  const region=page.getByLabel('独立对话内容'),stop=(id:string)=>region.locator('[data-id="'+id+'"]').getByRole('button',{name:'停止本轮',exact:true});
  await expect(stop(inputs[0]!.id)).toBeVisible();
  await page.goto(url(b)+'&at='+inputs[1]!.id);await expect(stop(inputs[0]!.id)).toHaveCount(0);
  await expect(region.getByRole('button',{name:'取消排队'})).toHaveCount(0);
  const endpoint=path+'/'+b+'/messages/'+inputs[1]!.id+'/stop';
  const requested=page.waitForResponse(r=>r.request().method()==='POST' && r.url()===endpoint);
  await stop(inputs[1]!.id).click();
  const received=await requested;assert.equal(received.status(),200);assert.deepEqual(received.request().postDataJSON(),{});assert.deepEqual(await received.json(),{outcome:'requested'});
  await expect(region.locator('[data-id="'+inputs[1]!.id+'"]')).toContainText('已停止本轮');await expect(stop(inputs[1]!.id)).toHaveCount(0);
  await expect.poll(()=>closed).toBe(1);assert.equal(server.app.store.get<Message>('messages',inputs[0]!.id)?.status,'pending');
  const meta=await (await page.request.get(path+'/'+b,{headers})).json();
  assert.equal((await page.request.patch(path+'/'+b,{headers,data:{version:meta.version,archived:true}})).status(),200);
  const historicId=randomUUID();server.app.store.put('messages',historicId,{...inputs[1],id:historicId,status:'pending',text:'历史待处理登记'});
  await page.reload();await expect(region).toContainText('历史待处理登记');await expect(region.getByRole('button',{name:'停止本轮'})).toHaveCount(0);
  await page.goto(url(a));await stop(inputs[0]!.id).click();await expect.poll(()=>closed).toBe(2);
});

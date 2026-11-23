import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('主对话及项目可手动重试原失败答复，重载可查看同一回执，输入草稿仍保留', {timeout:45000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'retry-turn-web-')),token='offline-retry-fixture';
  const calls=new Map<string,number>();
  const model=createServer(async(req,res)=>{
    if(req.method!=='POST'){res.end('fixture');return;}
    let raw='';for await(const chunk of req) raw+=chunk;
    const last=JSON.stringify(JSON.parse(raw).messages.at(-1)?.content);
    const label=last.includes('项目核验')?'项目核验':'主对话核验';
    const n=(calls.get(label)||0)+1;calls.set(label,n);
    if(n===1){res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'合成模型拒绝本次输入'}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,reason] of [[{role:'assistant',content:'重试回执 '+label},null],[{},'stop']]){
      res.write('data: '+JSON.stringify({id:'synthetic',model:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:reason}]})+'\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const address=model.address();assert.ok(address && typeof address==='object');
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:false,token,
    model:{provider:'openai-compatible',model:'fixture',apiKey:'fixture',baseUrl:'http://127.0.0.1:'+address.port+'/v1'}});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await rm(dir,{force:true,recursive:true});});
  const project=server.app.projects.create({name:'重试用项目'});
  const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const headers={authorization:'Bearer '+token},base=server.url+'/api/v1';
  for(const projectTurn of [false,true]){
    const text=projectTurn?'项目核验':'主对话核验', conv=projectTurn?'project:'+project.id+':work':'main';
    const route=projectTurn?'#projects/'+project.id+'/workspace':'#chat';
    const inputText=projectTurn?text:'';
    let payload:Record<string,unknown>={text:inputText};
    if(!projectTurn) {
      const upload=await page.request.put(base+'/chat-files/uploads?conversationId=main&name=fixture.txt',{headers:{...headers,'content-type':'text/plain'},data:'合成只读输入'});
      assert.equal(upload.status(),201);payload={text:'',readOnly:true,files:[{uploadId:(await upload.json()).uploadId}]};
    }
    const posted=await page.request.post(base+(projectTurn?'/projects/'+project.id:'')+'/messages',{headers,data:payload});
    assert.equal(posted.status(),202,await posted.text());const original=await posted.json();
    const failed=await t.waitFor(()=>{
      const reply=server.app.store.list<Message>('messages').find(m=>m.replyTo===original.id && m.status==='failed');
      assert.ok(reply?.retryable);return reply;
    });
    if(!projectTurn) {
      // Historical projections may retain a failure without transport evidence.
      for(const variant of ['stopped','channel','legacy']) {
        const sourceId='fixture-source-'+variant,id='fixture-failure-'+variant;
        server.app.store.put('messages',sourceId,{...original,id:sourceId,status:'failed',directWebInput:variant==='channel'?undefined:true});
        server.app.store.put('messages',id,{...failed,id,replyTo:sourceId,retryable:variant==='legacy'?undefined:true,stoppedByUser:variant==='stopped'});
      }
    }
    await page.goto(server.url+'/'+route+'?token='+token);
    if(!projectTurn) for(const variant of ['stopped','channel','legacy']) {
      const other=page.locator('[data-id="fixture-failure-'+variant+'"]');
      await expect(other).toBeVisible();await expect(other.getByRole('button',{name:'重试本轮'})).toHaveCount(0);
    }
    const row=page.locator('[data-id="'+failed.id+'"]');
    const retry=row.getByRole('button',{name:'重试本轮',exact:true});
    await expect(row).toContainText(projectTurn?'合成模型拒绝本次输入':'附件请求失败');
    await expect(retry).toBeVisible();
    const input=page.getByRole('textbox',{name:projectTurn?'项目目标':'给 Agent 的消息'});
    await input.fill('另写的新草稿');
    const endpoint=base+'/messages/'+failed.id+'/retry';
    if(!projectTurn){
      const plugin=base+'/plugins/conversation-retry';
      await page.request.post(plugin,{headers,data:{enabled:false}});await expect(retry).toBeHidden();
      await page.request.post(plugin,{headers,data:{enabled:true}});await expect(retry).toBeVisible();
      await page.route(endpoint,r=>r.fulfill({status:409,json:{error:'合成拒绝原因'}}),{times:1});
      await retry.click();await expect(row).toContainText('合成拒绝原因');assert.equal(calls.get(text),1);
    }
    const response=page.waitForResponse(r=>r.url()===endpoint && r.request().method()==='POST');
    await retry.click();const accepted=await response;assert.equal(accepted.status(),202,await accepted.text());
    assert.deepEqual(accepted.request().postDataJSON(),{conversationId:conv});
    const receipt=await accepted.json();assert.equal(receipt.text,inputText);assert.equal(receipt.retryOf,failed.id);
    if(!projectTurn){assert.equal(receipt.readOnly,true);assert.deepEqual(receipt.files,original.files);}
    await expect(row.getByRole('link',{name:'查看重试消息'})).toBeVisible();
    await expect(page.getByText('重试回执 '+text,{exact:true}).first()).toBeVisible();
    await expect(input).toHaveValue('另写的新草稿');
    await page.reload();await expect(row.getByRole('link',{name:'查看重试消息'})).toBeVisible();
    await expect(retry).toHaveCount(0);
    await row.getByRole('link',{name:'查看重试消息'}).click();await expect(page.locator('[data-id="'+receipt.id+'"]')).toBeVisible();
    assert.equal(calls.get(text),2);
  }
});

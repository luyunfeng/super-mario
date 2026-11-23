import assert from 'node:assert/strict';
import {createServer,type ServerResponse} from 'node:http';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startAgentNode} from '../apps/agent-node/src/index.ts';
import {startServer} from '../apps/server/src/index.ts';
import {createProjectDiscovery} from '../plugins/project-discovery.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('主对话与项目能在回复中排队，刷新后取消一项；已开始的排队项拒绝迟到的取消', {timeout:60000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-queue-browser-')),token='fixture-queue',machineId='fixture-workspace';
  const calls:string[]=[],held=new Map<string,ServerResponse>();
  const frame=(delta:object,finish_reason:string|null)=>'data: '+JSON.stringify({id:'fixture',model:'fixture',object:'chat.completion.chunk',
    choices:[{index:0,delta,finish_reason}]})+'\n\n';
  const finish=(res:ServerResponse)=>res.end(frame({},'stop')+'data: [DONE]\n\n');
  const model=createServer(async(req,res)=>{
    if(req.method!=='POST'){res.writeHead(404).end();return;}
    let body='';for await(const part of req)body+=part;
    const payload=JSON.parse(body),user=payload.messages.findLast((m:{role:string})=>m.role==='user');
    const tag=JSON.stringify(user?.content).match(/queue-(main|project)-(first|cancel|race|last)/)?.[0]??'unexpected';
    calls.push(tag);res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(frame({role:'assistant',content:'合成答复 '+tag},null));
    if(tag.endsWith('-first') || tag.endsWith('-race'))held.set(tag,res);
    else finish(res);
  });
  await new Promise<void>(done=>model.listen(0,'127.0.0.1',done));const addr=model.address();assert.ok(addr && typeof addr==='object');
  const server=await startServer({host:'127.0.0.1',port:0,token,dataDir:join(dir,'server'),demo:false,model:{
    provider:'openai-compatible',model:'fixture',apiKey:'fixture',baseUrl:'http://127.0.0.1:'+addr.port+'/v1'}});
  const cwd=join(dir,'workspace');await mkdir(cwd);
  const workspace=createProjectDiscovery({home:dir,cwd,roots:[],temporaryRoots:[],ignoreEnvironmentRoots:true});
  const node=startAgentNode({url:server.url,token,machineId,name:'合成电脑',dataDir:join(dir,'node'),executors:[],
    handlers:{'workspace.directory':workspace.handlers['workspace.directory']}});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{for(const res of held.values())if(!res.writableEnded)finish(res);await browser.close();await node.close();await server.close();
    model.closeAllConnections();await new Promise<void>(done=>model.close(()=>done()));await rm(dir,{recursive:true,force:true});});
  await expect.poll(()=>server.machines.list().some(m=>m.id===machineId && m.online)).toBe(true);
  const project=await server.app.createProject({name:'真实排队合成项目',workspace:{machineId,cwd}});
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const stops:string[]=[];
  page.on('request',r=>{if(r.method()==='POST' && r.url().endsWith('/stop'))stops.push(r.url());});
  for(const scoped of [false,true]){
    const tag='queue-'+(scoped?'project':'main')+'-',endpoint=server.url+'/api/v1'+(scoped?'/projects/'+project.id:'')+'/messages';
    await page.goto(server.url+'/#'+(scoped?'projects/'+project.id+'/workspace':'chat')+'?token='+token);
    const input=page.getByRole('textbox',{name:scoped?'项目目标':'给 Agent 的消息'});
    const send=page.getByRole('button',{name:scoped?'发送目标':'发送',exact:true});
    const sendInput=async(kind:string)=>{
      await input.fill(tag+kind);
      const req=page.waitForResponse(r=>r.url()===endpoint && r.request().method()==='POST');
      await send.click();const res=await req;assert.equal(res.status(),202,await res.text());
      return await res.json() as Message;
    };
    const row=(m:Message)=>page.locator('.msg--user[data-id="'+m.id+'"]');
    const cancel=(m:Message)=>row(m).getByRole('button',{name:'取消排队',exact:true});
    const url=(m:Message)=>endpoint+'/'+m.id+'/cancel-queued';
    const headers={authorization:'Bearer '+token};
    const checkQueue=async(expected:Message[])=>{
      const response=await page.request.get(endpoint+'/queue',{headers});
      assert.equal(response.status(),200);
      assert.deepEqual(await response.json(),{items:expected.map(m=>({id:m.id,text:m.text,images:0,files:0}))});
    };
    const first=await sendInput('first');
    await expect.poll(()=>held.has(tag+'first')).toBe(true);
    const drop=await sendInput('cancel'),race=await sendInput('race'),last=await sendInput('last');
    if (scoped) {
      const wrong=await page.request.post(server.url+'/api/v1/messages/'+drop.id+'/cancel-queued',{headers,data:{}});
      assert.equal(wrong.status(),404);
      const plugin=server.url+'/api/v1/plugins/conversation-queue';
      assert.equal((await page.request.post(plugin,{headers,data:{enabled:false}})).status(),200);
      assert.equal((await page.request.get(endpoint+'/queue',{headers})).status(),503);
      assert.equal((await page.request.post(url(drop),{headers,data:{}})).status(),503);
      assert.equal((await page.request.post(plugin,{headers,data:{enabled:true}})).status(),200);
    }
    await checkQueue([drop,race,last]);
    await expect(cancel(drop)).toBeVisible();
    await page.reload();
    await expect(row(first)).toContainText('运行中');await expect(cancel(first)).toHaveCount(0);
    for(const queued of [drop,race,last]){await expect(row(queued)).toContainText('排队中');await expect(cancel(queued)).toBeVisible();}
    const overview=page.locator('.message-queue:visible');
    const summary=overview.locator('summary');
    await expect(summary).toHaveText('排队消息（3）');
    await summary.click();
    await expect(overview.getByRole('link')).toHaveCount(3);
    for(const [i,m] of [drop,race,last].entries()) await expect(overview.getByRole('link').nth(i)).toContainText(m.text);
    await overview.getByRole('link').first().click();
    await expect(row(drop)).toBeFocused();
    const response=page.waitForResponse(r=>r.url()===url(drop));
    await cancel(drop).click();const dropped=await response;
    assert.equal(dropped.status(),200);assert.equal((await dropped.json()).outcome,'cancelled');
    await expect(row(drop)).toContainText('已取消排队');
    await checkQueue([race,last]);
    await expect(summary).toHaveText('排队消息（2）');
    const again=await page.request.post(url(drop),{headers:{authorization:'Bearer '+token},data:{}});
    assert.equal(again.status(),200);assert.equal((await again.json()).outcome,'cancelled');
    let release!:()=>void;const travelling=new Promise<void>(done=>{release=done;});
    let captured!:()=>void;const clicked=new Promise<void>(done=>{captured=done;});
    await page.route(url(race),async route=>{captured();await travelling;await route.continue();},{times:1});
    const stale=page.waitForResponse(r=>r.url()===url(race));
    await cancel(race).click();await clicked;
    try {
      finish(held.get(tag+'first')!);
      await expect.poll(()=>held.has(tag+'race')).toBe(true);
    } finally {release();}
    const started=await stale;
    assert.equal(started.status(),200);assert.equal((await started.json()).outcome,'started');
    assert.deepEqual(stops,[]);await expect(row(race)).toContainText('运行中');
    finish(held.get(tag+'race')!);
    await expect.poll(()=>server.app.store.list<Message>('messages').filter(m=>m.role==='assistant' &&
      [first.id,race.id,last.id].includes(m.replyTo??'') && m.status==='done').length).toBe(3);
    assert.deepEqual(calls.filter(call=>call.startsWith(tag)),['first','race','last'].map(s=>tag+s));
    assert.deepEqual(stops,[]);
  }
});

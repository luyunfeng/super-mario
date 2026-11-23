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

test('主对话与项目能在回复中排队，刷新后调序、取消并取回编辑；已开始的排队项拒绝迟到的取消', {timeout:60000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-queue-browser-')),token='fixture-queue',machineId='fixture-workspace';
  const calls:string[]=[],held=new Map<string,ServerResponse>(),editedPayloads=new Map<string,string>();
  const frame=(delta:object,finish_reason:string|null)=>'data: '+JSON.stringify({id:'fixture',model:'fixture',object:'chat.completion.chunk',
    choices:[{index:0,delta,finish_reason}]})+'\n\n';
  const finish=(res:ServerResponse)=>res.end(frame({},'stop')+'data: [DONE]\n\n');
  const model=createServer(async(req,res)=>{
    if(req.method!=='POST'){res.writeHead(404).end();return;}
    let body='';for await(const part of req)body+=part;
    const payload=JSON.parse(body),user=payload.messages.findLast((m:{role:string})=>m.role==='user');
    const tag=JSON.stringify(user?.content).match(/queue-(main|project|other)-(first|cancel|race|last|edit-block|edit-original|edit-final|edit-drop)/)?.[0]??'unexpected';
    if(tag.endsWith('-edit-final'))editedPayloads.set(tag,JSON.stringify(payload.messages.filter((m:{role:string})=>m.role==='user')));
    calls.push(tag);res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(frame({role:'assistant',content:'合成答复 '+tag},null));
    if(tag.endsWith('-first') || tag.endsWith('-race') || tag.endsWith('-edit-block'))held.set(tag,res);
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
      assert.deepEqual(await response.json(),{items:expected.map(m=>({id:m.id,text:m.text,images:m.images?.length??0,files:m.files?.length??0}))});
    };
    const first=await sendInput('first');
    await expect.poll(()=>held.has(tag+'first')).toBe(true);
    const drop=await sendInput('cancel'),race=await sendInput('race'),last=await sendInput('last');
    const reorder=(expected:string[],ordered:string[])=>page.request.post(endpoint+'/queue',{headers,data:{expected,ordered}});
    if (scoped) {
      const main=server.url+'/api/v1/messages';
      const postMain=async(text:string)=>{
        const res=await page.request.post(main,{headers,data:{text}});
        assert.equal(res.status(),202);return (await res.json() as Message).id;
      };
      await postMain('queue-other-first');
      await expect.poll(()=>held.has('queue-other-first')).toBe(true);
      const outsider=await postMain('queue-other-cancel');
      const visible=[drop.id,race.id,last.id];
      const injected=await reorder(visible,[race.id,outsider,drop.id]);
      assert.equal(injected.status(),400,await injected.text());
      const other=await page.request.get(main+'/queue',{headers});
      assert.deepEqual((await other.json()).items.map((item:Message)=>item.id),[outsider]);
      finish(held.get('queue-other-first')!);
      const wrong=await page.request.post(server.url+'/api/v1/messages/'+drop.id+'/cancel-queued',{headers,data:{}});
      assert.equal(wrong.status(),404);
      const plugin=server.url+'/api/v1/plugins/conversation-queue';
      assert.equal((await page.request.post(plugin,{headers,data:{enabled:false}})).status(),200);
      assert.equal((await page.request.get(endpoint+'/queue',{headers})).status(),503);
      assert.equal((await reorder(visible,[race.id,last.id,drop.id])).status(),503);
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
    const outdated=await reorder([drop.id,race.id,last.id],[last.id,race.id,drop.id]);
    assert.equal(outdated.status(),409);
    await checkQueue([race,last]);
    const moved=page.waitForResponse(r=>r.url().split('?')[0]===endpoint+'/queue' && r.request().method()==='POST');
    await overview.getByRole('listitem').filter({hasText:last.text}).getByRole('button',{name:'上移',exact:true}).click();
    const result=await moved;
    assert.equal(result.status(),200,await result.text());
    assert.deepEqual(result.request().postDataJSON(),{expected:[race.id,last.id],ordered:[last.id,race.id]});
    assert.deepEqual((await result.json()).items.map((item:Message)=>item.id),[last.id,race.id]);
    await expect(overview.getByRole('link').first()).toHaveText(last.text);
    await checkQueue([last,race]);
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
    assert.deepEqual(calls.filter(call=>call.startsWith(tag)),['first','last','race'].map(s=>tag+s));
    assert.deepEqual(stops,[]);

    const blocker=await sendInput('edit-block');
    await expect.poll(()=>held.has(tag+'edit-block')).toBe(true);
    const composer=input.locator('xpath=ancestor::*[contains(@class,"composer") and .//input[@type="file" and @multiple]][1]');
    const png=await page.evaluate(()=>document.createElement('canvas').toDataURL().split(',')[1]!);
    await composer.getByLabel('选择图片').setInputFiles({name:'示例图片.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await composer.getByLabel('选择文件').setInputFiles({name:'合成附件.txt',mimeType:'text/plain',buffer:Buffer.from('原附件合成标记')});
    await expect(composer.getByText('已上传',{exact:true})).toBeVisible();
    const queued=await sendInput('edit-original'),removed=await sendInput('edit-drop');
    const scopeData=scoped?{projectId:project.id}:{};
    const edit=(m:Message,data:Record<string,unknown>=scopeData)=>page.request.post(endpoint+'/'+m.id+'/edit-queued',{headers,data});
    assert.equal((await edit(blocker)).status(),409);
    assert.equal((await page.request.post(url(removed),{headers,data:{}})).status(),200);
    assert.equal((await edit(removed)).status(),409);
    if (!scoped) {
      assert.equal((await edit(queued,{projectId:project.id})).status(),409);
      const filePlugin=server.url+'/api/v1/plugins/conversation-files';
      assert.equal((await page.request.post(filePlugin,{headers,data:{enabled:false}})).status(),200);
      assert.equal((await edit(queued)).status(),503);
      assert.equal((await page.request.post(filePlugin,{headers,data:{enabled:true}})).status(),200);
    }
    await checkQueue([queued]);
    await input.fill('已有未发草稿 '+tag);
    await composer.getByLabel('选择文件').setInputFiles({name:'草稿保留.txt',mimeType:'text/plain',buffer:Buffer.from('已有草稿文件')});
    await expect(composer.getByText('已上传',{exact:true})).toBeVisible();
    await expect(summary).toHaveText('排队消息（1）');
    if (!await overview.evaluate(el=>(el as HTMLDetailsElement).open)) await summary.click();
    const editUrl=endpoint+'/'+queued.id+'/edit-queued';
    const retrieval=page.waitForResponse(r=>r.url()===editUrl && r.request().method()==='POST');
    await overview.getByRole('listitem').filter({hasText:queued.text}).getByRole('button',{name:'取回编辑'}).click();
    const confirm=page.getByRole('dialog',{name:'追加到现有草稿'});
    await confirm.getByRole('button',{name:'追加到草稿',exact:true}).click();
    const retrieved=await retrieval;
    assert.equal(retrieved.status(),200,await retrieved.text());
    const draft=await retrieved.json();
    assert.equal(draft.input.id,queued.id);
    assert.equal(draft.images[0].data,png);assert.equal(draft.files[0].name,'合成附件.txt');
    await checkQueue([]);
    const repeated=await edit(queued);
    assert.equal(repeated.status(),200,await repeated.text());
    const restoredText='已有未发草稿 '+tag+'\n\n'+queued.text;
    await expect(input).toHaveValue(restoredText);
    await expect(composer.locator('.message-image-draft')).toHaveCount(1);
    await expect(composer.locator('.message-file-draft')).toHaveCount(2);
    await expect(composer).toContainText('草稿保留.txt');
    await expect(composer).toContainText('合成附件.txt');
    if (!scoped) {
      await page.goto(server.url+'/#projects/'+project.id+'/workspace');
      await expect(page.getByRole('textbox',{name:'项目目标'})).toHaveValue('');
      await page.goto(server.url+'/#chat');
      await page.locator('#message-form').getByLabel('项目范围').selectOption('');
      await expect(input).toHaveValue(restoredText);
      await expect(composer.locator('.message-image-draft')).toHaveCount(1);
      await expect(composer.locator('.message-file-draft')).toHaveCount(2);
    }
    // Finish the active input before sending: retrieving from the queue alone must never start a model turn.
    finish(held.get(tag+'edit-block')!);
    await expect.poll(()=>server.app.store.list<Message>('messages').some(m=>m.replyTo===blocker.id && m.status==='done')).toBe(true);
    assert.ok(!calls.includes(tag+'edit-original'));
    const revised=await sendInput('edit-final');
    assert.notEqual(revised.id,queued.id);
    assert.equal(revised.images?.[0]?.sha256,queued.images?.[0]?.sha256);
    assert.equal(revised.files?.find(f=>f.name==='合成附件.txt')?.sha256,queued.files?.[0]?.sha256);
    assert.equal(revised.files?.length,2);
    assert.ok(revised.images?.[0]?.sha256 && revised.files?.[0]?.sha256);
    await expect.poll(()=>server.app.store.list<Message>('messages').some(m=>m.replyTo===revised.id && m.status==='done')).toBe(true);
    assert.ok(editedPayloads.get(tag+'edit-final')?.includes(png));
    assert.ok(!editedPayloads.get(tag+'edit-final')?.includes(tag+'edit-original'));
    assert.deepEqual(calls.filter(call=>call.startsWith(tag+'edit-')), [tag+'edit-block',tag+'edit-final']);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import {startAgentNode} from '../apps/agent-node/src/index.ts';
import {createProjectDiscovery} from '../plugins/project-discovery.ts';

test('文件只上传到原会话，草稿刷新可重试，原消息折叠并下载带认证的原件', {timeout:60000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'chat-file-web-')),token='fixture-chat-files',machineId='fixture-workspace';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:join(dir,'server'),demo:true,token});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const cwd=join(dir,'workspace');await mkdir(cwd);
  const discovery=createProjectDiscovery({home:dir,cwd,roots:[],temporaryRoots:[],ignoreEnvironmentRoots:true});
  const node=startAgentNode({url:server.url,token,machineId,name:'演示电脑',dataDir:join(dir,'node'),executors:[],handlers:{'workspace.directory':discovery.handlers['workspace.directory']}});
  t.after(()=>node.close());
  await expect.poll(()=>server.machines.list().some(m=>m.id===machineId && m.online)).toBe(true);
  const project=await server.app.createProject({name:'附件测试',workspace:{machineId,cwd}});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#chat?token='+token);
  const files=Array.from({length:5},(_,i)=>({name:'附件 '+i+'.txt',mimeType:'text/plain',buffer:Buffer.from('合成内容 '+i+'\n')}));
  const file=files[0]!;
  const headers={Authorization:'Bearer '+token};
  const plugin=server.url+'/api/v1/plugins/conversation-files';
  const toggle=async(enabled:boolean)=>{const r=await page.request.post(plugin,{headers,data:{enabled}});assert.equal(r.status(),200);};
  const uploads:URL[]=[];
  page.on('request',req=>{if(req.method()==='PUT' && req.url().includes('/chat-files/uploads?')) uploads.push(new URL(req.url()));});
  for(const p of [false,true]) {
    const conversation=p?'project:'+project.id+':work':'main', url=server.url+'/api/v1'+(p?'/projects/'+project.id:'')+'/messages';
    await page.goto(server.url+'/'+(p?'#projects/'+project.id+'/workspace':'#chat'));
    const input=page.getByRole('textbox',{name:p?'项目目标':'给 Agent 的消息'});
    const composer=input.locator('xpath=ancestor::*[contains(@class,"composer") and .//input[@type="file" and @multiple]][1]');
    const picker=composer.getByLabel('选择文件'),send=composer.getByRole('button',{name:p?'发送目标':'发送',exact:true});
    await expect(composer.getByRole('button',{name:'添加文件'})).toBeEnabled();
    const count=uploads.length;
    if(!p){
      await picker.setInputFiles(Array.from({length:21},()=>file));
      await expect(composer).toContainText('每条消息最多可附 20 个文件');
      await input.evaluate(el=>{
        const chunk=new Blob([new Uint8Array(1024*1024)]), file=new File(Array(201).fill(chunk),'超限.bin');
        const transfer=new DataTransfer();transfer.items.add(file);
        el.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
      });
      await expect(composer).toContainText('每个文件最多 200 MiB');
      assert.equal(uploads.length,count);
      await page.route('**/chat-files/uploads?**',r=>r.fulfill({status:503,json:{error:'合成上传故障'}}),{times:1});
      await picker.setInputFiles(file);await expect(composer).toContainText('合成上传故障');
      await page.reload();await composer.getByRole('button',{name:'重试上传'}).click();
      await expect(composer.getByText('已上传',{exact:true})).toHaveCount(1);
      await picker.setInputFiles(files.slice(1));
    } else {
      await picker.setInputFiles(file);
      const png=await page.evaluate(()=>document.createElement('canvas').toDataURL().split(',')[1]!);
      await composer.getByLabel('选择图片').setInputFiles({name:'合成.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
      await expect(composer.getByAltText('合成.png')).toBeVisible();
    }
    await expect(composer.getByText('已上传',{exact:true})).toHaveCount(p?1:5);
    assert.ok(uploads.slice(count).every(u=>u.searchParams.get('conversationId')===conversation && u.searchParams.get('projectId')===(p?project.id:null)));
    let key:string|undefined;
    await page.route(url,r=>{key=r.request().headers()['idempotency-key'];return r.fulfill({status:503,json:{error:'合成暂不可用'}});},{times:1});
    const failed=page.waitForResponse(r=>r.url()===url && r.request().method()==='POST');
    await send.click();assert.equal((await failed).status(),503);
    await page.reload();await expect(composer.getByText('已上传',{exact:true})).toHaveCount(p?1:5);
    if(!p) {
      // A lost/expired upload ticket can be replaced from the persisted Blob.
      await page.route(url,r=>r.fulfill({status:410,json:{error:'文件上传已过期'}}),{times:1});
      await send.click();await expect(composer.getByRole('button',{name:'重试上传'})).toHaveCount(5);
      for(let i=0;i<5;i++) await composer.getByRole('button',{name:'重试上传'}).first().click();
      await expect(composer.getByText('已上传',{exact:true})).toHaveCount(5);
    }
    const sent=page.waitForResponse(r=>r.url()===url && r.request().method()==='POST');
    await send.click();const res=await sent;assert.equal(res.status(),202,await res.text());
    assert.equal(res.request().headers()['idempotency-key'],key);
    const body=res.request().postDataJSON(),m=await res.json();
    assert.equal(body.text,'');assert.equal(body.files.length,p?1:5);assert.deepEqual(Object.keys(body.files[0]),['uploadId']);
    assert.equal(m.files.length,p?1:5);if(p) assert.equal(m.images.length,1);
    await expect(composer.locator('.message-file-draft')).toHaveCount(0);
    const row=page.locator('[data-id="'+m.id+'"]'), download=row.getByRole('button',{name:'下载文件 '+file.name});
    await expect(download).toBeVisible();
    if(!p){
      const fifth=row.getByRole('button',{name:'下载文件 '+files[4]!.name});
      await expect(fifth).toBeHidden();await row.getByText('其余 2 个文件').click();await expect(fifth).toBeVisible();
    }
    const got=page.waitForEvent('download'),req=page.waitForRequest(r=>r.url().includes('/files/0?'));
    await download.click();const saved=await got,request=await req;
    assert.deepEqual(await readFile((await saved.path())!),file.buffer);assert.equal(saved.suggestedFilename(),file.name);
    assert.equal(request.headers().authorization,'Bearer '+token);assert.ok(!request.url().includes(token));
    assert.equal(new URL(request.url()).searchParams.get('conversationId'),conversation);
    if(!p){
      await picker.setInputFiles(file);await expect(composer.getByText('已上传',{exact:true})).toHaveCount(1);
      await toggle(false);await expect(download).toBeHidden();await expect(composer.getByRole('button',{name:'添加文件'})).toBeHidden();
      await expect(composer.getByRole('button',{name:'添加图片'})).toBeVisible();
      await input.fill('文件插件停用时继续对话');
      const plain=page.waitForResponse(r=>r.url()===url && r.request().method()==='POST');await send.click();
      const ok=await plain;assert.equal(ok.status(),202);assert.equal(ok.request().postDataJSON().files,undefined);
      await toggle(true);await expect(download).toBeVisible();await expect(composer.getByText('已上传',{exact:true})).toHaveCount(1);
    }
  }
});

test('已配对飞书主人向独立对话发文件后，Web 从原私聊记录下载', {timeout:30000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'feishu-chat-file-web-')),token='fixture-private-chat-file';
  let client!:import('../plugins/feishu.ts').FeishuOptions;
  const content=Buffer.from('独立对话的合成附件');
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true,token},{
    botFactory(options) {
      client=options;
      return {async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),async send(){},
        async readPrivateFile(chatId,messageId,ownerId,guard,save) {
          assert.deepEqual([chatId,messageId,ownerId],['private-chat','private-file','owner']);
          guard();return save('私聊附件.txt','text/plain',(async function*(){yield content;})());
        }};
    },
  });
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const bot=await server.bots.create({appId:'cli_7777777777777777',appSecret:'fixture',name:'文件演示',scope:{kind:'global'},requireConfirmation:false});
  const source={chatId:'private-chat',senderId:'owner',senderType:'user' as const,chatType:'p2p'};
  await client.onMessage(bot.pairingCode!,{...source,messageId:'pair'});
  await client.onMessage('/new 附件讨论',{...source,messageId:'new'});
  await client.onMessage('[文件]',{...source,messageId:'private-file',privateFile:true});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.goto(server.url+'/#agent?token='+token);
  await page.locator('#agent-bot .row').filter({hasText:'文件演示'}).getByRole('button',{name:'独立对话记录'}).click();
  const drawer=page.getByRole('dialog',{name:'独立对话记录'});
  await drawer.getByRole('button',{name:/附件讨论/}).click();
  const download=page.waitForEvent('download');await drawer.getByRole('button',{name:'下载文件 私聊附件.txt'}).click();
  assert.deepEqual(await readFile((await (await download).path())!),content);
});

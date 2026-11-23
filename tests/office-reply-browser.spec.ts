import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium,expect} from '@playwright/test';
import JSZip from 'jszip';
import {startServer} from '../apps/server/src/index.ts';
import {startAgentNode} from '../apps/agent-node/src/index.ts';
import {createProjectDiscovery} from '../plugins/project-discovery.ts';
import type {FeishuOptions} from '../plugins/feishu.ts';

test('主对话、项目和飞书独立私聊的助手答复原位显示生成文档，两种插件分别控制显示', {timeout:60000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-reply-web-')), token='fixture-office-reply';
  const model=createServer(async(req,res)=>{
    if(req.method!=='POST') {res.end('fixture');return;}
    let raw='';for await(const chunk of req) raw+=chunk;
    const payload=JSON.parse(raw), last=payload.messages.at(-1);
    const prompt=JSON.stringify(last.content);
    const title=['主对话报告','项目工作报告','独立私聊报告'].find(s=>prompt.includes('请生成'+s));
    const useTool=last.role==='user' && title && payload.tools?.some((tool:{function:{name:string}})=>tool.function.name==='office_create');
    const delta=useTool ? {role:'assistant',tool_calls:[{index:0,id:'office-call',type:'function',function:{name:'office_create',
      arguments:JSON.stringify({title,format:'docx',source:'# 合成验收\n\n'+title+'的独有正文'})}}]} : {role:'assistant',content:'本轮处理结束。'};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [part,reason] of [[delta,null],[{},useTool?'tool_calls':'stop']]) {
      res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:part,finish_reason:reason}]})+'\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const cleanup:Array<()=>unknown>=[];
  t.after(async()=>{
    try {for (const close of cleanup.reverse()) await close();}
    finally {
      model.closeAllConnections();
      await new Promise<void>(resolve=>model.close(()=>resolve()));
      await rm(root,{force:true,recursive:true});
    }
  });
  const address=model.address();assert.ok(address && typeof address==='object');
  let client!:FeishuOptions;
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:join(root,'server'),token,demo:false,
    model:{provider:'openai-compatible',model:'fixture',apiKey:'local-fixture',baseUrl:'http://127.0.0.1:'+address.port+'/v1'}},{
    botFactory(options) {client=options;return {async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),async send(){}};},
  });
  cleanup.push(()=>server.close());
  const machineId='fixture-workstation',cwd=join(root,'work');await mkdir(cwd);
  const discovery=createProjectDiscovery({home:root,cwd,roots:[],temporaryRoots:[],ignoreEnvironmentRoots:true});
  const node=startAgentNode({url:server.url,token,machineId,name:'演示电脑',dataDir:join(root,'node'),executors:[],
    handlers:{'workspace.directory':discovery.handlers['workspace.directory']}});
  cleanup.push(()=>node.close());
  await expect.poll(()=>server.machines.list().some(m=>m.id===machineId && m.online)).toBe(true);
  const project=await server.app.createProject({name:'报告项目',workspace:{machineId,cwd}});
  const bot=await server.bots.create({appId:'cli_6666666666666666',appSecret:'fixture',name:'报告机器人',scope:{kind:'global'},requireConfirmation:false});
  const source={senderId:'owner',senderType:'user' as const,chatId:'owner-chat',chatType:'p2p'};
  await client.onMessage(bot.pairingCode!,{...source,messageId:'pair'});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  cleanup.push(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#chat?token='+token);
  const headers={authorization:'Bearer '+token};
  const toggle=async(plugin:string,enabled:boolean)=>{
    const r=await page.request.post(server.url+'/api/v1/plugins/'+plugin,{headers,data:{enabled}});
    assert.equal(r.status(),200,await r.text());
  };
  for(const [i,title] of ['主对话报告','项目工作报告','独立私聊报告'].entries()){
    if(i===2) {
      await client.onMessage('/new 文件交付',{...source,messageId:'thread'});
      await client.onMessage('请生成'+title,{...source,messageId:'generate'});
      await expect.poll(()=>server.app.store.list<import('../packages/protocol/src/index.ts').Message>('messages')
        .some(m=>m.role==='assistant' && m.files?.some(f=>f.name===title+'.docx')),{timeout:10000}).toBe(true);
      await page.goto(server.url+'/#agent');
      await page.locator('#agent-bot .row').filter({hasText:bot.name}).getByRole('button',{name:'独立对话记录'}).click();
      await page.getByRole('dialog',{name:'独立对话记录'}).getByRole('button',{name:/文件交付/}).click();
    } else {
      if(i===1) await page.goto(server.url+'/#projects/'+project.id+'/workspace');
      const send=page.getByRole('button',{name:i?'发送目标':'发送',exact:true});
      if(i===0) {
        await page.getByLabel('选择文件').setInputFiles({name:'原上传.txt',mimeType:'text/plain',buffer:Buffer.from('原件')});
        await expect(page.getByText('已上传',{exact:true})).toBeVisible();await send.click();
        await expect(page.getByRole('button',{name:'下载文件 原上传.txt'})).toBeVisible();
      }
      await page.getByRole('textbox',{name:i?'项目目标':'给 Agent 的消息'}).fill('请生成'+title);
      await send.click();
    }
    const history=i===2 ? page.getByRole('dialog',{name:'独立对话记录'}) : page.locator('.msg--assistant');
    const download=history.getByRole('button',{name:'下载文件 '+title+'.docx',exact:true});
    await expect(download).toBeVisible({timeout:10000});
    const got=page.waitForEvent('download');await download.click();
    const file=await got;assert.equal(file.suggestedFilename(),title+'.docx');
    const zip=await JSZip.loadAsync(await readFile((await file.path())!));
    assert.ok((await zip.file('word/document.xml')!.async('string')).includes(title+'的独有正文'));
    if(i===2) {
      await history.getByRole('button',{name:'预览文件 '+title+'.docx'}).click();
      const preview=page.getByRole('dialog',{name:'文件预览'});await expect(preview).toContainText(title+'的独有正文');
      await client.onRecall!('owner-chat','generate');await expect(preview).toBeHidden();await expect(download).toBeHidden();
      await history.getByRole('button',{name:'返回列表'}).click();
      await history.getByRole('button',{name:/文件交付/}).click();
      await expect(history.locator('section').first()).toBeVisible();
      await expect(history.getByRole('button',{name:'下载文件 '+title+'.docx'})).toHaveCount(0);
    }
    if(i===0){
      const uploaded=page.getByRole('button',{name:'下载文件 原上传.txt'});
      await history.getByRole('button',{name:'预览文件 '+title+'.docx'}).click();
      const preview=page.getByRole('dialog',{name:'文件预览'});await expect(preview).toContainText(title+'的独有正文');
      await toggle('office-documents',false);await expect(download).toBeHidden();await expect(preview).toBeHidden();await expect(uploaded).toBeVisible();
      await toggle('office-documents',true);await expect(download).toBeVisible();
      await toggle('conversation-files',false);await expect(download).toBeHidden();await expect(uploaded).toBeHidden();
      await toggle('conversation-files',true);await expect(download).toBeVisible();await expect(uploaded).toBeVisible();
    }
  }
});

import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('工作台预览并更新摘录，原匿名链接只显示已确认的版本，撤销后无法再读', {timeout:35000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-share-browser-'));
  const token='synthetic-workbench-private';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,token,demo:true});
  t.after(async()=>{try{await server.close();}finally{await rm(dataDir,{recursive:true,force:true});}});
  const shared='合成公开结论\n<img src="https://example.invalid/picture.png">',replacement='合成修订结论：延期至周五复核。',privateText='合成内部备注，不在本次公开范围';
  const assistantText='合成助手公开核对结果';
  const attachmentName='合成内部附件.txt', attachmentBody='仅供工作台读取的附件内容';
  const upload=await fetch(server.url+'/api/v1/chat-files/uploads?'+new URLSearchParams({conversationId:'main',name:attachmentName}),{
    method:'PUT',headers:{authorization:'Bearer '+token,'content-type':'text/plain'},body:attachmentBody});
  assert.equal(upload.status,201);
  const {uploadId}=await upload.json();
  let attachmentUrl='';
  for(const text of [shared,replacement,privateText]){
    const response=await fetch(server.url+'/api/v1/messages',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({text,...(text===shared && {files:[{uploadId}]})})});
    assert.equal(response.status,202);const source=await response.json();
    await t.waitFor(()=>assert.ok(server.app.store.list<Message>('messages').some(m=>m.replyTo===source.id && m.status==='done')),{timeout:6000});
    if(text===shared){
      attachmentUrl=server.url+'/api/v1/messages/'+source.id+'/files/0?conversationId=main';
      const download=await fetch(attachmentUrl,{headers:{authorization:'Bearer '+token}});
      assert.equal(download.status,200);
      assert.equal(await download.text(),attachmentBody);
      const reply=server.app.store.list<Message>('messages').find(m=>m.replyTo===source.id && m.role==='assistant')!;
      server.app.store.put('messages',reply.id,{...reply,text:assistantText});
      const details={phase:'working',goal:privateText};
      server.app.store.put('agent.traces',reply.id,{id:reply.id,conversationId:reply.conversationId,userMessageId:source.id,status:'done',
        toolCalls:[{id:'status',name:'conversation_status',args:JSON.stringify({internal:privateText}),isError:false,
          result:JSON.stringify({content:[{type:'text',text:JSON.stringify(details)}],details}),startedAt:reply.createdAt,finishedAt:reply.createdAt}]});
    }
  }
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const owner=await browser.newPage();
  await owner.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await owner.goto(server.url+'/#chat?token='+token);
  await owner.getByRole('button',{name:'分享对话摘录',exact:true}).click();
  const manager=owner.getByRole('dialog',{name:'分享对话摘录',exact:true});
  await manager.getByRole('checkbox',{name:/选择消息.*合成公开结论/}).first().check();
  const assistantChoice=manager.getByRole('checkbox',{name:/选择消息.*合成助手公开核对结果/});
  await assistantChoice.check();
  const includeTools=manager.getByRole('checkbox',{name:'包含工具记录',exact:true});
  await expect(includeTools).not.toBeChecked();
  await includeTools.check();
  await manager.getByRole('button',{name:'预览公开内容',exact:true}).click();
  const preview=manager.getByRole('region',{name:'公开内容预览',exact:true});
  await expect(preview.getByText(shared,{exact:true})).toBeVisible();
  const previewTools=preview.getByRole('region',{name:'工具记录'});
  await previewTools.getByText('conversation_status · 成功',{exact:true}).click();
  await expect(previewTools.locator('pre')).toHaveText('{"phase":"working"}');
  await expect(preview).not.toContainText(privateText);
  await manager.getByRole('button',{name:'确认创建分享',exact:true}).click();
  const field=manager.getByRole('textbox',{name:'分享链接',exact:true});
  await expect(field).toBeVisible();
  const url=new URL(await field.inputValue());
  assert.equal(url.pathname,'/share');assert.equal(url.origin,server.url);
  assert.equal(url.search,'');assert.match(url.hash,/^#[a-zA-Z0-9_-]{43}$/);
  const anonymous=await browser.newContext();
  const reader=await anonymous.newPage();
  await reader.clock.install();
  const requests:{path:string;auth?:string;referrer?:string;cookie?:string;data:string|null}[]=[];
  await anonymous.route('**/*',async route=>{
    const req=route.request(),target=new URL(req.url()),headers=await req.allHeaders();
    requests.push({path:target.pathname,auth:headers.authorization,referrer:headers.referer,cookie:headers.cookie,data:req.postData()});
    if(target.origin!==server.url) return route.abort();
    return route.continue();
  });
  await anonymous.addCookies([{url:server.url,name:'unused-session',value:'synthetic-cookie'}]);
  const receipt=reader.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/public/conversation-share');
  const document=await reader.goto(url.href);
  assert.equal(document?.headers()['referrer-policy'],'no-referrer');
  assert.match(document?.headers()['cache-control']??'',/no-store/);
  const publicResponse=await receipt;
  assert.ok(publicResponse.ok());assert.match(publicResponse.headers()['cache-control']??'',/no-store/);
  const messages=reader.getByRole('list',{name:'分享的消息'});
  await expect(messages.getByRole('listitem')).toHaveCount(2);
  await expect(messages.locator('p')).toHaveText([shared,assistantText]);
  const publicTools=messages.getByRole('region',{name:'工具记录'});
  await publicTools.getByText('conversation_status · 成功',{exact:true}).click();
  await expect(publicTools.locator('pre')).toHaveText('{"phase":"working"}');
  const publicBody=await publicResponse.text();
  for(const hidden of [privateText,attachmentName,attachmentBody]) assert.ok(!publicBody.includes(hidden));
  const privateDownload=await anonymous.request.get(attachmentUrl,{headers:{authorization:'Bearer '+url.hash.slice(1)}});
  assert.equal(privateDownload.status(),401);
  await expect(reader.locator('body')).not.toContainText(privateText);
  await expect(messages.locator('img,script,a')).toHaveCount(0);
  assert.ok(requests.every(r=>['/share','/css/base.css','/js/share.js','/js/lib/shared-excerpt-tools.js','/api/v1/public/conversation-share','/favicon.ico'].includes(r.path)));
  const publicRead=requests.filter(r=>r.path==='/api/v1/public/conversation-share');
  assert.equal(publicRead.length,1);assert.deepEqual(JSON.parse(publicRead[0].data!),{token:url.hash.slice(1)});
  assert.equal(publicRead[0].auth,undefined);assert.equal(publicRead[0].referrer,undefined);assert.equal(publicRead[0].cookie,undefined);
  await reader.route('**/api/v1/public/conversation-share', route => route.fulfill({status:503}), {times:1});
  await reader.reload();
  await expect(messages.getByRole('listitem')).toHaveCount(0);
  await reader.getByRole('button',{name:'重新读取摘录'}).click();
  await expect(messages.locator('p')).toHaveText([shared,assistantText]);
  await expect(reader.getByRole('button',{name:'重新读取摘录'})).toHaveCount(0);
  await manager.getByRole('button',{name:'关闭',exact:true}).click();
  const open=owner.getByRole('button',{name:'分享对话摘录',exact:true});
  await open.click();
  await manager.getByRole('button',{name:'修改分享',exact:true}).click();
  const originalChoice=manager.getByRole('checkbox',{name:/选择消息.*合成公开结论/}).first();
  const replacementChoice=manager.getByRole('checkbox',{name:/选择消息.*合成修订结论/}).first();
  await expect(originalChoice).toBeChecked();
  await originalChoice.uncheck();await replacementChoice.check();
  await expect(assistantChoice).toBeChecked();
  await expect(includeTools).toBeChecked();
  await manager.getByRole('button',{name:'预览公开内容',exact:true}).click();
  await expect(previewTools).toBeVisible();
  await includeTools.uncheck();
  await expect(manager.getByRole('button',{name:'确认更新分享',exact:true})).toHaveCount(0);
  await manager.getByRole('button',{name:'预览公开内容',exact:true}).click();
  await expect(preview.locator('pre')).toHaveText([assistantText,replacement]);
  await expect(previewTools).toHaveCount(0);
  await expect(preview).not.toContainText(shared);await expect(preview).not.toContainText(privateText);
  async function poll(){
    const response=reader.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/public/conversation-share' && r.request().postDataJSON().knownRevision===1);
    await reader.clock.fastForward(30000);
    return (await response).json();
  }
  const unchanged=await poll();
  assert.equal(unchanged.revision,1);assert.equal(unchanged.unchanged,true);assert.equal(unchanged.messages,undefined);
  await expect(messages.locator('p')).toHaveText([shared,assistantText]);
  const updated=owner.waitForResponse(r=>r.request().method()==='POST' && r.ok() &&
    new URL(r.url()).pathname==='/api/v1/conversation-shares' && r.request().postDataJSON().action==='update');
  await manager.getByRole('button',{name:'确认更新分享',exact:true}).click();
  await updated;
  const changed=await poll();assert.equal(changed.revision,2);
  assert.deepEqual(changed.messages,[{role:'assistant',text:assistantText},{role:'user',text:replacement}]);
  await expect(reader).toHaveURL(url.href);
  await expect(messages.getByRole('listitem')).toHaveCount(2);
  await expect(messages.locator('p')).toHaveText([assistantText,replacement]);
  await expect(publicTools).toHaveCount(0);
  await expect(reader.locator('body')).not.toContainText(shared);
  await expect(reader.locator('body')).not.toContainText(privateText);
  await manager.getByRole('button',{name:'关闭',exact:true}).click();
  await open.click();
  await expect(manager.getByRole('button',{name:'修改分享',exact:true})).toHaveCount(1);
  await manager.getByRole('button',{name:'撤销分享',exact:true}).click();
  const revoked=owner.waitForResponse(r=>r.request().method()==='POST' && r.ok() && r.request().postData()?.includes('revoke')===true);
  await owner.getByRole('button',{name:'确认撤销',exact:true}).click();
  await revoked;
  await reader.reload();
  await expect(reader.getByRole('status')).toContainText('无法读取');
  await expect(messages.getByRole('listitem')).toHaveCount(0);
  await expect(reader.locator('body')).not.toContainText('合成公开结论');
  await expect(reader.locator('body')).not.toContainText(replacement);
});

test('主人开启自动追加后匿名链接收到后续 Web 对话，关闭后保留已分享的摘录', {timeout:35000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-share-follow-'));
  const token='synthetic-follow-owner';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,token,demo:true});
  t.after(async()=>{try{await server.close();}finally{await rm(dataDir,{recursive:true,force:true});}});
  async function send(text:string){
    const response=await fetch(server.url+'/api/v1/messages',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({text})});
    assert.equal(response.status,202);
    const {id}=await response.json();
    const reply=()=>server.app.store.list<Message>('messages').find(m=>m.replyTo===id && m.role==='assistant' && m.status==='done');
    await t.waitFor(()=>assert.ok(reply()),{timeout:6000});
    return reply()!.text;
  }
  const original='合成已选开篇',prior='合成未选旧条目',later='合成新一轮发言',after='合成已关闭后发言';
  await send(prior);await send(original);
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const owner=await browser.newPage();
  await owner.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await owner.goto(server.url+'/#chat?token='+token);
  const open=owner.getByRole('button',{name:'分享对话摘录',exact:true});
  await open.click();
  const drawer=owner.getByRole('dialog',{name:'分享对话摘录'});
  await drawer.getByRole('checkbox',{name:new RegExp('选择消息.*：'+original+'$')}).check();
  const follow=drawer.getByRole('checkbox',{name:'自动追加后续消息',exact:true});
  await expect(follow).not.toBeChecked();
  await follow.check();
  const preview=drawer.getByRole('button',{name:'预览公开内容'});
  await preview.click();
  await drawer.getByRole('button',{name:'确认创建分享'}).click();
  const link=await drawer.getByRole('textbox',{name:'分享链接'}).inputValue();
  const reader=await browser.newPage();
  await reader.clock.install();
  await reader.goto(link);
  const messages=reader.getByRole('list',{name:'分享的消息'}).locator('li > p');
  await expect(messages).toHaveText([original]);
  await expect(reader.getByRole('status')).toContainText('自动追加后续消息');
  async function poll(delay=30000){
    const response=reader.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/public/conversation-share' && r.request().postDataJSON().knownRevision);
    await reader.clock.fastForward(delay);
    return (await response).json();
  }
  const answer=await send(later);
  await poll(15000);
  await expect(messages).toHaveText([original,later,answer]);
  await expect(reader.locator('body')).not.toContainText(prior);
  await drawer.getByRole('button',{name:'关闭',exact:true}).click();await open.click();
  await drawer.getByRole('button',{name:'修改分享'}).click();
  await expect(follow).toBeChecked();await follow.uncheck();
  await preview.click();
  const update=owner.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/conversation-shares' && r.request().postDataJSON().action==='update' && r.ok());
  await drawer.getByRole('button',{name:'确认更新分享'}).click();await update;
  await poll();
  await expect(messages).toHaveText([original,later,answer]);
  await send(after);
  assert.equal((await poll()).unchanged,true);
  await expect(messages).toHaveText([original,later,answer]);
  await expect(reader).toHaveURL(link);

  // Open the same published snapshot just before its deadline, then let it expire between polls.
  const expiresAt = await reader.locator('time').getAttribute('datetime');
  await reader.clock.setSystemTime(new Date(Date.parse(expiresAt!) - 5000));
  await reader.reload();
  await expect(messages).toHaveText([original,later,answer]);
  await reader.clock.fastForward(5001);
  await expect(reader.getByRole('status')).toHaveText('分享已过期。');
  await expect(messages).toHaveCount(0);
  await expect(reader.locator('time')).toBeHidden();
  await expect(reader.getByRole('button',{name:'重新读取摘录'})).toHaveCount(0);
});

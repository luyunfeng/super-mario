import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('独立对话在本线恢复引用片段并发送原始 Markdown，归档和停用限制引用',{timeout:40000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'web-thread-quotes-')),token='synthetic-thread-quotes';
  const server=await startServer({dataDir:dir,port:0,host:'127.0.0.1',demo:true,token});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});});
  const page=await browser.newPage(),headers={Authorization:'Bearer '+token};
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const path=server.url+'/api/v1/web-conversations',first=randomUUID(),second=randomUUID();
  for(const [id,title] of [[first,'原话核对'],[second,'另一条线']]){
    assert.equal((await page.request.post(path,{headers,data:{id,title}})).status(),201);
  }
  const sourceId=randomUUID(),segment='**需核实**\n第二行',raw='不引用的开头\n'+segment+'\n不引用的结尾';
  server.app.store.put('messages',sourceId,{id:sourceId,conversationId:'web:'+first,role:'user',text:raw,
    createdAt:new Date().toISOString(),status:'done',directWebInput:true});
  const url=(id:string)=>server.url+'/#chat?thread='+id;
  await page.goto(url(first)+'&token='+token);
  const region=page.getByLabel('独立对话内容'),input=region.getByLabel('给独立对话发消息');
  const quote=region.locator('[data-id="'+sourceId+'"]').getByRole('button',{name:'引用消息',exact:true});
  const preview=region.locator('[data-message-quote]');
  await quote.click();await expect(preview).toContainText('不引用的开头');
  await region.getByRole('button',{name:'选择引用片段'}).click();
  const dialog=page.getByRole('dialog',{name:'选择引用片段'}),passage=dialog.getByLabel('选择要引用的原文');
  await expect(passage).toHaveValue(raw);
  await passage.evaluate((el:HTMLTextAreaElement,value:string)=>{
    const start=el.value.indexOf(value);el.setSelectionRange(start,start+value.length);
  },segment);
  await dialog.getByRole('button',{name:'引用选中段落'}).click();
  await expect(preview).not.toContainText('不引用的开头');
  const question='请核对原文。';await input.fill(question);
  await page.goto(url(second));await expect(input).toHaveValue('');await expect(preview).toBeHidden();
  await input.fill('乙线仅有的草稿');
  await page.goto(url(first));await page.reload();await expect(input).toHaveValue(question);await expect(preview).toContainText('**需核实**');
  const posted=page.waitForResponse(res=>res.request().method()==='POST' && res.url()===path+'/'+first+'/messages');
  await input.press('Enter');const expected='> **需核实**\n> 第二行\n\n'+question;
  const response=await posted;assert.equal(response.status(),202);assert.equal(response.request().postDataJSON().text,expected);await expect(preview).toBeHidden();
  const history=await (await page.request.get(path+'/'+first+'/messages',{headers})).json();
  assert.ok(history.messages.some((m:{role:string;text:string})=>m.role==='user' && m.text===expected));
  const patch=async(archived:boolean)=>{
    const meta=await (await page.request.get(path+'/'+first,{headers})).json();
    assert.equal((await page.request.patch(path+'/'+first,{headers,data:{version:meta.version,archived}})).status(),200);
  };
  await patch(true);await expect(input).toBeHidden();await expect(quote).toBeHidden();
  await patch(false);await quote.click();await expect(preview).toContainText('不引用的开头');
  await input.fill('停用后的普通正文');
  assert.equal((await page.request.post(server.url+'/api/v1/plugins/conversation-quotes',{headers,data:{enabled:false}})).status(),200);
  await expect(quote).toBeHidden();await expect(preview).toBeHidden();
  await expect(input).toHaveValue('停用后的普通正文');
  const plain=page.waitForRequest(req=>req.method()==='POST' && req.url()===path+'/'+first+'/messages');
  await input.press('Enter');assert.equal((await plain).postDataJSON().text,'停用后的普通正文');
  await page.goto(url(second));await expect(input).toHaveValue('乙线仅有的草稿');
});

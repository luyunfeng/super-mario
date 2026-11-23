import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('独立对话文件草稿隔离，归档后可预览并下载原件，删除只清本线草稿',{timeout:40000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'thread-file-')),token='synthetic-thread-files';
  const server=await startServer({dataDir,port:0,host:'127.0.0.1',demo:true,token});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  const page=await browser.newPage(),headers={Authorization:'Bearer '+token};
  const project=server.app.projects.create({name:'独立对话文件归属'});
  const first=randomUUID(),second=randomUUID(),path=server.url+'/api/v1/web-conversations';
  for(const [id,title] of [[first,'归档文件'],[second,'单独草稿']]){
    assert.equal((await page.request.post(path,{headers,data:{id,title,projectId:project.id}})).status(),201);
  }
  const url=(id:string)=>server.url+'/#chat?thread='+id;
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));await page.goto(url(first)+'&token='+token);
  const region=page.getByLabel('独立对话内容'),draft=region.locator('.message-file-draft');
  const text='合成文件原文\n保留换行和字节',name='证据.txt';
  async function attach(filename:string,threadId:string){
    await expect(region.getByRole('button',{name:'添加文件'})).toBeEnabled();
    const uploaded=page.waitForResponse(r=>r.request().method()==='PUT' && r.url().includes('/chat-files/uploads?'));
    await region.getByLabel('选择文件').setInputFiles({name:filename,mimeType:'text/plain',buffer:Buffer.from(text)});
    const res=await uploaded,params=new URL(res.url()).searchParams;
    assert.equal(params.get('conversationId'),'web:'+threadId);assert.equal(params.get('projectId'),project.id);
    assert.equal(res.status(),201);await expect(draft).toContainText('已上传');return (await res.json()).uploadId;
  }
  const uploadId=await attach(name,first);
  await page.goto(url(second));await expect(region.getByRole('heading',{name:'单独草稿'})).toBeVisible();await expect(draft).toHaveCount(0);
  await attach('留在乙线.txt',second);
  await page.goto(url(first));await page.reload();await expect(draft).toContainText(name);
  const posted=page.waitForResponse(r=>r.request().method()==='POST' && r.url()===path+'/'+first+'/messages');
  await region.getByRole('button',{name:'发送',exact:true}).click();
  const res=await posted;assert.equal(res.status(),202);assert.deepEqual(res.request().postDataJSON(),{text:'',files:[{uploadId}]});
  const input=await res.json(),row=region.locator('article[data-id="'+input.id+'"]');
  await expect(row.getByRole('button',{name:'预览文件 '+name})).toBeVisible();await expect(draft).toHaveCount(0);
  await expect(row.getByRole('button',{name:'编辑消息',exact:true})).toHaveCount(0);
  await attach('删除时清理.txt',first);
  const meta=await (await page.request.get(path+'/'+first,{headers})).json();
  const archived=await page.request.patch(path+'/'+first,{headers,data:{version:meta.version,archived:true}});
  assert.equal(archived.status(),200);await expect(region.getByLabel('给独立对话发消息')).toBeHidden();
  await row.getByRole('button',{name:'预览文件 '+name}).click();
  const drawer=page.getByRole('dialog',{name:'文件预览'});
  await expect(drawer.locator('pre')).toHaveText(text);
  const pending=page.waitForEvent('download');await drawer.getByRole('button',{name:'下载原文件'}).click();
  const download=await pending;assert.equal(download.suggestedFilename(),name);
  assert.equal(await readFile((await download.path())!,'utf8'),text);
  const deleted=await page.request.delete(path+'/'+first,{headers,data:{version:(await archived.json()).version}});
  assert.equal(deleted.status(),200);await expect(drawer).toHaveCount(0);await expect(region).toContainText('原链接已失效');
  const storedNames=()=>page.evaluate(async()=>new Promise<string[]>((resolve,reject)=>{
    const open=indexedDB.open('sm-message-file-drafts');
    open.onsuccess=()=>{const db=open.result;const read=db.transaction('files').objectStore('files').getAll();
      read.onsuccess=()=>{resolve(read.result.flat().map((f:{name:string})=>f.name));db.close();};read.onerror=()=>reject(read.error);};
    open.onerror=()=>reject(open.error);
  }));
  await expect.poll(storedNames).toEqual(['留在乙线.txt']);
  await page.goto(url(second));await expect(draft).toContainText('留在乙线.txt');
});

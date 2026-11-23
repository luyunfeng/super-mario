import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('独立对话纯图发送、粘贴和编辑副本保留原图，草稿隔离并随各自对话清理',{timeout:40000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'thread-image-')),token='synthetic-thread-images';
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,demo:true,token});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  const page=await browser.newPage(),headers={Authorization:'Bearer '+token};
  const project=server.app.projects.create({name:'原图所在项目'}),first=randomUUID(),second=randomUUID(),path=server.url+'/api/v1/web-conversations';
  for(const [id,title] of [[first,'保存原图'],[second,'独立草稿']]){
    assert.equal((await page.request.post(path,{headers,data:{id,title,projectId:project.id}})).status(),201);
  }
  const url=(id:string)=>server.url+'/#chat?thread='+id;
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));await page.goto(url(first)+'&token='+token);
  const png=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=12;canvas.height=8;
    const ctx=canvas.getContext('2d')!;ctx.fillStyle='blue';ctx.fillRect(0,0,12,8);
    return canvas.toDataURL().split(',')[1]!;
  });
  const region=page.getByLabel('独立对话内容'),draft=region.locator('.message-image-draft img');
  await expect(region.getByRole('button',{name:'添加图片'})).toBeEnabled();
  await region.getByLabel('选择图片').setInputFiles({name:'原图.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect(draft).toBeVisible();
  const posted=page.waitForResponse(r=>r.request().method()==='POST' && r.url()===path+'/'+first+'/messages');
  await region.getByRole('button',{name:'发送',exact:true}).click();
  const response=await posted;assert.equal(response.status(),202);
  assert.deepEqual(response.request().postDataJSON(),{text:'',images:[{mime:'image/png',data:png}]});
  const message=await response.json();assert.equal(message.projectId,project.id);
  assert.equal(message.images[0].sha256,createHash('sha256').update(Buffer.from(png,'base64')).digest('hex'));
  await expect(draft).toHaveCount(0);await expect(region.locator('.msg--assistant').first()).toBeVisible();
  const row=region.locator('article[data-id="'+message.id+'"]');
  await row.getByRole('button',{name:'查看消息图片 1'}).click();
  const viewer=page.getByRole('dialog',{name:'图片查看器'});
  await viewer.getByRole('button',{name:'编辑到草稿'}).click();
  const editor=page.getByRole('dialog',{name:'编辑图片'});
  await editor.getByRole('button',{name:'裁剪',exact:true}).click();
  await editor.getByRole('button',{name:'向左旋转'}).click();await editor.getByRole('button',{name:'保存',exact:true}).click();
  const dimensions=()=>draft.evaluate((img:HTMLImageElement)=>[img.naturalWidth,img.naturalHeight]);
  await expect.poll(dimensions).toEqual([8,12]);
  assert.deepEqual(await row.getByAltText('消息图片 1').evaluate((img:HTMLImageElement)=>[img.naturalWidth,img.naturalHeight]),[12,8]);
  await page.goto(url(second));await expect(region.getByRole('heading',{name:'独立草稿'})).toBeVisible();await expect(draft).toHaveCount(0);
  await region.getByLabel('给独立对话发消息').evaluate((el,b64)=>{
    const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],'乙线粘贴.png',{type:'image/png'}));
    el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  },png);
  await expect(draft).toHaveAttribute('alt','乙线粘贴.png');
  await page.goto(url(first));await page.reload();await expect.poll(dimensions).toEqual([8,12]);
  const metadata=await (await page.request.get(path+'/'+first,{headers})).json();
  assert.equal((await page.request.delete(path+'/'+first,{headers,data:{version:metadata.version}})).status(),200);
  await expect(region).toContainText('原链接已失效');
  await expect.poll(()=>page.evaluate(()=>new Promise<string[]>((resolve,reject)=>{
    const open=indexedDB.open('sm-message-image-drafts');
    open.onsuccess=()=>{const db=open.result,read=db.transaction('images').objectStore('images').getAll();
      read.onsuccess=()=>{resolve(read.result.flat().map((r:{name:string})=>r.name));db.close();};read.onerror=()=>reject(read.error);};
    open.onerror=()=>reject(open.error);
  }))).toEqual(['乙线粘贴.png']);
  await page.goto(url(second));await expect(draft).toBeVisible();
});

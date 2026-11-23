import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('聊天附件在原会话预览 PDF 首页与文本，停用插件时关闭，预览失败仍可下载原件', {timeout:60000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'chat-file-preview-')),token='fixture-preview';
  const server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,token,demo:true});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#chat?token='+token);
  const pdf=await readFile(new URL('./fixtures/knowledge-attachments/text-layer.pdf',import.meta.url));
  const plain='合成文本 <strong>保留原样</strong>\n第二行';
  const files=[
    {name:'首页.pdf',mimeType:'application/pdf',buffer:pdf},
    {name:'只读资料.txt',mimeType:'text/plain',buffer:Buffer.from(plain)},
    {name:'可下载.txt',mimeType:'text/plain',buffer:Buffer.from('原件内容不受预览故障影响')},
    {name:'折叠.pdf',mimeType:'application/pdf',buffer:pdf},
    {name:'附注.txt',mimeType:'text/plain',buffer:Buffer.from('合成附注')},
  ];
  const seen:{path:string;authorization?:string;conversation:string|null}[]=[];
  page.on('request',request=>{
    const u=new URL(request.url());
    if(u.pathname.includes('/files/') && u.pathname.endsWith('/preview')){
      assert.ok(!u.search.includes(token));
      seen.push({path:u.pathname,authorization:request.headers().authorization,conversation:u.searchParams.get('conversationId')});
    }
  });
  await page.route('**/files/2/preview?**',r=>r.fulfill({status:503,json:{error:'合成预览故障'}}));
  await page.getByLabel('选择文件').setInputFiles(files);
  await expect(page.getByText('已上传',{exact:true})).toHaveCount(files.length);
  const posted=page.waitForResponse(r=>r.url()===server.url+'/api/v1/messages' && r.request().method()==='POST');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const receipt=await posted;assert.equal(receipt.status(),202,await receipt.text());
  const msg=await receipt.json(),row=page.locator('[data-id="'+msg.id+'"]');
  const prePath='/api/v1/messages/'+msg.id+'/files/';
  const preview=(name:string)=>row.getByRole('button',{name:'预览文件 '+name,exact:true});
  const thumbnail=(name:string)=>row.getByRole('img',{name:'首页缩略图 '+name,exact:true});
  const detail=page.getByRole('dialog',{name:'文件预览'});
  await expect(thumbnail(files[0]!.name)).toBeVisible({timeout:12000});
  assert.ok(!seen.some(r=>r.path===prePath+'3/preview'),'折叠的附件尚未请求');
  await preview(files[0]!.name).click();
  const front=detail.getByRole('img',{name:'文件首页 '+files[0]!.name});
  await expect(front).toBeVisible();
  assert.ok(await front.evaluate(async(img:HTMLImageElement)=>{
    await img.decode();
    const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
    if(c.width<30 || c.height<30)return false;
    const ctx=c.getContext('2d')!;ctx.drawImage(img,0,0);
    const rgba=ctx.getImageData(0,0,c.width,c.height).data;
    let marks=0,paper=0;
    for(let i=0;i<rgba.length;i+=4){if(rgba[i+3]!>200 && rgba[i]!<180)marks++;if(rgba[i]!>240)paper++;}
    return marks>4 && paper>100;
  }),'PDF 首页必须含可见的真实页面内容');
  await detail.getByRole('button',{name:'关闭',exact:true}).click();
  await row.getByText('其余 2 个文件').click();
  await expect(thumbnail(files[3]!.name)).toBeVisible({timeout:12000});
  await preview(files[1]!.name).click();
  await expect(detail.locator('pre')).toHaveText(plain);await expect(detail.locator('strong').filter({hasText:'保留原样'})).toHaveCount(0);
  assert.ok(seen.some(r=>r.path===prePath+'1/preview'));
  assert.ok(seen.every(r=>r.authorization==='Bearer '+token && r.conversation==='main'));
  const previewUrl=server.url+prePath+'0/preview',headers={authorization:'Bearer '+token};
  assert.equal((await page.request.get(previewUrl+'?conversationId=main')).status(),401);
  assert.equal((await page.request.get(previewUrl+'?conversationId=another',{headers})).status(),404);
  const toggle=async(enabled:boolean)=>{
    const r=await page.request.post(server.url+'/api/v1/plugins/conversation-files',{headers,data:{enabled}});
    assert.equal(r.status(),200,await r.text());
  };
  await toggle(false);await expect(detail).toBeHidden();await expect(preview(files[0]!.name)).toBeHidden();
  assert.ok([403,503].includes((await page.request.get(previewUrl+'?conversationId=main',{headers})).status()));
  await toggle(true);
  await preview(files[2]!.name).click();
  await expect(detail.getByRole('alert')).toBeVisible();
  await detail.getByRole('button',{name:'关闭',exact:true}).click();
  const downloaded=page.waitForEvent('download');
  await row.getByRole('button',{name:'下载文件 '+files[2]!.name,exact:true}).click();
  const original=await downloaded;
  assert.deepEqual(await readFile((await original.path())!),files[2]!.buffer);
  assert.equal(original.suggestedFilename(),files[2]!.name);
});

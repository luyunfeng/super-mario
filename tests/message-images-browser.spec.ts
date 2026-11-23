import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

test('截图选择与粘贴在主会话及项目分别保留，发送回执与历史原图核对一致', {timeout:60000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'message-image-web-'));
  const token='fixture-message-images',machineId='image-workspace';
  const server=await startServer({host:'127.0.0.1',port:0,demo:true,dataDir:join(dir,'server'),token});
  t.after(async()=>{await server.close();await rm(dir,{force:true,recursive:true});});
  const cwd=join(dir,'workspace');await mkdir(cwd);
  const discovery=createProjectDiscovery({home:dir,cwd,roots:[],temporaryRoots:[],ignoreEnvironmentRoots:true});
  const node=startAgentNode({url:server.url,token,machineId,name:'合成电脑',dataDir:join(dir,'node'),executors:[],
    handlers:{'workspace.directory':discovery.handlers['workspace.directory']}});
  t.after(()=>node.close());
  await expect.poll(()=>server.machines.list().some(m=>m.id===machineId && m.online)).toBe(true);
  const project=await server.app.createProject({name:'截图演示',workspace:{machineId,cwd}});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#chat?token='+token);
  const png=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=4;canvas.height=3;
    const ctx=canvas.getContext('2d')!;ctx.fillStyle='navy';ctx.fillRect(0,0,4,3);
    return canvas.toDataURL().split(',')[1]!;
  });
  const bytes=Buffer.from(png,'base64');
  const file={name:'合成截图.png',mimeType:'image/png',buffer:bytes};
  const headers:{path:string;authorization?:string}[]=[];
  page.on('request',req=>{if(req.url().includes('/images/'))headers.push({path:req.url(),authorization:req.headers().authorization});});
  let mainImageId='';
  for(const p of [false,true]){
    const path=p?'/projects/'+project.id+'/messages':'/messages',conversation=p?'project:'+project.id+':work':'main';
    const href=p?'#projects/'+project.id+'/workspace':'#chat';
    await page.goto(server.url+'/'+href);
    const input=page.getByRole('textbox',{name:p?'项目目标':'给 Agent 的消息'});
    const composer=input.locator('xpath=ancestor::*[contains(@class,"composer") and .//input[@type="file" and @multiple]][1]');
    const picker=composer.getByLabel('选择图片');
    await expect(composer.getByRole('button',{name:'添加图片'})).toBeEnabled();
    if(!p) {
      await picker.setInputFiles(Array.from({length:21},()=>file));
      await expect(composer).toContainText('一条消息最多可附 20 张图片');
      await expect(composer.locator('.message-image-draft')).toHaveCount(0);
      // A browser-encoded PNG above the wire limit must arrive under the limit at the same aspect ratio.
      await input.evaluate(async el=>{
        const canvas=document.createElement('canvas');canvas.width=1400;canvas.height=1000;
        const ctx=canvas.getContext('2d')!;
        const noise=ctx.createImageData(1400,1000);
        let seed=1;
        for(let i=0;i<noise.data.length;i+=4){
          seed=(Math.imul(seed,1664525)+1013904223)>>>0;
          noise.data[i]=seed>>>24;noise.data[i+1]=(seed>>>16)&255;noise.data[i+2]=(seed>>>8)&255;noise.data[i+3]=255;
        }
        ctx.putImageData(noise,0,0);
        const blob=await new Promise<Blob>(resolve=>canvas.toBlob(blob=>resolve(blob!),'image/png'));
        if(blob.size<=3750000) throw new Error('测试 PNG 须大于单图上限');
        const transfer=new DataTransfer();transfer.items.add(new File([blob],'压缩测试.png',{type:'image/png'}));
        el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
      });
      const compressed=composer.getByAltText('压缩测试.png');
      await expect(compressed).toBeVisible();
      assert.ok(await compressed.evaluate((el:HTMLImageElement)=>el.src.length<5000100 && Math.abs(el.naturalWidth/el.naturalHeight-1.4)<0.01));
      await composer.getByRole('button',{name:'移除第 1 张图片'}).click();
    }
    await picker.setInputFiles(file);
    await expect(composer.getByRole('button',{name:'移除第 1 张图片'})).toBeVisible();
    await input.evaluate((el,b64)=>{
      const transfer=new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],'粘贴图片.png',{type:'image/png'}));
      el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
    },png);
    await expect(composer.getByRole('button',{name:'移除第 2 张图片'})).toBeVisible();
    if(!p) await composer.getByRole('button',{name:'移除第 2 张图片'}).click();
    if(p) await input.fill('请看两张合成截图');
    const send=page.getByRole('button',{name:p?'发送目标':'发送',exact:true});
    const url=server.url+'/api/v1'+path;
    let firstKey:string|undefined;
    await page.route(url,route=>{firstKey=route.request().headers()['idempotency-key'];return route.fulfill({status:503,json:{error:'暂时不可用'}});},{times:1});
    const failed=page.waitForResponse(r=>r.url()===url && r.request().method()==='POST');
    await send.click();assert.equal((await failed).status(),503);
    await expect(composer.getByRole('button',{name:'移除第 1 张图片'})).toBeVisible();
    await page.reload();
    await expect(composer.getByRole('button',{name:'移除第 1 张图片'})).toBeVisible();
    const sent=page.waitForResponse(r=>r.url()===url && r.request().method()==='POST');
    await send.click();
    const res=await sent;assert.equal(res.status(),202,await res.text());
    const message=await res.json();
    assert.equal(res.request().headers()['idempotency-key'],firstKey);
    assert.equal(message.text,p?'请看两张合成截图':'');
    assert.equal(message.images.length,p?2:1);
    assert.equal(message.images[0].sha256,createHash('sha256').update(bytes).digest('hex'));
    await expect(composer.getByRole('button',{name:'移除第 1 张图片'})).toHaveCount(0);
    const row=page.locator('[data-id="'+message.id+'"]');
    const thumb=row.getByRole('img',{name:'消息图片 1',exact:true});
    await expect(thumb).toBeVisible();
    await page.reload();
    await expect(thumb).toBeVisible();
    assert.equal(await thumb.evaluate((el:HTMLImageElement)=>el.naturalWidth),4);
    assert.match((await thumb.getAttribute('src'))!,/^blob:/);
    assert.ok(headers.some(req=>req.path.includes(message.id+'/images/0') && new URL(req.path).searchParams.get('conversationId')===conversation && req.authorization==='Bearer '+token));
    assert.ok(headers.every(req=>!req.path.includes(token)));
    if(p) {
      const foreign=await page.request.get(server.url+'/api/v1/messages/'+mainImageId+'/images/0?conversationId='+encodeURIComponent(conversation),{headers:{Authorization:'Bearer '+token}});
      assert.ok(foreign.status()>=400 && foreign.status()<500);
    } else {
      mainImageId=message.id;
      await picker.setInputFiles(file);
      await expect(composer.getByRole('button',{name:'移除第 1 张图片'})).toBeVisible();
      const headers={Authorization:'Bearer '+token};
      const plugin=server.url+'/api/v1/plugins/conversation-images';
      const disable=await page.request.post(plugin,{headers,data:{enabled:false}});
      assert.equal(disable.status(),200,await disable.text());
      await expect(composer.getByRole('button',{name:'添加图片'})).toBeHidden();
      await expect(composer.getByRole('button',{name:'移除第 1 张图片'})).toBeHidden();
      await expect(thumb).toBeHidden();
      const unavailable=await page.request.get(server.url+'/api/v1/messages/'+message.id+'/images/0?conversationId=main',{headers});
      assert.ok([403,503].includes(unavailable.status()),'停用期间不能下载原图');
      await input.fill('插件停用期间继续文字对话');
      const receipt=page.waitForResponse(r=>r.url()===url && r.request().method()==='POST');
      await send.click();
      const plain=await receipt;
      assert.equal(plain.status(),202,await plain.text());
      assert.equal(plain.request().postDataJSON().images,undefined);
      const imagePost=await page.request.post(url,{headers,data:{text:'',images:[{mime:'image/png',data:png}]}});
      assert.ok([403,503].includes(imagePost.status()));
      const enable=await page.request.post(plugin,{headers,data:{enabled:true}});
      assert.equal(enable.status(),200,await enable.text());
      await expect(thumb).toBeVisible();
      await expect(composer.getByRole('button',{name:'移除第 1 张图片'})).toBeVisible();
      await composer.getByRole('button',{name:'移除第 1 张图片'}).click();
    }
  }
});

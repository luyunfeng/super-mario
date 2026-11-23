import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('图片查看器支持缩放、拖动、旋转、切换，下载和编辑时重新核准原图', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-viewer-'));
  const server = await startServer({dataDir:dir,port:0,host:'127.0.0.1',demo:true});
  t.after(async () => { await server.close(); await rm(dir,{recursive:true,force:true}); });
  const browser = await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page = await browser.newPage({viewport:{width:900,height:650},permissions:['clipboard-read','clipboard-write']});
  await page.goto(server.url+'/css/base.css');
  await page.setContent('<link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/chat-image-viewer.css"><button id="open">查看图片</button>');
  const bytes = await page.evaluate(async modulePath => {
    const {openChatImageViewer} = await import(modulePath);
    const canvas = document.createElement('canvas');
    canvas.width = 1800; canvas.height = 1200;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle='#26894e'; ctx.fillRect(10,10,800,400);
    const image = await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!),'image/jpeg'));
    const controls = document.body.dataset;
    controls.calls = ''; controls.closed = '0';
    document.querySelector<HTMLButtonElement>('#open')!.onclick=()=>{
      openChatImageViewer({index:0,count:2,
        valid:()=>controls.valid!=='no',
        async load(i:number,signal:AbortSignal) {
          controls.calls += String(i);
          if (controls.deny === 'yes') throw Object.assign(Error('denied'),{status:403});
          if(i===1 && controls.slow==='yes') await new Promise<void>(ok=>signal.addEventListener('abort',()=>ok(),{once:true}));
          return image;
        },
        onEdit(i:number,blob:Blob){controls.edited=i+'-'+blob.size;},
        onClose(){controls.closed=String(Number(controls.closed)+1);},
      });
    };
    return canvas.toDataURL('image/jpeg').split(',')[1];
  },server.url+'/js/features/chat-image-viewer.js');
  const dialog = page.getByRole('dialog',{name:'图片查看器'});
  const button = (name:string)=>dialog.getByRole('button',{name,exact:true});
  const open = ()=>page.getByRole('button',{name:'查看图片',exact:true}).click();
  const img = dialog.getByRole('img');
  const data = (key:string)=>page.locator('body').getAttribute('data-'+key);
  await open(); await expect(img).toBeVisible(); await expect(button('上一张')).toBeDisabled();
  const panel = dialog.locator('.chat-image-viewer__canvas');
  const fitted = await dialog.locator('output').innerText();
  assert.ok(parseInt(fitted) < 50);
  await panel.dblclick({position:{x:130,y:100}});
  await expect(dialog.locator('output')).toHaveText('100%');
  assert.doesNotMatch(await img.getAttribute('style') ?? '', /translate\(0px, 0px\)/);
  await panel.dblclick({position:{x:130,y:100}});
  await expect(dialog.locator('output')).toHaveText(fitted);
  await button('原尺寸').click(); await expect(dialog.locator('output')).toHaveText('100%');
  await panel.dispatchEvent('wheel',{deltaMode:0, deltaY:-2, ctrlKey:true});
  await expect(dialog.locator('output')).toHaveText('102%');
  await panel.dispatchEvent('wheel',{deltaMode:0, deltaY:2, ctrlKey:true});
  await expect(dialog.locator('output')).toHaveText('100%');
  await button('原尺寸').click();
  await button('放大').click(); await expect(dialog.locator('output')).toHaveText('125%');
  const stage = dialog.locator('.chat-image-viewer__canvas'); const b = (await stage.boundingBox())!;
  await page.mouse.move(b.x+200,b.y+100); await page.mouse.down(); await page.mouse.move(b.x+260,b.y+140); await page.mouse.up();
  assert.match(await img.getAttribute('style')??'',/60px, 40px/);
  await button('向右旋转').click(); assert.match(await img.getAttribute('style')??'',/rotate\(90deg\)/);
  await button('适应窗口').click(); assert.ok(parseInt(await dialog.locator('output').innerText())<100);
  await page.keyboard.press('ArrowRight'); await expect(img).toHaveAttribute('alt','消息图片 2');
  const downloadEvent = page.waitForEvent('download');
  await button('下载图片').click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(),'消息图片-2.jpg');
  assert.deepEqual(await readFile((await download.path())!),Buffer.from(bytes,'base64'));
  assert.equal(await data('calls'),'011');
  await button('复制图片').click(); await expect(dialog.getByRole('status',{name:'图片读取与操作状态'})).toContainText('图片已复制');
  const copied = await page.evaluate(async()=>{
    const item=(await navigator.clipboard.read())[0];
    const bitmap=await createImageBitmap(await item.getType('image/png'));
    try { return [bitmap.width,bitmap.height]; } finally { bitmap.close(); }
  });
  assert.deepEqual(copied,[1800,1200]);
  await button('编辑到草稿').click(); await expect(dialog).toHaveCount(0);
  assert.equal(await data('edited'),'1-'+Buffer.from(bytes,'base64').length);
  assert.equal(await data('calls'),'01111');
  await open(); await expect(img).toBeVisible();
  await page.evaluate(()=>{document.body.dataset.slow='yes';});
  await button('下一张').click(); await button('上一张').click();
  await expect(img).toHaveAttribute('alt','消息图片 1');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  assert.equal(await data('closed'),'2');
  await open(); await expect(img).toBeVisible();
  await page.evaluate(()=>{document.body.dataset.deny='yes';});
  await button('下载图片').click(); await expect(dialog).toHaveCount(0);
  assert.equal(await data('closed'),'3');
  await page.evaluate(()=>{delete document.body.dataset.deny;});
  await open(); await expect(img).toBeVisible();
  await page.evaluate(()=>{location.hash='other';});
  await expect(dialog).toHaveCount(0); assert.equal(await data('closed'),'4');
});

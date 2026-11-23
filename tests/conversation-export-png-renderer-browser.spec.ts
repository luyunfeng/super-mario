import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from '@playwright/test';

test('PNG 导出在分页后保留原文末尾，并只从已鉴权入口绘制纯图消息', async t => {
  const server = createServer(async (req, res) => {
    if (req.url === '/') return res.end('<html lang="zh"></html>');
    if (/^\/js\/[a-z0-9-]+\/[a-z0-9-]+\.js$/.test(req.url || '')) {
      try {
        const bytes = await readFile(new URL('../apps/web' + req.url, import.meta.url));
        res.setHeader('Content-Type', 'text/javascript');
        return res.end(bytes);
      } catch { /* An unknown static module is an ordinary 404. */ }
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + address.port);
  const report = await page.evaluate(async () => {
    const path = '/js/features/conversation-export-png.js';
    const { renderConversationPNGs } = await import(path);
    const signal = new AbortController().signal;
    const paint = document.createElement('canvas');
    paint.width = paint.height = 80;
    const ctx = paint.getContext('2d')!;
    ctx.fillStyle = '#ef1709';
    ctx.fillRect(0, 0, 80, 80);
    const fixture = await new Promise<Blob>(resolve => paint.toBlob(blob => resolve(blob!)));
    const calls: string[] = [], draws: {text:string;font:string}[] = [];
    const prev = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      draws.push({text:args[0],font:this.font});
      return prev.apply(this, args);
    };
    const api = {blob: async (url:string, s:AbortSignal) => {
      if (s !== signal) throw new Error('错误的请求控制器');
      calls.push(url);
      return fixture;
    }};
    const base = {api, conversationId: 'web:fixture', title:'测试标题', signal};
    const source = {id:'原图/0',role:'user',text:'',createdAt:'2026-11-24T12:00:00Z',images:[{index:1}]};
    const image = await renderConversationPNGs({...base,heading:false,dates:true,messages:[source]});
    const bitmap = await createImageBitmap(image[0]);
    paint.width = bitmap.width; paint.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const rgb = Array.from(ctx.getImageData(190,115,1,1).data);
    const first = draws.splice(0);
    const messages = [{id:'reply',role:'assistant', createdAt:source.createdAt, text:[
      '## 验收结果', '> 摘录', '- **开始**', '```js', 'let n = 1', '```',
      ...Array.from({length:260}, (_,i) => 'line ' + i), 'END_OF_LAST_PAGE'
    ].join('\n'),files:[{name:'fixture.txt',bytes:123}]}];
    const pages = await renderConversationPNGs({...base,dates:false,messages});
    const second = draws.splice(0);
    const sizes = await Promise.all(pages.map(async (blob:Blob) => {
      const im = await createImageBitmap(blob), size = [im.width, im.height];
      im.close();
      return size;
    }));
    const failed = await renderConversationPNGs({...base,api:{blob:async()=>{throw new Error('原图访问已失效');}},messages:[source]})
      .then(() => '', (e:Error) => e.message);
    CanvasRenderingContext2D.prototype.fillText = prev;
    return {calls,rgb,first,second,sizes,failed};
  });
  assert.deepEqual(report.calls, ['/messages/%E5%8E%9F%E5%9B%BE%2F0/images/1?conversationId=web%3Afixture']);
  assert.deepEqual(report.rgb,[239,23,9,255]);
  assert.ok(report.first.some(r=>r.text.includes('2026')));
  assert.ok(!report.first.some(r=>r.text.includes('测试标题')));
  assert.ok(report.sizes.length > 1);
  assert.ok(report.sizes.every(([w,h]:number[]) => w===780 && h<=4850));
  assert.ok(report.second.some(r=>r.text==='验收结果' && /600|bold/.test(r.font)));
  assert.ok(report.second.some(r=>r.text==='测试标题'));
  assert.ok(!report.second.some(r=>r.text.includes('2026')));
  assert.ok(report.second.some(r=>r.text==='END_OF_LAST_PAGE'));
  assert.ok(report.second.some(r=>r.text.includes('fixture.txt') && r.text.includes('123 B')));
  assert.equal(report.failed,'原图访问已失效');
});

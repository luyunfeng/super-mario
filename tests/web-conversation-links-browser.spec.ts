import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

test('独立消息链接定位早期原文、刷新与后翻页，复制不携带凭据，跨会话引用无法读取', {timeout:45000}, async t => {
  const dir=await mkdtemp(join(tmpdir(),'sm-web-msg-links-')),token='offline-link-token';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,token,demo:true});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});});
  async function create(title:string){
    const id=randomUUID();
    const response=await fetch(server.url+'/api/v1/web-conversations',{method:'POST',
      headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id,title})});
    assert.equal(response.status,201);
    return id;
  }
  const a=await create('分页对话甲'),b=await create('隔离对话乙');
  const ids:string[]=[];
  const otherId=randomUUID(),otherText='仅限乙的合成原文';
  const label=(n:number)=>'合成分页消息 '+String(n).padStart(3,'0');
  server.app.store.transaction(()=>{
    for(let i=0;i<128;i++){
      const id=randomUUID();
      ids.push(id);
      server.app.store.put('messages',id,{id,conversationId:'web:'+a,role:i%2?'assistant':'user',
        text:label(i),status:'done',createdAt:new Date(Date.UTC(2026,0,1)+i*1000).toISOString()});
    }
    server.app.store.put('messages',otherId,{id:otherId,conversationId:'web:'+b,role:'user',
      text:otherText,status:'done',createdAt:new Date().toISOString()});
  });
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
  await context.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const page=await context.newPage();
  const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.url+'/#chat?token='+token);
  await expect(page.locator('#message-text')).toBeVisible();
  const n=13,anchor=new URLSearchParams({thread:a,at:ids[n]}),link=server.url+'/#chat?'+anchor;
  await page.goto(link);
  const region=page.getByLabel('独立对话内容');
  const target=region.locator('article[aria-current=true][data-id="'+ids[n]+'"]');
  await expect(target).toContainText(label(n));
  await expect(target).toBeFocused();
  await expect(region.getByText(label(127),{exact:true})).toHaveCount(0);
  await target.getByRole('button',{name:'复制消息链接'}).click();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(link);
  await page.reload();
  await expect(target).toBeFocused();
  const later=region.getByRole('button',{name:'加载后续消息'});
  for(let i=0;i<3 && !await region.getByText(label(127),{exact:true}).count();i++){
    const count=await region.locator('article').count();
    await later.click();
    await expect.poll(()=>region.locator('article').count()).toBeGreaterThan(count);
  }
  await expect(region.getByText(label(127),{exact:true})).toHaveCount(1);
  const rows=await region.locator('article[data-id]').evaluateAll(els=>els.map(el=>el.getAttribute('data-id')));
  assert.equal(new Set(rows).size,rows.length);
  // The message exists, but belongs to another conversation. Verify both handler and renderer.
  const refused=page.waitForResponse(r=>new URL(r.url()).searchParams.get('at')===otherId);
  await page.goto(server.url+'/#chat?'+new URLSearchParams({thread:a,at:otherId}));
  assert.equal((await refused).status(),404);
  await expect(region.locator('article[aria-current=true]')).toHaveCount(0);
  await expect(region.getByText(otherText,{exact:true})).toHaveCount(0);
  assert.deepEqual(errors,[]);
});

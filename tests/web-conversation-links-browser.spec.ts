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

test('独立对话搜索仅显示本线原文和引用，点击旧发言可精确定位', {timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-search-web-thread-')),token='synthetic-search-thread';
  const server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,token,demo:true});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dir,{recursive:true,force:true});});
  const project=server.app.projects.create({name:'检索项目'}),thread=randomUUID(),other=randomUUID();
  const headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const source='逐字核对样本';
  const submit=async(id:string,text:string)=>{
    assert.equal((await fetch(server.url+'/api/v1/web-conversations',{method:'POST',headers,body:JSON.stringify({id,projectId:project.id,title:id===thread?'本线':'其他线'})})).status,201);
    const res=await fetch(server.url+'/api/v1/web-conversations/'+id+'/messages',{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},body:JSON.stringify({text})});
    assert.equal(res.status,202);return (await res.json()).id;
  };
  const target=await submit(thread,'> '+source+' 选择这段原话。\n\n请核对。');
  await submit(other,'> '+source+' 属于其他线。\n\n请核对。');
  for(let i=0;i<52;i++){
    const id=randomUUID();server.app.store.put('messages',id,{id,conversationId:'web:'+thread,projectId:project.id,role:'user',directWebInput:true,status:'done',text:'合成分页 '+i,createdAt:new Date().toISOString()});
  }
  const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  await page.goto(server.url+'/#chat?thread='+thread+'&token='+token);
  const region=page.getByLabel('独立对话内容');
  await expect(region.locator('[data-id="'+target+'"]')).toHaveCount(0);
  await region.getByRole('button',{name:'搜索本对话'}).click();
  const drawer=page.getByRole('dialog',{name:'搜索本对话'}),category=drawer.getByLabel('搜索内容');
  assert.deepEqual(await category.locator('option').allTextContents(),['全部','正文','引用']);
  await category.selectOption('quoted');
  const pending=page.waitForRequest(r=>r.method()==='POST' && r.url().endsWith('/conversation-message-search'));
  await drawer.getByRole('searchbox').fill(source);
  const request=await pending;
  assert.deepEqual(request.postDataJSON(),{conversationId:'web:'+thread,projectId:project.id,query:source,category:'quoted'});
  await expect(drawer.getByRole('listitem')).toHaveCount(1);await expect(drawer).not.toContainText('属于其他线');
  const link=drawer.getByRole('link',{name:/选择这段原话/});
  await expect(link).toHaveAttribute('href','#chat?thread='+thread+'&at='+target);
  await link.click();
  await expect(region.locator('[data-id="'+target+'"]')).toBeFocused();
  await region.getByRole('button',{name:'搜索本对话'}).click();
  const off=await fetch(server.url+'/api/v1/plugins/conversation-search',{method:'POST',headers,body:JSON.stringify({enabled:false})});
  assert.equal(off.status,200);
  await expect(drawer).toHaveCount(0);await expect(region.getByRole('button',{name:'搜索本对话'})).toHaveCount(0);
});

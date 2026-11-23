import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('独立对话跨页选消息，附上原提问后预览、复制和下载 PNG，切换来源会收起预览',{timeout:45000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'thread-png-')),token='synthetic-thread-png';
  const server=await startServer({dataDir,port:0,host:'127.0.0.1',demo:true,token});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(async()=>{await browser.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  const page=await browser.newPage({permissions:['clipboard-read','clipboard-write']});
  await page.addInitScript(()=>localStorage.setItem('sm.splash.seen','true'));
  const headers={Authorization:'Bearer '+token},project=server.app.projects.create({name:'合成图片导出项目'});
  const first=randomUUID(),second=randomUUID(),path=server.url+'/api/v1/web-conversations';
  for(const [id,title] of [[first,'跨页导出'],[second,'其他独立对话']]){
    assert.equal((await page.request.post(path,{headers,data:{id,title,projectId:project.id}})).status(),201);
  }
  const ids=Array.from({length:56},()=>randomUUID());
  for(const [i,id] of ids.entries()){
    const last=i===55;
    const text=i===0?'早期选中发言':i===54?'最后一条答复的原始提问':last?'选中的答复\n'+Array.from({length:320},(_,n)=>'核对事项 '+n).join('\n'):'无关历史 '+i;
    server.app.store.put('messages',id,{id,conversationId:'web:'+first,projectId:project.id,role:last?'assistant':'user',text,
      ...(last?{replyTo:ids[54]}:{directWebInput:true}),status:'done',createdAt:new Date(1700000000000+i*1000).toISOString()});
  }
  const url=(id:string)=>server.url+'/#chat?thread='+id;
  await page.goto(url(first)+'&token='+token);
  const region=page.getByLabel('独立对话内容'),enter=region.getByRole('button',{name:'导出消息图片',exact:true});
  await enter.click();
  const check=(id:string)=>region.locator('[data-id="'+id+'"]').getByRole('checkbox');
  await check(ids[55]!).check();await expect(check(ids[0]!)).toHaveCount(0);
  await region.getByRole('button',{name:'加载更早消息'}).click();await check(ids[0]!).check();await expect(check(ids[55]!)).toBeChecked();
  const preview=region.getByRole('button',{name:'预览图片',exact:true});
  const response=()=>page.waitForResponse(r=>r.url().endsWith('/conversation-export') && r.request().method()==='POST' && r.request().postDataJSON().action==='preview_image');
  const firstRead=response();await preview.click();
  const read=await firstRead;assert.equal(read.status(),200);
  assert.deepEqual(read.request().postDataJSON(),{action:'preview_image',webThreadId:first,projectId:project.id,messageIds:[ids[55],ids[0]],includeQuestions:false});
  const drawer=page.getByRole('dialog',{name:'导出消息图片',exact:true});
  await page.route('**/conversation-export',route=>route.fulfill({status:503,json:{error:'合成预览服务暂不可用'}}),{times:1});
  await drawer.getByLabel('附上对应提问').check();
  await expect(drawer.getByRole('status')).toContainText('合成预览服务暂不可用');
  await expect(drawer.getByLabel('附上对应提问')).toBeChecked();
  const include=response();
  await drawer.getByRole('button',{name:'重试',exact:true}).click();
  const retried=await include;
  assert.deepEqual(retried.request().postDataJSON().messageIds,[ids[55],ids[0]]);
  const withQuestion=await retried.json();
  assert.deepEqual(withQuestion.messages.map((m:{id:string})=>m.id),[ids[0],ids[54],ids[55]]);
  await drawer.getByLabel('显示对话标题').uncheck();await drawer.getByLabel('显示日期').uncheck();
  const image=drawer.getByAltText('PNG 预览 第 1 页',{exact:true});
  await expect(image).toBeVisible();await expect(drawer.getByAltText('PNG 预览 第 2 页',{exact:true})).toBeVisible();
  await drawer.getByRole('button',{name:'复制第 1 页'}).click();
  await expect.poll(()=>page.evaluate(async()=>(await navigator.clipboard.read()).some(item=>item.types.includes('image/png')))).toBe(true);
  const downloading=page.waitForEvent('download');await drawer.getByRole('button',{name:'下载第 2 页',exact:true}).click();
  const downloaded=await downloading;assert.equal(downloaded.suggestedFilename(),'对话摘录-2.png');
  const bytes=await readFile((await downloaded.path())!);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const count=await drawer.locator('img').count(),all:string[]=[];
  page.on('download',file=>all.push(file.suggestedFilename()));
  await drawer.getByRole('button',{name:'下载全部 PNG'}).click();
  await expect.poll(()=>new Set(all).size).toBe(count);
  const toggle=(id:string,enabled:boolean)=>page.request.post(server.url+'/api/v1/plugins/'+id,{headers,data:{enabled}});
  assert.equal((await toggle('conversation-files',false)).status(),200);await expect(drawer).toHaveCount(0);
  await preview.click();await expect(image).toBeVisible();
  await page.goto(url(second));await expect(drawer).toHaveCount(0);await expect(preview).toBeHidden();
  await page.goto(url(first));await enter.click();await check(ids[55]!).check();await preview.click();await expect(image).toBeVisible();
  assert.equal((await toggle('conversation-export',false)).status(),200);await expect(drawer).toHaveCount(0);await expect(enter).toBeHidden();await expect(preview).toBeHidden();
  assert.equal((await toggle('conversation-export',true)).status(),200);
  await enter.click();await check(ids[55]!).check();await preview.click();await expect(image).toBeVisible();
  const meta=await (await page.request.get(path+'/'+first,{headers})).json();
  assert.equal((await page.request.delete(path+'/'+first,{headers,data:{version:meta.version}})).status(),200);
  await expect(drawer).toHaveCount(0);await expect(region).toContainText('原链接已失效');
});

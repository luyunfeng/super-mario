import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import type { FeishuBotFactory } from '../apps/server/src/feishu-bots.ts';
import type { FeishuOptions, FeishuSendContext } from '../plugins/feishu.ts';

test('Web 从当前机器人打开独立对话，核对其正文和机器人归属', { timeout: 90000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-private-browser-'));
  const clients = new Map<string, FeishuOptions>();
  const token = 'offline-browser';
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, token }, {
    botFactory(opts) {
      clients.set(opts.appId, opts);
      return { async start() {}, async close() {}, async collect() { return []; }, status: () => ({ connected: true }),
        async readPrivateForward() {return '合成聊天记录正文';},
        async readPrivateImage() {return {mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};},
        async send() {} };
    },
  });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const create = async (name: string, appId: string) => {
    const bot = await server.bots.create({ name, appId, appSecret: 'fixture', scope: { kind: 'global' }, requireConfirmation: false });
    const send = (text: string, messageId: string, parentId?:string) => clients.get(appId)!.onMessage(text,
      { messageId, parentId, senderType: 'user', senderId: name, chatId: 'chat-' + name, chatType: 'p2p' });
    await send(bot.pairingCode!, 'pair');
    return { bot, send };
  };
  const first = await create('合成甲', 'cli_3333333333333333');
  const second = await create('合成乙', 'cli_4444444444444444');
  await second.send('/new 其他机器人的讨论', 'second');
  const input=async(text:string)=>t.waitFor(()=>{
    const m=server.app.store.list<Message>('messages').find(m=>m.role==='user' && m.text===text && m.status==='done');
    assert.ok(m);return m;
  });
  await first.send('原有主人私聊锚点','original-main');
  const main=await input('原有主人私聊锚点');
  await first.send('/new 核对独立方案', 'first');
  const independent=await input('核对独立方案');
  const base = '/api/v1/feishu/bots/';
  const get = (path: string) => fetch(server.url + path, { headers: { authorization: 'Bearer ' + token } });
  let thread = '';
  await t.waitFor(async () => {
    const res = await get(base + first.bot.id + '/threads');
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.equal(rows.length, 1);
    thread = rows[0].threadId;
  });
  assert.equal((await get(base + second.bot.id + '/threads/' + thread)).status, 404);
  assert.equal((await fetch(server.url + base + first.bot.id + '/threads')).status, 401);
  const detailPath=base+first.bot.id+'/threads/'+thread;
  const selection=async()=>(await (await get(detailPath)).json()).selection as {version:string;selected:boolean};
  const select=(version:string)=>fetch(server.url+detailPath+'/select',{method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({version})});
  const active=await selection();assert.equal(active.selected,true);
  await first.send('/main','back-main-before-inspection');
  const prior=await selection();assert.equal(prior.selected,false);assert.notEqual(prior.version,active.version);
  assert.equal((await select(active.version)).status,409);
  const page = await browser.newPage();
  const clipboardWrites: string[] = [];
  await page.exposeFunction('captureThreadClipboard', (text: string) => { clipboardWrites.push(text); });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: (text: string) => (window as unknown as { captureThreadClipboard(value: string): Promise<void> }).captureThreadClipboard(text),
    } });
  });
  await page.goto(server.url + '/#agent?token=' + token);
  const row = page.locator('#agent-bot .row').filter({ has: page.getByText('合成甲', { exact: true }) });
  await row.getByRole('button', { name: '独立对话记录' }).click();
  const drawer = page.getByRole('dialog', { name: '独立对话记录' });
  await drawer.getByRole('button', { name: /核对独立方案/ }).click();
  await expect(drawer.locator('section').first()).toContainText('核对独立方案');
  await expect(drawer).not.toContainText('其他机器人的讨论');
  assert.deepEqual(await selection(),prior);
  await first.send('只浏览详情后发送','peek-main');
  assert.equal((await input('只浏览详情后发送')).conversationId,main.conversationId);
  const selectedResult=page.waitForResponse(r=>r.url()===server.url+detailPath+'/select' && r.request().method()==='POST');
  await drawer.getByRole('button',{name:'在飞书继续聊',exact:true}).click();
  const selectedResponse=await selectedResult;assert.equal(selectedResponse.status(),200,await selectedResponse.text());
  assert.deepEqual(selectedResponse.request().postDataJSON(),{version:prior.version});
  const nowSelected=await selection();assert.equal(nowSelected.selected,true);assert.notEqual(nowSelected.version,prior.version);
  assert.equal((await select(prior.version)).status,200);assert.equal((await select(nowSelected.version)).status,200);
  assert.deepEqual(await selection(),nowSelected);
  await first.send('显式选择后的普通发言','selected-from-web');
  assert.equal((await input('显式选择后的普通发言')).conversationId,independent.conversationId);
  await first.send('仍引用最初的私聊','quote-original','original-main');
  assert.equal((await input('仍引用最初的私聊')).conversationId,main.conversationId);
  await first.send('引用之后仍以网页选择为准','no-quote-again');
  assert.equal((await input('引用之后仍以网页选择为准')).conversationId,independent.conversationId);
  await clients.get('cli_3333333333333333')!.onMessage('[图片]', {
    privateImage:true,chatType:'p2p',chatId:'chat-合成甲',senderId:'合成甲',senderType:'user',messageId:'photo-parent',
  });
  await input('[图片]');
  await first.send('这张图片里有什么？','quote-photo','photo-parent');
  await input('这张图片里有什么？');
  await clients.get('cli_3333333333333333')!.onMessage('[文件]', {
    privateForward:true,chatType:'p2p',chatId:'chat-合成甲',senderId:'合成甲',senderType:'user',messageId:'file-parent',
  });
  await input('[文件]');
  await first.send('这份记录说了什么？','quote-file','file-parent');
  await input('这份记录说了什么？');
  await drawer.getByRole('button',{name:'返回列表'}).click();
  await drawer.getByRole('button',{name:/核对独立方案/}).click();
  await drawer.getByRole('button',{name:'查看引用原图'}).click();
  await expect(drawer.locator('section').filter({has:page.getByText('定位到的消息',{exact:true})})).toContainText('[图片]');
  await drawer.getByRole('button',{name:'查看引用文件'}).click();
  await expect(drawer.locator('section').filter({has:page.getByText('定位到的消息',{exact:true})})).toContainText('转发的聊天记录.txt');
  await drawer.getByRole('button', { name: '复制对话 ID' }).click();
  await expect(drawer).toContainText('已复制对话 ID。');
  assert.deepEqual(clipboardWrites, [thread]);
  await drawer.getByRole('button', { name: '查看当前配置的模型清单' }).click();
  await expect(drawer).toContainText('演示模式');
  await drawer.getByRole('button', { name: '返回列表' }).click();
  await expect(drawer.getByRole('button', { name: /核对独立方案/ })).toBeVisible();
  await drawer.getByRole('button', { name: /核对独立方案/ }).click();
  await drawer.getByRole('textbox', { name: '对话标题' }).fill('归档核验方案');
  await drawer.getByRole('button', { name: '保存标题' }).click();
  await expect(drawer.getByRole('heading', { name: '归档核验方案' })).toBeVisible();
  await drawer.getByRole('button', { name: '归档对话' }).click();
  await expect(drawer.getByRole('button', { name: '恢复对话' })).toBeVisible();
  const archivedSelect=await select((await selection()).version);
  assert.equal(archivedSelect.status,409,await archivedSelect.text());
  await drawer.getByRole('button', { name: '返回列表' }).click();
  await expect(drawer.getByRole('button', { name: /归档核验方案/ })).toBeVisible();
  await drawer.getByRole('button', { name: '未归档', exact: true }).click();
  await expect(drawer.getByRole('button', { name: /归档核验方案/ })).toHaveCount(0);
  await drawer.getByRole('button', { name: '已归档', exact: true }).click();
  await drawer.getByRole('button', { name: /归档核验方案/ }).click();
  await drawer.getByRole('button', { name: '恢复对话' }).click();
  await expect(drawer.getByRole('button', { name: '归档对话' })).toBeVisible();
  const saved = await (await get(base + first.bot.id + '/threads/' + thread)).json();
  assert.equal(saved.title, '归档核验方案');
  assert.equal(saved.archived, false);
  const changedElsewhere = await fetch(server.url + base + first.bot.id + '/threads/' + thread, {
    method: 'PATCH', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ version: saved.version, title: '另一个页面的新标题' }),
  });
  assert.equal(changedElsewhere.status, 200);
  await drawer.getByRole('textbox', { name: '对话标题' }).fill('不应覆盖的新标题');
  await drawer.getByRole('button', { name: '保存标题' }).click();
  await expect(drawer).toContainText('已在别处修改');
  await expect(drawer.getByRole('heading', { name: '另一个页面的新标题' })).toBeVisible();
  await drawer.getByRole('button', { name: '还原默认标题' }).click();
  await expect(drawer.getByRole('heading', { name: '核对独立方案' })).toBeVisible();
  async function addTag(tag: string) {
    await drawer.getByLabel('新标签', { exact: true }).fill(tag);
    await drawer.getByRole('button', { name: '添加标签', exact: true }).click();
  }
  await addTag('初始标签');
  await drawer.getByRole('button', { name: '保存标签', exact: true }).click();
  await expect(drawer).toContainText('当前已保存标签：初始标签');
  await drawer.getByRole('button', { name: '移除 初始标签' }).click();
  await addTag('核对标签');
  await drawer.getByRole('button', { name: '保存标签', exact: true }).click();
  await expect(drawer).toContainText('当前已保存标签：核对标签');
  const keyword = '蓝色铅笔标记';
  await first.send('很早的'.repeat(25) + keyword + '后文'.repeat(40), 'old-hit');
  await t.waitFor(async () => {
    const detail = await (await get(detailPath)).json();
    assert.ok(detail.messages.some((message: { role: string; text: string }) =>
      message.role === 'assistant' && message.text.includes(keyword)));
  });
  for (let i = 0; i < 22; i++) await first.send('较新的记录 ' + i, 'recent-' + i);
  await t.waitFor(async () => {
    const detail = await (await get(detailPath)).json();
    assert.equal(detail.messages.length, 40);
    assert.match(detail.messages.at(-1).text, /较新的记录 21/);
    assert.ok(!detail.messages.some((message: { role: string; text: string }) => message.role === 'user' && message.text.includes(keyword)),
      '指定的用户发言应在最近一页之前');
  }, { timeout: 15000 });
  await drawer.getByRole('button', { name: '返回列表' }).click();
  await first.send('/new 另一条没有标签的资料', 'different-thread');
  await drawer.getByRole('combobox', { name: '筛选标签' }).selectOption('核对标签');
  await expect(drawer.getByRole('button', { name: /核对独立方案/ })).toBeVisible();
  await expect(drawer).not.toContainText('另一条没有标签的资料');
  await drawer.getByRole('textbox', { name: '搜索独立对话' }).fill(keyword);
  await drawer.getByRole('button', { name: '搜索', exact: true }).click();
  const hitButton=drawer.getByRole('button',{name:new RegExp('用户.*'+keyword)}).first();
  await expect(hitButton.locator('mark')).toHaveText(keyword);
  await expect(hitButton).toContainText('…');
  await hitButton.click();
  const marked = drawer.locator('section').filter({ hasText: '命中消息' });
  await expect(marked).toHaveCount(1);
  await expect(marked).toContainText(keyword);
  await expect(drawer.getByRole('button', { name: '加载后续消息' })).toBeVisible();
  await drawer.getByRole('button', { name: '加载后续消息' }).click();
  await expect(drawer).toContainText('较新的记录 21');
  await expect(marked).toHaveCount(1);
  await drawer.getByRole('button', { name: '返回列表' }).click();
  await expect(drawer.getByRole('textbox', { name: '搜索独立对话' })).toHaveValue(keyword);
  await expect(drawer.getByRole('combobox', { name: '筛选标签' })).toHaveValue('核对标签');
  await drawer.getByRole('button', { name: /核对独立方案/ }).click();
  await drawer.getByRole('button', { name: '移除 核对标签' }).click();
  await drawer.getByRole('button', { name: '保存标签', exact: true }).click();
  await expect(drawer).toContainText('当前已保存标签：无');
  assert.deepEqual((await (await get(detailPath)).json()).tags, []);
  await server.bots.update(first.bot.id, { enabled: false });
  await expect(drawer).not.toBeVisible();
  assert.equal((await get(base + first.bot.id + '/threads/' + thread)).status, 404);
});

test('飞书搜索卡提供可授权定位的 Web 原话链接，未知工作台地址时省略链接',{timeout:45000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-search-link-'));
  const clients=new Map<string,FeishuOptions>(),cards=new Map<string,FeishuSendContext>();
  const token='fixture-web-private-link',name='合成检索会话',phrase='仅在页外原话出现的检索词';
  const factory:FeishuBotFactory=opts=>{
    clients.set(opts.appId,opts);
    return {async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),
      async send(_chat,_text,ctx){
        if(ctx?.card && ctx.replyTo) cards.set(ctx.replyTo,ctx);
        ctx?.onSent?.('local-platform-'+cards.size+'-'+(ctx.replyTo??''),ctx.card?'interactive':'text');
      }};
  };
  async function start(port:number,publicBase?:string){
    const previous=process.env.SUPER_MARIO_WEB_URL;
    if(publicBase)process.env.SUPER_MARIO_WEB_URL=publicBase;else delete process.env.SUPER_MARIO_WEB_URL;
    try {return await startServer({host:'127.0.0.1',port,dataDir,token,demo:true},{botFactory:factory});}
    finally{if(previous===undefined)delete process.env.SUPER_MARIO_WEB_URL;else process.env.SUPER_MARIO_WEB_URL=previous;}
  }
  let server=await start(0);
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const bot=await server.bots.create({name:'合成直达',appId:'cli_5566778899001122',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false});
  const send=(text:string,id:string)=>clients.get(bot.appId)!.onMessage(text,{senderId:'fixture-owner',senderType:'user',chatId:'fixture-private',chatType:'p2p',messageId:id});
  await send(bot.pairingCode!,'pair');
  await send('/new '+name,'new');
  await send(phrase,'early');
  const source=await t.waitFor(()=>{
    const row=server.app.store.list<Message>('messages').find(m=>m.role==='user' && m.text===phrase && m.status==='done');
    assert.ok(row);return row;
  });
  const route=server.app.store.get<{conversationThreadId:string}>('message.routes',source.id)!;
  const threadId=route.conversationThreadId;
  server.app.store.transaction(()=>{
    for(let i=0;i<44;i++){
      const id='recent-real-route-'+i;
      server.app.store.put('messages',id,{...source,id,text:'较新的已核验原话 '+i,createdAt:new Date(Date.now()+1000+i).toISOString()});
      server.app.store.put('message.routes',id,{...route,inputId:id,sourceMessageId:'platform-newer-'+i});
    }
  });
  const listLinks=async(query:string,id:string)=>{
    await send('/list '+query,id);
    const ctx=await t.waitFor(()=>{const row=cards.get(id);assert.ok(row);return row;});
    type Action={url?:string};
    const elements=ctx.card!.elements as {actions?:Action[]}[];
    return elements.flatMap(el=>(el.actions??[]).flatMap(a=>a.url?[a.url]:[]));
  };
  assert.deepEqual(await listLinks(phrase,'no-base'),[]);
  const port=Number(new URL(server.url).port);
  const origin='http://fixture-workbench.test:'+port;
  await server.close();server=await start(port,origin);
  const foreign=await server.bots.create({name:'其他配对',appId:'cli_6677889900112233',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false});
  await clients.get(foreign.appId)!.onMessage(foreign.pairingCode!,{senderId:'other-owner',senderType:'user',chatId:'other-chat',chatType:'p2p',messageId:'pair-other'});
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  // Route the synthetic public origin to this test's loopback service. Chromium preserves the incoming fragment.
  await page.route(origin+'/**',r=>r.fulfill({status:302,headers:{location:server.url+'/'}}));
  await page.goto(server.url+'/#agent?token='+token);
  await expect(page.locator('#agent-bot')).toBeVisible();
  const path='/api/v1/feishu/bots/'+bot.id+'/threads/'+threadId;
  const api=async(suffix:string)=>{const res=await fetch(server.url+path+suffix,{headers:{authorization:'Bearer '+token}});assert.equal(res.status,200);return res.json();};
  const latest=await api('');
  const [link]=await listLinks(phrase,'find-body');
  assert.ok(link);
  const target=new URL(link);
  assert.equal(target.origin,origin);assert.equal(target.search,'');assert.equal(target.pathname,'/');
  const prefix='#agent/private-thread/'+bot.id+'/'+threadId;
  assert.ok(target.hash.startsWith(prefix+'/'));
  const id=decodeURIComponent(target.hash.slice(prefix.length+1));
  assert.equal(link,origin+'/'+prefix+'/'+encodeURIComponent(id));
  assert.ok(!link.includes(token) && !decodeURIComponent(link).includes(phrase));
  assert.ok(!latest.messages.some((m:Message)=>m.id===id));
  const around=page.waitForResponse(r=>new URL(r.url()).pathname===path && new URL(r.url()).searchParams.get('around')===id);
  await page.goto(link);
  assert.equal((await around).status(),200);
  const drawer=page.getByRole('dialog',{name:'独立对话记录'});
  const mark=drawer.getByText('命中消息',{exact:true});
  await expect(mark).toBeFocused();await expect(mark.locator('..')).toContainText(phrase);
  const renamed='只匹配标题的合成词';
  const edit=await fetch(server.url+path,{method:'PATCH',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({version:latest.version,title:renamed})});
  assert.equal(edit.status,200);
  assert.deepEqual(await listLinks(renamed,'title-only'),[origin+'/'+prefix]);
  const wrong=origin+'/#agent/private-thread/'+foreign.id+'/'+threadId+'/'+encodeURIComponent(id);
  const rejected=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/feishu/bots/'+foreign.id+'/threads/'+threadId);
  await page.goto(wrong);assert.equal((await rejected).status(),404);
  await expect(page.getByRole('alert').filter({hasText:/不可用|配对无法读取/})).toBeVisible();
  await expect(drawer).toBeHidden();
  await expect(page.getByText(phrase,{exact:true})).not.toBeVisible();
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';

const owner = {chatType:'p2p',senderType:'user',senderId:'ou_fixture',chatId:'oc_owner'} as const;
test('群内及专属项目和事项机器人的 SDK 不开放提问卡，全局主人私聊仍可用',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'question-scope-sdk-'));
  const clients=new Map<string,FeishuOptions>();
  const seen=new Map<string,string[]>();
  const deliveries:{id:string;card?:any}[]=[];
  const http=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    if(request.url!=='http://127.0.0.1:1/fixture/chat/completions') {
      assert.ok(request.url.startsWith('http://127.0.0.1:'));
      return http(input,init);
    }
    const payload=await request.json();
    const last=payload.messages.at(-1);
    const label=JSON.stringify(last.content).match(/合成[A-E]/)?.[0];
    if(label && last.role==='user')seen.set(label,(payload.tools??[]).map((row:{function:{name:string}})=>row.function.name));
    // Exercise execution enforcement by attempting to call the hidden tool.
    const attempt=last.role==='user' && !!label && !['合成A','合成E'].includes(label);
    const delta=attempt ? {role:'assistant',tool_calls:[{index:0,id:'unauthorized',type:'function',function:{name:'interaction_open',arguments:JSON.stringify({kind:'question',title:'不该持久化的卡',body:'仅用于隔离验收'})}}]} :
      {role:'assistant',content:'合成回合已完成。'};
    const frames=[delta,{}].map((piece,i)=>'data: '+JSON.stringify({id:'scope',model:'fixture',object:'chat.completion.chunk',
      choices:[{index:0,delta:piece,finish_reason:i ? attempt?'tool_calls':'stop' : null}]}));
    return new Response([...frames,'data: [DONE]',''].join('\n\n'),{headers:{'content-type':'text/event-stream'}});
  });
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,demo:false,model:{provider:'openai-compatible',model:'fixture',apiKey:'synthetic',baseUrl:'http://127.0.0.1:1/fixture'}},
    {botFactory:o=>{clients.set(o.appId,o);return {async start(){},async close(){},async collect(){return [];},async send(_chat,_text,context){const id=randomUUID();deliveries.push({id,card:context?.card});context?.onSent?.(id,context.card?'interactive':'text');},status:()=>({connected:true})};}});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const project=server.app.projects.create({name:'测试项目'});
  const todo=server.app.createTodo({title:'测试事项',projectId:project.id});
  server.app.policies.write({}, {ladder:['user']});
  for(const [i,scope] of ([{kind:'global'},{kind:'project',projectId:project.id},{kind:'task',projectId:project.id,todoId:todo.id}] as const).entries()) {
    const bot=await server.bots.create({scope,name:'合成'+i,appId:'cli_'+String(i+1).repeat(16),appSecret:'synth',requireConfirmation:false,
      groupChats:[{chatId:'oc_test_group',mentionOnly:true,allowedSenderIds:[]}]});
    const client=clients.get(bot.appId)!;
    await client.onMessage(bot.pairingCode!,{...owner,messageId:randomUUID()});
    const label=['合成A','合成C','合成D'][i];
    await client.onMessage(label,{...owner,messageId:randomUUID()});
    await t.waitFor(()=>assert.ok(seen.has(label)));
    assert.equal(seen.get(label)!.includes('interaction_open'),i===0);
    if(i===0) {
      await client.onMessage('合成B',{...owner,chatType:'group',chatId:'oc_test_group',mentionedSelf:true,messageId:randomUUID()});
      await t.waitFor(()=>assert.ok(seen.has('合成B')));
      assert.ok(!seen.get('合成B')!.includes('interaction_open'));
    }
  }
  await t.waitFor(()=>assert.ok(!server.app.store.list<Message>('messages').some(row=>row.status==='pending')));
  assert.equal(server.app.interactions.list().length,0);
  const global=server.bots.list().find(bot=>bot.scope.kind==='global')!;
  const client=clients.get(global.appId)!;
  await client.onMessage('工作台',{...owner,messageId:randomUUID()});
  const board=deliveries.findLast(row=>row.card?.elements?.some((el:any)=>el.actions?.some((btn:any)=>btn.value?.projectId===project.id)))!;
  assert.ok(board);
  const choice=board.card.elements.flatMap((el:any)=>el.actions??[]).find((btn:any)=>btn.value?.projectId===project.id);
  client.onCardAction!({chatId:owner.chatId,operatorId:owner.senderId,messageId:board.id,value:choice.value});
  await client.onMessage('合成E',{...owner,messageId:randomUUID()});
  await t.waitFor(()=>assert.ok(seen.get('合成E')?.includes('interaction_open')));
  const original=server.app.store.list<Message>('messages').find(m=>m.role==='user' && m.text==='合成E')!;
  assert.equal(original.conversationId,'project:'+project.id+':work');
  const card=server.app.interactions.open({kind:'question',title:'确定列顺序',body:'先按甲列？'},original);
  await t.waitFor(()=>assert.ok(deliveries.some(row=>JSON.stringify(row.card??'').includes(card.id))));
  await server.bots.update(global.id,{enabled:false});
  const result=await server.app.interactions.answer(card.id,card.version,'原配对撤销后的内容');
  assert.equal(result.delivery,'failed');
  assert.ok(!server.app.store.list<Message>('messages').some(m=>m.role==='user' && m.text.includes('原配对撤销后的内容')));
});

test('停机期间飞书截止点已过，启动安装原配对校验后只采用一次推荐',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'question-deadline-startup-'));
  let client!:FeishuOptions;
  const start=()=>startServer({dataDir,host:'127.0.0.1',port:0,demo:true},{botFactory:opts=>{client=opts;
    return {async start(){},async close(){},async collect(){return [];},async send(){},status:()=>({connected:true})};}});
  let server=await start();
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const bot=await server.bots.create({appId:'cli_4444444444444444',appSecret:'fixture',name:'测试',scope:{kind:'global'},requireConfirmation:false});
  await client.onMessage(bot.pairingCode!,{...owner,messageId:'pair'});
  await client.onMessage('核对列名',{...owner,messageId:'source'});
  const source=server.app.store.list<Message>('messages').find(m=>m.text==='核对列名' && m.role==='user')!;
  const card=server.app.interactions.open({kind:'question',title:'列名',body:'如何排序',deadline:'1h',reversible:true,
    questions:[{question:'怎么排序？',recommend:'日期',options:[{label:'日期'},{label:'金额'}]}]},source);
  await t.waitFor(()=>assert.ok(server.app.store.get<Card>('interactions',card.id)?.userNotifiedAt));
  const past=new Date(Date.now()-1000).toISOString();
  const current=server.app.store.get<Card>('interactions',card.id)!;
  server.app.store.put('interactions',card.id,{...current,expiresAt:past,decisionDeadlineAt:past});
  await server.close();
  server=await start();
  await t.waitFor(()=>assert.equal(server.app.store.get<Card>('interactions',card.id)?.delivery,'confirmed'));
  const result=server.app.store.get<Card>('interactions',card.id)!;
  assert.equal(result.byDefault,true);assert.equal(result.deadlineRemindedAt,undefined);
  const messages=server.app.store.list<Message>('messages').filter(m=>m.role==='user' && m.text.includes(card.id));
  assert.equal(messages.length,1);assert.equal(messages[0].conversationId,source.conversationId);
  assert.equal(messages[0].readOnly,true);
});

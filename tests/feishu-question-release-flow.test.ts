import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('真实协作回报排队后，飞书原卡保持有效、无需二次推送，仅主人可在原会话回答', {timeout:30000}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(),'mario-feishu-question-release-'));
  const pair = {chatType:'p2p', senderType:'user', senderId:'ou_owner', chatId:'oc_private'} as const;
  const originalText = '准备合成任务，请确认验收方式';
  const privateAnswer = '仅验收合成流程';
  const relayText = '合成协作任务的阶段回报';
  const relayTask = '请独立核实测试记录';
  let finishHeld!: () => void;
  const held = new Promise<void>(resolve => {finishHeld=resolve;});
  let followingTool = false;
  const modelInputs:string[] = [];
  t.mock.method(globalThis,'fetch',async (input:RequestInfo|URL, init?:RequestInit) => {
    const req = new Request(input,init);
    assert.equal(req.url,'http://127.0.0.1:1/release-fixture/chat/completions');
    const {messages} = await req.json();
    const last = messages.at(-1);
    modelInputs.push(JSON.stringify(last));
    const opening = last.role === 'user' && JSON.stringify(last.content).includes(originalText) && !JSON.stringify(last.content).includes(privateAnswer);
    if (last.role === 'tool') {followingTool=true; await held;}
    const delta = opening ? {role:'assistant',tool_calls:[{index:0,id:'open-question',type:'function',function:{
      name:'interaction_open',arguments:JSON.stringify({kind:'question',title:'验收哪些流程？',body:'请选择验收范围。'}),
    }}]} : {role:'assistant',content:JSON.stringify(last.content).includes(relayTask)?relayText:'合成模型已收到本轮消息'};
    const frames = [delta,{}].map((piece,i)=>'data: '+JSON.stringify({id:'test',model:'fixture',object:'chat.completion.chunk',
      choices:[{index:0,delta:piece,finish_reason:i?(opening?'tool_calls':'stop'):null}]}));
    return new Response([...frames,'data: [DONE]',''].join('\n\n'),{headers:{'content-type':'text/event-stream'}});
  });
  const clients = new Map<string,FeishuOptions>();
  const deliveries:{id:string;target:string;card:any;text:string}[]=[];
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:false,
    model:{provider:'openai-compatible',model:'fixture',apiKey:'synthetic',baseUrl:'http://127.0.0.1:1/release-fixture'}},{
    botFactory:opts=>{
      clients.set(opts.appId,opts);
      return {async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),
        async send(target,text,ctx){const id='om-test-'+deliveries.length;deliveries.push({id,target,card:ctx?.card,text});ctx?.onSent?.(id,ctx.card?'interactive':'text');}};
    },
  });
  t.after(async()=>{finishHeld();await server.close();await rm(dataDir,{recursive:true,force:true});});
  const bot=await server.bots.create({appId:'cli_1010101010101010',appSecret:'synthetic-fixture',name:'合成机器人',scope:{kind:'global'},requireConfirmation:false});
  server.app.policies.write({}, {ladder:['user']});
  const peer=await server.bots.create({appId:'cli_2020202020202020',appSecret:'synthetic-peer',name:'合成协作者',scope:{kind:'global'},requireConfirmation:false});
  await clients.get(bot.appId)!.onMessage(bot.pairingCode!,{...pair,messageId:'pair'});
  await clients.get(peer.appId)!.onMessage(peer.pairingCode!,{...pair,messageId:'pair-peer'});
  await server.bots.update(bot.id,{collaboration:{peerBotIds:[peer.id]}});
  await server.bots.update(peer.id,{collaboration:{peerBotIds:[bot.id]}});
  const client=clients.get(bot.appId)!;
  await client.onMessage('/new '+originalText,{...pair,messageId:'original'});
  await t.waitFor(()=>assert.ok(followingTool));
  const original=server.app.store.list<Message>('messages').find(m=>m.role==='user'&&m.text===originalText)!;
  const originalCard=server.app.interactions.list()[0]!;
  const isForm=(row:typeof deliveries[number])=>JSON.stringify(row.card??'').includes('submit_answer');
  await t.waitFor(()=>assert.ok(deliveries.some(isForm)));
  const form=deliveries.find(isForm)!;
  const submit=form.card.body.elements.find((el:any)=>el.tag==='form').elements.at(-1).behaviors[0].value;
  assert.notEqual(originalCard.wait,false);
  // A deployed older form has this genuine delivery receipt but predates questionForm on navigation records.
  const navigation=server.app.store.get<Record<string,unknown>>('feishu.card.navigation',submit.navigation)!;
  const {questionForm: originalGrant, ...oldNavigation}=navigation;
  assert.ok(originalGrant);
  server.app.store.put('feishu.card.navigation',submit.navigation,oldNavigation);
  // Advance the age of the question only; the model and the SDK serial queue remain live.
  server.app.store.put('interactions',originalCard.id,{...originalCard,createdAt:new Date(Date.now()-121000).toISOString()});
  await server.bots.relay({sourceBotId:bot.id,targetBotId:peer.id,sourceMessageId:original.id,key:'verified-evidence',text:relayTask});
  const returned=() => server.app.store.list<Message>('messages').find(row=>row.role==='user' && row.origin==='result' &&
    row.replyTo===original.id && row.text.includes(relayText));
  await t.waitFor(()=>assert.ok(returned()),{timeout:8000});
  const queued=returned()!;
  const current=()=>server.app.store.get<Card>('interactions',originalCard.id)!;
  await t.waitFor(()=>assert.equal(current().wait,false));
  assert.equal(current().version,submit.version);
  assert.equal(queued.status,'pending');
  assert.equal(queued.conversationId,original.conversationId);
  assert.equal(deliveries.filter(isForm).length,1);
  finishHeld();
  await t.waitFor(()=>assert.ok(modelInputs.some(text=>text.includes(relayText))));
  await client.onMessage('另一个独立问题',{...pair,messageId:'owner-spoke'});
  assert.equal(current().status,'open');
  assert.equal(current().answer,undefined);
  await client.onMessage('/home',{...pair,messageId:'show-current-dashboard'});
  const board=deliveries.findLast(row=>row.card?.elements?.some((el:any)=>el.actions?.some((b:any)=>b.value?.view==='questions')))!;
  const press=(value:Record<string,unknown>,fields?:Record<string,unknown>)=>client.onCardAction!({
    operatorId:pair.senderId,chatId:pair.chatId,messageId:board.id,value,formValue:fields,
  }) as any;
  const buttons=(card:any)=>card.elements.flatMap((el:any)=>el.actions??[]);
  const list=press(buttons(board.card).find((b:any)=>b.value?.view==='questions').value).card.data;
  const displayed=press(buttons(list).find((b:any)=>b.value?.id===originalCard.id).value).card.data;
  assert.match(displayed.header.title.content,/可稍后回答/);
  const boardSubmit=displayed.body.elements.find((el:any)=>el.tag==='form').elements.at(-1).behaviors[0].value;
  client.onRecall?.(pair.chatId,board.id);
  assert.doesNotMatch(press(boardSubmit,{answer:'已撤回平台卡的迟到提交'}).toast.content,/正在提交/);
  const click=(operatorId:string,chatId:string,messageId:string)=>client.onCardAction!({
    operatorId,chatId,messageId,value:submit,formValue:{answer:privateAnswer},
  }) as any;
  for (const response of [click('ou_other',pair.chatId,form.id),click(pair.senderId,'oc_forward',form.id),click(pair.senderId,pair.chatId,'om_wrong')])
    assert.doesNotMatch(response.toast.content,/正在提交/);
  assert.equal(current().status,'open');
  assert.match(click(pair.senderId,pair.chatId,form.id).toast.content,/正在提交/);
  await t.waitFor(()=>assert.equal(current().delivery,'confirmed'));
  assert.doesNotMatch(click(pair.senderId,pair.chatId,form.id).toast.content,/正在提交/);
  const receipt=server.app.store.get<{continuationId:string}>('interaction-origins',originalCard.id)!;
  const continued=server.app.store.get<Message>('messages',receipt.continuationId)!;
  assert.equal(continued.conversationId,original.conversationId);
  assert.ok(continued.text.includes(privateAnswer));
  assert.equal(server.app.store.get<{sourceMessageId:string}>('message.routes',continued.id)?.sourceMessageId,'original');
  assert.equal(deliveries.filter(isForm).length,1);
});

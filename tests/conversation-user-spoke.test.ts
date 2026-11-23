import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';
import type { Message } from '../packages/protocol/src/index.ts';
import { runWithAgentInput } from '../packages/core/src/agent-input.ts';
import type { Card } from '../packages/core/src/interactions.ts';

test('同一对话的新发言撤回阻塞提问，重放、内部续答和项目隔离', async t => {
  const dataDir = await mkdtemp(join(tmpdir(),'mario-question-spoke-'));
  const server=await startServer({dataDir, token:'test-only', host:'127.0.0.1', port:0, demo:true});
  t.after(async()=>{await server.close(); await rm(dataDir,{recursive:true,force:true});});
  const {app}=server;
  app.policies.write({}, {ladder:['user']});
  const post=async(text:string,key=randomUUID(),extra={})=>{
    const response=await fetch(server.url+'/api/v1/messages',{method:'POST',headers:{authorization:'Bearer test-only','content-type':'application/json','idempotency-key':key},body:JSON.stringify({text,...extra})});
    assert.equal(response.status,202); return await response.json() as Message;
  };
  const ask=(source?:Message)=>app.interactions.open({kind:'question',title:'要选择哪项？',body:'甲或乙'},source);
  const get=(id:string)=>app.store.get<Card>('interactions',id)!;
  const firstKey=randomUUID(), first=await post('合成请求一',firstKey), card=ask(first);
  const loose=ask();
  app.store.put('runs','fixture-run',{id:'fixture-run',status:'running',sourceMessageId:first.id});
  const runQuestion=app.interactions.open({kind:'question',title:'执行机请求',body:'等待',runId:'fixture-run'});
  const internal=await app.agent.post('内部回报','main');
  await post('只读观察',randomUUID(),{readOnly:true});
  const project=app.projects.create({name:'合成项目'});
  const other=await post('另一个项目',randomUUID(),{projectId:project.id});
  const answer=app.contributions.list('tools').find(item=>item.value.name==='interaction_answer')!.value;
  for(const source of [other,internal,first]) await assert.rejects(async()=>runWithAgentInput(source,()=>
    answer.execute({id:card.id,version:card.version,text:'无权写回'},new AbortController().signal)),{status:403});
  assert.equal(get(card.id).status,'open');
  await app.interactions.answer(loose.id,loose.version,'甲');
  assert.equal(get(card.id).status,'open');
  const second=await post('合成请求二');
  assert.equal(get(card.id).withdrawnReason,'user_spoke');
  assert.equal(get(runQuestion.id).status,'open');
  assert.deepEqual(app.store.get('input-paused',first.id),{cardId:card.id});
  assert.throws(()=>app.interactions.answer(card.id,card.version,'迟到回答'),{status:409});
  assert.match(app.store.get<Message>('messages','interaction-notice:'+card.id)!.text,/提问已撤回/);
  const next=ask(second);
  assert.equal((await post('合成请求一',firstKey)).id,first.id);
  assert.equal(get(next.id).status,'open');
  const late=ask(first);
  assert.equal(late.withdrawnReason,'user_spoke');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.store.get('messages','interaction-notice:'+late.id),undefined);

  const explicitlyAnswered=await app.interactions.answer(next.id,next.version,'乙');
  assert.equal(explicitlyAnswered.delivery,'confirmed');
  const followUpId=app.store.get<{continuationId:string}>('interaction-origins',next.id)!.continuationId;
  const followUp=ask(app.store.get<Message>('messages',followUpId));
  assert.equal(followUp.status,'open');
  app.policies.write({}, {ladder:['rules','user'],rules:[{id:'fixture-rule',kind:'question',handler:'rules',answer:'甲',mode:'auto'}]});
  const third=await post('等待规则判断');
  assert.equal(get(followUp.id).withdrawnReason,'user_spoke');
  const pending=ask(third);
  assert.equal(pending.handler,'rules');
  await app.agent.post('改为新的目标','main',{directWebInput:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(get(pending.id).withdrawnReason,'user_spoke');
  assert.equal(get(pending.id).answer,undefined);
  assert.equal(app.store.get('messages','interaction-notice:'+pending.id),undefined);
});

test('配对飞书私聊新发言仅撤回同一线程原卡，并编辑已确认的卡片',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-private-question-'));
  let client!:FeishuOptions;
  const delivered:{id:string;card:string}[]=[], edited:{id:string;card:string}[]=[];
  const server=await startServer({dataDir,token:'test-only',host:'127.0.0.1',port:0,demo:true},{botFactory:options=>{
    client=options;
    return {async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),
      async send(_target,_text,ctx){const id='om-'+(delivered.length+1); delivered.push({id,card:JSON.stringify(ctx?.card??'')}); ctx?.onSent?.(id,ctx.card?'interactive':'text');},
      async updateCard(id,card){edited.push({id,card:JSON.stringify(card)});}
    };
  }});
  t.after(async()=>{await server.close(); await rm(dataDir,{recursive:true,force:true});});
  const {app}=server;
  app.policies.write({}, {ladder:['user']});
  const bot=await server.bots.create({appId:'cli_1111111111111111',appSecret:'fixture-key',name:'合成机器人',scope:{kind:'global'},requireConfirmation:false});
  const speak=(text:string,messageId=randomUUID())=>client.onMessage(text,{messageId,senderId:'fixture-owner',chatId:'private-chat',chatType:'p2p',senderType:'user'});
  await speak(bot.pairingCode!);
  await speak('合成原始问题');
  const src=app.store.list<Message>('messages').find(m=>m.role==='user' && m.text==='合成原始问题')!;
  const q=app.interactions.open({kind:'question',title:'私聊选择甲或乙',body:'合成示例'},src);
  const status=()=>app.store.get<Card>('interactions',q.id)!;
  await t.waitFor(()=>assert.ok(delivered.some(x=>x.card.includes('submit_answer'))));
  const original=delivered.find(x=>x.card.includes('submit_answer'))!;
  await speak('/new 合成独立对话');
  await speak('另一对话的发言');
  assert.equal(status().status,'open');
  await speak('/main');
  assert.equal(status().status,'open');
  await speak('在原私聊改变任务');
  assert.equal(status().withdrawnReason,'user_spoke');
  await t.waitFor(()=>assert.ok(edited.some(x=>x.id===original.id && x.card.includes('已撤回'))));
  assert.equal(edited.filter(x=>x.id===original.id && x.card.includes('已撤回')).length,1);
});

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';
import type {Message,Run,Todo} from '../packages/protocol/src/index.ts';
import {ownerReviewLink} from '../packages/core/src/todo-link.ts';
import type {FeishuOptions} from '../plugins/feishu.ts';

test('原飞书私聊结果卡可在关联后验收或返工，仅接受当前配对、同卡同轮证据',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'sm-feishu-review-'));
  let client!:FeishuOptions;
  const sent:{id:string;text:string}[]=[],updates:{id:string;card:any}[]=[];
  const previous=process.env.SUPER_MARIO_WEB_URL;
  process.env.SUPER_MARIO_WEB_URL='https://work.example.test';
  t.after(()=>{if(previous===undefined)delete process.env.SUPER_MARIO_WEB_URL;else process.env.SUPER_MARIO_WEB_URL=previous;});
  const start=()=>startServer({dataDir,host:'127.0.0.1',port:0,demo:true},{botFactory:opts=>{
    client=opts;
    return {async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),
      async send(_target,text,ctx){ctx?.beforeSend?.();const id=randomUUID();sent.push({id,text});ctx?.onSent?.(id,'interactive');},
      async updateCard(id,card,guard){guard?.();updates.push({id,card});}};
  }});
  let server=await start();
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const {store,events,taskClosure}=server.app;
  const bot=await server.bots.create({appId:'cli_1212121212121212',appSecret:'synthetic',name:'合成验收',scope:{kind:'global'},requireConfirmation:false});
  const operatorId='fixture-owner',chatId='fixture-pair';
  const say=(text:string)=>client.onMessage(text,{messageId:randomUUID(),chatId,senderId:operatorId,senderType:'user',chatType:'p2p'});
  await say(bot.pairingCode!);
  const ask='请处理合成待办';
  await say(ask);
  const input=store.list<Message>('messages').find(m=>m.role==='user' && m.text===ask)!;
  await t.waitFor(()=>assert.ok(store.get('message.routes',input.id)));
  async function finish(attachFirst:boolean) {
    const now=new Date().toISOString();
    const todo:Todo={id:randomUUID(),title:'合成验收任务',notes:'',createdAt:now,updatedAt:now};
    const run:Run={id:randomUUID(),sourceMessageId:input.id,conversationId:input.conversationId,todoId:todo.id,doneWhen:'列出两项实测差异',
      executionMode:'task',executorId:'demo',expectMinutes:5,status:'completed',output:'合成结果甲、乙',prompt:'合成验收',
      createdAt:now,updatedAt:now,resultSource:'fixture-native',nativeResultSources:['fixture-native']};
    const message:Message={id:'run-result:'+run.id,role:'assistant',origin:'result',text:'先前结果快照 '+run.id,status:'done',createdAt:now,
      replyTo:input.id,conversationId:run.conversationId,todoId:todo.id,runResult:{runId:run.id,status:'completed',source:run.resultSource!}};
    store.put('todos',todo.id,todo);store.put('runs',run.id,run);store.put('messages',message.id,message);
    const attach=()=>taskClosure.review.attach({todoId:todo.id,runId:run.id});
    if(attachFirst)attach();
    events.publish('runs.result',{runId:run.id,messageId:message.id});
    await t.waitFor(()=>assert.ok(sent.find(s=>s.text.includes(run.id))),{timeout:5000});
    if(!attachFirst)attach();
    const card=await t.waitFor(()=>{const card=updates.find(x=>JSON.stringify(x.card).includes(run.id));assert.ok(card);return card;});
    const buttons=card.card.body.elements;
    assert.ok(JSON.stringify(buttons).includes('实际结果：'+run.output));
    assert.ok(!JSON.stringify(buttons).includes('先前结果快照'));
    const link=buttons.find((b:any)=>b.text?.content==='在工作台核对').behaviors[0].default_url;
    assert.equal(new URL(link).hash,ownerReviewLink(taskClosure.review.pendingForOwner(todo.id)!).href);
    const accept=buttons.find((b:any)=>b.text?.content==='验收通过并完成待办').behaviors[0].value;
    const rework=buttons.find((b:any)=>b.tag==='form').elements[1].behaviors[0].value;
    const act=(value:Record<string,unknown>,extra:Record<string,unknown>={})=>client.onCardAction!({operatorId,chatId,messageId:card.id,value,...extra});
    events.publish('run-review.changed',{todoId:todo.id});
    assert.equal(sent.filter(s=>s.text.includes(run.id)).length,1);
    assert.equal(updates.filter(s=>s.id===card.id).length,1);
    return {run,todo,platformId:card.id,accept,rework,act};
  }
  const a=await finish(false);
  for(const extra of [{operatorId:'other'},{chatId:'other'},{messageId:'other'}]){
    a.act(a.accept,extra);assert.equal(taskClosure.review.get(a.todo.id).status,'pending');
  }
  const mark=store.get<Run>('runs',a.run.id)!;
  store.put('runs',mark.id,{...mark,output:'变更后的结果'});
  a.act(a.accept);assert.equal(taskClosure.review.get(a.todo.id).status,'pending');
  const b=await finish(true);
  b.act(b.accept);b.act(b.rework,{formValue:{defects:'更改已完成的决定'}});
  assert.ok(store.get<Todo>('todos',b.todo.id)?.completedAt);
  assert.equal(taskClosure.review.get(b.todo.id).status,'accepted');
  const recalled=await finish(true);
  client.onRecall!(chatId,recalled.platformId);
  recalled.act(recalled.accept);assert.equal(taskClosure.review.get(recalled.todo.id).status,'pending');
  const c=await finish(true);
  c.act(c.rework,{formValue:{defects:'缺少第二项验证，请附差异清单'}});
  const next=taskClosure.review.get(c.todo.id);
  assert.equal(next.round,1);
  c.act(c.accept);
  assert.ok(!store.get<Todo>('todos',c.todo.id)?.completedAt);
  assert.equal(taskClosure.review.get(c.todo.id).round,1);
  const durable=await finish(false);
  const detached=await finish(false);
  const oldClient=client;
  await server.close();
  const sentBefore=sent.length, updatesBefore=updates.length;
  server=await start();
  const stale=oldClient.onCardAction!({operatorId,chatId,messageId:durable.platformId,value:durable.accept});
  assert.match(JSON.stringify(stale),/卡片已过期/);
  await t.waitFor(()=>assert.notEqual(client,oldClient));
  durable.act(durable.accept);
  assert.equal(server.app.taskClosure.review.get(durable.todo.id).status,'accepted');
  a.act(a.accept);
  assert.equal(server.app.taskClosure.review.get(a.todo.id).status,'pending');
  assert.equal(sent.length,sentBefore);
  assert.equal(updates.slice(updatesBefore).filter(x=>x.id===detached.platformId).length,0);
  await server.bots.update(bot.id,{enabled:false});
  detached.act(detached.accept);assert.equal(server.app.taskClosure.review.get(detached.todo.id).status,'pending');
});

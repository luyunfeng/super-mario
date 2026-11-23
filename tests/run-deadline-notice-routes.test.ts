import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { selectedAgentStatus } from '../apps/server/src/feishu-agent-card.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Message, Run } from '../packages/protocol/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import { runWithAgentInput } from '../packages/core/src/agent-input.ts';
import { waitingRunQuestion } from '../packages/core/src/supervision.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('执行问题截止继续阻塞，Web 与已配对私聊各自提醒一次，配对失效的回执不外发',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-run-deadline-routes-'));
  const token='fixture-run-notice', machineId='fixture';
  let client:FeishuOptions;
  const sent:{id:string;text:string;target:string;replyTo?:string;card:any}[]=[];
  const server=await startServer({dataDir,token,demo:true,host:'127.0.0.1',port:0},{botFactory:opts=>{
    client=opts;
    return {async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),
      async send(target,text,ctx){ctx?.beforeSend?.();const id=randomUUID();sent.push({id,target,text,card:ctx?.card,replyTo:ctx?.replyTo});ctx?.onSent?.(id,ctx.card?'interactive':'text');}};
  }});
  const app=server.app, inputs:string[]=[];
  const machine=startAgentNode({machineId,name:'协议替身',dataDir:join(dataDir,'node'),token,url:server.url,
    executors:[{id:'codex',machineId,name:'进程内执行者',mode:'real',kind:'cli',available:true,description:'',defaultCwd:dataDir}],
    handlers:{'executor.start':async()=>({sessionId:randomUUID()}),'executor.input':async value=>{inputs.push(String(value.text));return {requested:true};}}});
  t.after(async()=>{await machine.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  await t.waitFor(()=>assert.ok(server.machines.list().some(row=>row.id===machineId && row.online)),{timeout:10000});
  app.policies.write({},{ladder:['user']});
  async function ask(source:Message|undefined,title:string) {
    const run=app.dispatch({executorId:machineId+'/codex',executionMode:'interactive',cwd:dataDir,prompt:'执行合成校验',
      conversationId:source?.conversationId,sourceMessageId:source?.id, projectId:source?.projectId});
    await t.waitFor(()=>assert.ok(app.store.get<Run>('runs',run.id)?.sessionId),{timeout:10000});
    const res=await fetch(server.url+'/api/v1/interactions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({kind:'question',runId:run.id,title,body:'请核对当前执行',deadline:'2m',reversible:false,
        questions:[{question:'使用哪份清单？',recommend:'甲',options:[{label:'甲'},{label:'乙',description:'先核对明细'}]}]})});
    const raw=await res.text();assert.equal(res.status,201,raw);return JSON.parse(raw) as Card;
  }
  function expire(card:Card) {
    const elapsed=new Date(Date.now()-2000).toISOString();
    const prior=app.store.get<Card>('interactions',card.id)!;
    app.store.put('interactions',card.id,{...prior,expiresAt:elapsed,decisionDeadlineAt:elapsed});
    app.interactions.expireTick();
  }
  const webSource=await app.projectWorkspace.post(app.projects.create({name:'本地合成项目'}).id,'请核对项目输出',undefined,undefined,true);
  const web=await ask(webSource,'Web 原项目问题');
  expire(web);app.interactions.expireTick();
  const noticeId='question-deadline:'+web.id;
  await t.waitFor(()=>assert.equal(app.store.get<Message>('messages',noticeId)?.conversationId,webSource.conversationId),{timeout:10000});
  assert.equal(app.store.get<Message>('messages',noticeId)?.replyTo,webSource.id);
  assert.equal(app.runObservations(web.runId!).blockedBy[0]?.id,web.id);
  assert.equal(waitingRunQuestion(app.store,web.id)?.run.id,web.runId);
  const detail=app.runObservations(web.runId!).blockedBy[0]!;
  assert.equal(detail.decisionContext,'请核对当前执行');
  assert.equal(detail.reversible,false);
  assert.ok(detail.deadlineRemindedAt);
  assert.deepEqual(detail.questions?.[0]?.alternatives,[{label:'乙',description:'先核对明细'}]);
  const summary=selectedAgentStatus(app.store,app.store.get<Run>('runs',web.runId!)!).text;
  assert.match(summary,/已过决定截止时间.*仍需你亲自回答/);
  assert.match(summary,/乙 · 先核对明细/);
  assert.equal(app.runObservations(web.runId!,false).blockedBy[0]?.questions,undefined);
  assert.deepEqual(inputs,[]);
  const former = app.store.get<Run>('runs',web.runId!)!;
  app.store.put('runs',former.id,{...former,sessionId:randomUUID()});
  assert.equal(app.runObservations(former.id).blockedBy.length,0);
  assert.equal(waitingRunQuestion(app.store,web.id),undefined);
  const noChat=await ask(undefined,'没有聊天来源的 Web 执行问题');
  expire(noChat);
  assert.ok(app.store.get<Card>('interactions',noChat.id)?.deadlineRemindedAt);
  assert.equal(app.store.get('messages','question-deadline:'+noChat.id),undefined);
  assert.equal(app.runObservations(noChat.runId!).blockedBy[0]?.id,noChat.id);
  await app.interactions.answer(noChat.id,noChat.version,[{selected:['乙']}],'user');
  assert.equal(inputs.length,1);
  const bot=await server.bots.create({name:'群外替身',appId:'cli_1212121212121212',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false});
  const chatId='oc_owner',senderId='ou_owner';
  const speak=(text:string)=>client.onMessage(text,{chatId,senderId,messageId:randomUUID(),senderType:'user',chatType:'p2p'});
  await speak(bot.pairingCode!);
  const currentWeb=await ask(webSource,'可通过已授权离场渠道发送的运行卡');
  expire(currentWeb);
  await app.background.eventbox.drain();app.awayNotifications.flush();
  const outbox=app.background.outbox;
  const currentNotice=outbox.list().find(row=>String(row.content.text).includes('提问已到截止时间：'+currentWeb.title));
  assert.ok(currentNotice);
  outbox.grant('away-notifications',currentNotice.channel,true);
  await outbox.tick();await outbox.tick();
  assert.equal(sent.filter(row=>row.text.includes('提问已到截止时间：'+currentWeb.title)).length,1);
  assert.equal(sent.filter(row=>row.text.includes('提问已到截止时间：'+web.title)).length,0);
  assert.equal(sent.filter(row=>row.text.includes(noChat.title)).length,0);
  await speak('/new 启动我的合成执行');
  const source=app.store.list<Message>('messages').find(row=>row.role==='user' && row.text==='启动我的合成执行')!;
  const formFor=(card:Card)=>sent.find(row=>row.card?.body?.elements && JSON.stringify(row.card).includes(card.id));
  const notices=(card:Card)=>sent.filter(row=>row.text.includes('提问已到截止时间') && row.text.includes(card.title));
  const first=await ask(source,'来自原私聊的执行卡');
  await t.waitFor(()=>assert.ok(formFor(first)),{timeout:15000});
  const form=formFor(first)!;
  assert.equal(app.store.get<Message>('messages','interaction-notice:'+first.id)?.conversationId,source.conversationId);
  expire(first);
  await server.bots.sweepDecisionNudges(bot.id);await server.bots.sweepDecisionNudges(bot.id);
  await t.waitFor(()=>assert.equal(notices(first).length,1),{timeout:10000});
  assert.equal(notices(first)[0].target,chatId);assert.equal(notices(first)[0].replyTo,form.id);
  assert.equal(app.store.get('messages','question-deadline:'+first.id),undefined);
  const pick=form.card.body.elements.find((el:any)=>el.text?.content==='乙').behaviors[0].value;
  const result=client!.onCardAction!({operatorId:senderId,chatId,messageId:form.id,value:pick});
  assert.match(JSON.stringify(result),/正在提交/);
  await t.waitFor(()=>assert.equal(app.store.get<Card>('interactions',first.id)?.delivery,'confirmed'),{timeout:10000});
  assert.equal(inputs.length,2);
  const chatCard=await ask(source,'原私聊文字回答');
  await speak('乙');
  const actor=app.store.list<Message>('messages').find(row=>row.role==='user' && row.text==='乙' && row.conversationId===source.conversationId);
  assert.ok(actor);
  const answer=app.contributions.list('tools').find(entry=>entry.value.name==='interaction_answer')!.value;
  await runWithAgentInput(actor,()=>answer.execute({id:chatCard.id,version:chatCard.version},new AbortController().signal));
  assert.equal(app.store.get<Card>('interactions',chatCard.id)?.answeredBy,'user_feishu');
  assert.equal(app.store.get<Card>('interactions',chatCard.id)?.delivery,'confirmed');
  assert.equal(inputs.length,3);
  const revoked=await ask(source,'旧绑定问题不得冒给新主人');
  await t.waitFor(()=>assert.ok(formFor(revoked)),{timeout:10000});
  await server.bots.update(bot.id,{appId:'cli_1313131313131313',appSecret:'fixture-next'});
  expire(revoked);await server.bots.sweepDecisionNudges();
  assert.equal(notices(revoked).length,0);
  assert.equal(app.store.get('messages','question-deadline:'+revoked.id),undefined);
});

import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import type { Message,Run } from '../packages/protocol/src/index.ts';
import type { FeishuOptions } from '../plugins/feishu.ts';

test('原主人可在飞书执行卡查看背景并手答，旧卡和已排队截止提醒不会越过新版本',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-feishu-context-'));
  const token='local-test',machineId='fixture',chatId='oc_private',owner='ou_owner';
  const cards=new Map<string,any>(),edits:string[]=[],texts:string[]=[],inputs:string[]=[];
  let client:FeishuOptions,release!:()=>void,entered=false;
  const pause=new Promise<void>(resolve=>{release=resolve;});
  const server=await startServer({dataDir,token,host:'127.0.0.1',port:0,demo:true},{botFactory:opts=>{
    client=opts;
    return {async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),
      async updateCard(id,data){assert.ok(cards.has(id));cards.set(id,data);edits.push(id);},
      async send(_target,text,ctx){
        if (text.includes('提问已到截止时间')) {entered=true;await pause;}
        ctx?.beforeSend?.();texts.push(text);const id=randomUUID();
        if(ctx?.card)cards.set(id,ctx.card);ctx?.onSent?.(id,ctx.card?'interactive':'text');
      }};
  }});
  const app=server.app;
  const machine=startAgentNode({machineId,name:'合成机器',dataDir:join(dataDir,'node'),token,url:server.url,
    executors:[{id:'codex',machineId,name:'合成执行器',mode:'real',kind:'cli',available:true,description:'',defaultCwd:dataDir}],
    handlers:{'executor.start':async()=>({sessionId:randomUUID()}),'executor.input':async value=>{inputs.push(String(value.text));return {requested:true};}}});
  t.after(async()=>{release();await machine.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  await t.waitFor(()=>assert.ok(server.machines.list().some(m=>m.online)),{timeout:10000});
  const bot=await server.bots.create({name:'测试',appId:'cli_1010101010101010',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false});
  const speak=(text:string)=>client.onMessage(text,{chatId,senderId:owner,messageId:randomUUID(),chatType:'p2p',senderType:'user'});
  await speak(bot.pairingCode!);await speak('/new 合成执行来源');
  const source=app.store.list<Message>('messages').find(row=>row.role==='user' && row.text==='合成执行来源')!;
  const run=app.dispatch({prompt:'核对合成样表 token=fixture-private-string',executorId:machineId+'/codex',executionMode:'interactive',cwd:dataDir,
    doneWhen:'已确认字段',conversationId:source.conversationId,sourceMessageId:source.id});
  await t.waitFor(()=>assert.ok(app.store.get<Run>('runs',run.id)?.sessionId),{timeout:10000});
  const click=(id:string,value:Record<string,unknown>,operatorId=owner)=>client.onCardAction!({chatId,messageId:id,operatorId,value});
  app.policies.write({}, {ladder:['user']});
  for(const reversible of [false,true]) {
    const q=app.interactions.open({kind:'question',title:'选择字段',body:'核对正文',deadline:'2m',reversible,runId:run.id,
      questions:[{question:'字段类型',recommend:'甲',options:[{label:'甲'},{label:'乙'}]}]},source);
    const original=()=>[...cards.entries()].find(([,c])=>c.body?.elements && JSON.stringify(c).includes(q.id));
    await t.waitFor(()=>assert.ok(original()),{timeout:10000});
    const [id,before]=original()!;
    const action=(card:any,label:string)=>card.body.elements.find((el:any)=>el.text?.content===label)?.behaviors[0].value;
    const ask=action(before,'先告诉我背景');
    assert.ok(ask);
    if (!reversible) {
      app.interactions.expireTick(Date.parse(q.decisionDeadlineAt!)+1);
      await t.waitFor(()=>assert.ok(entered),{timeout:10000});
    }
    click(id,ask,'ou_other');click('om_other',ask);
    assert.equal(app.store.get<Card>('interactions',q.id)?.contextRequestedAt,undefined);
    assert.match(JSON.stringify(click(id,ask)),/准备背景/);
    await t.waitFor(()=>assert.ok(edits.includes(id)),{timeout:10000});
    release();
    const updated=cards.get(id);
    assert.match(JSON.stringify(updated),/已暂停到期默认选择/);
    assert.match(JSON.stringify(updated),/核对合成样表/);
    assert.doesNotMatch(JSON.stringify(updated),/fixture-private-string/);
    assert.equal(action(updated,'先告诉我背景'),undefined);
    const pick=action(updated,'乙');
    assert.ok(pick.version>ask.version);
    assert.doesNotMatch(JSON.stringify(click(id,action(before,'乙'))),/正在提交/);
    app.interactions.expireTick(Date.parse(q.decisionDeadlineAt!)+500);
    await server.bots.sweepDecisionNudges(bot.id);
    assert.equal(inputs.length,reversible?1:0);
    assert.equal(app.store.get<Card>('interactions',q.id)?.status,'open');
    assert.match(JSON.stringify(click(id,pick)),/正在提交/);
    await t.waitFor(()=>assert.equal(app.store.get<Card>('interactions',q.id)?.delivery,'confirmed'),{timeout:10000});
    assert.equal(app.store.get<Card>('interactions',q.id)?.answeredBy,'user_feishu');
    assert.equal(edits.filter(value=>value===id).length,1);
  }
  assert.equal(inputs.length,2);
  assert.ok(inputs.every(text=>text.includes('乙')));
  assert.ok(texts.every(text=>!text.includes('提问已到截止时间')));
});

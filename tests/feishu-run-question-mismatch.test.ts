import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startAgentNode} from '../apps/agent-node/src/index.ts';
import {startServer} from '../apps/server/src/index.ts';
import type {Card} from '../packages/core/src/interactions.ts';
import type {Message,Run} from '../packages/protocol/src/index.ts';
import type {FeishuOptions} from '../plugins/feishu.ts';

test('飞书和 Web 都能报告执行方向不符，关闭同一原卡且不会中断或输入执行',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-feishu-mismatch-'));
  const token='fixture',owner='ou_fixture',chat='oc_fixture',machineId='node';
  const sent=new Map<string,any>(),inputs:unknown[]=[];
  let client:FeishuOptions, release!:()=>void,backgroundStarted=false;
  const processing=new Promise<void>(resolve=>{release=resolve;});
  const server=await startServer({dataDir,token,host:'127.0.0.1',port:0,demo:true},{botFactory:opts=>{
    client=opts;
    return {async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),
      async send(_target,_text,ctx){const id=randomUUID();ctx?.beforeSend?.();if(ctx?.card)sent.set(id,ctx.card);ctx?.onSent?.(id,ctx?.card?'interactive':'text');},
      async updateCard(id,card){
        assert.ok(sent.has(id));if(JSON.stringify(card).includes('已暂停到期默认选择')){backgroundStarted=true;await processing;}
        sent.set(id,card);
      }};
  }});
  const app=server.app;
  const machine=startAgentNode({machineId,name:'合成机器',dataDir:join(dataDir,'node'),token,url:server.url,
    executors:[{id:'codex',machineId,name:'进程内替身',mode:'real',kind:'cli',available:true,description:'',defaultCwd:dataDir}],
    handlers:{'executor.start':async()=>({sessionId:randomUUID()}),'executor.input':async args=>{inputs.push(args);return {requested:true};}}});
  t.after(async()=>{release();await machine.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  await t.waitFor(()=>assert.ok(server.machines.list().some(row=>row.online)),{timeout:10000});
  const bot=await server.bots.create({name:'合成',appId:'cli_1212121212121212',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false});
  const speak=(text:string)=>client.onMessage(text,{chatId:chat,senderId:owner,messageId:randomUUID(),chatType:'p2p',senderType:'user'});
  await speak(bot.pairingCode!);await speak('/new 合成执行来源');
  const source=app.store.list<Message>('messages').find(row=>row.role==='user' && row.text==='合成执行来源')!;
  app.policies.write({},{ladder:['user']});
  for(const channel of ['飞书','Web']) {
    const run=app.dispatch({executorId:machineId+'/codex',cwd:dataDir,executionMode:'interactive',prompt:'核对虚构目标',
      sourceMessageId:source.id,conversationId:source.conversationId});
    await t.waitFor(()=>assert.ok(app.store.get<Run>('runs',run.id)?.sessionId),{timeout:10000});
    const q=app.interactions.open({kind:'question',title:'决定方向',body:'合成说明',runId:run.id,deadline:'2m',reversible:true,
      questions:[{question:'用哪条路？',options:[{label:'甲'},{label:'乙'}],recommend:'甲'}]},source);
    const read=()=>app.store.get<Card>('interactions',q.id)!;
    const original=()=>[...sent].find(([,c])=>c.body?.elements && JSON.stringify(c).includes(q.id));
    await t.waitFor(()=>assert.ok(original()),{timeout:10000});
    const [id,form]=original()!;
    const buttons=(label:string)=>form.body.elements.find((el:any)=>el.text?.content===label)?.behaviors[0].value;
    const wrong=buttons('这不是我要的');assert.ok(wrong);
    const click=(value:Record<string,unknown>,messageId=id,operatorId=owner)=>client.onCardAction!({value,messageId,operatorId,chatId:chat});
    click(wrong,id,'other-user');click(wrong,'other-message');click({...wrong,version:q.version+1});assert.equal(read().status,'open');
    if (channel==='飞书') {
      assert.match(JSON.stringify(click(wrong)),/督办复核/);
    } else {
      click(buttons('先告诉我背景'));
      await t.waitFor(()=>assert.ok(backgroundStarted),{timeout:10000});
      const response=await fetch(server.url+'/api/v1/interactions/'+q.id+'/mismatch',{method:'POST',
        headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({version:read().version})});
      assert.equal(response.status,200,await response.text());release();
    }
    await t.waitFor(()=>assert.match(JSON.stringify(sent.get(id)),/已交督办复核/),{timeout:10000});
    const terminal=JSON.stringify(sent.get(id));
    assert.match(terminal,/已暂停.*自动跟进/);assert.match(terminal,/没有中断执行/);
    assert.doesNotMatch(terminal,/workbench.answerQuestion|workbench.questionContext|workbench.questionMismatch/);
    assert.equal(read().withdrawnReason,'owner_mismatch');
    assert.doesNotMatch(JSON.stringify(click(buttons('乙'))),/正在提交/);
    app.interactions.expireTick(Date.parse(q.decisionDeadlineAt!)+1);
    assert.deepEqual(inputs,[]);assert.equal(app.store.get<Run>('runs',run.id)?.status,'running');
  }
});

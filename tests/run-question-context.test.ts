import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/server/src/index.ts';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createInteractions, type Card } from '../packages/core/src/interactions.ts';
import { cardAcceptsAnswer } from '../packages/core/src/question-deadline.ts';

test('同卡背景请求先暂停默认，保留选项与期限；重复请求只读一次，旧表单不能作答',async t=>{
  const store=createStore(':memory:'),events=createEventBus(store);
  let finish!:(value:string)=>void;
  const reply=new Promise<string>(resolve=>{finish=resolve;});
  let reads=0,sends=0,authorized=true;
  const service=createInteractions({store,events,decide:()=>({handler:'user',layer:'default'}),
    deadlineOutcome:()=>authorized?'eligible':'unverified',
    questionContext:()=>({facts:'只列原执行记录',explain:async()=>{reads++;return reply;}}),answer:async()=>{sends++;}});
  t.after(async()=>{finish('释放测试替身');await service.close();store.close();});
  const card=service.open({kind:'question',runId:'run',title:'核对排序',body:'',deadline:'2m',reversible:true,
    questions:[{question:'按哪列？',options:[{label:'月份'},{label:'部门'}],recommend:'月份'}]},false,true);
  const get=()=>store.get<Card>('interactions',card.id)!;
  const first=service.requestContext(card.id,card.version);
  const pending=get();
  assert.ok(pending.contextRequestedAt);assert.equal(pending.status,'open');
  assert.equal(pending.version,card.version+1);assert.equal(pending.decisionExplanation,'只列原执行记录');
  const duplicate=service.requestContext(card.id,card.version);
  const after=Date.parse(card.decisionDeadlineAt!)+86400000;
  assert.deepEqual(service.expireTick(after),[]);assert.equal(cardAcceptsAnswer(get(),after),true);
  await Promise.resolve();assert.equal(reads,1);assert.equal(sends,0);
  finish('根据原材料核对两列。');
  assert.deepEqual(await first,await duplicate);
  const explained=get();
  assert.equal(explained.decisionExplanation,'根据原材料核对两列。');assert.equal(explained.version,pending.version);
  assert.deepEqual(explained.questions,card.questions);assert.equal(explained.decisionDeadlineAt,card.decisionDeadlineAt);
  assert.equal(explained.reversible,card.reversible);assert.equal(explained.byDefault,undefined);
  assert.deepEqual(await service.requestContext(card.id,pending.version),explained);assert.equal(reads,1);
  authorized=false;
  await assert.rejects(service.requestContext(card.id,pending.version),{status:409});
  authorized=true;
  // A later human choice remains valid even if the original clock has already elapsed.
  const past=new Date(Date.now()-1000).toISOString();
  store.put('interactions',card.id,{...explained,decisionDeadlineAt:past,expiresAt:past});
  assert.throws(()=>service.answer(card.id,card.version,[{selected:['部门']}]),{status:409});
  const done=await service.answer(card.id,pending.version,[{selected:['部门']}]);
  assert.equal(done.answeredBy,'user');assert.equal(done.delivery,'confirmed');assert.equal(sends,1);
  assert.equal(events.since(0).some(event=>event.type==='interactions.deadline_overdue'),false);
});

test('模型失败保留事实回退；回答或撤权后，迟到的补充内容不会写回',async t=>{
  const store=createStore(':memory:'),events=createEventBus(store);
  let authorized=true,sends=0;
  let finish:((text:string)=>void)|undefined;
  let fail=true;
  const service=createInteractions({store,events,decide:()=>({handler:'user',layer:'default'}),
    deadlineOutcome:()=>authorized?'eligible':'unverified',
    questionContext:()=>({facts:'原记录中的任务范围',explain:async()=>{
      if (fail) throw new Error('synthetic-provider-secret');
      return new Promise<string>(resolve=>{finish=resolve;});
    }}),answer:async()=>{sends++;}});
  t.after(async()=>{finish?.('');await service.close();store.close();});
  const open=()=>service.open({kind:'question',runId:'r',title:'问题',body:'',deadline:'2m',reversible:false,
    questions:[{question:'如何排列',options:[{label:'一'},{label:'二'}],recommend:'一'}]},false,true);
  const card=open();
  const fallback=await service.requestContext(card.id,card.version);
  assert.equal(fallback.decisionExplanation,'原记录中的任务范围');assert.equal(sends,0);
  fail=false;
  for(const mode of ['answered','revoked']) {
    const row=open(),pending=service.requestContext(row.id,row.version);
    await Promise.resolve();
    if (mode==='answered') await service.answer(row.id,row.version+1,[{selected:['二']}]);
    else authorized=false;
    finish!('已经失去时效的说明');await assert.rejects(pending,{status:409});
    assert.equal(store.get<Card>('interactions',row.id)?.decisionExplanation,'原记录中的任务范围');
    authorized=true;
  }
  const invalid=open();store.put('interactions',invalid.id,{...invalid,handler:'supervisor'});
  await assert.rejects(service.requestContext(invalid.id,invalid.version),{status:409});
  assert.equal(store.get<Card>('interactions',invalid.id)?.contextRequestedAt,undefined);
  assert.equal(sends,1);
});

test('工作台背景接口仅将原执行证据发给无工具的本地协议替身',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'question-context-model-'));
  const requests:{messages:{role:string;content:unknown}[];tools?:unknown[]}[]=[];
  const model=createServer(async(req,res)=>{
    if (req.url!=='/v1/chat/completions') {res.writeHead(404).end();return;}
    let raw='';for await(const chunk of req) raw+=chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,finish_reason] of [[{role:'assistant',content:'原执行先核对部门分布；其他影响待核实。'},null],[{},'stop']])
      res.write('data: '+JSON.stringify({id:'ctx',object:'chat.completion.chunk',model:'local-context',created:1,
        choices:[{index:0,delta,finish_reason}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));
  const address=model.address();assert.ok(address && typeof address!=='string');
  let server:Awaited<ReturnType<typeof startServer>>|undefined;
  t.after(async()=>{await server?.close();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await rm(dir,{recursive:true,force:true});});
  server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,token:'context-test',demo:false,
    model:{provider:'openai-compatible',model:'local-context',apiKey:'offline-fixture',baseUrl:'http://127.0.0.1:'+address.port+'/v1'}});
  const {app}=server;
  const timestamp=new Date().toISOString(),rpc:string[]=[];
  app.setMachineClient({list:()=>[{id:'node',name:'合成执行机',platform:'linux',capabilities:[],online:true,connectedAt:timestamp,
    executors:[{id:'codex',name:'内存测试执行器',description:'',machineId:'node',kind:'cli',mode:'real',available:true}]}],
    async call(_,method){rpc.push(method);return {};}});
  app.store.put('runs','r',{id:'r',machineId:'node',sessionId:'s',executorId:'node/codex',executionMode:'interactive',conversationId:'main',status:'running',
    createdAt:timestamp,updatedAt:timestamp,prompt:'检查部门分布',doneWhen:'核对部门总计',output:'PRIVATE_RAW_LOG'});
  app.store.put('messages','unrelated',{id:'unrelated',role:'user',conversationId:'main',text:'PRIVATE_OTHER_CONVERSATION',createdAt:timestamp});
  const card=app.interactions.openFromWeb({runId:'r',kind:'question',title:'选择顺序',body:'先看哪个维度',deadline:'2m',reversible:true,
    questions:[{question:'排序',options:[{label:'部门'},{label:'月份'}],recommend:'部门'}]});
  const ask=()=>fetch(server!.url+'/api/v1/interactions/'+card.id+'/context',{method:'POST',headers:{authorization:'Bearer context-test','content-type':'application/json'},
    body:JSON.stringify({version:card.version})});
  const response=await ask();assert.equal(response.status,200);
  const updated=await response.json() as Card;
  assert.match(updated.decisionExplanation!,/原执行先核对部门分布/);
  assert.deepEqual(updated.questions,card.questions);assert.equal(updated.status,'open');
  assert.equal((await ask()).status,200);
  assert.equal(requests.length,1);assert.equal(requests[0]!.tools?.length??0,0);
  const prompt=JSON.stringify(requests[0]!.messages);
  assert.match(prompt,/检查部门分布/);assert.match(prompt,/核对部门总计/);assert.match(prompt,/不代选/);
  assert.doesNotMatch(prompt,/PRIVATE_/);assert.equal(rpc.includes('executor.input'),false);
});

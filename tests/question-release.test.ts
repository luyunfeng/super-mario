import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { startServer } from '../apps/server/src/index.ts';
import type { Card } from '../packages/core/src/interactions.ts';
import type { Message } from '../packages/protocol/src/index.ts';

test('只在卡创建满两分钟且同受众内部输入仍在真实队列时就地转换',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'question-release-'));
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,token:'fixture',demo:true});
  t.after(async()=>{t.mock.timers.reset();await server.close();await rm(dataDir,{recursive:true,force:true});});
  const {app}=server;
  app.policies.write({},{ladder:['user']});
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  const speak=(text:string,projectId?:string)=>app.agent.post(text,'main',{directWebInput:true,projectId});
  const block=()=>app.agent.post('内部只读任务','main',{readOnly:true});
  const relay=(input:Message)=>app.postScopedResult({sourceMessageId:input.id,scope:{kind:'global'},botId:'fixture',text:'内部回报'});
  const open=(source:Message)=>app.interactions.open({kind:'question',title:'合成待决定项',body:'甲或乙'},source);
  const latest=(q:Card)=>app.store.get<Card>('interactions',q.id)!;
  const drain=async()=>{while(app.agent.configurationBusy()) await setImmediate();};
  const source=await speak('原始目标');
  await drain();
  const q=open(source);
  t.mock.timers.tick(120000);
  await relay(source); // No existing turn: the event loop hop before processing is not backlog.
  await drain();assert.equal(latest(q).wait,undefined);
  const project=app.projects.create({name:'另一项目'});
  const other=await speak('另一范围',project.id);
  await block();await relay(other);
  assert.equal(latest(q).wait,undefined);
  await drain();
  await block();await relay(source);
  assert.equal(latest(q).wait,false);
  assert.equal(latest(q).version,q.version);
  assert.equal(app.store.get<{cardId:string}>('input-paused',source.id)?.cardId,q.id);
  assert.equal(app.events.since(0).filter(e=>e.type==='interactions.user_required' && (e.data as {id?:string}).id===q.id).length,1);
  await drain();
  assert.equal((await app.interactions.answer(q.id,q.version,'选甲')).delivery,'confirmed');

  const next=await speak('第二个目标'); await drain();
  await block(); await relay(next); // A question opened after the internal item has already queued.
  const young=open(next);
  t.mock.timers.tick(119999);assert.equal(latest(young).wait,undefined);
  t.mock.timers.tick(1);assert.equal(latest(young).wait,false);
  assert.equal(latest(young).version,young.version);
  await drain();

  const final=await speak('第三个目标');const finished=open(final);
  await relay(final);
  await drain();
  t.mock.timers.tick(120000);
  assert.equal(latest(finished).wait,undefined); // The candidate ran before the timer.
  const cancel=await speak('第四个目标');const stopped=open(cancel);
  const queued=await relay(cancel);
  assert.equal((await app.interruptTurn('main',queued.id)).outcome,'requested');
  t.mock.timers.tick(120000);assert.equal(latest(stopped).wait,undefined);
  await drain();
});

test('稍后问题容量已满时入队照常执行，原问题、版本及发送次数不变',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'question-release-cap-'));
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,token:'fixture',demo:true});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const {app}=server;app.policies.write({},{ladder:['user']});
  const owner=await app.agent.post('合成目标','main',{directWebInput:true});
  for(let i=0;i<20;i++) app.interactions.open({kind:'question',title:'合成稍后卡'+i,body:'?',wait:false},owner);
  const q=app.interactions.open({kind:'question',title:'普通提问',body:'?'},owner);
  app.store.put('interactions',q.id,{...q,createdAt:new Date(Date.now()-120001).toISOString()});
  await app.agent.post('正在排队','main',{readOnly:true});
  const queued=await app.postScopedResult({sourceMessageId:owner.id,scope:{kind:'global'},botId:'fixture',text:'应正常处理的内部回报'});
  await t.waitFor(()=>assert.equal(app.store.get<Message>('messages',queued.id)?.status,'done'));
  assert.equal(app.store.get<Card>('interactions',q.id)?.wait,undefined);
  assert.equal(app.store.get<Card>('interactions',q.id)?.version,q.version);
  assert.equal(app.store.list('interaction.later-questions').length,20);
});

test('写入前其他 SQLite 句柄答卡时保留答案，存储异常安全回滚并留下脱敏诊断',async t=>{
  const {createQuestionRelease}=await import('../packages/core/src/question-release.ts');
  const {createStore}=await import('../packages/core/src/store.ts');
  const dir=await mkdtemp(join(tmpdir(),'release-race-'));
  const a=createStore(join(dir,'fixture.sqlite')), b=createStore(join(dir,'fixture.sqlite'));
  t.after(async()=>{a.close();b.close();await rm(dir,{recursive:true,force:true});});
  const now=Date.now();
  const source:Message={id:'source',role:'user',conversationId:'main',text:'合成',createdAt:new Date(now-121000).toISOString()};
  const item:Message={...source,id:'queued',status:'pending'};
  const card:Card={id:'q',version:2,kind:'question',title:'合成',body:'?',handler:'user',status:'open',layer:'global',
    createdAt:source.createdAt,updatedAt:source.createdAt,expiresAt:new Date(now+60000).toISOString()};
  a.put('messages',item.id,item);a.put('interactions',card.id,card);
  let beforeWrite:(()=>void)|undefined;
  const release=createQuestionRelease({...a,transaction(fn){beforeWrite?.();return a.transaction(fn);}},{
    source:()=>({input:source,audience:'fixture'}),audience:()=>'fixture',
    keep(c){a.put('interaction.later-questions',c.id,{id:c.id});throw Object.assign(new Error('不应输出的合成正文'),{code:'SQLITE_IOERR'});},
    changed(){assert.fail('不会转换成功');}
  });
  t.after(()=>release.close());
  beforeWrite=()=>{b.put('interactions',card.id,{...card,version:3,status:'answered',answer:'保留乙'});};
  const dequeue=release.queued(item,source.id);
  assert.equal(a.get<Card>('interactions',card.id)?.answer,'保留乙');
  assert.equal(a.get('interaction.later-questions',card.id),undefined);
  beforeWrite=undefined;
  b.put('interactions',card.id,card);
  const log=t.mock.method(console,'warn',()=>{});
  release.check(card.id);
  assert.equal(a.get<Card>('interactions',card.id)?.wait,undefined);
  assert.equal(a.get('interaction.later-questions',card.id),undefined);
  assert.equal(log.mock.calls.length,1);
  const diagnostic=JSON.stringify(log.mock.calls[0]!.arguments);
  assert.match(diagnostic,/SQLITE_IOERR/);assert.doesNotMatch(diagnostic,/不应输出/);
  dequeue();
});

test('宿主对旧答卡的续答和未回答的系统通知都按原始受众唤醒等待卡',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'release-internal-'));
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,token:'fixture',demo:true});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const {app}=server;
  app.policies.write({},{ladder:['user']});
  for(const ended of ['answer','withdraw'] as const) {
    const source=await app.agent.post('前一个问题'+ended,'main',{directWebInput:true});
    const prior=app.interactions.open({kind:'question',title:'前一个问题',body:'?',wait:false},source);
    const current=await app.agent.post('请处理当前问题'+ended,'main',{directWebInput:true});
    const card=app.interactions.open({kind:'question',title:'当前问题',body:'?'},current);
    app.store.put('interactions',card.id,{...card,createdAt:new Date(Date.now()-121000).toISOString()});
    // This pending local turn puts the host's answer/notice into the actual queue.
    await app.agent.post('排在宿主回投之前','main',{readOnly:true});
    if (ended==='answer') await app.interactions.answer(prior.id,prior.version,'选择甲');
    else app.interactions.withdraw(prior.id,prior.version);
    await t.waitFor(()=>assert.equal(app.store.get<Card>('interactions',card.id)?.wait,false));
    assert.equal(app.store.get<Card>('interactions',card.id)?.version,card.version);
    while(app.agent.configurationBusy()) await setImmediate();
  }
});

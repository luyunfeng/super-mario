import assert from 'node:assert/strict';
import test from 'node:test';
import {createStore} from '../packages/core/src/store.ts';
import {createEventBus} from '../packages/core/src/events.ts';
import {createInboxAssistant,type InboxAnalysis} from '../packages/core/src/inbox-assistant.ts';
import type {InboxItem} from '../packages/protocol/src/index.ts';

type Analyze=Parameters<typeof createInboxAssistant>[0]['analyze'];
const now=Date.parse('2026-06-01T10:00:00Z'),iso=new Date(now).toISOString();
const old={summary:'会话摘要',disposition:'watching',tasks:[]} satisfies InboxAnalysis;
function fixture(t:test.TestContext,analyze:Analyze){
  const store=createStore(':memory:'),events=createEventBus(store);let timestamp=now;
  function start(){return createInboxAssistant({store,events,workspace:'/fixture',now:()=>timestamp,debounceMs:0,
    enabled:()=>true,available:()=>({available:true}),analyze,
    createTodo(){throw Error('不应创建待办');},updateTodo(){throw Error('不应改待办');},
    archive(id,version){const item=store.get<InboxItem>('inbox',id)!;assert.equal(item.version,version);
      store.put('inbox',id,{...item,version:version+1,archivedAt:new Date(timestamp).toISOString()});}});}
  let svc=start();t.after(async()=>{await svc.close();store.close();});
  function add(id:string,patch:Partial<InboxItem>={}){const item:InboxItem={id,thread:id,last:id,source:'feishu:fixture:X',
    title:id,text:'原始-'+id,tier:'fyi',reason:'合成',updatedAt:iso,receivedAt:iso,version:1,
    origin:{kind:'direct',chatId:'chat-A'},...patch};store.put('inbox',id,item);}
  return {store,get svc(){return svc;},add,time:(t:number)=>{timestamp=t;},async restart(){await svc.close();svc=start();}};
}
const descriptor=(event:string)=>({event,title:'事项'+event,summary:'一件合成事项',tier:'fyi' as const});

test('积压按20条分批，每条归一件，重启继续，历史候选只来自真实会话',async t=>{
  const calls:string[][]=[];
  const f=fixture(t,async input=>{
    const batch=input.matterBatch!;calls.push(batch.newMessageIds);
    for(const id of batch.newMessageIds)assert.ok(input.messages.some(m=>m.id===id && m.text==='原始-'+id));
    if(calls.length===1)assert.equal(batch.existing.length,0);
    const event=batch.existing[0]?.id ?? 'new:1';
    return {...old,grouping:{assign:batch.newMessageIds.map(message=>({message,event})),events:[descriptor(event)]}};
  });
  for(let i=0;i<25;i++)f.add('id-'+String(i).padStart(2,'0'));
  await f.svc.tick();assert.equal(f.svc.list()[0]!.status,'queued');
  await f.restart();await f.svc.tick();await f.svc.tick();
  assert.deepEqual(calls.map(c=>c.length),[20,5]);assert.equal(new Set(calls.flat()).size,25);
  const view=f.svc.list()[0]!;assert.equal(view.matters?.length,1);assert.deepEqual(view.matters[0]!.messageIds,calls.flat());
  assert.equal(f.store.list('inbox').length,25);
  f.svc.archive(view.id,view.version);
  assert.equal(f.svc.list()[0]!.matters![0]!.doneAt,iso);assert.equal(f.svc.list()[0]!.pendingCount,0);
});

test('主人结项、致谢只追加、追问重开及独立续接；超三天已处理事项不可引用',async t=>{
  let mode='new';
  const f=fixture(t,async ({matterBatch:batch})=>{
    assert.ok(batch);const prior=batch.existing.find(m=>m.title==='主事项');
    const event=mode==='new'||mode==='continues'||mode==='stale'?'new:1':prior!.id;
    return {...old,grouping:{assign:batch.newMessageIds.map(message=>({message,event})),events:[{
      ...descriptor(event),title:mode==='continues'?'独立续接':'主事项',
      ...(mode==='thanks' && {reopen:false}),...(mode==='continues' && {continues:prior!.id}),
      ...(mode==='stale' && {continues:'不可见历史ID'}),...(mode==='settled' && {settled:'over'})
    }]}};
  });
  f.add('a');await f.svc.tick();
  let view=f.svc.list()[0]!,first=view.matters![0]!.id;
  f.svc.setMatterDone(view.id,first,view.version,true);
  assert.throws(()=>f.svc.setMatterDone(view.id,first,view.version,false),{status:409});
  mode='thanks';f.add('b');await f.svc.tick();assert.equal(f.svc.list()[0]!.matters![0]!.doneAt,iso);
  mode='reply';f.add('c');await f.svc.tick();assert.equal(f.svc.list()[0]!.matters![0]!.doneAt,undefined);
  mode='settled';f.add('d');await f.svc.tick();
  mode='continues';f.add('e');await f.svc.tick();view=f.svc.list()[0]!;
  assert.equal(view.matters![1]!.continues,first);assert.deepEqual(view.matters![0]!.messageIds,['a','b','c','d']);
  f.time(now+4*86400000);mode='stale';f.add('f');await f.svc.tick();
  assert.equal(f.svc.list()[0]!.status,'failed');assert.equal(f.svc.list()[0]!.matters!.length,2);
});

test('在途模型晚于主人操作不能覆盖状态，跨项目重新归类不会带出老事项摘要',async t=>{
  let release!:()=>void,started!:()=>void;
  const blocked=new Promise<void>(r=>{started=r;});
  let mode='first';
  const f=fixture(t,async ({matterBatch:batch,previousSummary})=>{
    assert.ok(batch);
    if(mode==='move'){assert.equal(batch.existing.length,0);assert.equal(previousSummary,undefined);}
    if(mode==='late'){started();await new Promise<void>(r=>{release=r;});}
    const event=batch.existing[0]?.id ?? 'new:1';
    return {...old,grouping:{assign:batch.newMessageIds.map(message=>({message,event})),events:[descriptor(event)]}};
  });
  f.add('a');f.add('b');await f.svc.tick();mode='late';f.add('c');
  const waiting=f.svc.tick();await blocked;
  let view=f.svc.list()[0]!;f.svc.setMatterDone(view.id,view.matters![0]!.id,view.version,true);
  release();await waiting;
  view=f.svc.list()[0]!;assert.ok(view.matters![0]!.doneAt);assert.deepEqual(view.matters![0]!.messageIds,['a','b']);
  f.store.put('projects','P',{id:'P'});f.add('a',{projectId:'P'});
  assert.ok(f.svc.list().every(g=>!g.matters?.length));mode='move';await f.svc.tick();
});

test('旧分析结果允许显式重试归组；新事件不因settled被自动处理，只有行动事项可标紧急',async t=>{
  let legacy=true;
  const f=fixture(t,async ({matterBatch})=>{
    assert.ok(matterBatch);
    if(legacy)return old;
    const ids=matterBatch.newMessageIds;
    const events=[{...descriptor('new:1'),reason:'等主人确认',tier:'action' as const,urgent:true},
      {...descriptor('new:2'),reason:'仅作知会',tier:'noise' as const,urgent:true,settled:'over' as const}];
    return {...old,grouping:{assign:ids.map((message,i)=>({message,event:events[i]!.event})),events}};
  });
  f.add('a');f.add('b');await f.svc.tick();let view=f.svc.list()[0]!;
  assert.equal(view.matters,undefined);await f.restart();f.svc.retry(view.id,view.version);legacy=false;
  await f.svc.tick();view=f.svc.list()[0]!;
  assert.equal(view.matters![0]!.urgent,true);assert.equal(view.matters![0]!.reason,'等主人确认');
  assert.equal(view.matters![1]!.doneAt,undefined);assert.equal(view.matters![1]!.urgent,undefined);
});

test('已处理的noise不参加候选，移出会话的旧总结在回迁后可恢复，其他事项新增不覆盖历史',async t=>{
  let n=0;
  const f=fixture(t,async ({matterBatch,previousSummary})=>{
    assert.ok(matterBatch);n++;
    if(n===2){assert.equal(matterBatch.existing.length,0);assert.deepEqual(matterBatch.newMessageIds,['c']);assert.equal(previousSummary,undefined);}
    if(n===3)assert.ok(matterBatch.existing.every(m=>m.tier!=='noise' || !m.doneAt));
    return {...old,grouping:{assign:matterBatch.newMessageIds.map(message=>({message,event:'new:1'})),
      events:[{...descriptor('new:1'),tier:n===1?'noise':'fyi'}]}};
  });
  f.add('a');f.add('b');await f.svc.tick();let group=f.svc.list()[0]!;
  const first=group.matters![0]!.id;f.svc.setMatterDone(group.id,first,group.version,true);
  f.store.put('projects','P',{id:'P',archivedAt:iso});f.add('a',{projectId:'P'});f.add('c');await f.svc.tick();
  group=f.svc.list().find(g=>!g.projectId)!;assert.equal(group.matters!.length,1);
  f.add('a');f.add('d');await f.svc.tick();group=f.svc.list()[0]!;
  assert.equal(group.matters!.length,3);assert.deepEqual(group.matters!.find(m=>m.id===first)?.messageIds,['a','b']);
});

test('模型错误归组整批撤销，重复分配、异会话事项、不合规紧急字段均不产生行动',async t=>{
  let n=0;
  const f=fixture(t,async ({matterBatch})=>{
    assert.ok(matterBatch);
    const message=matterBatch.newMessageIds[0]!,event=n===1?'other-conversation-id':'new:1';
    const a={message,event};const row=descriptor(event);
    return {...old,grouping:{assign:n===0?[a,a]:[a],events:[n===2?{...row,urgent:'true' as unknown as boolean}:row]}};
  });
  f.add('a');
  for(n=0;n<3;n++){if(n){const view=f.svc.list()[0]!;f.svc.retry(view.id,view.version);}await f.svc.tick();
    assert.equal(f.svc.list()[0]!.status,'failed');assert.equal(f.svc.list()[0]!.matters,undefined);}
});

test('归组输入只带可见的真实连接器回复，同批指消息，已归组指事项，跨会话和人工挂接不作回复',async t=>{
  let first=true,prior='';
  const f=fixture(t,async ({matterBatch,messages})=>{
    assert.ok(matterBatch);
    const map=new Map(messages.map(m=>[m.id,m]));
    if(first){
      assert.equal(map.get('b')?.replyToMessageId,'a');first=false;
    }else {
      prior=matterBatch.existing[0]!.id;assert.equal(map.get('c')?.replyToMatterId,prior);
      for(const k of ['d','e']){assert.equal(map.get(k)?.replyToMatterId,undefined);assert.equal(map.get(k)?.replyToMessageId,undefined);}
    }
    const event=prior || 'new:1';return {...old,grouping:{assign:matterBatch.newMessageIds.map(message=>({message,event})),events:[descriptor(event)]}};
  });
  f.add('a');f.add('b',{parentInboxBy:'connector',parentInboxId:'a'});await f.svc.tick();
  f.add('c',{parentInboxBy:'connector',parentInboxId:'a'});
  f.add('d',{parentInboxBy:'connector',parentInboxId:'elsewhere'});f.add('e',{parentInboxBy:'user',parentInboxId:'c'});
  await f.svc.tick();assert.equal(f.svc.list()[0]!.matters![0]!.messageIds.length,5);assert.ok(prior);
});

test('失去来源后，跨轮沿用的会话摘要及由其生成的事项均不可见；原文和后续模型请求也不带出标记',async t=>{
  const marker='合成机密-限定来源';let n=0;
  const f=fixture(t,async input=>{
    n++;assert.ok(input.matterBatch);
    if(n===2)assert.equal(input.previousSummary,marker);
    if(n===3){assert.doesNotMatch(JSON.stringify(input),new RegExp(marker));assert.equal(input.previousSummary,undefined);
      assert.equal(input.matterBatch.existing.length,0);}
    const event='new:1';
    return {...old,summary:n<3?marker:'当前可见收件',grouping:{assign:input.matterBatch.newMessageIds.map(message=>({message,event})),
      events:[{...descriptor(event),summary:n<3?marker:'新事项'}]}};
  });
  f.add('a',{text:marker});await f.svc.tick();f.add('b');await f.svc.tick();
  const convo=f.svc.list()[0]!.id;assert.equal(f.svc.list()[0]!.matters!.length,2);
  f.store.put('projects','moved',{id:'moved',archivedAt:iso});
  f.add('a',{text:marker,projectId:'moved'});f.add('c');await f.restart();
  const scoped=f.svc.list().find(g=>g.id===convo)!;assert.equal(scoped.summary,undefined);assert.equal(scoped.matters,undefined);
  await f.svc.tick();assert.equal(n,3);assert.equal(f.svc.list().find(g=>g.id===convo)?.summary,'当前可见收件');
});

test('无来源记录的旧摘要仅在原签名精确匹配时复用；0、负数和非整数群人数均不参与整理',async t=>{
  let reads=0;
  const f=fixture(t,async input=>{reads++;assert.equal(input.previousSummary,undefined);return {...old,summary:'合成旧库摘要'};});
  const origin={kind:'group' as const,chatId:'chat-A',senderId:'sender-A',personalGroupObserved:true as const};
  for(const [i,count] of [0,-1,1.5].entries())f.add('invalid-'+i,{origin:{...origin,chatId:'invalid-'+i,personalGroupUserCount:count}});
  await f.svc.tick();assert.equal(reads,0);
  f.add('valid',{origin:{...origin,personalGroupUserCount:2}});await f.svc.tick();
  const g=f.svc.list().find(g=>g.pendingCount)!;
  const row=f.store.get<Record<string,unknown>>('inbox.assistant',g.id)!;delete row.summarySourceIds;f.store.put('inbox.assistant',g.id,row);
  assert.equal(f.svc.list().find(s=>s.id===g.id)?.summary,'合成旧库摘要');
  f.add('new',{origin:{...origin,personalGroupUserCount:2}});assert.equal(f.svc.list().find(s=>s.id===g.id)?.summary,undefined);
  await f.svc.tick();assert.equal(reads,2);
});

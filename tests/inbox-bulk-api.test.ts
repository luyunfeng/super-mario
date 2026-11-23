import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../apps/server/src/index.ts';
import type {InboxItem} from '../packages/protocol/src/index.ts';

test('个人收件批量归档、恢复共用单条语义，陈旧卡或非个人收件使整批回滚',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'inbox-bulk-')),token='fixture-bulk-inbox';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true,token});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const {inbox,store,events}=server.app;
  for (const source of ['source-a','source-b'])
    await inbox.ingest(source,[{thread:'thread',last:'message',title:'合成卡片',text:'阶段摘要'}]);
  const [a,b]=inbox.list();
  const todoId=inbox.confirm(a.id,a.version).todoId;
  inbox.reopen(a.id);
  const item=(id:string)=>store.get<InboxItem>('inbox',id)!;
  const targets=()=>[a,b].map(({id})=>({id,version:item(id).version}));
  const call=(action:string,items:unknown)=>fetch(server.url+'/api/v1/inbox/bulk',{method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({action,items})});
  const observed:string[][]=[];
  const unsub=events.subscribe(event=>{
    if (event.type==='inbox.changed') observed.push([a,b].filter(({id})=>!!item(id).archivedAt).map(row=>row.id));
  });
  t.after(unsub);
  const before=targets();
  for (const [items,status] of [[[],400],[Array(101).fill(before[0]),400],[[before[0],before[0]],400],
    [[before[0],{id:'mailbox-message',version:1}],404],[[before[0],{...before[1],version:1+before[1].version}],409]] as const) {
    assert.equal((await call('archive',items)).status,status);
    assert.deepEqual(targets(),before);
  }
  assert.deepEqual(observed,[]);
  assert.deepEqual(await (await call('archive',before)).json(),{updated:2});
  assert.deepEqual(observed,[[a.id,b.id],[a.id,b.id]]);
  assert.equal((await call('archive',targets())).status,409);
  const oldTier=item(a.id).tier;
  assert.deepEqual(await (await call('reopen',targets())).json(),{updated:2});
  assert.deepEqual(observed.slice(2),[[],[]]);
  assert.equal(item(a.id).tier,oldTier);
  assert.equal(item(a.id).todoId,todoId);
  assert.match(item(a.id).reason,/保留原分拣结论和待办关联$/);
  assert.equal(server.app.todos().find(t=>t.id===todoId)?.completedAt,undefined);
  assert.equal((await call('reopen',targets())).status,409);
});

test('批量转待办共享期限并按项返回，写入途中失败不留下待办、关联或通知',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'inbox-bulk-todos-')),token='fixture-personal-inbox';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true,token});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const {inbox,store,events}=server.app;
  await inbox.ingest('fixture',Array.from({length:3},(_,i)=>({thread:'topic-'+i,last:'1',title:'收件 '+i,text:'内容 '+i})));
  const [a,b,c]=inbox.list();
  store.put('projects','p',{id:'p',name:'项目'});
  const projectItem=inbox.assignProject(b.id,b.version,'p');
  const items=[a,projectItem].map(({id,version})=>({id,version}));
  const call=(payload:Record<string,unknown>)=>fetch(server.url+'/api/v1/inbox/bulk',{method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({action:'todo',items,...payload})});
  const notices:string[]=[];
  const unsub=events.subscribe(e=>{if(e.type==='todos.changed'||e.type==='inbox.changed') notices.push(e.type);});
  t.after(unsub);
  for(const payload of [{dueAt:'2026-02-30T12:00:00Z'},{dueAt:'2026-10-01T10:00'},{dueDay:'2026-10-01'},
    {dueDay:'2026-10-01',dueAt:'2026-10-03T12:00:00.000Z'}]) assert.equal((await call(payload)).status,400);
  assert.equal((await call({items:[items[0],{...items[1],version:99}]})).status,409);

  const put=store.put;let inserts=0;
  store.put=(collection,id,value)=>{
    if(collection==='todos' && ++inserts===2) throw new Error('合成的第二条写入故障');
    return put.call(store,collection,id,value);
  };
  try {assert.equal((await call({})).status,500);} finally {store.put=put;}
  assert.deepEqual(notices,[]);
  assert.deepEqual(server.app.todos(),[]);
  assert.deepEqual(items.map(({id})=>store.get<InboxItem>('inbox',id)?.todoId),[undefined,undefined]);

  const dueAt='2026-10-01T15:59:59.999Z',dueDay='2026-10-01';
  const reply=await call({dueAt,dueDay});assert.equal(reply.status,200);
  const result=await reply.json() as {updated:number;created:{id:string;todoId:string}[]};
  assert.deepEqual(result.created.map(r=>r.id),items.map(r=>r.id));
  assert.equal(result.updated,2);
  for(const {id,todoId} of result.created) {
    const card=store.get<InboxItem>('inbox',id)!;
    const todo=server.app.todos().find(row=>row.id===todoId)!;
    assert.equal(todo.title,card.title);assert.ok(todo.notes.includes(card.text) && todo.notes.includes(card.thread));
    assert.equal(todo.projectId,card.projectId);assert.equal(todo.dueAt,dueAt);assert.equal(todo.dueDay,dueDay);
    assert.ok(card.archivedAt);assert.equal(card.todoId,todo.id);
  }
  assert.deepEqual(notices.sort(),['inbox.changed','inbox.changed','todos.changed','todos.changed']);
  assert.equal((await call({})).status,409);
  const noDue=await call({items:[{id:c.id,version:c.version}]});assert.equal(noDue.status,200);
  assert.equal(server.app.todos().find(row=>row.id===store.get<InboxItem>('inbox',c.id)?.todoId)?.dueAt,undefined);
});

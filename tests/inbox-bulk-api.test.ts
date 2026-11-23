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

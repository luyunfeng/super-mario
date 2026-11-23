import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../apps/server/src/index.ts';
import {createEventBus} from '../packages/core/src/events.ts';
import {createStore} from '../packages/core/src/store.ts';
import {createInboxService,inboxItemId} from '../packages/core/src/inbox.ts';

test('主人通过 HTTP 关联、移动与解绑收件；归档、重新摄入、版本竞争与重启保留正确父项',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'sm-inbox-relation-'));
  const config={dataDir,host:'127.0.0.1',port:0,demo:true,token:'fixture'};
  let server=await startServer(config);
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const make=(thread:string,last='one')=>({thread,last,title:thread,text:'合成内容',receivedAt:'2026-01-01T12:00:00Z'});
  const src='fixture';
  const nodes=Array.from({length:12},(_,i)=>make('item-'+i));await server.app.inbox.ingest(src,nodes);
  const id=(n:number)=>inboxItemId(src,nodes[n]!.thread);
  const req=(path:string,method='GET',body?:unknown,token='fixture')=>fetch(server.url+'/api/v1/'+path,{method,
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body!==undefined && {body:JSON.stringify(body)})});
  const tree=(n:number)=>req('inbox/'+id(n)+'/tree');
  const put=(n:number,parentId:string|null,version:number)=>req('inbox/'+id(n)+'/parent','PUT',{parentId,version});
  assert.equal((await req('inbox/'+id(0)+'/tree','GET',undefined,'wrong')).status,401);
  assert.equal((await req('inbox/absent/tree')).status,404);
  assert.equal((await req('inbox/'+id(0)+'/parent','PUT',{version:1})).status,400);
  assert.equal((await put(0,'unknown-parent',1)).status,404);
  assert.equal((await put(0,id(0),1)).status,409);
  for(let n=1;n<=8;n++)assert.equal((await put(n,id(n-1),1)).status,200);
  assert.equal((await put(0,id(9),1)).status,409);
  assert.equal((await put(0,id(7),1)).status,409);
  assert.equal((await put(9,id(8),1)).status,409);
  let chain=await (await tree(8)).json();assert.deepEqual(chain.ancestors.map((x:{id:string})=>x.id),Array.from({length:8},(_,i)=>id(7-i)));
  assert.deepEqual((await (await tree(7)).json()).children.map((x:{id:string})=>x.id),[id(8)]);
  assert.equal((await put(8,id(7),2)).status,200);
  const race=await Promise.all([put(8,id(9),2),put(8,id(10),2)]);
  assert.deepEqual(race.map(x=>x.status).sort(),[200,409]);const moved=await race.find(r=>r.status===200)!.json();
  await server.app.inbox.ingest(src,[make('item-8','new-message')]);assert.equal(server.app.inbox.tree(id(8)).item.parentInboxId,moved.parentInboxId);
  const archive=await req('inbox/'+id(8)+'/archive','POST',{version:4});assert.equal(archive.status,200);
  const saved=await (await put(8,id(0),5)).json();assert.ok(saved.archivedAt);assert.equal(saved.version,6);
  await server.close();server=await startServer(config);
  chain=await (await tree(8)).json();assert.equal(chain.item.archivedAt,saved.archivedAt);assert.deepEqual(chain.ancestors.map((x:{id:string})=>x.id),[id(0)]);
  assert.equal((await req('plugins/inbox-triage','POST',{enabled:false})).status,200);
  assert.equal((await tree(8)).status,503);assert.equal((await put(8,null,6)).status,503);
  assert.equal((await req('plugins/inbox-triage','POST',{enabled:true})).status,200);
  const detached=await (await put(8,null,6)).json();assert.equal(detached.parentInboxId,undefined);assert.equal(detached.archivedAt,saved.archivedAt);
  assert.deepEqual((await (await tree(8)).json()).ancestors,[]);

  const project=server.app.projects.create({name:'合成项目'});
  const inProject=server.app.inbox.assignProject(id(11),1,project.id);
  assert.equal((await put(11,id(0),inProject.version)).status,200);
  assert.equal((await (await tree(11)).json()).ancestors[0].id,id(0));
  const notice={subscriptionId:'fixture-health',name:'合成来源',since:'2020-01-01T00:00:00Z',reason:'合成错误'};
  server.app.inbox.syncSubscriptionFailure({...notice,state:'open'});
  let health=server.app.inbox.subscriptionFailureCard(notice.subscriptionId)!;
  server.app.inbox.setParent(health.id,id(11),health.version);
  server.app.inbox.syncSubscriptionFailure({...notice,state:'recovered'});
  server.app.inbox.syncSubscriptionFailure({...notice,since:'2020-02-01T00:00:00Z',state:'open'});
  health=server.app.inbox.subscriptionFailureCard(notice.subscriptionId)!;
  assert.equal(health.parentInboxId,id(11));assert.equal(health.archivedAt,undefined);
});

test('连接器建议父项可更新、重复幂等，主人按同一父项确认后锁定；旧库已有关联同样受保护',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'sm-inbox-offer-'));
  const config={dataDir,host:'127.0.0.1',port:0,demo:true,token:'fixture'};
  let server=await startServer(config);
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const src='fixture-source',things=['a','b','c'].map(thread=>({thread,title:thread,text:'合成材料',last:'one'}));
  await server.app.inbox.ingest(src,things);
  const [a,b,c]=things.map(x=>inboxItemId(src,x.thread)) as [string,string,string];
  const offer=(id:string,parent:string)=>server.app.inbox.offerConnectorParent(id,parent);
  const current=()=>server.app.inbox.tree(a).item;
  assert.equal(offer(a,'unknown'),'missing');assert.equal(offer('unknown',b),'missing');
  assert.equal(offer(a,b),'applied');assert.equal(current().parentInboxBy,'connector');
  assert.equal(offer(b,a),'ignored');assert.equal(offer(a,a),'ignored');
  assert.equal(offer(a,b),'ignored');assert.equal(current().version,2);
  assert.equal(offer(a,c),'applied');assert.equal(current().version,3);assert.equal(current().parentInboxId,c);
  await server.app.inbox.ingest(src,[{...things[0]!,last:'two'}]);assert.equal(current().parentInboxBy,'connector');
  const chosen=server.app.inbox.setParent(a,c,current().version);assert.equal(chosen.parentInboxBy,'user');assert.equal(chosen.version,5);
  await server.close();server=await startServer(config);
  assert.equal(offer(a,b),'ignored');assert.equal(current().parentInboxId,c);
  assert.equal(server.app.inbox.setParent(a,c,5).version,5);
  const legacy=current();delete legacy.parentInboxBy;server.app.store.put('inbox',a,legacy);
  assert.equal(offer(a,b),'ignored');assert.equal(current().parentInboxId,c);
  const clear=server.app.inbox.setParent(a,null,current().version);assert.equal(clear.parentInboxId,undefined);assert.equal(clear.parentInboxBy,undefined);
  assert.equal(offer(a,b),'applied');assert.equal(current().parentInboxBy,'connector');
});

test('旧库反向索引仅构建一次，批量挂接与重启查询不扫描整箱，关系写入中断会回滚两个方向',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'sm-inbox-rel-index-')),file=join(dataDir,'inbox.sqlite');
  let db=createStore(file),fullScans=0,rejectCardWrite=false;
  function open(){
    const store:typeof db={...db,
      list<T>(collection:string){if(collection==='inbox')fullScans++;return db.list<T>(collection);},
      put(collection,id,value){if(rejectCardWrite && collection==='inbox')throw Error('合成写入故障');db.put(collection,id,value);}
    };
    return createInboxService({store,events:createEventBus(store),createTodo(){throw Error('意外创建待办');}});
  }
  let inbox=open();t.after(async()=>{await inbox.close();db.close();await rm(dataDir,{force:true,recursive:true});});
  const card=(id:string,parentInboxId?:string)=>({id,title:id,text:'合成正文',source:'fixture',last:'one',thread:id,reason:'合成',tier:'fyi',
    version:1,updatedAt:'2026-01-01T00:00:00Z',...(parentInboxId && {parentInboxId})});
  db.put('inbox','root',card('root'));db.put('inbox','old',card('old','root'));db.put('inbox','other',card('other'));
  for(let i=0;i<120;i++)db.put('inbox','new-'+i,card('new-'+i));
  assert.deepEqual(inbox.tree('root').children.map(i=>i.id),['old']);
  for(let i=0;i<120;i++)assert.equal(inbox.offerConnectorParent('new-'+i,'old'),'applied');
  assert.equal(inbox.tree('old').children.length,120);assert.equal(fullScans,1);
  rejectCardWrite=true;assert.throws(()=>inbox.setParent('old','other',1),/合成写入故障/);rejectCardWrite=false;
  assert.equal(inbox.tree('old').item.parentInboxId,'root');
  assert.deepEqual(inbox.tree('root').children.map(i=>i.id),['old']);assert.equal(inbox.tree('other').children.length,0);
  inbox.setParent('old','other',1);await inbox.close();db.close();db=createStore(file);inbox=open();
  assert.deepEqual(inbox.tree('other').children.map(i=>i.id),['old']);assert.equal(inbox.tree('root').children.length,0);
  assert.equal(inbox.tree('old').children.length,120);assert.equal(fullScans,1);
});

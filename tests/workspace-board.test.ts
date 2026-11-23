import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../packages/core/src/store.ts';
import {createEventBus} from '../packages/core/src/events.ts';
import {PluginHost,createContributions} from '../packages/core/src/plugin-host.ts';
import {createWorkspaceBoard} from '../plugins/workspace-board.ts';
import type {JsonObject} from '../packages/plugin-sdk/src/index.ts';
import {startServer} from '../apps/server/src/index.ts';

type Board={revision:number;columns:{id:string;title:string}[];cards:{id:string;projectId:string;title:string;columnId:string;pinned:boolean;archived:boolean}[]};

test('项目看板的列与批量卡片修改原子保存，同版并发不覆盖，重启及插件停用后可恢复',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-workspace-board-'));
  const config={host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'fixture'};
  let server=await startServer(config);
  t.after(async()=>{try{await server.close();}finally{await rm(dir,{recursive:true,force:true});}});
  const post=(path:string,body:object,token=config.token)=>fetch(server.url+'/api/v1'+path,{method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  const read=async<T=Board>(body:object):Promise<T>=>{
    const response=await post('/workspace-board',body);
    assert.equal(response.status,200,JSON.stringify(body));return response.json();
  };
  type Summary={revision:number;changeCount:number;cardCount:number;kinds:string[]};
  type History={entries:Summary[];nextBefore:number|null;oldestRevision:number;latestRevision:number;retentionLimit:number};
  type State={title:string;columnId?:string;columnTitle?:string;pinned?:boolean;archived?:boolean};
  type Detail={changes:{id?:string;before?:State;after?:State}[];total:number;nextOffset:number|null};
  const history=(params:object={})=>read<History>({action:'activity',...params});
  const detail=(revision:number,params:object={})=>read<Detail>({action:'activity_detail',revision,...params});
  assert.equal((await post('/workspace-board',{action:'list'},'wrong')).status,401);
  const initial=await read({action:'list'});
  assert.deepEqual(initial.columns.map(c=>c.id),['todo','doing','review','done']);
  const a=await server.app.createProject({name:'合成项目甲'}),b=await server.app.createProject({name:'合成项目乙'});
  let board=initial;
  for(const project of [a,b]) board=await read({action:'add_card',revision:board.revision,projectId:project.id,columnId:'todo'});
  const first=board.cards.find(c=>c.projectId===a.id)!,second=board.cards.find(c=>c.projectId===b.id)!;
  assert.ok(first && second);
  board=await read({action:'batch_cards',revision:board.revision,changes:[{id:second.id,columnId:'todo',beforeId:first.id}]});
  assert.deepEqual(board.cards.filter(c=>c.columnId==='todo').map(c=>c.id),[second.id,first.id]);
  const beforeFailure=await history();
  for(const invalid of [
    {id:second.id,columnId:'todo',beforeId:'missing-card'},
    {id:second.id,columnId:'review',beforeId:first.id},
    {id:second.id,pinned:true,beforeId:first.id}
  ]){
    const invalidBatch=await post('/workspace-board',{action:'batch_cards',revision:board.revision,changes:[{id:first.id,pinned:true},invalid]});
    assert.ok([400,404,409].includes(invalidBatch.status));
    assert.deepEqual(await read({action:'list'}),board);
    assert.deepEqual(await history(),beforeFailure);
  }
  const bad=await post('/workspace-board',{action:'batch_cards',revision:board.revision,changes:[
    {id:first.id,pinned:true},{id:second.id,columnId:'missing-column'}]});
  assert.ok([400,404,409].includes(bad.status));assert.deepEqual(await read({action:'list'}),board);
  assert.deepEqual(await history(),beforeFailure);
  const concurrent=await Promise.all(['待复核','待确认'].map(title=>post('/workspace-board',{
    action:'add_column',revision:board.revision,title})));
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  board=await concurrent.find(r=>r.ok)!.json();
  const extra=board.columns.find(c=>!initial.columns.some(x=>x.id===c.id))!;
  assert.ok(extra);
  board=await read({action:'rename_column',revision:board.revision,id:extra.id,title:'待交接'});
  board=await read({action:'move_column',revision:board.revision,id:extra.id,beforeId:'todo'});
  assert.deepEqual(board.columns[0],{id:extra.id,title:'待交接'});
  board=await read({action:'batch_cards',revision:board.revision,changes:[
    {id:first.id,columnId:extra.id,pinned:true},{id:second.id,columnId:extra.id,archived:true}]});
  const batchVersion=board.revision;
  const firstPage=await detail(batchVersion,{limit:1});
  assert.equal(firstPage.total,2);assert.equal(firstPage.changes.length,1);assert.equal(firstPage.nextOffset,1);
  const secondPage=await detail(batchVersion,{offset:firstPage.nextOffset,limit:1});
  assert.equal(secondPage.nextOffset,null);
  assert.deepEqual([firstPage.changes[0].id,secondPage.changes[0].id].sort(),[first.id,second.id].sort());
  const filtered=await detail(batchVersion,{cardId:first.id});
  assert.equal(filtered.total,1);
  const change=filtered.changes[0];
  assert.equal(change.id,first.id);
  assert.equal(change.before?.columnTitle,initial.columns[0].title);
  assert.equal(change.before?.pinned,false);assert.equal(change.before?.columnId,'todo');
  assert.equal(change.after?.columnTitle,'待交接');assert.equal(change.after?.columnId,extra.id);assert.equal(change.after?.pinned,true);
  board=await read({action:'remove_column',revision:board.revision,id:extra.id,moveTo:'doing'});
  assert.ok(!board.columns.some(c=>c.id===extra.id));
  assert.equal(board.cards.find(c=>c.id===first.id)?.columnId,'doing');
  assert.equal(board.cards.find(c=>c.id===first.id)?.pinned,true);
  assert.equal(board.cards.find(c=>c.id===second.id)?.archived,true);
  const storedHistory=await history();
  const summary=storedHistory.entries.find(e=>e.revision===batchVersion);
  assert.ok(summary);assert.equal(summary.changeCount,2);assert.equal(summary.cardCount,2);assert.ok(summary.kinds.length);
  assert.equal(storedHistory.latestRevision,board.revision);
  assert.equal(storedHistory.oldestRevision,1);assert.ok(storedHistory.retentionLimit>=storedHistory.entries.length);
  assert.deepEqual(storedHistory.entries.map(e=>e.revision),Array.from({length:board.revision},(_,i)=>board.revision-i));
  const last=await history({limit:1,cardId:first.id});
  assert.equal(last.entries.length,1);assert.ok(last.nextBefore);
  const older=await history({before:last.nextBefore,cardId:first.id});
  assert.ok(older.entries.some(e=>e.revision===batchVersion));
  assert.ok(older.entries.every(e=>e.revision<last.entries[0].revision));
  assert.ok(!older.entries.some(e=>e.revision===2),'其他项目的单卡新增不应命中');
  await server.close();server=await startServer(config);
  assert.deepEqual(await history(),storedHistory);
  assert.deepEqual(await detail(batchVersion,{cardId:first.id}),filtered);
  assert.deepEqual(await read({action:'list'}),board);
  assert.equal((await post('/plugins/workspace-board',{enabled:false})).status,200);
  assert.equal((await post('/workspace-board',{action:'list'})).status,503);
  assert.equal((await post('/workspace-board',{action:'activity'})).status,503);
  assert.equal((await post('/workspace-board',{action:'activity_detail',revision:batchVersion})).status,503);
  assert.equal((await post('/workspace-board',{action:'batch_cards',revision:board.revision,changes:[{id:second.id,archived:false}]})).status,503);
  assert.equal((await post('/plugins/workspace-board',{enabled:true})).status,200);
  assert.deepEqual(await read({action:'list'}),board);
});


test('手工看板工具先匹配当前机器和关键词，再按置顶和持久顺序分页',async t=>{
  const store=createStore(':memory:'), contributions=createContributions();
  const host=new PluginHost({store,contributions,events:createEventBus(store),dataDir:':memory:'});
  t.after(async()=>{await host.close();store.close();});
  host.register(createWorkspaceBoard(()=>[],()=>undefined,()=>()=>[]));
  await host.start();
  const tool=contributions.list('tools').find(entry=>entry.value.name==='workspace_board_read')!.value;
  const read=async(input:JsonObject)=>await tool.execute(input,new AbortController().signal) as Board & {nextOffset:number|null};
  let revision=0;
  for (const id of ['NODE-ALPHA','NODE-ALPHA-2']) store.put('machines',id,{id,name:'同名合成机器'});
  const cardIds:string[]=[];
  for (let i=0;i<30;i++) {
    const project={id:'p'+i,name:'合成项目'+i,...(i!==0 && {workspace:{
      machineId:i===1?'NODE-ALPHA-2':'NODE-ALPHA',cwd:'/fixture/'+(i===29?'另一个目录':'Reports')+'/'+i}})};
    store.put('projects',project.id,project);
    const board=await host.invocations.use('workspace-board.manage',{action:'add_card',revision:revision++,projectId:project.id,columnId:'doing'}) as Board;
    cardIds.push(board.cards.at(-1)!.id);
  }
  await host.invocations.use('workspace-board.manage',{action:'batch_cards',revision,changes:[
    {id:cardIds[28],pinned:true},{id:cardIds[27],archived:true},
  ]});
  const filter={machineId:'NODE-ALPHA',query:'  reports  ',columnId:'doing'};
  const first=await read(filter), second=await read({...filter,offset:25});
  assert.equal(first.cards.length,25);assert.equal(first.cards[0].id,cardIds[28]);assert.equal(first.nextOffset,25);
  assert.deepEqual([...first.cards,...second.cards].map(c=>c.id),[cardIds[28],...cardIds.slice(2,27)]);
  assert.equal(second.nextOffset,null);
  assert.deepEqual((await read({...filter,archived:true})).cards.map(c=>c.id),[cardIds[27]]);
  assert.deepEqual((await read({query:'node-alpha-2'})).cards.map(c=>c.id),[cardIds[1]]);
  const named=await read({query:'同名合成机器'});
  assert.ok(named.cards.some(card=>card.id===cardIds[1]));
  assert.ok(named.cards.some(card=>card.id===cardIds[2]));
  assert.deepEqual((await read({query:'同名合成机器',machineId:'NODE-ALPHA-2'})).cards.map(c=>c.id),[cardIds[1]]);
  assert.deepEqual((await read({machineId:'node-alpha'})).cards,[]);
  assert.deepEqual((await read({query:'合成项目0'})).cards.map(c=>c.id),[cardIds[0]]);
  assert.deepEqual((await read({...filter,columnId:'done'})).cards,[]);
  assert.ok(!JSON.stringify(first).includes('/fixture/'));
  for (const args of [{machineId:''},{query:null},{query:'长'.repeat(501)}] as JsonObject[])
    await assert.rejects(read(args),{status:400});
});

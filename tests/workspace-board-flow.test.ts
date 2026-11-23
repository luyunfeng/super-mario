import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../apps/server/src/index.ts';

type Lane='needs_you'|'working'|'review'|'planned'|'idle';
type Flow={counts:Record<Lane,number>;items:{id:string;kind:string;lane:Lane;title:string;reason:string}[];nextOffset:number|null};
type Board={revision:number;cards:{projectId:string;id:string}[]};

test('看板按真实待决定、执行、待办归组，筛选分页及归档不改手工卡',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mario-board-flow-'));
  const server=await startServer({dataDir,host:'127.0.0.1',port:0,token:'fixture',demo:true});
  t.after(async()=>{try{await server.close();}finally{await rm(dataDir,{recursive:true,force:true});}});
  async function request<T>(body:object):Promise<T>{
    const response=await fetch(server.url+'/api/v1/workspace-board',{method:'POST',headers:{authorization:'Bearer fixture',
      'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200,JSON.stringify(body));return response.json();
  }
  const flow=(fields:object={})=>request<Flow>({action:'flow',...fields});
  const projects:{id:string;name:string}[]=[];
  for(const suffix of ['有审批','空闲','归档']) projects.push(await server.app.createProject({name:'合成分组'+suffix}));
  let board=await request<Board>({action:'list'});
  for(const project of projects) board=await request<Board>({action:'add_card',revision:board.revision,projectId:project.id,columnId:'done'});
  const [busy,idle,archived]=projects.map(p=>board.cards.find(c=>c.projectId===p.id)!);
  board=await request<Board>({action:'batch_cards',revision:board.revision,changes:[{id:archived.id,archived:true}]});
  const now=new Date().toISOString();
  const addRun=(id:string,projectId?:string,machineId='fixture-node')=>server.app.store.put('runs',id,{id,projectId,machineId,conversationId:'main',prompt:'合成分组执行'+id,
    executorId:'offline-synthetic',status:'running',output:'',createdAt:now,updatedAt:now});
  addRun('bound',projects[0].id);addRun('standalone');
  server.app.store.put('runs','ready-review',{id:'ready-review',conversationId:'main',prompt:'合成分组核验',
    executorId:'offline-synthetic',status:'completed',resultSource:'real',output:'合成执行完成结果',createdAt:now,updatedAt:now});
  const todo=server.app.createTodo({title:'合成分组待办'});
  const lane=(f:Flow,id:string)=>f.items.find(i=>i.id===id)?.lane;
  addRun('other-machine',undefined,'fixture-node-2');
  const byMachine=await flow({machineId:'fixture-node',lane:'working'});
  assert.ok(byMachine.items.some(item=>item.id==='standalone'));
  assert.ok(!byMachine.items.some(item=>item.id==='other-machine'));
  const initial=await flow();
  assert.equal(lane(initial,'bound'),undefined,'已归入项目卡的执行不重复列出');
  assert.equal(lane(initial,busy.id),'working');assert.equal(lane(initial,idle.id),'idle');
  assert.equal(lane(initial,'ready-review'),'review');assert.equal(lane(initial,'standalone'),'working');assert.equal(lane(initial,todo.id),'planned');
  const card=server.app.interactions.open({kind:'permission',runId:'bound',title:'合成审批标题',body:'合成私有内容'});
  assert.equal(card.handler,'user');
  const current=await flow({query:'合成分组'});
  assert.equal(lane(current,busy.id),'needs_you');assert.equal(lane(current,archived.id),undefined);
  const matched=current.items.map(i=>i.id);
  const paged:string[]=[];
  let offset:number|null=0;
  while(offset!==null){
    const part:Flow=await flow({query:'合成分组',limit:1,offset});
    assert.deepEqual(part.counts,current.counts);assert.equal(part.items.length,1);
    paged.push(part.items[0].id);
    assert.ok(part.nextOffset===null||part.nextOffset>offset);
    offset=part.nextOffset;
  }
  assert.deepEqual(paged,matched);assert.equal(new Set(paged).size,paged.length);
  const waiting=await flow({query:'合成分组',lane:'needs_you'});
  assert.ok(waiting.items.length && waiting.items.every(i=>i.lane==='needs_you'));
  assert.ok(waiting.items.some(i=>i.id===busy.id && i.reason));
  const hidden=await flow({archived:true,query:'合成分组归档'});
  assert.equal(hidden.items.length,1);assert.equal(hidden.items[0].id,archived.id);
  assert.deepEqual(await request<Board>({action:'list'}),board);
});

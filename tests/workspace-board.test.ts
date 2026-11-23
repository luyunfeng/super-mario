import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../apps/server/src/index.ts';

type Board={revision:number;columns:{id:string;title:string}[];cards:{id:string;projectId:string;title:string;columnId:string;pinned:boolean;archived:boolean}[]};

test('项目看板的列与批量卡片修改原子保存，同版并发不覆盖，重启及插件停用后可恢复',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-workspace-board-'));
  const config={host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'fixture'};
  let server=await startServer(config);
  t.after(async()=>{try{await server.close();}finally{await rm(dir,{recursive:true,force:true});}});
  const post=(path:string,body:object,token=config.token)=>fetch(server.url+'/api/v1'+path,{method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  const read=async(body:object):Promise<Board>=>{
    const response=await post('/workspace-board',body);
    assert.equal(response.status,200,JSON.stringify(body));return response.json();
  };
  assert.equal((await post('/workspace-board',{action:'list'},'wrong')).status,401);
  const initial=await read({action:'list'});
  assert.deepEqual(initial.columns.map(c=>c.id),['todo','doing','review','done']);
  const a=await server.app.createProject({name:'合成项目甲'}),b=await server.app.createProject({name:'合成项目乙'});
  let board=initial;
  for(const project of [a,b]) board=await read({action:'add_card',revision:board.revision,projectId:project.id,columnId:'todo'});
  const first=board.cards.find(c=>c.projectId===a.id)!,second=board.cards.find(c=>c.projectId===b.id)!;
  assert.ok(first && second);
  const bad=await post('/workspace-board',{action:'batch_cards',revision:board.revision,changes:[
    {id:first.id,pinned:true},{id:second.id,columnId:'missing-column'}]});
  assert.ok([400,404,409].includes(bad.status));assert.deepEqual(await read({action:'list'}),board);
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
  board=await read({action:'remove_column',revision:board.revision,id:extra.id,moveTo:'doing'});
  assert.ok(!board.columns.some(c=>c.id===extra.id));
  assert.equal(board.cards.find(c=>c.id===first.id)?.columnId,'doing');
  assert.equal(board.cards.find(c=>c.id===first.id)?.pinned,true);
  assert.equal(board.cards.find(c=>c.id===second.id)?.archived,true);
  await server.close();server=await startServer(config);
  assert.deepEqual(await read({action:'list'}),board);
  assert.equal((await post('/plugins/workspace-board',{enabled:false})).status,200);
  assert.equal((await post('/workspace-board',{action:'list'})).status,503);
  assert.equal((await post('/workspace-board',{action:'batch_cards',revision:board.revision,changes:[{id:second.id,archived:false}]})).status,503);
  assert.equal((await post('/plugins/workspace-board',{enabled:true})).status,200);
  assert.deepEqual(await read({action:'list'}),board);
});

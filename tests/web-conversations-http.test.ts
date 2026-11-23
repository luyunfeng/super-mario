import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('同项目独立 Web 对话隔离真实 SDK 历史、分页位置和首轮回执',{timeout:60000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'web-threads-'));
  const requests:string[]=[];
  const model=createServer(async(req,res)=>{
    if(req.method==='GET'){res.end('fixture');return;}
    let body='';for await(const chunk of req)body+=chunk.toString();
    requests.push(JSON.stringify(JSON.parse(body).messages));
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,finish_reason] of [[{role:'assistant',content:'收到合成正文'},null],[{},'stop']]){
      res.write('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
  const address=model.address();assert.ok(address&&typeof address==='object');
  const config={dataDir,host:'127.0.0.1',port:0,demo:false,model:{provider:'openai-compatible',model:'fixture',apiKey:'synthetic-local',baseUrl:'http://127.0.0.1:'+address.port+'/v1'}};
  let server=await startServer(config);
  t.after(async()=>{await server.close();model.closeAllConnections();await new Promise(r=>model.close(r));await rm(dataDir,{recursive:true,force:true});});
  const path='/api/v1/web-conversations';
  const get=(suffix='')=>fetch(server.url+path+suffix);
  const post=(suffix:string,input:object,key?:string)=>fetch(server.url+path+suffix,{method:'POST',
    headers:{'content-type':'application/json',...(key&&{'idempotency-key':key})},body:JSON.stringify(input)});
  const projectId=server.app.projects.create({name:'合成独立对话项目'}).id;
  const a=randomUUID(),b=randomUUID(),key=randomUUID();
  const record={id:a,title:'甲会话',projectId};
  const created=await post('',record);assert.equal(created.status,201);
  assert.deepEqual(await(await post('',record)).json(),await created.json());
  assert.equal((await post('',{...record,title:'其他标题'})).status,409);
  assert.equal((await post('',{...record,id:b,title:'乙会话'})).status,201);
  assert.equal((await(await get('?projectId='+projectId)).json()).items.length,2);
  assert.deepEqual(await(await get()).json(),{items:[]});
  assert.equal((await post('/'+a+'/messages',{text:'额外项目',projectId:'other'})).status,400);
  async function turn(id:string,text:string,receipt:string){
    const response=await post('/'+id+'/messages',{text},receipt);
    assert.equal(response.status,202,await response.clone().text());
    const input=await response.json();assert.equal(input.conversationId,'web:'+id);
    assert.equal(input.projectId,projectId);assert.equal(input.directWebInput,true);
    await t.waitFor(()=>{const answer=server.app.store.list<Message>('messages').find(row=>row.replyTo===input.id&&row.status==='done');assert.equal(answer?.text,'收到合成正文');},{timeout:15000});
    return input;
  }
  const one=await turn(a,'only-alpha-original',key);
  assert.equal((await(await post('/'+a+'/messages',{text:'only-alpha-original'},key)).json()).id,one.id);
  assert.equal((await post('/'+a+'/messages',{text:'变更原文'},key)).status,409);
  assert.equal((await(await get('/'+a+'/messages/receipts/'+key)).json()).id,one.id);
  const wrong=await get('/'+b+'/messages/receipts/'+key);assert.equal(wrong.status,404);
  assert.equal((await wrong.json()).code,'MESSAGE_RECEIPT_NOT_FOUND');
  assert.equal((await get('/'+b+'/messages?before='+one.id)).status,404);
  await turn(b,'only-beta-original',randomUUID());
  assert.doesNotMatch(requests.at(-1)!,/only-alpha-original/);
  await server.close();server=await startServer(config);
  await turn(a,'only-alpha-followup',randomUUID());
  assert.match(requests.at(-1)!,/only-alpha-original/);
  assert.match(requests.at(-1)!,/独立的 Web 对话/);
  assert.doesNotMatch(requests.at(-1)!,/only-beta-original/);
  const history=await(await get('/'+a+'/messages')).json();
  assert.equal(history.messages.length,4);assert.equal(history.nextBefore,null);
  assert.ok(history.messages.every((m:Message)=>m.conversationId==='web:'+a));
  assert.equal(requests.length,3);
  for(let i=0;i<50;i++){const id=randomUUID();server.app.store.put('messages',id,{...one,id,requestId:undefined,status:'done',text:'已加载原文'+i});}
  const page=await(await get('/'+a+'/messages')).json();assert.equal(page.messages.length,50);
  assert.equal(page.nextBefore,page.messages[0].id);
  const earlier=await(await get('/'+a+'/messages?before='+page.nextBefore)).json();assert.deepEqual(earlier,history);
  const patch=(input:object)=>fetch(server.url+path+'/'+a,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  // A pre-versioning SQLite record stays readable and accepts its first versioned update.
  const old={...record,createdAt:one.createdAt};
  server.app.store.put('web-conversations',a,old);
  const beforeEdit=await(await get('/'+a)).json();assert.equal(beforeEdit.version,1);assert.equal(beforeEdit.archived,false);
  const renamed=await patch({version:1,title:'新的对话标题'});assert.equal(renamed.status,200);
  const changed=await renamed.json();assert.equal(changed.title,'新的对话标题');assert.equal(changed.version,2);
  assert.equal((await patch({version:1,archived:true})).status,409);
  assert.equal((await patch({version:2,projectId:'other',archived:true})).status,400);
  const archived=await patch({version:2,archived:true});assert.equal(archived.status,200);assert.equal((await archived.json()).archived,true);
  const list=async(flag:string)=>(await(await get('?projectId='+projectId+flag)).json()).items.map((row:{id:string})=>row.id);
  assert.deepEqual(await list(''),[b]);assert.deepEqual(await list('&archived=false'),[b]);assert.deepEqual(await list('&archived=true'),[a]);
  assert.equal((await get('?archived=all')).status,400);
  assert.equal((await post('/'+a+'/messages',{text:'归档后的新消息'},randomUUID())).status,409);
  assert.equal((await(await get('/'+a+'/messages/receipts/'+key)).json()).id,one.id);
  assert.equal((await(await get('/'+a+'/messages')).json()).messages.length,50);
  const back=await patch({version:3,archived:false});assert.equal(back.status,200);
  await turn(a,'恢复后继续',randomUUID());
  const remove=(id:string,payload:object,type='application/json')=>fetch(server.url+path+'/'+id,{
    method:'DELETE',headers:{'content-type':type},body:JSON.stringify(payload)});
  assert.equal((await remove(b,{version:1},'text/plain')).status,415);
  assert.equal((await remove(b,{version:1,title:'wrong'})).status,400);
  assert.equal((await remove(b,{version:2})).status,409);
  assert.deepEqual(await (await remove(b,{version:1})).json(),{deleted:true});
  assert.equal((await get('/'+b+'/messages')).status,410);
  assert.equal((await remove(b,{version:1})).status,200);
  assert.equal((await get('/'+a+'/messages')).status,200);
  await server.app.plugins.setEnabled('web-conversations',false);
  assert.equal((await get('/'+a+'/messages')).status,503);
  assert.equal((await post('/'+a+'/messages',{text:'已停用'},randomUUID())).status,503);
});

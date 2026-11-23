import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {startServer} from '../apps/server/src/index.ts';
import {acceptMessage} from '../packages/core/src/message-receipts.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('Web 消息检索限当前有效受众，旧版受理回执可溯源，游标不暴露其他消息',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'conversation-message-search-'));
  const token='local-search-test',server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,demo:true,token});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const store=server.app.store,search=(args:Record<string,unknown>,auth=true)=>fetch(server.url+'/api/v1/conversation-message-search',{
    method:'POST',headers:{...(auth && {authorization:'Bearer '+token}),'content-type':'application/json'},body:JSON.stringify(args),
  });
  const base={conversationId:'main',query:'[A.]'};
  const write=(id:string,extra:Partial<Message>={})=>{
    const message:Message={id,conversationId:'main',text:'中文'.repeat(100)+'[a.]'+'😀'.repeat(100),role:'user',
      directWebInput:true,createdAt:new Date(0).toISOString(),...extra};
    acceptMessage(store,message);return message;
  };
  for(let i=0;i<25;i++) write('web-'+i);
  const legacy=write('old-web',{directWebInput:undefined,requestId:randomUUID()});
  write('old-answer',{role:'assistant',directWebInput:undefined,replyTo:legacy.id});
  write('unverified',{directWebInput:undefined});
  write('private');store.put('message.routes','private',{channel:'feishu'});
  write('private-answer',{role:'assistant',replyTo:'private',directWebInput:undefined});
  write('resumed',{directWebInput:undefined,requestId:randomUUID()});store.put('conversation.question-continuations','resumed','old-web');
  store.put('projects','p',{id:'p'});store.put('projects','old',{id:'old',archivedAt:'fixture'});
  store.put('todos','moved',{id:'moved',projectId:'other'});
  write('orphan',{todoId:'moved'});write('archived',{projectId:'old'});
  write('project-main',{projectId:'p'});
  const projectScope={conversationId:'project:p:work',projectId:'p'};
  write('legacy-project',{conversationId:projectScope.conversationId,directWebInput:undefined,requestId:randomUUID()});
  write('wrong-scope-answer',{...projectScope,role:'assistant',replyTo:'old-web'});
  assert.equal((await search(base,false)).status,401);
  const first=await (await search(base)).json();
  assert.equal(first.hits.length,25);
  assert.ok(first.hits.every((hit:{text:string})=>hit.text.includes('[a.]') && hit.text.length<150 && Buffer.from(hit.text).toString()===hit.text));
  const second=await (await search({...base,before:first.nextBefore})).json();
  assert.equal(second.nextBefore,undefined);
  assert.deepEqual([...first.hits,...second.hits].map(h=>h.id),['project-main','old-answer','old-web',...Array.from({length:25},(_,i)=>'web-'+(24-i))]);
  assert.deepEqual((await (await search({...base,projectId:'p'})).json()).hits.map((h:{id:string})=>h.id),['project-main']);
  assert.deepEqual((await (await search({...base,...projectScope})).json()).hits.map((h:{id:string})=>h.id),['legacy-project']);
  for(const extra of [{conversationId:'bot:x'},{projectId:'old'},{before:'private'},{...projectScope,todoId:'moved'}])
    assert.equal((await search({...base,...extra})).status,404);
  await server.app.plugins.setEnabled('conversation-search',false);
  assert.equal((await search(base)).status,503);
});

test('独立对话搜索验证直接 Web 来源、精确项目和注册状态，归档后可读，停用时拒绝', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'web-thread-search-'));
  const server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,demo:true});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const store=server.app.store;
  const post=(path:string,input:object)=>fetch(server.url+'/api/v1'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  const {id:projectId}=await (await post('/projects',{name:'合成项目'})).json();
  const id=randomUUID(),sibling=randomUUID(),globalId=randomUUID();
  for(const item of [{id,projectId},{id:sibling,projectId},{id:globalId}]) assert.equal((await post('/web-conversations',item)).status,201);
  const conversationId='web:'+id,base={conversationId,projectId,query:'sample'};
  const search=(overrides:object={})=>post('/conversation-message-search',{...base,...overrides});
  function put(id:string,extra:Partial<Message>={}){
    const message:Message={id,conversationId,projectId,role:'user',text:'sample '+id,directWebInput:true,status:'done',createdAt:new Date(0).toISOString(),...extra};
    acceptMessage(store,message);
  }
  for(let i=0;i<26;i++) put('sample-'+i);
  put('quote',{text:'> sample 引用\n\n正文'});
  put('reply',{role:'assistant',replyTo:'sample-0',directWebInput:undefined});
  put('sibling',{conversationId:'web:'+sibling});
  put('unscoped',{projectId:undefined});
  put('wrong-answer',{role:'assistant',replyTo:'unscoped',directWebInput:undefined});
  put('bot');store.put('message.routes','bot',{channel:'feishu'});
  put('bot-answer',{role:'assistant',replyTo:'bot',directWebInput:undefined});
  put('not-from-Web',{directWebInput:undefined,requestId:randomUUID()});
  put('internal',{origin:'notification'});
  put('global',{conversationId:'web:'+globalId,projectId:undefined});
  put('wrong-project-in-global',{conversationId:'web:'+globalId});
  const files=[{name:'核对清单.txt',mime:'text/plain',bytes:3,sha256:'0'.repeat(64)}];
  put('attachment',{text:'',files});
  put('sibling-attachment',{text:'',files,conversationId:'web:'+sibling});
  const byFile={query:'核对清单',category:'file'};
  const fileHits=(await (await search(byFile)).json()).hits;
  assert.deepEqual(fileHits.map((hit:{id:string})=>hit.id),['attachment']);
  assert.deepEqual(fileHits[0].matches,[{category:'file',text:'核对清单.txt'}]);
  await server.app.plugins.setEnabled('conversation-files',false);
  assert.deepEqual((await (await search(byFile)).json()).hits,[]);
  await server.app.plugins.setEnabled('conversation-files',true);
  const first=await (await search()).json();
  assert.equal(first.hits.length,25);
  const second=await (await search({before:first.nextBefore})).json();
  assert.deepEqual([...first.hits,...second.hits].map(row=>row.id),
    ['reply','quote',...Array.from({length:26},(_,i)=>'sample-'+(25-i))]);
  assert.deepEqual((await (await search({category:'quoted'})).json()).hits.map((row:{id:string})=>row.id),['quote']);
  assert.deepEqual((await (await search({conversationId:'web:'+globalId,projectId:undefined})).json()).hits.map((row:{id:string})=>row.id),['global']);
  for(const wrong of [{projectId:undefined},{projectId:'other'},{before:'sibling'},{conversationId:'web:'+randomUUID()},{todoId:'unknown'}])
    assert.equal((await search(wrong)).status,404);
  await server.app.plugins.invocations.use('web-conversations.manage',{action:'update',id,version:1,archived:true});
  assert.equal((await (await search()).json()).hits.length,25);
  await server.app.plugins.setEnabled('web-conversations',false);
  assert.equal((await search()).status,503);
  assert.equal((await search({conversationId:'main',projectId:undefined})).status,200);
  await server.app.plugins.setEnabled('web-conversations',true);
  store.put('projects',projectId,{id:projectId,archivedAt:new Date().toISOString()});
  assert.equal((await search()).status,409);
  await server.app.plugins.setEnabled('conversation-search',false);
  assert.equal((await search()).status,503);
});

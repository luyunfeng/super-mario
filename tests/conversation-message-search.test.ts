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

import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {access,mkdir,mkdtemp,readFile,rm,symlink,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('独立 Web 对话删除受忙碌与版本保护，清理可重放且重启后只补删原目录',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'web-delete-'));
  const config={dataDir,demo:true,host:'127.0.0.1',port:0};
  let server=await startServer(config);
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const a=randomUUID(),b=randomUUID(),receipt=randomUUID();
  const base=()=>server.url+'/api/v1/web-conversations';
  const post=(path:string,body:object)=>fetch(base()+path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':receipt},body:JSON.stringify(body)});
  const sessions=(id:string)=>join(dataDir,'pi','agents',createHash('sha256').update('web:'+id).digest('hex'),'sessions');
  const transcript=async(id:string,dir=sessions(id))=>{
    await mkdir(join(dir,'conversation'),{recursive:true});
    const file=join(dir,'conversation','fixture.jsonl');
    await writeFile(file,id);return file;
  };
  for(const id of [a,b]){
    assert.equal((await post('',{id,title:'合成对话'})).status,201);
    const m=await (await post('/'+id+'/messages',{text:'合成回执'})).json();
    await t.waitFor(()=>assert.ok(server.app.store.list<Message>('messages').some(r=>r.replyTo===m.id&&r.status==='done')));
  }
  const app=server.app,store=app.store;
  const fileA=await transcript(a),fileB=await transcript(b);
  const receiptKey=(id:string)=>JSON.stringify(['web:'+id,receipt]);
  assert.ok(store.get('message.requests',receiptKey(a)));
  await assert.rejects(app.deleteWebConversation(a,2),{status:409});
  store.put('runs','busy',{id:'busy',conversationId:'web:'+a,status:'running'});
  await assert.rejects(app.deleteWebConversation(a,1),{status:409});
  assert.ok(store.get('web-conversations',a));assert.equal(store.get('web-conversations.deleted',a),undefined);
  store.remove('runs','busy');
  assert.deepEqual(await Promise.all([app.deleteWebConversation(a,1),app.deleteWebConversation(a,1)]),[{deleted:true},{deleted:true}]);
  assert.equal(store.get('message.requests',receiptKey(a)),undefined);
  assert.ok(store.get('message.requests',receiptKey(b)));
  assert.equal(store.list<Message>('messages').some(m=>m.conversationId==='web:'+a),false);
  await assert.rejects(access(fileA),{code:'ENOENT'});
  assert.equal(await readFile(fileB,'utf8'),b);
  assert.equal((await fetch(base()+'/'+a)).status,410);
  assert.equal((await post('',{id:a,title:'重放创建'})).status,410);
  await assert.rejects(app.deleteWebConversation(a,2),{status:409});

  await rm(sessions(b),{recursive:true});
  const unrelated=join(dataDir,'unrelated');
  const preserved=await transcript(a,unrelated);
  await symlink(unrelated,sessions(b));
  await assert.rejects(app.deleteWebConversation(b,1),{status:503});
  assert.equal(store.get<{cleanupPending:boolean}>('web-conversations.deleted',b)?.cleanupPending,true);
  assert.equal(store.get('web-conversations',b),undefined);
  assert.equal(await readFile(preserved,'utf8'),a);
  await server.close();
  await unlink(sessions(b));await transcript(b);
  server=await startServer(config);
  await assert.rejects(access(fileB),{code:'ENOENT'});
  assert.equal(server.app.store.get<{cleanupPending:boolean}>('web-conversations.deleted',b)?.cleanupPending,false);
  assert.equal(await readFile(preserved,'utf8'),a);
  assert.deepEqual(await server.app.deleteWebConversation(b,1),{deleted:true});
});

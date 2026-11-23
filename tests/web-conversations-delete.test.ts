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
  const upload=async(thread:string,text:string)=>{
    const query=new URLSearchParams({conversationId:'web:'+thread,name:'合成资料.txt'});
    const response=await fetch(server.url+'/api/v1/chat-files/uploads?'+query,{method:'PUT',headers:{'content-type':'text/plain'},body:text});
    assert.equal(response.status,201,await response.clone().text());return response.json();
  };
  const unposted=await upload(a,'从未发送的原件'), sent=await upload(a,'已发送的独有原件');
  const shared=await upload(a,'两个线程共享的字节'), other=await upload(b,'两个线程共享的字节');
  const withFile=await fetch(base()+'/'+a+'/messages',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({text:'合成文件',files:[{uploadId:sent.uploadId},{uploadId:shared.uploadId}]})});
  assert.equal(withFile.status,202,await withFile.clone().text());
  const fileInput=await withFile.json();
  await t.waitFor(()=>assert.ok(store.list<Message>('messages').some(m=>m.replyTo===fileInput.id && m.status!=='pending')));
  const hashPath=(sha:string)=>join(dataDir,'chat-files',sha);
  const fileA=await transcript(a),fileB=await transcript(b);
  const receiptKey=(id:string)=>JSON.stringify(['web:'+id,receipt]);
  assert.ok(store.get('message.requests',receiptKey(a)));
  await assert.rejects(app.deleteWebConversation(a,2),{status:409});
  store.put('runs','busy',{id:'busy',conversationId:'web:'+a,status:'running'});
  await assert.rejects(app.deleteWebConversation(a,1),{status:409});
  assert.ok(store.get('web-conversations',a));assert.equal(store.get('web-conversations.deleted',a),undefined);
  store.remove('runs','busy');
  assert.deepEqual(await Promise.all([app.deleteWebConversation(a,1),app.deleteWebConversation(a,1)]),[{deleted:true},{deleted:true}]);
  for(const row of [unposted,sent,shared])assert.equal(store.get('message.file-uploads',row.uploadId),undefined);
  assert.ok(store.get('message.file-uploads',other.uploadId));
  for(const row of [unposted,sent])await assert.rejects(access(hashPath(row.sha256)),{code:'ENOENT'});
  assert.equal(await readFile(hashPath(other.sha256),'utf8'),'两个线程共享的字节');
  assert.equal(store.get('message.requests',receiptKey(a)),undefined);
  assert.ok(store.get('message.requests',receiptKey(b)));
  assert.equal(store.list<Message>('messages').some(m=>m.conversationId==='web:'+a),false);
  await assert.rejects(access(fileA),{code:'ENOENT'});
  assert.equal(await readFile(fileB,'utf8'),b);
  assert.equal((await fetch(base()+'/'+a)).status,410);
  assert.equal((await post('',{id:a,title:'重放创建'})).status,410);
  await assert.rejects(app.deleteWebConversation(a,2),{status:409});

  // Deleting a text-only thread should not trigger an unrelated full blob sweep.
  const empty=randomUUID(), orphan=hashPath(createHash('sha256').update('unrelated orphan').digest('hex'));
  assert.equal((await post('',{id:empty,title:'无文件对话'})).status,201);
  await writeFile(orphan,'unrelated orphan');
  await app.deleteWebConversation(empty,1);
  assert.equal(await readFile(orphan,'utf8'),'unrelated orphan');

  await rm(sessions(b),{recursive:true});
  const unrelated=join(dataDir,'unrelated');
  const preserved=await transcript(a,unrelated);
  await symlink(unrelated,sessions(b));
  await assert.rejects(app.deleteWebConversation(b,1),{status:503});
  assert.equal(store.get<{cleanupPending:boolean}>('web-conversations.deleted',b)?.cleanupPending,true);
  assert.equal(store.get<{filesPending?:boolean}>('web-conversations.deleted',b)?.filesPending,true);
  assert.equal(store.get('web-conversations',b),undefined);
  assert.equal(await readFile(preserved,'utf8'),a);
  await server.close();
  await unlink(sessions(b));await transcript(b);
  server=await startServer(config);
  await assert.rejects(access(fileB),{code:'ENOENT'});
  await assert.rejects(access(hashPath(other.sha256)),{code:'ENOENT'});
  assert.equal(server.app.store.get<{cleanupPending:boolean}>('web-conversations.deleted',b)?.cleanupPending,false);
  assert.equal(await readFile(preserved,'utf8'),a);
  assert.deepEqual(await server.app.deleteWebConversation(b,1),{deleted:true});
});

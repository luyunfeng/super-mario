import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/core/src/store.ts';
import { createEventBus } from '../packages/core/src/events.ts';
import { createContributions, PluginHost } from '../packages/core/src/plugin-host.ts';
import type { JsonObject } from '../packages/plugin-sdk/src/index.ts';
import { createOfficeDocuments } from '../plugins/office/index.ts';

test('仅工具生成的真实办文成果可绑定，会话失权后管理列表与下载都不可读', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-office-bound-'));
  const store=createStore(join(dir,'test.db')), contributions=createContributions();
  const host=new PluginHost({store,contributions,dataDir:dir,events:createEventBus(store)});
  t.after(async()=>{await host.close(); store.close(); await rm(dir,{recursive:true,force:true});});
  let boundId='',allowed=true, calls=0;
  let notifyStarted!:()=>void;
  const waiting=new Promise<void>(resolve=>{notifyStarted=resolve;});
  let mode:'attach'|'none'|'deny'|'mismatch'|'wait'='attach';
  host.register(createOfficeDocuments({
    async attach(doc,bytes,signal){
      calls++; signal.throwIfAborted();
      assert.equal(bytes.toString('ascii',0,2),'PK');
      if(mode==='none') return;
      if(mode==='deny') throw Object.assign(Error('失效来源'),{status:403});
      if(mode==='wait'){
        notifyStarted();
        await new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
      }
      boundId=doc.id;
      return {name:doc.filename,mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:bytes.length,
        sha256:mode==='mismatch'?'wrong':createHash('sha256').update(bytes).digest('hex')};
    },canRead:id=>allowed&&id===boundId,
  }));
  await host.start();
  const manage=(args:JsonObject)=>host.invocations.use('office-documents.manage',args);
  const list=async()=>await manage({action:'list'}) as JsonObject[];
  const tool=contributions.list('tools').find(x=>x.value.name==='office_create')!.value;
  const create=(title:string,extra:JsonObject={})=>tool.execute({title,source:'合成内容',format:'docx',...extra},new AbortController().signal);
  await assert.rejects(create('伪造',{attachedFile:{name:'假文件'}}),{status:400});
  const manual=await manage({action:'create',title:'手工',format:'docx',source:'管理面板创建'}) as JsonObject;
  assert.equal(calls,0);assert.equal(manual.attachedFile,undefined);
  const bound=await create('会话成果') as JsonObject;
  assert.equal(bound.conversationBound,true);
  assert.equal((bound.attachedFile as JsonObject).name,'会话成果.docx');
  const downloaded=await manage({action:'download',id:bound.id}) as JsonObject;
  assert.equal(createHash('sha256').update(Buffer.from(String(downloaded.base64),'base64')).digest('hex'),(bound.attachedFile as JsonObject).sha256);
  assert.equal((await list()).length,2);
  allowed=false;
  assert.deepEqual((await list()).map(d=>d.id),[manual.id]);
  await assert.rejects(manage({action:'download',id:bound.id}),/找不到办公文件/);
  mode='deny'; await assert.rejects(create('来源失效'),{status:403});
  mode='mismatch'; await assert.rejects(create('错误回执'),{status:500});
  mode='none'; const unbound=await create('文'.repeat(120)) as JsonObject;
  assert.equal(unbound.title,'文'.repeat(120));
  assert.equal(unbound.filename,'文'.repeat(83)+'.docx');
  assert.equal(unbound.attachedFile,undefined);assert.equal(unbound.conversationBound,undefined);
  assert.deepEqual(new Set((await list()).map(d=>d.id)),new Set([unbound.id,manual.id]));
  mode='wait';
  const interrupted=assert.rejects(create('停用期间的私有文件'),/已停用/);
  await waiting;
  await host.setEnabled('office-documents',false);
  await interrupted;
  assert.equal(store.list('office.documents').length,3);
  assert.equal(store.list('office.files').length,3);
});

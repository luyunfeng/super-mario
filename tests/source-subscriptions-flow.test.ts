import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';
import type {InboxItem,KnowledgeEntry} from '../packages/protocol/src/index.ts';
import type {SourceSubscription} from '../packages/core/src/source-subscriptions.ts';

test('来源订阅通过真实 HTTP 恢复分目的地投递，重启后保留已编辑的知识页及唯一收件',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-source-flow-'));
  const config={host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'local-subscription-test'};
  let server=await startServer(config);
  t.after(async()=>{try{await server.close();}finally{await rm(dir,{recursive:true,force:true});}});
  const endpoint='source-subscriptions',service='local-source.releases';
  let reads=0, sensitiveReads=0;
  const release={id:'synthetic-release-001',title:'本地版本一',text:'首个版本说明',url:'https://example.test/release/1'};
  const input={sourceId:service,name:'合成发布订阅',resource:'local/testing',intervalMinutes:60,destinations:['inbox','knowledge']};
  async function api<T>(path:string,method='GET',body?:object,status=200,authorized=true){
    const res=await fetch(server.url+'/api/v1/'+path,{method,headers:{'content-type':'application/json',
      ...(authorized && {authorization:'Bearer '+config.token})},...(body && {body:JSON.stringify(body)})});
    const data=await res.json();assert.equal(res.status,status,method+' '+path+' '+JSON.stringify(data));return data as T;
  }
  const toggle=(id:string,enabled:boolean)=>api('plugins/'+id,'POST',{enabled});
  async function install(){
    server.app.plugins.register({id:'local-source',name:'合成来源',capabilities:['subscription.source'],
      permissions:['contribute:connectors','service.provide:local-source.unsafe','service.provide:'+service],activate(ctx){
        ctx.contribute('connectors','local-fixture-releases',{kind:'subscription-source',name:'合成发布',resourceLabel:'仓库',service});
        ctx.contribute('connectors','fixture-unsafe',{kind:'subscription-source',name:'写服务',resourceLabel:'资源',service:'local-source.unsafe'});
        ctx.contribute('services','unsafe',{name:'local-source.unsafe',version:1,handler(){sensitiveReads++;return {items:[]};}});
        ctx.contribute('services','local-fixture-releases',{name:service,version:1,readOnly:true,async handler(raw){
          assert.deepEqual(raw,{resource:input.resource});reads++;return {items:[release]};
        }});
      }});
    await toggle('local-source',true);
  }
  await install();
  await api(endpoint+'/preview','POST',{sourceId:'local-source.unsafe',resource:'sample'},503);
  assert.equal(sensitiveReads,0);
  await api(endpoint,'GET',undefined,401,false);await api(endpoint,'POST',input,401,false);
  await api(endpoint+'/preview','POST',input,401,false);
  assert.equal(reads,0);
  await api(endpoint+'/preview','POST',input);
  const empty=await api<{subscriptions:SourceSubscription[]}>(endpoint);
  assert.deepEqual(empty.subscriptions,[]);
  const row=await api<SourceSubscription>(endpoint,'POST',input,201);
  const pull=(status=200)=>api<SourceSubscription>(endpoint+'/'+row.id+'/pull','POST',{version:row.version},status);
  await api(endpoint+'/'+row.id+'/pull','POST',{version:1},401,false);assert.equal(reads,1);
  const inbox=async()=>(await api<InboxItem[]>('inbox')).filter(r=>r.source==='subscription:'+row.id);
  const pages=async()=>(await api<KnowledgeEntry[]>('knowledge')).filter(e=>e.tags?.includes('来源订阅'));
  await toggle('knowledge-local',false);await pull(502);
  const first=await inbox();assert.equal(first.length,1);assert.equal(first[0]?.title,release.title);
  assert.ok((await api<{subscriptions:SourceSubscription[]}>(endpoint)).subscriptions[0]?.error);
  let legacyWrites=0;
  server.app.plugins.register({id:'legacy-knowledge-fixture',name:'合成旧知识后端',capabilities:[],
    activate(ctx){ctx.contribute('knowledge_backends','legacy-fixture',{
      async list(){return [];},async put(){legacyWrites++;throw new Error('unexpected write');},async remove(){return false;},
    });}});
  await toggle('legacy-knowledge-fixture',true);
  await pull(503);assert.equal(legacyWrites,0);
  await toggle('legacy-knowledge-fixture',false);
  await toggle('knowledge-local',true);await pull();
  const page=(await pages())[0]!;assert.equal(page.layer,'personal');assert.match(page.content,/首个版本说明/);
  const edit={content:'主人已补充并核对内容',expectedUpdatedAt:page.updatedAt};
  await api('knowledge/'+page.id,'PATCH',edit);
  assert.equal((await pages()).length,1);
  await pull();assert.equal((await pages())[0]?.content,edit.content);
  // Simulate a crash between the destination transaction and the delivery receipt commit in this isolated fixture.
  const receipts=server.app.store.entries!('source.subscription-receipts.'+row.id);assert.equal(receipts.length,2);
  for(const receipt of receipts)server.app.store.remove('source.subscription-receipts.'+row.id,receipt.id);
  await server.close();server=await startServer(config);await install();
  await pull();
  const finalInbox=await inbox(),finalPages=await pages();
  assert.deepEqual(finalInbox.map(x=>[x.id,x.version]),first.map(x=>[x.id,x.version]));
  assert.deepEqual(finalPages.map(x=>[x.id,x.content]),[[page.id,edit.content]]);
  assert.equal(server.app.store.entries!('source.subscription-receipts.'+row.id).length,2);

  const privateService='local-private.read';
  server.app.plugins.register({id:'local-private',name:'私有服务替身',capabilities:[],permissions:['service.provide:'+privateService],activate(ctx){
    ctx.contribute('services','private-fixture-read',{name:privateService,version:1,async handler(){sensitiveReads++;return {items:[release]};}});
  }});
  server.app.plugins.register({id:'local-forged',name:'声明错误来源的插件',capabilities:['subscription.source'],permissions:['contribute:connectors'],activate(ctx){
    ctx.contribute('connectors','foreign',{kind:'subscription-source',name:'错误来源',resourceLabel:'资源',service:privateService});
  }});
  await toggle('local-private',true);
  assert.ok(server.app.contributions.list('services').some(s=>s.value.name===privateService));
  const response=await fetch(server.url+'/api/v1/plugins/local-forged',{method:'POST',
    headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify({enabled:true})});
  const pluginStatus=await response.json();
  assert.ok(!response.ok || (Array.isArray(pluginStatus) && pluginStatus.some(p=>p.id==='local-forged' && p.status==='failed')));
  const catalog=await api<{sources:{id:string}[]}>(endpoint);
  assert.ok(!catalog.sources.some(x=>x.id===privateService));
  await api(endpoint+'/preview','POST',{...input,sourceId:privateService},503);
  assert.equal(sensitiveReads,0);
});

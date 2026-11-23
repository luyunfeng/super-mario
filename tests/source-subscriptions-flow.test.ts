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
  let reads=0, sensitiveReads=0, throttled=false;
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
          assert.deepEqual(raw,{resource:input.resource});reads++;
          if(throttled) throw Object.assign(new Error('private fixture detail'),{sourceReadCode:'rate_limited',retryAfterSeconds:180});
          return {items:[release]};
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
  const historyPath=endpoint+'/'+row.id+'/runs';
  const history=()=>api<ReturnType<ReturnType<typeof server.app.subscriptions.service>['runHistory']>>(historyPath);
  await api(historyPath,'GET',undefined,401,false);
  assert.deepEqual((await history()).items,[]);
  const pull=(status=200)=>api<SourceSubscription>(endpoint+'/'+row.id+'/pull','POST',{version:row.version},status);
  await api(endpoint+'/'+row.id+'/pull','POST',{version:1},401,false);assert.equal(reads,1);
  const inbox=async()=>(await api<InboxItem[]>('inbox')).filter(r=>r.source==='subscription:'+row.id);
  const pages=async()=>(await api<KnowledgeEntry[]>('knowledge')).filter(e=>e.tags?.includes('来源订阅'));
  await toggle('knowledge-local',false);await pull(502);
  const waiting=await history();
  assert.deepEqual(waiting.currentPending,{inbox:0,knowledge:1,totalEntries:1,entries:[{title:release.title,destinations:['knowledge']}]});
  const [partial]=waiting.items;
  assert.ok(partial);assert.equal(partial.status,'failed');assert.equal(partial.trigger,'manual');
  assert.deepEqual(partial.delivered,{inbox:1,knowledge:0});assert.deepEqual(partial.pending,{inbox:0,knowledge:1});
  assert.equal(partial.readCount,1);assert.equal(partial.newCount,1);
  assert.equal(partial.entries[0]?.title,release.title);
  assert.ok(!JSON.stringify(partial).includes(release.text));assert.ok(!JSON.stringify(partial).includes(release.url!));
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
  const recovered=await history();assert.equal(recovered.currentPending.totalEntries,0);
  const [recovery]=recovered.items;
  assert.ok(recovery);assert.equal(recovery.status,'completed');assert.deepEqual(recovery.delivered,{inbox:0,knowledge:1});
  assert.deepEqual(recovery.pending,{inbox:0,knowledge:0});
  const page=(await pages())[0]!;assert.equal(page.layer,'personal');assert.match(page.content,/首个版本说明/);
  const edit={content:'主人已补充并核对内容',expectedUpdatedAt:page.updatedAt};
  await api('knowledge/'+page.id,'PATCH',edit);
  assert.equal((await pages()).length,1);
  await pull();assert.equal((await pages())[0]?.content,edit.content);
  // Simulate a crash between the destination transaction and the delivery receipt commit in this isolated fixture.
  const receipts=server.app.store.entries!('source.subscription-receipts.'+row.id);assert.equal(receipts.length,2);
  for(const receipt of receipts)server.app.store.remove('source.subscription-receipts.'+row.id,receipt.id);
  await server.close();server=await startServer(config);await install();
  assert.deepEqual((await history()).items.find(run=>run.id===partial.id),partial);
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

  throttled=true;
  const preview=await fetch(server.url+'/api/v1/'+endpoint+'/preview',{method:'POST',
    headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify(input)});
  assert.equal(preview.status,429);
  assert.ok(Number(preview.headers.get('retry-after'))>0);
  const wait=await preview.json();
  assert.ok(Date.parse(wait.retryAt)>Date.now());
  assert.doesNotMatch(wait.error,/private fixture/);
  assert.equal((await api<{subscriptions:SourceSubscription[]}>(endpoint)).subscriptions[0]?.retryAt,wait.retryAt);
});

test('GitHub 来源跨页补收 35 个新版本，服务重启与重复条目不改变收件总数',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-release-pages-'));
  const config={host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'local-pagination-test'};
  let server=await startServer(config);
  t.after(async()=>{try{await server.close();}finally{await rm(dir,{recursive:true,force:true});}});
  const pages:number[]=[];
  let latest=2;
  const localFetch=fetch;
  t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(url,init), target=new URL(request.url);
    if(target.origin===server.url)return localFetch(request);
    assert.equal(target.origin,'https://api.github.com');
    assert.equal(target.pathname,'/repos/sample/fixture/releases');
    const page=Number(target.searchParams.get('page') ?? 1);
    pages.push(page);
    const all=Array.from({length:latest},(_,i)=>({id:latest-i,tag_name:'v'+(latest-i),draft:false}));
    const items=all.slice((page-1)*30,page*30);
    return Response.json(items,{headers:page*30<all.length
      ? {link:'<https://api.github.com/repos/sample/fixture/releases?per_page=30&page='+(page+1)+'>; rel="next"'} : {}});
  });
  async function api(path:string,body?:object) {
    const res=await localFetch(server.url+'/api/v1/'+path,{method:body?'POST':'GET',headers:{
      authorization:'Bearer '+config.token,'content-type':'application/json'},...(body && {body:JSON.stringify(body)})});
    assert.ok(res.ok,await res.clone().text());return res.json();
  }
  const route='source-subscriptions';
  const row=await api(route,{name:'合成公开版本',sourceId:'release-source.releases',resource:'sample/fixture',destinations:['inbox'],intervalMinutes:10080});
  const pull=()=>api(route+'/'+row.id+'/pull',{version:row.version});
  await pull();latest=37;
  const next=await pull();assert.equal(next.nextPageNumber,2);
  await server.close();server=await startServer(config);
  const resumed=await pull();assert.equal(resumed.nextPageNumber,undefined);
  await pull();
  assert.deepEqual(pages,[1,1,2,1]);
  const received=(await api('inbox') as InboxItem[]).filter(item=>item.source==='subscription:'+row.id);
  assert.equal(received.length,37);
  assert.deepEqual(new Set(received.map(item=>item.title)),new Set(Array.from({length:37},(_,i)=>'v'+(i+1))));
});

test('仓库快照只在变化时更新同一收件，重启后恢复旧状态仍归入该订阅的个人记忆',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm-repo-state-'));
  const config={host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'snapshot-fixture'};
  let server=await startServer(config);
  t.after(async()=>{try{await server.close();}finally{await rm(dir,{recursive:true,force:true});}});
  let branch='main';
  const localFetch=fetch;
  t.mock.method(globalThis,'fetch',async(url:RequestInfo|URL,init?:RequestInit)=>{
    const req=new Request(url,init);
    if(new URL(req.url).origin===server.url)return localFetch(req);
    assert.equal(req.url,'https://api.github.com/repos/sample/fixture');
    return Response.json({full_name:'sample/fixture',default_branch:branch,description:'状态验收',archived:false,disabled:false,private:false});
  });
  async function api(path:string,body?:object) {
    const res=await localFetch(server.url+'/api/v1/'+path,{method:body?'POST':'GET',headers:{
      authorization:'Bearer '+config.token,'content-type':'application/json'},...(body && {body:JSON.stringify(body)})});
    assert.ok(res.ok,await res.clone().text());return res.json();
  }
  const route='source-subscriptions', resource={sourceId:'release-source.repository',resource:'sample/fixture'};
  const catalog=await api(route);
  assert.ok(catalog.timezone);
  assert.equal(catalog.sources.find((s:{id:string})=>s.id===resource.sourceId).mode,'snapshot');
  const sub=await api(route,{...resource,name:'仓库状态',destinations:['inbox','knowledge']});
  assert.equal(sub.dailyAt,'08:00');
  const pull=()=>api(route+'/'+sub.id+'/pull',{version:sub.version});
  const inbox=async()=>(await api('inbox') as InboxItem[]).filter(r=>r.source==='subscription:'+sub.id);
  const knowledge=async()=>(await api('knowledge') as KnowledgeEntry[]).filter(r=>r.tags?.includes('订阅:'+sub.id));
  assert.equal((await api(route+'/preview',{...resource,subscriptionId:sub.id})).firstObservation,true);
  assert.deepEqual(await inbox(),[]);
  await pull();
  const [a]=await inbox();assert.match(a!.text,/main/);
  assert.equal((await api(route+'/preview',{...resource,subscriptionId:sub.id})).changed,false);
  await pull();assert.deepEqual(await inbox(),[a]);assert.equal((await knowledge()).length,1);
  branch='stable';assert.equal((await api(route+'/preview',{...resource,subscriptionId:sub.id})).changed,true);
  await pull();
  const [b]=await inbox();assert.equal(b!.id,a!.id);assert.match(b!.text,/stable/);
  await server.close();server=await startServer(config);branch='main';
  await pull();await pull();
  const final=await inbox();assert.equal(final.length,1);
  assert.equal(final[0]!.id,a!.id);assert.ok(final[0]!.version>b!.version);assert.match(final[0]!.text,/main/);
  const history=await api(route+'/'+sub.id+'/snapshot-history');
  assert.deepEqual(history.items.map((entry:{sequence:number})=>entry.sequence),[3,2,1]);
  const pages=await knowledge();assert.equal(pages.length,3);assert.ok(pages.every(p=>p.layer==='personal'));
});

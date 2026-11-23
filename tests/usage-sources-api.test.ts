import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readdir,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';

test('用量来源管理在真实 HTTP、SQLite 和本地网关之间保持凭证、窗口与轮询边界',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'usage-source-api-')),key='synthetic-bearer';
  let reads=0,fail=false,entered:(()=>void)|undefined,gate:Promise<void>|undefined;
  const provider=createServer(async(req,res)=>{
    reads++;assert.equal(req.headers.authorization,'Bearer '+key);
    entered?.();await gate;
    res.writeHead(fail?503:200,{'content-type':'application/json'});
    res.end(JSON.stringify(fail?{error:'remote-private-detail'}:{accounts:[{id:'remote-private-id',name:'本地合成账号',provider:'test-gateway',windows:[
      {label:'5h',used_percent:82},{label:'1d',used_percent:70,resets_at:'2000-01-01T00:00:00Z'}]}]}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const addr=provider.address();assert.ok(addr && typeof addr==='object');
  const url='http://127.0.0.1:'+addr.port+'/synthetic';
  const start=()=>startServer({dataDir,host:'127.0.0.1',port:0,token:'fixture',demo:true});
  let server=await start();
  t.after(async()=>{await server.close();await new Promise<void>(r=>provider.close(()=>r()));await rm(dataDir,{recursive:true,force:true});});
  const headers={authorization:'Bearer fixture','content-type':'application/json'};
  const api=(path='',method='GET',input?:object)=>fetch(server.url+'/api/v1/usage/'+path,{method,headers,body:input&&JSON.stringify(input)});
  const get=async(path='sources')=>(await api(path)).json();
  const request=async(path:string,method:string,input:object,status=200)=>{
    const response=await api(path,method,input),body=await response.json();
    assert.equal(response.status,status,JSON.stringify(body));return body;
  };
  assert.equal((await fetch(server.url+'/api/v1/usage/sources')).status,401);
  const empty=await get();assert.equal(empty.limit,8);assert.equal(empty.pollMinutes,5);assert.equal(empty.enabled,true);
  await request('sources','POST',{url:url+'?key=hidden',type:'generic',name:'源'},400);
  const cfg={type:'generic',url,name:'测试源',key};
  const probe=await request('sources/test','POST',cfg);assert.equal(probe.accounts,1);assert.equal(probe.windows,2);assert.equal(reads,1);
  const added=await request('sources','POST',cfg,201),source=added.sources[0],path='sources/'+source.id;
  assert.equal(source.hasKey,true);assert.equal(JSON.stringify(added).includes(key),false);
  const files=await readdir(join(dataDir,'plugins','usage-sources','keys'));assert.equal(files.length,1);
  assert.equal((await stat(join(dataDir,'plugins','usage-sources','keys',files[0]!))).mode&0o777,0o600);
  await request('sources/test','POST',{id:source.id,url:url+'/elsewhere'},400);
  await request(path,'PUT',{revision:source.revision,url:url+'/elsewhere'},400);
  await request('sources/test','POST',{id:source.id});
  server.app.usageSources.poll();await t.waitFor(async()=>{assert.ok((await get()).sources[0].status.okAt);});
  const account=(await get('windows')).accounts[0];assert.equal(account.windows.length,1);assert.equal(account.windows[0].usedPercent,82);
  assert.notEqual(account.id,'remote-private-id');assert.equal(account.stale,false);
  assert.deepEqual((await get()).providers,['test-gateway']);
  fail=true;
  const problem=await request(path+'/refresh','POST',{},502);assert.doesNotMatch(problem.error,/remote-private-detail|synthetic-bearer/);
  assert.equal((await get('windows')).accounts[0].stale,true);
  const hidden=await request('sources/settings','PUT',{revision:empty.revision,hiddenProviders:['test-gateway']});
  assert.deepEqual((await get('windows')).accounts,[]);assert.deepEqual(hidden.providers,['test-gateway']);
  await request('sources/settings','PUT',{revision:empty.revision,pollMinutes:10},409);
  const disabled=await request('sources/settings','PUT',{revision:hidden.revision,hiddenProviders:[],enabled:false,pollMinutes:10});
  await request(path+'/refresh','POST',{},409);
  await server.close();server=await start();assert.equal((await get()).enabled,false);
  await request('sources/settings','PUT',{revision:disabled.revision,enabled:true});
  assert.equal((await get('windows')).accounts[0].stale,true);
  fail=false;let release!:()=>void;gate=new Promise<void>(r=>{release=r;});
  const ready=new Promise<void>(r=>{entered=r;}),pending=api(path+'/refresh','POST',{});
  await ready;
  try {await server.app.plugins.setEnabled('usage-sources',false);assert.equal((await api('windows')).status,503);}
  finally {release();}
  assert.equal((await pending).status,409);
  await server.app.plugins.setEnabled('usage-sources',true);
  const current=(await get()).sources[0];
  const moved=await request(path,'PUT',{revision:current.revision,url:url+'/new',clearKey:true});
  assert.deepEqual((await get('windows')).accounts,[]);assert.equal(moved.sources[0].hasKey,false);
  await request(path,'DELETE',{revision:current.revision},409);
  const removed=await request(path,'DELETE',{revision:moved.sources[0].revision});assert.deepEqual(removed.sources,[]);
  for(let i=0;i<8;i++)await request('sources','POST',{type:'generic',url,name:'合成源 '+i,enabled:false},201);
  await request('sources','POST',{type:'generic',url,name:'超额合成源',enabled:false},409);
  assert.equal((await get()).sources.length,8);
  for(const filename of (await readdir(dataDir)).filter(f=>f.startsWith('workbench.sqlite')))
    assert.equal((await readFile(join(dataDir,filename))).includes(Buffer.from(key)),false);
});

test('账户池清单仅存本次进程，HTTP 与显式授权插件读取同份缓存',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'gateway-inventory-'));
  let calls=0,failed=false,partial=false,gate:Promise<void>|undefined,entered:(()=>void)|undefined;
  const gateway=createServer(async(req,res)=>{
    calls++;entered?.();await gate;
    if(failed){res.writeHead(503);res.end();return;}
    res.setHeader('content-type','application/json');
    const accounts=[{id:'private-inventory-only',provider:'test',status:'disabled',schedulable:false,last_error:'quarantine:private detail',quota_summary:[{kind:'kiro_bonus'}]},
      {id:'active-id',provider:'test',status:'active'}];
    if(req.url?.startsWith('/api/admin/accounts?')){
      if(req.url.includes('after_id=')){res.writeHead(503);res.end();return;}
      res.end(JSON.stringify({accounts,...(partial&&{next_after_id:'cursor'})}));
    }else res.end(JSON.stringify({accounts:[{account_id:'active-id',windows:[{kind:'weekly',used_ratio:0.5}]}]}));
  });
  await new Promise<void>(r=>gateway.listen(0,'127.0.0.1',r));
  const endpoint=gateway.address();assert.ok(endpoint && typeof endpoint==='object');
  const start=()=>startServer({dataDir,host:'127.0.0.1',port:0,token:'fixture',demo:true});
  let server=await start();
  t.after(async()=>{await server.close();await new Promise<void>(r=>gateway.close(()=>r()));await rm(dataDir,{recursive:true,force:true});});
  const headers={authorization:'Bearer fixture','content-type':'application/json'};
  const req=async(path:string,method='GET',data?:object,status=200)=>{
    const r=await fetch(server.url+'/api/v1/usage/'+path,{method,headers,body:data&&JSON.stringify(data)}),v=await r.json();
    assert.equal(r.status,status,JSON.stringify(v));return v;
  };
  const base='gateway-accounts',newSource=await req('sources','POST',{type:'relay',url:'http://127.0.0.1:'+endpoint.port,key:'synthetic-key'},201);
  const id=newSource.sources[0].id,path='sources/'+id;
  assert.deepEqual((await req(base)).sources[0],{id,name:'Relay',error:'pending',listed:0,complete:false});
  assert.equal(calls,0);
  await req(path+'/refresh','POST',{});
  const reads=calls,all=await req(base);
  assert.equal(all.total,2);assert.equal(all.sources[0].complete,true);
  assert.equal(all.accounts[0].reason,'quarantine');assert.equal(all.accounts[0].windows[0].kind,'kiro_bonus');
  assert.deepEqual((await req(base+'?limit=1&offset=1')).accounts,[all.accounts[1]]);
  assert.equal((await req(base+'?sourceId=missing')).total,0);
  await req(base+'?offset=-1','GET',undefined,400);
  assert.equal(calls,reads);
  const host=server.app.plugins;
  for(const [suffix,permissions,allowed] of [
    ['explicit',['usage_gateways'],true],['legacy',undefined,false],['wildcard',['*'],false],['service',['service.use:usage.gateway_accounts'],false]
  ] as const){
    let read:(()=>Promise<unknown>)|undefined;
    const pluginId='test-inventory-'+suffix;
    host.register({id:pluginId,name:pluginId,capabilities:[],permissions:permissions?[...permissions]:undefined,activate(ctx){
      read=()=>ctx.use('usage.gateway_accounts',{limit:1});
    }});
    await host.setEnabled(pluginId,true);assert.ok(read);
    if(allowed)assert.deepEqual(await read(),await req(base+'?limit=1'));
    else await assert.rejects(read,/usage_gateways/);
    await host.setEnabled(pluginId,false);await assert.rejects(read,/closed/);
  }
  assert.equal(calls,reads);
  partial=true;await req(path+'/refresh','POST',{});assert.equal((await req(base)).sources[0].complete,false);
  failed=true;await req(path+'/refresh','POST',{},502);
  const stale=await req(base);assert.equal(stale.sources[0].error,'server_error');assert.equal(stale.total,2);assert.ok(stale.accounts.every((a:{stale:boolean})=>a.stale));
  await server.close();failed=false;partial=false;
  let release!:()=>void;gate=new Promise<void>(r=>{release=r;});const requested=new Promise<void>(r=>{entered=r;});
  server=await start();await requested;
  try {const cold=await req(base);assert.equal(cold.sources[0].error,'pending');assert.equal(cold.total,0);}
  finally {gate=undefined;release();}
  await t.waitFor(async()=>assert.equal((await req(base)).total,2));
  const updated=await req(path,'PUT',{revision:1,key:'synthetic-replacement'});assert.equal((await req(base)).sources[0].error,'pending');
  await req(path+'/refresh','POST',{});await req(path,'PUT',{revision:updated.sources[0].revision,enabled:false});
  assert.deepEqual((await req(base)).accounts,[]);assert.deepEqual((await req(base)).sources,[]);
  for(const name of (await readdir(dataDir)).filter(f=>f.startsWith('workbench.sqlite')))
    assert.equal((await readFile(join(dataDir,name))).includes(Buffer.from('private-inventory-only')),false);
});

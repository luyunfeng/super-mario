import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {request} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import {startServer} from '../apps/server/src/index.ts';
import {startAgentNode} from '../apps/agent-node/src/index.ts';

test('浏览器设备凭证隔离、单次兑换、HTTP 与三类 WebSocket 撤销', {timeout:18000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'browser-auth-')),root='synthetic-root';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:join(dataDir,'server'),token:root,demo:true});
  let releases=0;
  const node=startAgentNode({url:server.url,token:root,machineId:'mock',name:'本地合成执行机',dataDir:join(dataDir,'node'),handlers:{
    'terminal.watch':async()=>({watchId:'fixture'}),'terminal.unwatch':async()=>({}),
    'terminal.live.full.open':async()=>({connectionId:'synthetic-live'}),'terminal.live.frames':async()=>({frames:[]}),
    'terminal.live.release':async()=>{releases++;return {};},
  }});
  const sockets:WebSocket[]=[];
  t.after(async()=>{for(const socket of sockets)socket.terminate();await node.close();await server.close();await rm(dataDir,{recursive:true,force:true});});
  const api=(path:string,token?:string,method='GET',body?:object)=>fetch(server.url+'/api/v1/'+path,{method,
    headers:{...(token && {authorization:'Bearer '+token}),'content-type':'application/json'},...(body && {body:JSON.stringify(body)})});
  const socket=(path:string,token:string)=>{
    const url=new URL(server.url+'/api/v1/'+path);url.protocol='ws:';url.searchParams.set('token',token);
    const ws=new WebSocket(url);sockets.push(ws);return ws;
  };
  const pair=async(name:string)=>{
    const issued=await api('browser/devices/pairings',root,'POST',{name});assert.equal(issued.status,201);
    assert.equal(issued.headers.get('cache-control'),'no-store');
    const {code}=await issued.json(),response=await api('public/browser-pair',undefined,'POST',{code});assert.equal(response.status,201);
    assert.ok((await api('public/browser-pair',undefined,'POST',{code})).status>=400);
    return response.json() as Promise<{device:{id:string;name:string};token:string;replacementProof:string}>;
  };
  const first=await pair('甲'),second=await pair('乙');
  assert.equal((await api('projects',first.token)).status,200);
  const listing=await(await api('browser/devices',first.token)).json();
  assert.match(first.replacementProof,/^[a-f0-9]{64}$/);
  assert.equal(listing.replacementProof,first.replacementProof);assert.notEqual(listing.replacementProof,second.replacementProof);
  assert.doesNotMatch(JSON.stringify(await(await api('browser/devices',root)).json()),/replacementProof/);
  assert.equal(listing.currentDeviceId,first.device.id);assert.equal(listing.canManage,false);
  assert.deepEqual(listing.devices.map((d:{id:string})=>d.id),[first.device.id]);
  assert.equal((await api('browser/devices/pairings',first.token,'POST',{name:'额外'})).status,403);
  assert.equal((await api('browser/devices/'+second.device.id,first.token,'DELETE')).status,403);
  assert.equal((await api('plugins/browser-devices',first.token,'POST',{enabled:false})).status,403);
  assert.equal((await api('worker-tools/todo-decisions',first.token,'POST',{})).status,401);
  const denied=socket('node',first.token);
  assert.match(String((await once(denied,'error'))[0]),/401/);
  await t.waitFor(()=>assert.ok(server.machines.list().some(m=>m.online)));
  const event=socket('events',first.token),terminal=socket('terminal?machineId=mock&paneId=pane',first.token),
    live=socket('live-terminal?machineId=mock&mode=full',first.token),keep=socket('events',second.token),rootEvent=socket('events',root);
  await Promise.all([once(event,'message'),once(terminal,'open'),once(live,'message'),once(keep,'message'),once(rootEvent,'message')]);
  // A partially uploaded HTTP request has already authenticated but is still waiting for its body.
  const slow=request(server.url+'/api/v1/saved-searches',{method:'POST',headers:{authorization:'Bearer '+first.token,'content-type':'application/json'}});
  // Server listeners run in registration order. Its HTTP handler enters body() before this observer.
  const accepted=new Promise<void>(resolve=>server.server.once('request',()=>resolve()));
  const disconnected=once(slow,'error');slow.write('{"');
  await accepted;
  const closes=[event,terminal,live].map(w=>once(w,'close'));
  assert.equal((await api('browser/devices/current',root,'DELETE')).status,409);
  const removed=await api('browser/devices/current',first.token,'DELETE');
  assert.equal(removed.status,200);assert.deepEqual(await removed.json(),{revoked:true});
  await Promise.all([...closes,disconnected]);
  await t.waitFor(()=>assert.equal(releases,1));
  assert.equal(keep.readyState,WebSocket.OPEN);assert.equal(rootEvent.readyState,WebSocket.OPEN);
  assert.equal((await api('projects',first.token)).status,401);
  const third=await pair('丙');
  assert.equal((await api('browser/devices/'+third.device.id,root,'DELETE')).status,200);
  assert.equal((await api('projects',third.token)).status,401);
  const replacementCode=async()=> (await(await api('browser/devices/pairings',root,'POST',{name:'替换测试'})).json()).code;
  const code=await replacementCode();
  assert.equal((await api('public/browser-pair',undefined,'POST',{code,replaces:{id:second.device.id}})).status,400);
  const wrong=await api('public/browser-pair',undefined,'POST',{code,replaces:{id:second.device.id,proof:'f'.repeat(64)}});
  assert.equal(wrong.status,201);assert.equal((await api('projects',second.token)).status,200);
  const old=await wrong.json(),oldWS=socket('events',old.token);await once(oldWS,'message');
  const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
  const proof=digest('super-mario.browser-replace.v1:'+digest(old.token)),closed=once(oldWS,'close');
  assert.equal(old.replacementProof,proof);
  const fresh=await api('public/browser-pair',undefined,'POST',{code:await replacementCode(),replaces:{id:old.device.id,proof}});
  assert.equal(fresh.status,201);assert.equal((await api('projects',(await fresh.json()).token)).status,200);
  await closed;assert.equal((await api('projects',old.token)).status,401);
  const stopped=once(keep,'close');
  assert.equal((await api('plugins/browser-devices',root,'POST',{enabled:false})).status,200);await stopped;
  assert.equal((await api('projects',second.token)).status,401);assert.equal((await api('projects',root)).status,200);
});

test('未设工作台主令牌时保留本地 Web，配对发行和兑换均不可用',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'browser-local-'));
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,demo:true});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const api=(path:string,input?:object)=>fetch(server.url+'/api/v1/'+path,{method:input?'POST':'GET',
    ...(input && {headers:{'content-type':'application/json'},body:JSON.stringify(input)})});
  assert.equal((await api('projects')).status,200);
  assert.deepEqual(await(await api('browser/devices')).json(),{devices:[],canManage:false});
  assert.equal((await api('browser/devices/pairings',{name:'本机'})).status,403);
  assert.equal((await api('public/browser-pair',{code:'fixture'})).status,403);
  assert.equal((await fetch(server.url+'/api/v1/browser/devices/current',{method:'DELETE'})).status,409);
});

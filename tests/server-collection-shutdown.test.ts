import test from 'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{setTimeout as delay}from'node:timers/promises';
import{startServer}from'../apps/server/src/index.ts';import{createStore}from'../packages/core/src/store.ts';import type{Message}from'../packages/protocol/src/index.ts';import type{PersonalProvider}from'../plugins/feishu-personal.ts';
test('shutdown aborts readonly triage before awaiting its active collector without discarding the collected item',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mario-source-close-'));const account={profile:'offline',appId:'cli_offline',openId:'ou_offline',name:'Offline'};
 const provider:PersonalProvider={async application(){return{profile:account.profile,appId:account.appId};},async begin(){return{url:'https://accounts.feishu.cn/offline',code:'offline',expiresIn:60};},async complete(){return account;},async verify(){return account;},async collect(){return[{thread:'source',last:'one',title:'Source',text:'请处理本地事项'}];}};
 const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:false},{personalProvider:provider});let reject!:(error:Error)=>void,asked=false,aborted=false;
 server.app.inboxClassifier.status=()=>({available:true});server.app.inboxClassifier.ask=async()=>{asked=true;return new Promise<Message>((_resolve,no)=>{reject=no;});};const close=server.app.inboxClassifier.close;
 server.app.inboxClassifier.close=async()=>{aborted=true;reject?.(new Error('readonly cancelled'));return close();};
 try{server.personal.authorize();for(let n=0;server.personal.status().status!=='connected'&&n<100;n++)await delay(5);assert.equal(server.personal.status().status,'connected');await server.personal.enable(true);for(let n=0;!asked&&n<100;n++)await delay(5);assert.equal(asked,true);
  const stopping=server.close();const finished=await Promise.race([stopping.then(()=>true),delay(1000).then(()=>false)]);
  if(!finished){reject(new Error('test cleanup'));await stopping;}
  assert.equal(finished,true,'collector must not wait forever before model cancellation');assert.equal(aborted,true);const persisted=createStore(join(dir,'workbench.sqlite'));try{assert.equal(persisted.list('inbox').length,1);}finally{persisted.close();}
 }finally{reject?.(new Error('test cleanup'));await server.close();await rm(dir,{recursive:true,force:true});}
});

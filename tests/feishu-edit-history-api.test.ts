import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';
import {createPersonalProvider,PERSONAL_MESSAGE_SCOPES} from '../plugins/feishu-personal.ts';
import {inboxItemId} from '../packages/core/src/inbox.ts';

test('个人飞书消息编辑历史由当前账号控制，跨批重复、换代和重启不回填',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'edit-history-api-')),appId='cli_fixture',chat='oc_fixture',message='om_sample';
  let owner='ou_first',content='初始未启用',timestamp=Date.now(),edited=false,deleted=false;
  let gate:Promise<void>|undefined,entered:(()=>void)|undefined;
  const envelope=(data:object)=>({ok:true,identity:'user',data});
  const provider=createPersonalProvider({application:()=>undefined,runCLI:async args=>{
    if(args.includes('show'))return {profile:'fixture',appId};
    if(args.includes('--no-wait'))return {verification_url:'https://accounts.feishu.cn/oauth/v1/device/verify',device_code:'synthetic',expires_in:60};
    if(args.includes('--device-code'))return {ok:true};
    if(args.includes('--verify'))return {appId,identity:'user',verified:true,identities:{user:{available:true,openId:owner,userName:'同名',scope:PERSONAL_MESSAGE_SCOPES.join(' ')}}};
    if(args.includes('+chat-list'))return envelope({chats:[],has_more:false});
    if(args.includes('+messages-search')){
      const row={chat_id:chat,message_id:message,chat_type:'p2p',msg_type:'text',sender:{id:'ou_peer',id_type:'open_id',sender_type:'user'},
        content,create_time:String(timestamp),...(edited && {edited:true,update_time:String(timestamp)}),deleted};
      if(gate){entered?.();await gate;}
      return envelope({messages:[row],has_more:false});
    }
    if(args.includes('chats')&&args.includes('get'))return envelope({chat_mode:'p2p'});
    throw Error('未知的合成连接请求');
  }});
  const start=()=>startServer({dataDir,host:'127.0.0.1',port:0,demo:true,token:'fixture'},{personalProvider:provider});
  let server=await start();
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const head={authorization:'Bearer fixture','content-type':'application/json'};
  const settings='/api/v1/feishu/personal/edit-history';
  const get=(path:string)=>fetch(server.url+path,{headers:head});
  const configure=(state:{accountKey:string;revision:number},enabled:boolean)=>fetch(server.url+settings,{headers:head,method:'PUT',
    body:JSON.stringify({accountKey:state.accountKey,revision:state.revision,enabled})});
  const current=async()=>{const r=await get(settings);assert.equal(r.status,200);return r.json();};
  const connected=()=>t.waitFor(()=>assert.equal(server.personal.status().status,'connected'));
  const source='feishu:'+appId+':'+owner, thread='feishu:message:'+JSON.stringify([chat,message]);
  const id=inboxItemId(source,thread),path='/api/v1/inbox/'+id+'/edit-history';
  assert.equal((await fetch(server.url+settings)).status,401);
  assert.equal((await get(settings)).status,409);
  server.personal.authorize();await connected();
  await server.personal.enable(true);await server.personal.collect();
  const off=await current();assert.equal(off.enabled,false);assert.equal(off.source,source);
  assert.equal((await get(path)).status,403);
  assert.equal((await configure(off,true)).status,200);
  assert.equal((await configure(off,false)).status,409);
  const collect=async(value:string)=>{edited=true;timestamp=Date.now();content=value;await server.personal.collect();};
  await collect('启用后第一次看到');assert.deepEqual((await (await get(path)).json()).versions,[]);
  await collect('已修改');await server.personal.collect();
  assert.deepEqual(await (await get(path)).json(),{versions:[{text:'启用后第一次看到',replacedAt:new Date(timestamp).toISOString()}],truncated:false});
  function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
  const ready=deferred(),release=deferred();
  gate=release.promise;entered=ready.resolve;const pending=collect('等待期间旧回包');await ready.promise;
  try{
    assert.equal((await configure(await current(),false)).status,200);
    assert.equal((await configure(await current(),true)).status,200);
  }finally {gate=undefined;release.resolve();}
  await pending;
  await collect('新代次首次');assert.deepEqual((await (await get(path)).json()).versions,[]);
  await collect('新代次再次');const kept=await (await get(path)).json();assert.equal(kept.versions[0].text,'新代次首次');
  await server.personal.enable(false);await server.close();server=await start();await connected();
  assert.deepEqual(await (await get(path)).json(),kept);
  await server.app.plugins.setEnabled('feishu-edit-history',false);assert.equal((await get(path)).status,503);
  await server.app.plugins.setEnabled('feishu-edit-history',true);
  await server.personal.enable(true);await server.personal.collect();
  deleted=true;await server.personal.collect();assert.equal((await get(path)).status,404);
  const original=await current();owner='ou_second';server.personal.authorize();await connected();
  assert.equal((await get(path)).status,404);assert.equal((await configure(original,true)).status,409);
  assert.notEqual((await current()).accountKey,original.accountKey);assert.equal((await current()).enabled,false);
});

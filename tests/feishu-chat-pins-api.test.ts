import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';
import type {PersonalProvider} from '../plugins/feishu-personal.ts';
import {createPersonalPins} from '../plugins/feishu-personal-pins.ts';
import {PERSONAL_MESSAGE_SCOPES} from '../plugins/feishu-personal.ts';
import {inboxItemId} from '../packages/core/src/inbox.ts';

test('个人原消息置顶按同一聊天和账号分页、查看原件，写入并发/重启保持单次',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'chat-pins-api-'));
  const account={appId:'cli_fixture',profile:'fixture',openId:'ou_owner',name:'测试账号'};
  const provider:PersonalProvider={
    application:async()=>account,begin:async()=>({url:'https://accounts.feishu.cn/oauth/v1/device/verify',code:'fake',expiresIn:120}),
    complete:async()=>({...account}),verify:async()=>({...account}),collect:async()=>[],
  };
  let writes=0,uncertain=false,revoked=false,entered:(()=>void)|undefined,gate:Promise<void>|undefined;
  const source='feishu:'+account.appId+':'+account.openId;
  const chat='oc_group',otherChat='oc_away',message='om_source',remote='om_remote';
  const pins=createPersonalPins(async args=>{
    if(args.includes('--verify'))return {appId:account.appId,identity:'user',verified:true,identities:{user:{available:true,openId:account.openId,scope:PERSONAL_MESSAGE_SCOPES.join(' ')}}};
    const envelope=(data:object)=>({code:0,data});
    if(args.includes('list')){
      entered?.();await gate;
      return envelope({items:[{message_id:args.includes('--page-token')?remote:message,chat_id:args[args.indexOf('--chat-id')+1]}],
        has_more:!args.includes('--page-token'),page_token:'synthetic-page-2'});
    }
    if(args.includes('GET')){
      const id=args[args.indexOf('GET')+1]!.split('/').at(-1);
      return envelope({items:[{message_id:id,chat_id:id==='om_foreign'?otherChat:chat,deleted:revoked,
        thread_id:'omt_fixture',msg_type:'text',body:{content:JSON.stringify({text:'原消息正文'})}}]});
    }
    if(args.includes('create')||args.includes('delete')){
      writes++;if(uncertain)throw Error('synthetic lost receipt');
      return envelope(args.includes('create')?{pin:{chat_id:chat,message_id:message}}:{});
    }
    throw Error('unexpected fixture command');
  });
  const start=()=>startServer({host:'127.0.0.1',port:0,dataDir,demo:true,token:'fixture'},{personalProvider:provider,personalPins:pins});
  let server=await start();
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const head={authorization:'Bearer fixture','content-type':'application/json'};
  const get=(path:string)=>fetch(server.url+path,{headers:head});
  const row=(chatId:string,id:string)=>({last:id,title:'合成收件',text:'采集正文',thread:'feishu:message:'+JSON.stringify([chatId,id]),origin:{connector:'飞书',kind:'direct' as const,chatId}});
  const route=(chatId:string,id:string)=>'/api/v1/inbox/'+inboxItemId(source,row(chatId,id).thread)+'/pins';
  const path=route(chat,message),other=route(otherChat,'om_other');
  const post=(body:object)=>fetch(server.url+path,{method:'POST',headers:head,body:JSON.stringify(body)});
  assert.equal((await fetch(server.url+path)).status,401);
  assert.equal((await get(path)).status,409);
  server.personal.authorize();await t.waitFor(()=>assert.equal(server.personal.status().status,'connected'));
  await server.app.inbox.ingest(source,[row(chat,message),row(otherChat,'om_other')]);
  const first=await (await get(path)).json(),accountKey=first.accountKey;
  assert.equal(typeof first.pins[0].originalRef,'string');assert.equal(first.pins[0].textTruncated,false);assert.equal(typeof accountKey,'string');assert.equal(first.pins[0].text,'采集正文');assert.ok(first.pins[0].inboxId);
  assert.equal((await (await get(path+'?cursor='+first.nextCursor)).json()).pins[0].messageId,remote);
  assert.equal((await get(other+'?cursor='+first.nextCursor)).status,400);
  assert.equal((await get(path+'?cursor=junk')).status,400);
  const original=path+'/'+remote+'/original?accountKey='+accountKey;
  assert.deepEqual(await(await get(original)).json(),{messageId:remote,chatId:chat,deleted:false,text:'原消息正文',threadId:'omt_fixture'});
  revoked=true;assert.deepEqual(await(await get(original)).json(),{messageId:remote,chatId:chat,deleted:true});revoked=false;
  assert.equal((await get(path+'/om_foreign/original?accountKey='+accountKey)).status,404);
  const body={action:'pin',messageId:message,accountKey,requestId:'choice-1'};
  for(const response of await Promise.all([post(body),post(body)])){
    assert.deepEqual(await response.json(),{action:'pin',confirmed:true,messageId:message});
  }
  assert.equal(writes,1);
  assert.equal((await post({...body,action:'unpin'})).status,409);
  assert.equal((await post({...body,requestId:'wrong-chat',action:'unpin',messageId:'om_foreign'})).status,409);
  assert.equal(writes,1);
  uncertain=true;
  const unpin={...body,requestId:'choice-2',action:'unpin',messageId:remote};
  assert.equal((await(await post(unpin)).json()).code,'PIN_DELIVERY_UNKNOWN');assert.equal(writes,2);
  await server.close();server=await start();await t.waitFor(()=>assert.equal(server.personal.status().status,'connected'));
  assert.equal((await(await post(unpin)).json()).code,'PIN_DELIVERY_UNKNOWN');assert.equal(writes,2);
  const beforeToggle=await (await get(path)).json();
  let release!:()=>void;
  gate=new Promise<void>(r=>{release=r;});
  const ready=new Promise<void>(r=>{entered=r;});
  const reading=get(path);await ready;
  try{await server.app.plugins.setEnabled('feishu-chat-pins',false);await server.app.plugins.setEnabled('feishu-chat-pins',true);}
  finally {release();}
  assert.equal((await reading).status,409);
  assert.equal((await get(path+'?cursor='+beforeToggle.nextCursor)).status,400);
  account.openId='ou_other';server.personal.authorize();await t.waitFor(()=>assert.equal(server.personal.status().status,'connected'));
  assert.equal((await get(path)).status,404);assert.equal((await post(body)).status,404);
});

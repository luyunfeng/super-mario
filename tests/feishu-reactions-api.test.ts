import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';
import type {PersonalProvider} from '../plugins/feishu-personal.ts';
import type {createPersonalReactions} from '../plugins/feishu-personal-reactions.ts';
import {inboxItemId} from '../packages/core/src/inbox.ts';

test('个人飞书原消息表情分页与账号隔离，主人写操作持久去重、撤回后拒绝继续',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'feishu-reactions-api-'));
  const actor={profile:'fixture',appId:'cli_fixture',openId:'ou_one',name:'合成账号'};
  const personalProvider:PersonalProvider={
    application:async()=>actor,begin:async()=>({url:'https://accounts.feishu.cn/oauth/v1/device/verify',code:'fake',expiresIn:120}),
    complete:async()=>({...actor}),verify:async()=>({...actor}),collect:async()=>[],
  };
  const chatId='oc_fixture',message='om_first',other='om_other',source='feishu:'+actor.appId+':'+actor.openId;
  let writes=0,reads=0,fail=false,before:(()=>void)|undefined,gate:Promise<void>|undefined;
  const platform:ReturnType<typeof createPersonalReactions>={
    async list(account,chat,id,_signal,cursor){
      assert.equal(chat,chatId);reads++;
      return {items:[{emoji:'OK',operatorId:account.openId,operatorType:'user' as const,reactionId:'reaction_fixture',mine:true}],
        ...(cursor===undefined && {nextCursor:'page-for-'+id})};
    },
    async write(account,chat,id,emoji,remove,_signal,guard){
      assert.equal(chat,chatId);assert.ok([message,other].includes(id));assert.equal(account.openId,actor.openId);
      before?.();await gate;await guard();writes++;
      if(fail) throw Error('合成回执失败');
      return {confirmed:true,changed:true};
    },
  };
  const start=()=>startServer({host:'127.0.0.1',port:0,dataDir,demo:true,token:'fixture'},{personalProvider,personalReactions:platform});
  let server=await start();
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const headers={authorization:'Bearer fixture','content-type':'application/json'};
  const get=(path:string)=>fetch(server.url+path,{headers});
  const post=(path:string,data:object)=>fetch(server.url+path,{method:'POST',headers,body:JSON.stringify(data)});
  const row=(id:string)=>({thread:'feishu:message:'+JSON.stringify([chatId,id]),last:id,title:'合成收件',text:'合成正文',origin:{chatId,connector:'飞书',kind:'direct' as const}});
  const route=(id:string)=>'/api/v1/inbox/'+inboxItemId(source,row(id).thread)+'/reactions';
  const path=route(message);
  assert.equal((await fetch(server.url+path)).status,401);
  assert.equal((await get(path)).status,409);
  server.personal.authorize();await t.waitFor(()=>assert.equal(server.personal.status().status,'connected'));
  await server.app.inbox.ingest(source,[row(message),row(other)]);
  const page=await(await get(path)).json(),accountKey=page.accountKey;
  assert.equal(page.items[0].mine,true);assert.equal(page.items[0].emoji,'OK');
  assert.equal((await get(path+'?cursor='+page.nextCursor)).status,200);
  assert.equal((await get(route(other)+'?cursor='+page.nextCursor)).status,400);assert.equal(reads,2);
  const add={accountKey,action:'add',emoji:'OK',requestId:'confirm1'};
  assert.equal((await post(path,{...add,operatorId:'ou_peer'})).status,400);
  for(const res of await Promise.all([post(path,add),post(path,add)])){
    assert.equal(res.status,200);assert.deepEqual(await res.json(),{confirmed:true,action:'add',emoji:'OK'});
  }
  assert.equal(writes,1);
  assert.equal((await post(path,{...add,emoji:'SMILE'})).status,409);
  const remove={...add,action:'remove',requestId:'confirm2'};fail=true;
  const uncertain=await post(path,remove);assert.equal(uncertain.status,502);assert.equal((await uncertain.json()).code,'REACTION_DELIVERY_UNKNOWN');assert.equal(writes,2);
  await server.close();server=await start();await t.waitFor(()=>assert.equal(server.personal.status().status,'connected'));
  assert.equal((await post(path,remove)).status,502);assert.equal(writes,2);fail=false;
  let release!:()=>void;gate=new Promise<void>(r=>{release=r;});
  const ready=new Promise<void>(r=>{before=r;});
  const pending=post(path,{...remove,requestId:'confirm3'});await ready;
  try{
    await server.app.plugins.setEnabled('feishu-message-reactions',false);
    assert.equal((await get(path)).status,503);
    await server.app.plugins.setEnabled('feishu-message-reactions',true);
  }finally{release();}
  assert.equal((await(await pending).json()).code,'REACTION_NOT_SENT');assert.equal(writes,2);
  server.app.waitingReplies.observeSource(source,[{source,chatId,messageId:message,senderId:'ou_peer',senderIdType:'open_id',createdAt:new Date().toISOString(),deleted:true}]);
  assert.equal((await get(path)).status,404);
  actor.openId='ou_new';server.personal.authorize();await t.waitFor(()=>assert.equal(server.personal.status().status,'connected'));
  assert.equal((await get(route(other))).status,404);
});

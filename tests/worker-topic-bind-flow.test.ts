import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { startServer } from '../apps/server/src/index.ts';
import { createFeishuIntegration } from '../plugins/feishu.ts';
import type { Run, Todo } from '../packages/protocol/src/index.ts';

test('执行会话凭证只可为当前负责的待办首次绑定主人实际发言的飞书话题', {timeout:30000}, async t => {
  const dir = await mkdtemp(join(tmpdir(),'worker-topic-binding-'));
  const token = 'local-web-token', machineId = 'local-machine', sessionId = 'synthetic-session';
  const workerKey = randomBytes(32).toString('base64url');
  const keyHash = createHash('sha256').update(workerKey).digest('hex');
  const dispatchers = new Map<string,EventDispatcher>();
  const sent: {path:string;text:string}[] = [];
  const host = await startServer({dataDir:dir,host:'127.0.0.1',port:0,token,demo:true},{
    botFactory:opts=>createFeishuIntegration({...opts,wsFactory:options=>({async start(input) {
      dispatchers.set(opts.appId,input.eventDispatcher); options.onReady?.();
    },close(){},getConnectionStatus:()=>({state:'connected',reconnectAttempts:0})}),
    fetch:async(url,init)=>{
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/tenant_access_token/internal')) return Response.json({code:0,tenant_access_token:'fixture',expire:3600});
      if (path.endsWith('/bot/v3/info')) return Response.json({code:0,bot:{open_id:'ou_bot'}});
      if (path.endsWith('/reactions')) return Response.json({code:0,data:{reaction_id:'synthetic'}});
      assert.match(path,/\/im\/v1\/messages/);
      const payload = JSON.parse(String(init?.body));
      sent.push({path,text:String(payload.content)});
      return Response.json({code:0,data:{message_id:'om_response_'+sent.length}});
    }}),
  });
  const src='fixture-worker-result', instanceId='fixture-worker-instance';
  let finished=false, mismatch=false;
  const mismatchedKey=randomBytes(32).toString('base64url');
  const mismatchedSession='another-synthetic-session';
  const node=startAgentNode({url:host.url,token,dataDir:join(dir,'node'),machineId,agentInstanceId:instanceId,name:'合成执行机',
    executors:[{id:'codex',kind:'cli',name:'本地替身',description:'合成凭证与回执',machineId,mode:'real',available:true,
      defaultCwd:dir,nativeResultSources:[src]}],
    handlers:{'executor.start':async()=>mismatch
      ? {sessionId:mismatchedSession,agentInstanceId:'different-instance',workerToolKeyHash:createHash('sha256').update(mismatchedKey).digest('hex')}
      : {sessionId,agentInstanceId:instanceId,workerToolKeyHash:keyHash},
      'executor.result':async()=>({state:finished?'completed':'running',source:src,text:finished?'合成完成':'',nativeSessionId:'fixture-native'})}});
  t.after(async()=>{try {await node.close(); await host.close();} finally {await rm(dir,{recursive:true,force:true});}});
  const request=(path:string,key:string,method:string,body?:object)=>fetch(host.url+'/api/v1/'+path,{method,
    headers:{authorization:'Bearer '+key,'content-type':'application/json'},...(body && {body:JSON.stringify(body)})});
  async function web<T>(path:string,method='GET',body?:object) {
    const res=await request(path,token,method,body); assert.ok(res.ok,path+' '+res.status); return res.json() as Promise<T>;
  }
  const bot=await host.bots.create({name:'合成机器人',appId:'cli_5555555555555555',appSecret:'fixture',scope:{kind:'global'}});
  let seq=0;
  async function event(id:string,text:string,thread?:string,owner=true,pair=false,appId=bot.appId,chatId='oc_group') {
    const dispatcher = dispatchers.get(appId); assert.ok(dispatcher);
    await dispatcher.invoke({schema:'2.0',header:{event_type:'im.message.receive_v1',event_id:'evt_'+(++seq)},event:{
      sender:{sender_type:'user',sender_id:{open_id:owner?'ou_owner':'ou_other'}},message:{
        message_id:id,chat_id:pair?'oc_private':chatId,chat_type:pair?'p2p':'group',thread_id:thread,
        root_id:thread?'om_root_'+thread:undefined,parent_id:thread?'om_root_'+thread:undefined,
        message_type:'text',content:JSON.stringify({text})}
    }},{needCheck:false});
  }
  await event('om_pair',bot.pairingCode!,undefined,true,true);
  await t.waitFor(()=>assert.ok(host.bots.list().some(row=>row.paired)));
  await event('om_enroll','/topics');
  await event('om_guest','群友发言','omt_guest',false);
  for (const id of ['omt_allowed','omt_second','omt_shared','omt_private_other']) {
    await event('om_owner_'+id,'主人已核对这个话题',id);
    await t.waitFor(()=>assert.ok(sent.some(row=>row.path.endsWith('/om_owner_'+id+'/reply'))));
  }
  await event('om_other_enroll','/topics',undefined,true,false,bot.appId,'oc_other');
  await event('om_cross_pair','另一群里的主人发言','omt_cross',true,false,bot.appId,'oc_other');
  await t.waitFor(()=>assert.ok(sent.some(row=>row.path.endsWith('/om_cross_pair/reply'))));
  const secondBot=await host.bots.create({name:'另一合成机器人',appId:'cli_6666666666666666',appSecret:'fixture',scope:{kind:'global'}});
  await event('om_pair_second',secondBot.pairingCode!,undefined,true,true,secondBot.appId);
  await t.waitFor(()=>assert.ok(host.bots.list().find(row=>row.id===secondBot.id)?.paired));
  await event('om_enroll_second','/topics',undefined,true,false,secondBot.appId);
  await event('om_second_shared','第二个机器人也收到主人的发言','omt_shared',true,false,secondBot.appId);
  await t.waitFor(()=>assert.ok(sent.some(row=>row.path.endsWith('/om_second_shared/reply'))));
  await t.waitFor(()=>assert.ok(host.machines.list().some(row=>row.id===machineId && row.online)));
  const project = await web<{id:string}>('projects','POST',{name:'合成项目'});
  const todo=await web<Todo>('todos','POST',{title:'现有待办'}), other=await web<Todo>('todos','POST',{title:'其他项目待办',projectId:project.id});
  const launch=()=>web<Run>('runs','POST',{executorId:machineId+'/codex',prompt:'合成任务。仅核对明确列出的群话题：oc_group / omt_allowed、oc_group / omt_second、oc_group / omt_shared、oc_group / omt_guest、oc_group / omt_unseen、oc_group / omt_cross、oc_other / omt_elsewhere。',executionMode:'task',todoId:todo.id,
    doneWhen:'合成记录就绪',expectMinutes:1,cwd:dir});
  const run=await launch();
  const current=async()=>(await web<{runs:Run[]}>('state')).runs.find(row=>row.id===run.id);
  await t.waitFor(async()=>assert.equal((await current())?.sessionId,sessionId));
  const args={channel:'feishu',chatId:'oc_group',threadId:'omt_allowed',title:'主人已确认的话题'};
  const tool='worker-tools/todo-bind-thread';
  const call=(key:string,arguments_:object=args,session=sessionId,method='POST')=>request(tool,key,method,{sessionId:session,arguments:arguments_});
  async function denied(response:Promise<Response>, status:number) {
    const res=await response; assert.equal(res.status,status);
  }
  const baseline=sent.length;
  await denied(call(workerKey),403); // A task-scoped dispatch alone does not designate its responsible session.
  await web('todos/'+todo.id,'PATCH',{responsibleRunId:run.id});
  const thread=(id:string)=>web<{thread:null|{threadId:string;title?:string;version:string}}>('todos/'+id+'/thread');
  await denied(call(token),401); await denied(call(randomBytes(32).toString('base64url')),401);
  await denied(call(workerKey,args,'other-session'),401);
  await denied(call(workerKey,{...args,todoId:other.id}),403);
  await denied(call(workerKey,{...args,threadId:'omt_guest'}),409); await denied(call(workerKey,{...args,threadId:'omt_unseen'}),409);
  await denied(call(workerKey,{...args,threadId:'omt_shared'}),409);
  await denied(call(workerKey,{...args,threadId:'omt_private_other'}),403);
  await denied(call(workerKey,{...args,chatId:'oc_other',threadId:'omt_cross'}),403);
  assert.equal((await thread(todo.id)).thread,null);
  const response=await call(workerKey);
  assert.ok(response.ok,'合法工作者绑定失败 HTTP '+response.status);
  const initial=(await thread(todo.id)).thread;
  assert.ok(initial);assert.deepEqual([initial.threadId,initial.title],[args.threadId,args.title]);
  const newTitle='同一话题的更新标题';
  const update=await call(workerKey,{...args,title:newTitle});
  assert.equal(update.status,200);
  const binding=(await thread(todo.id)).thread;
  assert.deepEqual(binding,{...initial,title:newTitle});
  await denied(call(workerKey,{...args,threadId:'omt_second',todoId:todo.id}),409);
  await denied(call(workerKey,args,sessionId,'DELETE'),405);
  await denied(request('todos/'+todo.id+'/thread',workerKey,'DELETE',{expectedVersion:binding.version}),401);
  assert.deepEqual((await thread(todo.id)).thread,binding); assert.equal((await thread(other.id)).thread,null);
  assert.equal(sent.length,baseline);
  finished=true;await host.app.monitor.poll();
  await t.waitFor(async()=>assert.equal((await current())?.status,'completed'));
  await web('todos/'+todo.id+'/thread','DELETE',{expectedVersion:binding.version});
  await denied(call(workerKey),401);
  assert.equal((await thread(todo.id)).thread,null);
  finished=false; mismatch=true;
  const second=await launch();
  const secondState=async()=>(await web<{runs:Run[]}>('state')).runs.find(row=>row.id===second.id);
  await t.waitFor(async()=>{const row=await secondState();assert.ok(row && ['running','failed','unknown'].includes(row.status) &&
    (row.sessionId===mismatchedSession || row.status!=='running'));});
  if ((await secondState())?.status==='running') await web('todos/'+todo.id,'PATCH',{responsibleRunId:second.id});
  await denied(call(mismatchedKey,args,mismatchedSession),401);
  assert.equal((await thread(todo.id)).thread,null);
});

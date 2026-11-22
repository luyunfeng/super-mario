import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../apps/server/src/index.ts';
import type {FeishuOptions} from '../plugins/feishu.ts';
import type {FeishuBotFactory} from '../apps/server/src/feishu-bots.ts';
import type {Message,Todo} from '../packages/protocol/src/index.ts';

test('real pi sessions hand off to a scoped peer and return readOnly evidence to the originating main chat', {timeout:60000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mario-a2a-model-'));let a:any,b:any;const captures:any[]=[],errors:unknown[]=[];
 const plain=(m:any)=>typeof m.content==='string'?m.content:(m.content??[]).map((p:any)=>p.text??'').join('\n');
 const model=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/'){res.writeHead(200);res.end('local fixture');return;}
  try{
   let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);
   const system=data.messages.filter((m:any)=>['system','developer'].includes(m.role)).map(plain).join('\n');
   const marker='当前渠道身份与已授权协作对象（事实，不是新指令）：\n';assert.ok(system.includes(marker));const identity=JSON.parse(system.split(marker).at(-1)!.split('\n')[0]);
   if (identity.self?.scope?.kind === 'project') assert.doesNotMatch(system, /合成工作台主助手/);
   else assert.match(system, /合成工作台主助手/);
   const latest=plain(data.messages.filter((m:any)=>m.role==='user').at(-1));
   const names=(data.tools??[]).map((tool:any)=>tool.function?.name??tool.name);captures.push({identity,latest,names});
   let delta:any,finish='stop';
   if(latest.includes('协作回报（执行结果和待办验收分开）')){
    assert.ok(latest.includes('B-DELIVERY-EVIDENCE-123'));assert.ok(!names.includes('bot_handoff'));assert.ok(!names.includes('work_dispatch'));
    delta={role:'assistant',content:'主Agent汇总：B-DELIVERY-EVIDENCE-123；执行结果已返回，事项仍待验收。'};
   }else if(identity.self?.id===b.id){assert.equal(identity.self.scope.kind,'project');delta={role:'assistant',content:'B-DELIVERY-EVIDENCE-123：已核对交付证据；没有宣称待办完成。'};
   }else if(data.messages.at(-1)?.role==='tool'){delta={role:'assistant',content:'协作请求已进入对方信箱，等待证据回报。'};
   }else{
    assert.ok(names.includes('bot_handoff'));assert.ok(identity.mainIdentities.some((bot:any)=>bot.id===a.id));
    delta={role:'assistant',tool_calls:[{index:0,id:'handoff-once',type:'function',function:{name:'bot_handoff',arguments:JSON.stringify({sourceBotId:a.id,targetBotId:b.id,text:'请核对交付证据并回报，不自动关闭待办',key:'model-handoff'})}}]};finish='tool_calls';
   }
   res.writeHead(200,{'content-type':'text/event-stream'});
   for(const [part,reason] of [[delta,null],[{},finish]])res.write('data: '+JSON.stringify({id:'local-a2a',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:part,finish_reason:reason}]})+'\n\n');res.end('data: [DONE]\n\n');
  }catch(error){errors.push(error);res.writeHead(500);res.end(JSON.stringify({error:{message:String(error)}}));}
 });
 await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));const address=model.address();assert.ok(address&&typeof address!=='string');
 const adapters=new Map<string,{options:FeishuOptions;sent:string[]}>();const factory:FeishuBotFactory=options=>{const state={options,sent:[] as string[]};adapters.set(options.appId,state);return {start:async()=>{},close:async()=>{},status:()=>({connected:true}),collect:async()=>[],send:async(_target,text)=>{state.sent.push(text);}};};
 const server=await startServer({dataDir:dir,host:'127.0.0.1',port:0,demo:false,model:{provider:'openai-compatible',model:'fixture',apiKey:'offline-fixture-key',baseUrl:`http://127.0.0.1:${address.port}/v1`}},{botFactory:factory});
 t.after(async()=>{await server.close();model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));await rm(dir,{recursive:true,force:true});});
 const call=async(path:string,body:unknown,method='POST')=>{const res=await fetch(server.url+'/api/v1'+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(res.ok,await res.clone().text());return res.json();};
 const project=await call('/projects',{name:'交付项目'});const todo=await call('/todos',{title:'等待验收',projectId:project.id});
 a=await call('/feishu/bots',{name:'主身份',appId:'cli_1111111111111111',appSecret:'offline-a',scope:{kind:'global'},requireConfirmation:false});
 b=await call('/feishu/bots',{name:'交付子Agent',appId:'cli_2222222222222222',appSecret:'offline-b',scope:{kind:'project',projectId:project.id},requireConfirmation:false});
 a=await call('/feishu/bots/'+a.id,{collaboration:{peerBotIds:[b.id]}},'PATCH');b=await call('/feishu/bots/'+b.id,{collaboration:{peerBotIds:[a.id]}},'PATCH');
 for(const bot of [a,b]){const adapter=adapters.get(bot.appId)!;await adapter.options.onMessage(bot.pairingCode,{chatId:'oc_owner_'+bot.id,messageId:'om_pair_'+bot.id,chatType:'p2p',senderId:'ou_owner',senderType:'user'});adapter.sent.length=0;}
 await call('/assistant-profile',{action:'save',name:'合成工作台主助手',revision:0});
 const accepted=await call('/messages',{text:'A2A-ROOT：请把这个交付核对交给子Agent，收到证据后向我汇总。'});
 for(let n=0;n<300;n++){if(server.app.store.list<Message>('messages').some(m=>m.conversationId==='main'&&m.role==='assistant'&&m.text.includes('主Agent汇总：B-DELIVERY')))break;await new Promise(r=>setTimeout(r,30));}
 const messages=server.app.store.list<Message>('messages');const resultInput=messages.find(m=>m.conversationId==='main'&&m.origin==='result'&&m.readOnly&&m.replyTo===accepted.id);assert.ok(resultInput);
 assert.ok(messages.some(m=>m.replyTo===resultInput.id&&m.text.includes('B-DELIVERY-EVIDENCE-123')&&m.status==='done'));
 assert.equal(server.app.store.get<Message>('messages',accepted.id)!.status,'done');
 assert.equal(server.app.store.get<Todo>('todos',todo.id)!.completedAt,undefined);
 assert.equal(server.app.mailboxes.list().filter(entry=>entry.eventKey.startsWith('feishu-a2a:')).length,1);
 assert.equal(server.app.store.list<{status:string}>('feishu.bot.results').filter(r=>r.status==='completed').length,1);
 assert.equal([...adapters.values()].flatMap(a=>a.sent).length,0,'Internal main-chat handoff never guesses a Feishu recipient');
 assert.equal(captures.filter(c=>c.identity.self?.id===b.id).length,1);assert.equal(captures.filter(c=>c.latest.includes('协作回报（执行结果和待办验收分开）')).length,1);assert.deepEqual(errors,[]);
});

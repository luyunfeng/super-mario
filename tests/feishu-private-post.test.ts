import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {EventDispatcher} from '@larksuiteoapi/node-sdk';
import {startServer} from '../apps/server/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';
import {createFeishuIntegration} from '../plugins/feishu.ts';

test('主人富文本在当前独立对话传入正文和核验原图，区分命令并在撤回后收回原图权限',async t=>{
  let dispatcher!:EventDispatcher,seq=0;
  const unexpectedRequests:string[]=[],reads:string[]=[];
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCc8AAAAASUVORK5CYII=';
  const realFetch=globalThis.fetch;
  const dir=await mkdtemp(join(tmpdir(),'mario-private-post-'));
  type ModelCall={messages:{role:string;content:unknown}[]};
  const modelCalls:ModelCall[]=[];
  const baseUrl='http://127.0.0.1:1/post-fixture';
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const req=new Request(input,init);
    assert.equal(req.url,baseUrl+'/chat/completions');
    modelCalls.push(await req.json());
    const frames=[{role:'assistant',content:'合成协议答复'},{}].map((delta,i)=>'data: '+JSON.stringify({
      id:'post-fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason:i?'stop':null}]
    }));
    return new Response([...frames,'data: [DONE]',''].join('\n\n'),{headers:{'content-type':'text/event-stream'}});
  });
  const host=await startServer({host:'127.0.0.1',port:0,dataDir:dir,token:'fixture',demo:false,
    model:{provider:'openai-compatible',model:'fixture',apiKey:'fixture',baseUrl}},{
    botFactory:options=>createFeishuIntegration({...options,
      fetch:async(input,init)=>{
        const url=new URL(String(input));
        if(url.pathname.endsWith('/tenant_access_token/internal')) return Response.json({code:0,tenant_access_token:'fixture',expire:3600});
        if(url.pathname.endsWith('/bot/v3/info')) return Response.json({code:0,bot:{open_id:'ou_bot'}});
        if((init?.method??'GET')==='GET' && url.hostname==='open.feishu.cn' && url.pathname.includes('/messages/')){
          const path=url.pathname.split('/messages/')[1];
          reads.push(path);
          assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture');
          assert.equal(init?.redirect,'error');
          if(path==='om_post'){
            assert.equal(url.searchParams.get('user_id_type'),'open_id');
            return Response.json({code:0,data:{items:[{message_id:'om_post',chat_id:'oc_private',msg_type:'post',
              sender:{id_type:'open_id',sender_type:'user',id:'ou_owner'},
              body:{content:JSON.stringify(content).replace('img_private_key_fixture','img_verified_fixture')}
            }]}});
          }
          if(path==='om_post/resources/img_verified_fixture'){
            assert.equal(url.searchParams.get('type'),'image');
            return new Response(Buffer.from(png,'base64'),{headers:{'content-type':'image/png'}});
          }
        }
        if(url.hostname!=='open.feishu.cn' || !['POST','PATCH','PUT'].includes(init?.method??'GET') || url.pathname.includes('/resources/')) {
          unexpectedRequests.push(url.pathname);
          return Response.json({code:999},{status:404});
        }
        return Response.json({code:0,data:{message_id:'om_out_'+(++seq)}});
      },
      wsFactory:opts=>({async start(spec){dispatcher=spec.eventDispatcher;opts.onReady?.();},close(){},
        getConnectionStatus:()=>({state:'connected',reconnectAttempts:0})})
    })
  });
  t.after(async()=>{try{await host.close();}finally{await rm(dir,{recursive:true,force:true});}});
  const bot=await host.bots.create({name:'合成私聊助手',appId:'cli_7555555555555555',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false});
  const emit=(id:string,body:string|object,sender='ou_owner')=>dispatcher.invoke({schema:'2.0',
    header:{event_type:'im.message.receive_v1',event_id:'evt_'+(++seq)},event:{
      sender:{sender_type:'user',sender_id:{open_id:sender}},message:{chat_id:'oc_private',chat_type:'p2p',message_id:id,
        message_type:typeof body==='string'?'text':'post',
        content:JSON.stringify(typeof body==='string'?{text:body}:body),
        mentions:[{key:'@_user_1',id:{open_id:'ou_peer'},name:'合成同事'}]}}},{needCheck:false});
  const users=()=>host.app.store.list<Message>('messages').filter(m=>m.role==='user');
  const findInput=(part:string)=>t.waitFor(()=>{const row=users().find(m=>m.text.includes(part));assert.ok(row);return row;},{timeout:8000});
  const post=(text:string)=>({zh_cn:{title:'',content:[[{tag:'text',text}]]}});
  const untrustedImagePost=(title:string)=>({title,content:[[{tag:'img',image_key:'img_untrusted'}]]});
  await emit('om_unpaired',untrustedImagePost('未配对合成发言'));
  await emit('om_pair',bot.pairingCode!);
  await t.waitFor(()=>assert.ok(host.bots.list()[0]?.paired));
  await emit('om_new','/new 开启本次合成讨论');
  const thread=await findInput('开启本次合成讨论');
  await emit('om_stranger',untrustedImagePost('非主人合成发言'),'ou_other');
  await emit('om_command',{content:[[{tag:'md',text:'/main'}]]});
  const content={zh_cn:{title:'合成设计稿',content:[
    [{tag:'text',text:'第一段请核对'},{tag:'at',user_id:'@_user_1',user_name:'合成同事'}],
    [{tag:'text',text:'第二段附'},{tag:'a',text:'合成资料',href:'https://example.invalid/doc'}],
    [{tag:'img',image_key:'img_private_key_fixture'}]
  ]}};
  await emit('om_post',content);await emit('om_post',content);
  await emit('om_after','后续合成发言');
  assert.equal((await findInput('后续合成发言')).conversationId,thread.conversationId);
  const row=await findInput('合成设计稿');
  assert.equal(row.conversationId,thread.conversationId);
  assert.match(row.text,/\*\*合成设计稿\*\*\n第一段请核对/);
  assert.match(row.text,/@合成同事/);
  assert.match(row.text,/\n第二段附/);
  assert.ok(row.text.includes('合成资料') && row.text.includes('https://example.invalid/doc'));
  assert.ok(!row.text.includes('img_private_key_fixture') && !row.files?.length);
  assert.equal(row.images?.length,1);
  assert.deepEqual(reads,['om_post','om_post/resources/img_verified_fixture']);
  assert.equal(users().filter(m=>m.text.includes('合成设计稿')).length,1);
  assert.equal(users().find(m=>m.text==='[富文本]\n/main')?.conversationId,thread.conversationId);
  assert.ok(!users().some(m=>/未配对合成发言|非主人合成发言/.test(m.text)));
  await t.waitFor(()=>{
    const call=modelCalls.find(c=>JSON.stringify(c.messages.at(-1)?.content).includes('合成设计稿'));
    assert.ok(call);
    assert.ok(JSON.stringify(call.messages.at(-1)?.content).includes('data:image/png;base64,'+png));
    assert.match(JSON.stringify(call.messages.filter(m=>m.role==='system'||m.role==='developer')),/只看到链接不表示已读取目标页面/);
  },{timeout:8000});
  await emit('om_real_command',post('/main'));
  await emit('om_main_follow','已返回主线的合成发言');
  assert.notEqual((await findInput('已返回主线的合成发言')).conversationId,thread.conversationId);
  const imageUrl=host.url+'/api/v1/messages/'+row.id+'/images/0?conversationId='+encodeURIComponent(thread.conversationId);
  const image=()=>realFetch(imageUrl,{headers:{authorization:'Bearer fixture'}});
  const original=await image(); assert.equal(original.status,200);
  assert.equal(Buffer.from(await original.arrayBuffer()).toString('base64'),png);
  await dispatcher.invoke({schema:'2.0',header:{event_type:'im.message.recalled_v1',event_id:'evt_recall'},
    event:{chat_id:'oc_private',message_id:'om_post'}},{needCheck:false});
  assert.equal((await image()).status,404);
  assert.deepEqual(unexpectedRequests,[]);
});

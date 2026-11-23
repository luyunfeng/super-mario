import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {EventDispatcher} from '@larksuiteoapi/node-sdk';
import {startServer} from '../apps/server/src/index.ts';
import {createFeishuIntegration} from '../plugins/feishu.ts';
import type {Message} from '../packages/protocol/src/index.ts';

test('飞书配对主人在独立私聊发原图，核对同一条消息后读图一次；伪造发送人和转发图片不会进入模型', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-private-image-'));
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCc8AAAAASUVORK5CYII=';
  const requests:{messages:{role:string;content:unknown}[]}[]=[];
  const realFetch=fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const req=new Request(input,init);
    if(!req.url.startsWith('http://127.0.0.1:1/')) {assert.equal(new URL(req.url).hostname,'127.0.0.1');return realFetch(req);}
    requests.push(await req.json());
    return new Response(['data: '+JSON.stringify({id:'fixture',model:'fixture',object:'chat.completion.chunk',
      choices:[{index:0,delta:{role:'assistant',content:'合成图片已收到'},finish_reason:null}]}),'data: [DONE]',''].join('\n\n'),
      {headers:{'content-type':'text/event-stream'}});
  });
  let dispatcher!:EventDispatcher;
  const reads:string[]=[],outgoing:string[]=[];
  const host=await startServer({host:'127.0.0.1',port:0,dataDir:dir,token:'fixture',demo:false,
    model:{provider:'openai-compatible',model:'fixture',apiKey:'fixture',baseUrl:'http://127.0.0.1:1/offline'}},
    {botFactory:opts=>createFeishuIntegration({...opts,fetch:async(input,init)=>{
      const u=new URL(String(input)),path=u.pathname;
      if(path.includes('tenant_access_token'))return Response.json({code:0,tenant_access_token:'synthetic',expire:7200});
      if(path.endsWith('/bot/v3/info'))return Response.json({code:0,bot:{open_id:'ou_bot'}});
      if((init?.method??'GET')==='GET'){
        reads.push(path);
        assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic');
        assert.equal(init?.redirect,'error');
        if(path.includes('/resources/')) {
          assert.match(path,/^\/open-apis\/im\/v1\/messages\/om_(photo|project)\/resources\/img_verified$/);
          assert.equal(u.searchParams.get('type'),'image');return new Response(Buffer.from(png,'base64'));
        }
        const id=path.split('/').pop();
        assert.equal(u.searchParams.get('user_id_type'),'open_id');
        if(id==='om_transcript') return Response.json({code:0,data:{items:[
          {message_id:id,chat_id:'oc_owner',msg_type:'merge_forward',sender:{id_type:'open_id',sender_type:'user',id:'ou_owner'}},
          {message_id:'om_in',upper_message_id:id,msg_type:'text',body:{content:JSON.stringify({text:'合成讨论原话 /main'})}},
        ]}});
        return Response.json({code:0,data:{items:[{message_id:id,chat_id:'oc_owner',msg_type:'image',
          sender:{id_type:'open_id',sender_type:'user',id:id==='om_forged'?'ou_other':'ou_owner'},
          body:{content:JSON.stringify({image_key:'img_verified'})}}]}});
      }
      const body=JSON.parse(String(init?.body??'{}'));outgoing.push(body.content??'');
      return Response.json({code:0,data:{message_id:'om_out_'+outgoing.length}});
    },wsFactory:options=>({async start(input){dispatcher=input.eventDispatcher;options.onReady?.();},close(){},
      getConnectionStatus:()=>({state:'connected',reconnectAttempts:0})})})});
  t.after(async()=>{try{await host.close();}finally{await rm(dir,{recursive:true,force:true});}});
  const bot=await host.bots.create({name:'图片助手',appId:'cli_8888888888888888',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false});
  let seq=0;
  async function event(id:string,type:string,text='',sender='ou_owner',group=false,parentId?:string) {
    await dispatcher.invoke({schema:'2.0',header:{event_type:'im.message.receive_v1',event_id:'event_'+ ++seq},event:{
      sender:{sender_type:'user',sender_id:{open_id:sender}},message:{message_id:id,parent_id:parentId,chat_type:group?'group':'p2p',
        chat_id:group?'oc_group':'oc_owner',message_type:type,content:JSON.stringify(type==='text'?{text}:{image_key:'img_untrusted_event',text:'/ai 建办'})}
    }},{needCheck:false});
  }
  await event('om_before','image');await event('om_pair','text',bot.pairingCode!);
  await t.waitFor(()=>assert.ok(host.bots.list().some(row=>row.paired)));
  await event('om_new','text','/new');
  await t.waitFor(()=>assert.ok(host.app.store.list('feishu.private-threads').length));
  const thread=host.app.store.list<{threadId:string}>('feishu.private-threads')[0].threadId;
  await event('om_group','image','','ou_owner',true);await event('om_other','image','','ou_other');
  await event('om_forward','merge_forward');await event('om_forged','image');await event('om_photo','image');
  await event('om_photo','image');
  await t.waitFor(()=>assert.ok(host.app.store.list<Message>('messages').some(m=>m.images?.length)),{timeout:8000});
  const photos=host.app.store.list<Message>('messages').filter(m=>m.images?.length);
  assert.equal(photos.length,1);assert.ok(photos[0].conversationId?.includes(thread));assert.equal(photos[0].text,'[图片]');assert.equal(photos[0].readOnly,true);
  assert.deepEqual(reads.map(path=>path.split('/messages/')[1]),['om_forward','om_forged','om_photo','om_photo/resources/img_verified']);
  assert.ok(outgoing.some(text=>text.includes('无法读取这条转发的聊天记录')));
  assert.ok(outgoing.some(text=>text.includes('无法读取这张原图')));
  await t.waitFor(()=>assert.ok(requests.some(req=>JSON.stringify(req).includes('data:image/png;base64,'+png))),{timeout:8000});
  assert.equal(host.app.store.list('runs').length,0);
  assert.ok(!JSON.stringify(host.app.mailboxes.list()).includes(png));
  const readImage=async(message:Message)=>fetch(host.url+'/api/v1/messages/'+message.id+'/images/0?conversationId='+encodeURIComponent(message.conversationId!),
    {headers:{authorization:'Bearer fixture'}});
  assert.ok(host.bots.canReadPrivateImage(photos[0]));
  const original=await readImage(photos[0]);assert.equal(original.status,200);assert.equal(Buffer.from(await original.arrayBuffer()).toString('base64'),png);
  const history=await fetch(host.url+'/api/v1/feishu/bots/'+bot.id+'/threads/'+thread,{headers:{authorization:'Bearer fixture'}});
  assert.equal(history.status,200);
  const page=await history.json();
  assert.deepEqual(page.messages.find((m:Message)=>m.id===photos[0].id)?.images,photos[0].images);
  async function ask(id:string,text:string,parentId?:string){
    await event(id,'text',text,'ou_owner',false,parentId);
    return t.waitFor(()=>{
      const call=requests.find(req=>JSON.stringify(req.messages.at(-1)?.content).includes(text));
      const input=host.app.store.list<Message>('messages').find(m=>m.role==='user' && m.text===text);
      assert.ok(call && input && input.conversationId===photos[0].conversationId);
      return {call,input};
    },{timeout:8000});
  }
  const resourceReads=reads.length;
  const visual='data:image/png;base64,'+png;
  const quoted=await ask('om_ask_photo','请核对引用原图中的合成标记','om_photo');
  assert.ok(JSON.stringify(quoted.call.messages.at(-1)?.content).includes(visual),'应将图像放入包含本轮问题的用户消息');
  const route=host.app.store.get<{replyReference?:{imageSourceId?:string}}>('message.routes',quoted.input.id);
  assert.equal(route?.replyReference?.imageSourceId,photos[0].id);
  assert.ok(!quoted.input.images?.length);
  assert.equal((await readImage(quoted.input)).status,404);
  const historyQuote=async()=>{
    const page=await fetch(history.url,{headers:{authorization:'Bearer fixture'}});
    assert.equal(page.status,200);
    const data=await page.json();
    return data.messages.find((m:Message)=>m.id===quoted.input.id);
  };
  const visible=await historyQuote();
  assert.equal(visible.quotedImageMessageId,photos[0].id);
  assert.ok(!visible.images?.length);
  const plain=await ask('om_no_parent','现在只讨论后续文字');
  assert.ok(!JSON.stringify(plain.call.messages).includes(visual));
  const other=await ask('om_other_parent','请看这条未经核实的引用','om_unknown_parent');
  assert.ok(!JSON.stringify(other.call.messages).includes(visual));
  await dispatcher.invoke({schema:'2.0',header:{event_type:'im.message.recalled_v1',event_id:'recall-source-photo'},
    event:{chat_id:'oc_owner',message_id:'om_photo'}},{needCheck:false});
  const hidden=await historyQuote();
  assert.equal(hidden.quotedImageMessageId,undefined);
  assert.equal(hidden.quotedImagesUnavailable,true);
  const revoked=await ask('om_revoked_parent','能否读取刚刚撤回的图','om_photo');
  assert.ok(!JSON.stringify(revoked.call.messages).includes(visual));
  assert.equal(reads.length,resourceReads,'引用只复用已授权本地原件');
  await event('om_transcript','merge_forward');
  const providerInput=await t.waitFor(()=>{
    const call=requests.find(req=>JSON.stringify(req).includes('合成讨论原话 /main'));
    assert.ok(call);return JSON.stringify(call);
  },{timeout:8000});
  assert.match(providerInput,/主人转发了一组飞书聊天记录/);
  assert.doesNotMatch(providerInput,/img_untrusted_event/);
  const refreshed=await fetch(history.url,{headers:{authorization:'Bearer fixture'}});
  const turn=(await refreshed.json()).messages.find((message:Message)=>message.files?.[0]?.name==='转发的聊天记录.txt');
  assert.ok(turn && turn.conversationId===photos[0].conversationId);
  const project=host.app.projects.create({name:'合成项目'});
  const changed=await host.bots.update(bot.id,{scope:{kind:'project',projectId:project.id}});
  await event('om_pair_project','text',changed.pairingCode!);
  await t.waitFor(()=>assert.ok(host.bots.list().some(row=>row.paired)));
  assert.equal((await readImage(photos[0])).status,404);
  await event('om_project','image');
  const scoped=await t.waitFor(()=>{const m=host.app.store.list<Message>('messages').find(row=>row.images?.length && row.projectId===project.id);assert.ok(m && host.bots.canReadPrivateImage(m));return m;});
  assert.equal((await readImage(scoped)).status,200);
  await dispatcher.invoke({schema:'2.0',header:{event_type:'im.message.recalled_v1',event_id:'recall'},event:{chat_id:'oc_owner',message_id:'om_project'}},{needCheck:false});
  assert.equal(host.bots.canReadPrivateImage(scoped),false);
  assert.equal((await readImage(scoped)).status,404);
});

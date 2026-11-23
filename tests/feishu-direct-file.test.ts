import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {EventDispatcher} from '@larksuiteoapi/node-sdk';
import {startServer} from '../apps/server/src/index.ts';
import type {Message} from '../packages/protocol/src/index.ts';
import type {FeishuOptions} from '../plugins/feishu.ts';
import {createFeishuIntegration} from '../plugins/feishu.ts';

test('私聊普通文件从已核实的原消息分块接收，撤回和重新配对收回附件权限',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-private-file-')),headers={authorization:'Bearer fixture'};
  const file=Buffer.from('合成文件第一段，不应进入信箱或命令行。\n合成文件第二段。');
  const received:string[]=[],sent:string[]=[];
  let dispatcher!:EventDispatcher,sequence=0;
  let resume!:()=>void;const hold=new Promise<void>(resolve=>{resume=resolve;});
  const host=await startServer({host:'127.0.0.1',port:0,dataDir:dir,token:'fixture',demo:true},{
    botFactory:options=>createFeishuIntegration({...options,fetch:async(input,init)=>{
      const url=new URL(String(input)),path=url.pathname;
      if(path.includes('tenant_access_token')) return Response.json({code:0,tenant_access_token:'synthetic',expire:7200});
      if(path.endsWith('/bot/v3/info')) return Response.json({code:0,bot:{open_id:'ou_bot'}});
      if ((init?.method??'GET')==='GET') {
        const where=path.split('/messages/')[1]!;received.push(where);
        assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic');
        assert.equal(init?.redirect,'error');
        const id=where.split('/')[0];
        if (where.includes('/resources/')) {
          assert.equal(url.searchParams.get('type'),'file');
          assert.equal(where,id+'/resources/file_verified');
          let index=0;
          return new Response(new ReadableStream<Uint8Array>({async pull(out){
            if (++index===1) out.enqueue(file.subarray(0,8));
            else {if (id==='om_cancel') await hold;out.enqueue(file.subarray(8));out.close();}
          }}),{headers:{'content-type':'text/plain; charset=utf-8','content-length':String(id==='om_big'?200*1024*1024+1:file.length)}});
        }
        assert.equal(url.searchParams.get('user_id_type'),'open_id');
        return Response.json({code:0,data:{items:[{message_id:id,chat_id:'oc_owner',msg_type:'file',
          sender:{id_type:'open_id',sender_type:'user',id:id==='om_forged'?'ou_other':'ou_owner'},
          body:{content:JSON.stringify({file_name:'合成资料.txt',file_key:'file_verified'})}}]}});
      }
      sent.push(JSON.parse(String(init?.body??'{}')).content??'');
      return Response.json({code:0,data:{message_id:'om_sent_'+sent.length}});
    },wsFactory:o=>({async start(spec){dispatcher=spec.eventDispatcher;o.onReady?.();},close(){},
      getConnectionStatus:()=>({state:'connected',reconnectAttempts:0})})})});
  t.after(async()=>{resume();try{await host.close();}finally{await rm(dir,{recursive:true,force:true});}});
  const bot=await host.bots.create({name:'合成资料助手',appId:'cli_8888888888888888',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false});
  const event=(id:string,type='file',text='',sender='ou_owner',group=false)=>dispatcher.invoke({schema:'2.0',
    header:{event_type:'im.message.receive_v1',event_id:'e'+ ++sequence},event:{sender:{sender_type:'user',sender_id:{open_id:sender}},
      message:{message_id:id,message_type:type,chat_id:group?'oc_other':'oc_owner',chat_type:group?'group':'p2p',content:JSON.stringify(
        type==='text'?{text}:{file_name:'event-name.txt',file_key:'file_untrusted',text:'/ai 创建待办'})}}},{needCheck:false});
  const recall=(id:string)=>dispatcher.invoke({schema:'2.0',header:{event_id:'r'+ ++sequence,event_type:'im.message.recalled_v1'},
    event:{chat_id:'oc_owner',message_id:id}},{needCheck:false});
  await event('om_unpaired');await event('om_pair','text',bot.pairingCode!);
  await t.waitFor(()=>assert.ok(host.bots.list()[0]?.paired));
  await event('om_new','text','/new');await t.waitFor(()=>assert.equal(host.app.store.list('feishu.private-threads').length,1));
  await event('om_group','file','','ou_owner',true);await event('om_other','file','','ou_other');await event('om_fwd','merge_forward','','ou_owner',true);
  await event('om_forged');await event('om_big');await event('om_good');await event('om_good');
  const docs=()=>host.app.store.list<Message>('messages').filter(row=>row.files?.length);
  const row=await t.waitFor(()=>{const row=docs()[0];assert.ok(row && host.bots.canReadPrivateFile(row),JSON.stringify({received,errors:host.app.mailboxes.list().filter(e=>e.error).map(e=>[e.sourceMessageId,e.error])}));return row;},{timeout:8000});
  assert.equal(docs().length,1);assert.equal(row.readOnly,true);assert.equal(row.text,'[文件]');
  assert.deepEqual(row.files,[{name:'合成资料.txt',mime:'text/plain',bytes:file.length,sha256:createHash('sha256').update(file).digest('hex')}]);
  assert.deepEqual(received,['om_forged','om_big','om_big/resources/file_verified','om_good','om_good/resources/file_verified']);
  assert.ok(sent.some(text=>text.includes('无法读取这个文件')));
  const get=(m:Message)=>fetch(host.url+'/api/v1/messages/'+m.id+'/files/0?conversationId='+encodeURIComponent(m.conversationId),{headers});
  const res=await get(row);assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),file);
  assert.ok(!JSON.stringify(host.app.mailboxes.list()).includes('合成文件第一段'));
  const plugin=host.url+'/api/v1/plugins/conversation-files';
  const toggle=(enabled:boolean)=>fetch(plugin,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({enabled})});
  assert.equal((await toggle(false)).status,200);
  await event('om_disabled');
  await t.waitFor(()=>assert.ok(host.app.mailboxes.list().some(e=>e.sourceMessageId==='om_disabled' && e.status==='failed')));
  assert.ok(!received.includes('om_disabled'));assert.equal(host.bots.canReadPrivateFile(row),false);
  assert.equal((await toggle(true)).status,200);assert.equal((await get(row)).status,200);
  await event('om_cancel');
  await t.waitFor(()=>assert.ok(received.includes('om_cancel/resources/file_verified')));
  await recall('om_cancel');resume();
  await t.waitFor(()=>assert.ok(host.app.mailboxes.list().some(e=>e.sourceMessageId==='om_cancel' && e.status==='failed')));
  assert.equal(docs().length,1);
  await event('om_preview');
  const previewRow=await t.waitFor(()=>{const found=docs().find(m=>m.id!==row.id);assert.ok(found);return found;});
  const previewUrl=host.url+'/api/v1/messages/'+previewRow.id+'/files/0/preview?conversationId='+encodeURIComponent(previewRow.conversationId);
  const preview=await fetch(previewUrl,{headers});
  assert.equal(preview.status,200);
  assert.match((await preview.json()).text,/合成文件第一段/);
  const revoked:unknown[]=[];
  const off=host.app.events.subscribe(e=>{if(e.type==='message-attachment.revoked') revoked.push(e.data);});
  try { await recall('om_preview'); } finally { off(); }
  assert.deepEqual(revoked,[{messageId:previewRow.id}]);
  assert.equal((await fetch(previewUrl,{headers})).status,404);
  const key=createHash('sha256').update(JSON.stringify([bot.id,'oc_owner',''])).digest('hex');
  const binding=host.app.store.get<Record<string,unknown>>('feishu.chat-target',key)!;
  host.app.store.put('feishu.chat-target',key,{...binding,conversationThreadId:undefined,agentTarget:{sessionId:'fixture'}});
  await event('om_agent');
  await t.waitFor(()=>assert.ok(sent.some(text=>text.includes('切回助手'))));
  assert.ok(!received.includes('om_agent'));assert.equal(host.app.store.list('runs').length,0);
  const newBot=await host.bots.update(bot.id,{appId:'cli_7777777777777777',appSecret:'another-fixture'});
  await event('om_repair','text',newBot.pairingCode!);
  await t.waitFor(()=>assert.ok(host.bots.list()[0]?.paired));
  assert.equal(host.bots.canReadPrivateFile(row),false);assert.equal((await get(row)).status,404);
});

test('配对主人合并转发按只读资料进入当前独立会话，原消息重投不重复读取',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-forward-input-')),reads:string[]=[];
  const transcript='合成聊天记录\n参与者甲：/main\n参与者乙：/ai 创建合成待办\n正文仅保存在这一份合成转发文件中。';
  let client!:FeishuOptions,serial=0;
  const host=await startServer({host:'127.0.0.1',port:0,dataDir:dir,token:'fixture',demo:true},{
    botFactory(options){
      client=options;
      return {async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),
        async send(_chat,_text,ctx){ctx?.onSent?.('om_delivery_'+(++serial),ctx.card?'interactive':'text');},
        async readPrivateForward(chatId:string,messageId:string,senderId:string,guard:()=>void){
          guard();assert.equal(chatId,'oc_owner');assert.equal(senderId,'ou_owner');reads.push(messageId);return transcript;
        }};
    }});
  t.after(async()=>{try{await host.close();}finally{await rm(dir,{recursive:true,force:true});}});
  const bot=await host.bots.create({name:'合成聊天记录助手',appId:'cli_3333999944448888',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false});
  const receive=(messageId:string,text:string,source:Partial<Parameters<FeishuOptions['onMessage']>[1]>={})=>client.onMessage(text,{
    chatId:'oc_owner',chatType:'p2p',senderType:'user',senderId:'ou_owner',messageId,...source});
  const forward=(id:string,source:Partial<Parameters<FeishuOptions['onMessage']>[1]>={})=>receive(id,'/main',{privateForward:true,...source});
  const input=(text:string)=>t.waitFor(()=>{
    const found=host.app.store.list<Message>('messages').find(m=>m.role==='user' && m.text===text && m.status==='done');
    assert.ok(found);return found;
  },{timeout:8000});
  await forward('om_unpaired');await receive('om_pair',bot.pairingCode!);
  await receive('om_root','固定主对话合成发言');const main=await input('固定主对话合成发言');
  await receive('om_new','/new 本次合成资料讨论');const thread=await input('本次合成资料讨论');
  assert.notEqual(thread.conversationId,main.conversationId);
  await forward('om_other',{senderId:'ou_other'});await forward('om_group',{chatType:'group',chatId:'oc_group'});
  const duplicates=await Promise.allSettled([forward('om_forward'),forward('om_forward')]);
  const rows=()=>host.app.store.list<Message>('messages').filter(m=>m.role==='user' && m.files?.length);
  const attached=await t.waitFor(()=>{const [m]=rows();assert.ok(m && host.bots.canReadPrivateFile(m));return m;},{timeout:8000});
  await forward('om_forward');
  assert.deepEqual(reads,['om_forward']);assert.equal(rows().length,1);
  assert.equal(attached.conversationId,thread.conversationId);
  assert.equal(attached.readOnly,true);assert.equal(attached.text,'[文件]');
  assert.equal(attached.files?.[0]?.name,'转发的聊天记录.txt');assert.equal(attached.files?.[0]?.mime,'text/plain');
  const filePath='/api/v1/messages/'+attached.id+'/files/0?conversationId=';
  const get=(id:string)=>fetch(host.url+filePath+encodeURIComponent(id),{headers:{authorization:'Bearer fixture'}});
  const bytes=await get(thread.conversationId);
  assert.equal(bytes.status,200);assert.equal(await bytes.text(),transcript);
  assert.equal((await get(main.conversationId)).status,404);
  assert.ok(!JSON.stringify(host.app.mailboxes.list()).includes('正文仅保存在这一份合成转发文件中'));
  await receive('om_more','转发后的普通发言');assert.equal((await input('转发后的普通发言')).conversationId,thread.conversationId);
  assert.equal(host.app.todos().length,0);assert.equal(host.app.store.list('runs').length,0);
  assert.deepEqual(duplicates.map(result=>result.status),['fulfilled','fulfilled']);
  assert.ok(client.onRecall);
  client.onRecall('oc_owner','om_forward');
  assert.equal((await get(thread.conversationId)).status,404);
  assert.equal(host.bots.canReadPrivateFile(attached),false);
});

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import {startServer} from '../apps/server/src/index.ts';
import type {Message,ChatFileRef} from '../packages/protocol/src/index.ts';
import type {FeishuOptions} from '../plugins/feishu.ts';

test('真实 pi 工具生成 Word，文件属于原答复，私聊撤回或重绑后原下载和目录均失效', {timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-office-reply-')),token='test-office',headers={authorization:'Bearer '+token,'content-type':'application/json'};
  type Result={id:string;filename:string;attachedFile?:ChatFileRef};
  const results=new Map<string,Result>(),toolsSeen=new Map<string,string[]>();
  const transport=fetch;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const req=new Request(input,init),url=new URL(req.url);
    assert.equal(url.hostname,'127.0.0.1');
    if(url.port!=='1')return transport(req);
    const packet=await req.json();
    const last=packet.messages.at(-1);
    const text=JSON.stringify(packet.messages.findLast((m:{role:string})=>m.role==='user')?.content);
    const tag=text?.match(/CASE_[A-Z]+/u)?.[0]??'';
    let delta;
    if(last.role==='tool'){
      const content=typeof last.content==='string'?last.content:last.content.map((c:{text:string})=>c.text).join('');
      try {results.set(tag,JSON.parse(content));} catch { /* Failed tool calls are caught by the terminal assertions. */ }
      delta={role:'assistant',content:'本轮办公工具已返回。'};
    }else{
      const names=(packet.tools??[]).map((fn:{function:{name:string}})=>fn.function.name);
      toolsSeen.set(tag,names);
      delta=names.includes('office_create') && tag && tag!=='CASE_GROUP'
        ?{role:'assistant',tool_calls:[{index:0,id:'make_'+tag,type:'function',function:{name:'office_create',
          arguments:JSON.stringify({title:tag,format:'docx',source:'# 合成交付\n\n收据原文 '+tag+'。'})}}]}
        :{role:'assistant',content:'合成普通答复。'};
    }
    const sse=[delta,{}].map((part,i)=>'data: '+JSON.stringify({id:'fixture',model:'fixture',object:'chat.completion.chunk',
      choices:[{index:0,delta:part,finish_reason:i?('tool_calls' in delta?'tool_calls':'stop'):null}]}));
    return new Response(sse.concat('data: [DONE]','').join('\n\n'),{headers:{'content-type':'text/event-stream'}});
  });
  let client!:FeishuOptions,sent=0;
  const server=await startServer({host:'127.0.0.1',port:0,token,dataDir:dir,demo:false,
    model:{provider:'openai-compatible',model:'fixture',baseUrl:'http://127.0.0.1:1/offline',apiKey:'fixture'}},
    {botFactory:opts=>{client=opts;return{async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),
      async send(_target,_text,context){context?.beforeSend?.();context?.onSent?.('fake_sent_'+ ++sent,context.card?'interactive':'text');}};}});
  t.after(async()=>{try{await server.close();}finally{await rm(dir,{recursive:true,force:true});}});
  const api=(path:string,body?:unknown)=>fetch(server.url+'/api/v1'+path,{headers,...(body!==undefined && {method:'POST',body:JSON.stringify(body)})});
  const office=(body:unknown)=>api('/office-documents',body);
  const bot=await server.bots.create({name:'合成办公助手',appId:'cli_8989898989898989',appSecret:'fixture',scope:{kind:'global'},
    requireConfirmation:false,groupChats:[{chatId:'oc_group',mentionOnly:true,allowedSenderIds:[]}]});
  const event=(id:string,text:string,group=false)=>client.onMessage(text,{messageId:id,senderType:'user',senderId:'ou_owner',
    chatId:group?'oc_group':'oc_owner',chatType:group?'group':'p2p',mentionedSelf:group});
  await event('om_pair',bot.pairingCode!);
  const ask=(tag:string)=>'请生成内容为 '+tag+' 的 Word 文件';
  const answer=async(input:Message)=>t.waitFor(()=>{
    const m=server.app.store.list<Message>('messages').find(m=>m.replyTo===input.id && ['done','failed'].includes(m.status??''));
    assert.ok(m);assert.equal(m.status,'done',m.text);return m;
  },{timeout:8000});
  const privateInput=async(tag:string)=>t.waitFor(()=>{
    const m=server.app.store.list<Message>('messages').find(m=>m.role==='user' && m.text===ask(tag));assert.ok(m);return m;});
  const fileUrl=(m:Message,preview=false)=>'/messages/'+m.id+'/files/0'+(preview?'/preview':'')+'?conversationId='+encodeURIComponent(m.conversationId);
  async function verify(tag:string,input:Message) {
    const reply=await answer(input),result=results.get(tag);
    assert.ok(toolsSeen.get(tag)?.includes('office_create'),'工具应在真实模型请求中可见 '+tag);
    assert.ok(result?.attachedFile,'成功回执须含本轮附件 '+tag);assert.deepEqual(reply.files,[result.attachedFile]);
    assert.equal(input.files,undefined);assert.equal(reply.conversationId,input.conversationId);
    assert.deepEqual(Object.keys(result.attachedFile).sort(),['bytes','mime','name','officeDocumentId','sha256']);
    assert.equal(result.attachedFile.officeDocumentId,result.id);
    const raw=await api(fileUrl(reply));assert.equal(raw.status,200,await raw.clone().text());
    const bytes=Buffer.from(await raw.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'),result.attachedFile.sha256);
    const zip=await JSZip.loadAsync(bytes);
    assert.ok((await zip.file('word/document.xml')!.async('string')).includes(tag));
    const preview=await api(fileUrl(reply,true));assert.equal(preview.status,200,await preview.clone().text());assert.match((await preview.json()).text,new RegExp(tag));
    assert.equal((await api('/messages/'+reply.id+'/files/0?conversationId=another')).status,404);
    return {reply,doc:result.id};
  }
  const web=await api('/messages',{text:ask('CASE_WEB')});assert.equal(web.status,202);
  const home=await verify('CASE_WEB',await web.json());
  const project=server.app.projects.create({name:'合成办公项目'});
  const work=await api('/projects/'+project.id+'/messages',{text:ask('CASE_PROJECT')});assert.equal(work.status,202);
  await verify('CASE_PROJECT',await work.json());
  await event('om_private','/new '+ask('CASE_PRIVATE'));
  const priv=await privateInput('CASE_PRIVATE');assert.ok(server.bots.canReadOfficeSource(priv));
  const thread=await verify('CASE_PRIVATE',priv);
  const initial=(await (await office({action:'list'})).json()) as Result[];
  assert.ok(initial.some(d=>d.id===thread.doc));
  const revoked:string[]=[];
  const off=server.app.events.subscribe(e=>{if(e.type==='message-attachment.revoked' && typeof e.data==='object' && e.data && 'messageId' in e.data)revoked.push(String(e.data.messageId));});
  await client.onRecall!('oc_owner','om_private');off();
  assert.ok(revoked.includes(priv.id));
  assert.equal(server.bots.canReadOfficeSource(priv),false);
  assert.equal((await api(fileUrl(thread.reply))).status,404);
  assert.equal((await api(fileUrl(thread.reply,true))).status,404);
  assert.equal((await office({action:'download',id:thread.doc})).status,404);
  assert.equal((await api(fileUrl(home.reply))).status,200);
  await event('om_group',ask('CASE_GROUP'),true);
  assert.equal(server.bots.canReadOfficeSource(await privateInput('CASE_GROUP')),false);
  await api('/plugins/conversation-files',{enabled:false});
  await event('om_catalog',ask('CASE_CATALOG'));
  const listOnly=await privateInput('CASE_CATALOG');
  const reply=await answer(listOnly),local=results.get('CASE_CATALOG');
  assert.ok(local?.attachedFile);assert.deepEqual(reply.files,[local.attachedFile]);
  assert.equal((await api(fileUrl(reply))).status,503);
  assert.equal((await office({action:'download',id:local.id})).status,200);
  await api('/plugins/conversation-files',{enabled:true});
  assert.equal((await api(fileUrl(reply))).status,200);
  await server.bots.update(bot.id,{appId:'cli_9292929292929292',appSecret:'new-fixture'});
  assert.equal(server.bots.canReadOfficeSource(listOnly),false);assert.equal((await office({action:'download',id:local.id})).status,404);
  assert.equal((await api(fileUrl(reply))).status,404);
  assert.ok(!((await (await office({action:'list'})).json()) as Result[]).some(doc=>doc.id===local.id));
});

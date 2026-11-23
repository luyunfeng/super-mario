import assert from 'node:assert/strict';
import test from 'node:test';
import type {EventDispatcher} from '@larksuiteoapi/node-sdk';
import {createFeishuIntegration, type FeishuMessageSource} from '../plugins/feishu.ts';

test('私聊富文本按原文读取有序原图，批次边界或身份不符时拒绝交付',async t=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCc8AAAAASUVORK5CYII=','base64');
  const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
  const raw=(keys:string[])=>({zh_cn:{content:[[{tag:'at',user_id:'ou_a'},
    ...keys.map(image_key=>({tag:'img',image_key})),{tag:'media',file_key:'file_never'}]]},
    en_us:{content:[[{tag:'image',image_key:'img_wrong_language'}]]}});
  let dispatcher!:EventDispatcher, input:{text:string;source:FeishuMessageSource}|undefined;
  let content=raw(['img_verified','img_other','img_verified']), patched={}, afterRead=()=>{};
  let imageResponse=(key:string)=>new Response(key==='img_verified'?png:gif);
  const resources:string[]=[];
  const app=createFeishuIntegration({privatePosts:true,privateImages:true,appId:'cli_1111111111111111',appSecret:'fixture',
    wsFactory:o=>({async start(spec){dispatcher=spec.eventDispatcher;o.onReady?.();},close(){},getConnectionStatus:()=>({state:'connected',reconnectAttempts:0})}),
    onMessage:async(text,source)=>{input={text,source};},onInbox:async()=>{},fetch:async(url,init)=>{
      const path=new URL(String(url)).pathname;
      if (path.includes('tenant_access_token')) return Response.json({code:0,tenant_access_token:'fixture',expire:7200});
      assert.equal(init?.redirect,'error');
      if (path.endsWith('/messages/om_post')) return Response.json({code:0,data:{items:[{
        message_id:'om_post',msg_type:'post',chat_id:'oc_owner',sender:{id:'ou_owner',id_type:'open_id',sender_type:'user'},
        mentions:[{id:'ou_a',id_type:'open_id',key:'@_user_1',name:'合成成员'}], body:{content:JSON.stringify(content)},...patched}]}});
      const key=path.split('/').pop()!;
      assert.equal(path,'/open-apis/im/v1/messages/om_post/resources/'+key);
      assert.equal(new URL(String(url)).searchParams.get('type'),'image');
      resources.push(key);afterRead();
      return imageResponse(key);
    }});
  await app.start();t.after(()=>app.close());
  await dispatcher.invoke({schema:'2.0',header:{event_id:'evt_post',event_type:'im.message.receive_v1'},event:{
    sender:{sender_type:'user',sender_id:{open_id:'ou_owner'}},message:{chat_id:'oc_owner',chat_type:'p2p',message_id:'om_post',message_type:'post',
      content:JSON.stringify(raw(['img_injected','img_injected','img_injected'])),mentions:[{id:{open_id:'ou_a'},key:'@_user_1',name:'合成成员'}]}}},{needCheck:false});
  await t.waitFor(()=>assert.ok(input));const accepted=input!;
  assert.equal(accepted.source.privatePostImages,true);
  assert.equal(accepted.text,'@合成成员[图片][图片][图片][视频]');
  const read=(text=accepted.text,guard=()=>{})=>app.readPrivatePostImages('oc_owner','om_post','ou_owner',text,guard);
  const images=await read();
  assert.deepEqual(images.map(i=>i.mime),['image/png','image/gif','image/png']);
  assert.deepEqual(resources,['img_verified','img_other']);
  assert.equal(images[0].data,images[2].data);
  resources.length=0;
  for (patched of [{updated:true},{deleted:true},{msg_type:'image'},{chat_id:'oc_other'},{upper_message_id:'om_other'},
    {sender:{id:'ou_other',id_type:'open_id',sender_type:'user'}}]) await assert.rejects(read(),/原始私聊/);
  patched={};
  await assert.rejects(read('改变后的正文'),/不一致/);
  content=raw(Array(21).fill('img_many'));await assert.rejects(read(),/20 张/);
  content=raw(['https://example.invalid/unsafe']);await assert.rejects(read(),/有效图片/);
  assert.deepEqual(resources,[]);
  content=raw(['img_verified']);imageResponse=()=>new Response('invalid bytes');
  await assert.rejects(read('@合成成员[图片][视频]'),/格式/);
  let valid=true;
  afterRead=()=>{valid=false;};
  await assert.rejects(read('@合成成员[图片][视频]',()=>{if(!valid) throw new Error('已撤权');}),/撤权/);
  afterRead=()=>{};
  content=raw(Array(8).fill('img_verified'));
  // The repeated image is fetched once, but each occurrence counts against the per-message base64 budget.
  const large=Buffer.concat([png,Buffer.alloc(3_700_000-png.length)]);
  imageResponse=()=>new Response(large);
  await assert.rejects(read('@合成成员'+'[图片]'.repeat(8)+'[视频]'),/大小限制/);
});

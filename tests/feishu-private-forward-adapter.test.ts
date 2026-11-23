import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { createFeishuIntegration, type FeishuMessageSource } from '../plugins/feishu.ts';

const root = {message_id:'om_root', chat_id:'oc_owner', msg_type:'merge_forward', sender:{id:'ou_owner', id_type:'open_id', sender_type:'user'}};
const child = (id:string, type:string, content:unknown, time:string) => ({
  message_id:id, upper_message_id:root.message_id, msg_type:type, create_time:time,
  sender:{sender_type:'user',id:'ou_a'}, body:{content:JSON.stringify(content)},
});
function fixture(enabled=true) {
  let dispatcher!:EventDispatcher, serial=0;
  const inputs:{text:string;source:FeishuMessageSource}[]=[];
  let reply=()=>Response.json({code:0,data:{items:[root]}});
  const reads:string[]=[];
  const app=createFeishuIntegration({appId:'cli_1234567890123456', appSecret:'synthetic', privateForwards:enabled,
    onInbox:async()=>{},onMessage:async(text,source)=>{inputs.push({text,source});},
    wsFactory:o=>({async start(spec){dispatcher=spec.eventDispatcher;o.onReady?.();},close(){},getConnectionStatus:()=>({state:'connected',reconnectAttempts:0})}),
    fetch:async(input,init)=>{
      const url=new URL(String(input));
      if(url.pathname.includes('tenant_access_token')) return Response.json({code:0,tenant_access_token:'fixture',expire:7200});
      assert.equal(url.pathname,'/open-apis/im/v1/messages/om_root');
      assert.equal(url.searchParams.get('user_id_type'),'open_id');
      assert.equal(init?.redirect,'error');assert.equal(init?.method,'GET');
      reads.push(url.pathname);
      return reply();
    }});
  const event=(messageId:string,chat='p2p',sender='user',content='/ai malicious')=>dispatcher.invoke({schema:'2.0',
    header:{event_id:'evt'+ ++serial,event_type:'im.message.receive_v1'},event:{
      sender:{sender_type:sender,sender_id:{open_id:'ou_owner'}},message:{
        chat_type:chat,chat_id:'oc_owner',message_id:messageId,message_type:'merge_forward',content},
    }},{needCheck:false});
  return {app,event,inputs,reads,set:(fn:()=>Response)=>{reply=fn;},
    rows:(items:unknown[])=>{reply=()=>Response.json({code:0,data:{items}});},
    read:(guard=()=>{})=>app.readPrivateForward('oc_owner','om_root','ou_owner',guard)};
}
test('合并转发仅发私聊占位，忽略事件内命令和群转发',async t=>{
  for(const enabled of [true,false]){
    const f=fixture(enabled); await f.app.start(); t.after(()=>f.app.close());
    await f.event('om_g','group'); await f.event('om_bot','p2p','app');
    await f.event('om_owner','p2p','user',JSON.stringify({text:'/new'})); await f.event('om_owner');
    await f.event('om_invalid');
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(f.inputs.map(x=>[x.text,x.source.privateForward]),enabled?Array(2).fill(['[转发的聊天记录]',true]):[]);
    assert.deepEqual(f.reads,[]);
    if(!enabled) await assert.rejects(f.read(),/未启用/);
  }
});
test('读取原私聊中直接子消息，按时间排序并限制 Unicode 记录总长',async t=>{
  const f=fixture();await f.app.start(); t.after(()=>f.app.close());
  const first={...child('om_a','text',{text:'@_user_1 阅读材料'},'1700000000000'),mentions:[{key:'@_user_1',name:'合成成员'}]};
  const second=child('om_b','post',{zh_cn:{title:'第二条',content:[[{tag:'a',text:'链接标题',href:'shadow-url'},{tag:'img',image_key:'shadow-key'}]]}},'1700000000100');
  f.rows([second,root,first,child('om_img','image',{text:'shadow-body'},'1700000000200'),
    {...child('om_nested','text',{text:'shadow-nested'},'1700000000000'),upper_message_id:'om_b'},
    {...child('om_deleted','text',{text:'shadow-deleted'},'1700000000000'),deleted:true},first]);
  const text=await f.read();
  assert.match(text,/@合成成员 阅读材料[\s\S]+第二条\n链接标题\[图片\][\s\S]+\[图片\]/);
  assert.equal((text.match(/阅读材料/g)??[]).length,1);assert.doesNotMatch(text,/shadow/);
  f.rows([root,child('om_long','text',{text:'🐢'.repeat(40200)},'1700000000000')]);
  const clipped=await f.read();assert.equal(Array.from(clipped).length,30000);
  assert.equal(Buffer.from(clipped).toString('utf8'),clipped);assert.match(clipped,/聊天记录已截断/);
});
test('合并转发拒绝空记录、来源不符、读取失败及读途中失权',async t=>{
  const f=fixture();await f.app.start();t.after(()=>f.app.close());
  for(const patch of [{message_id:'om_other'},{msg_type:'post'},{chat_id:'oc_other'},{chat_type:'group'},
    {sender:{...root.sender,id:'ou_other'}},{sender:{...root.sender,id_type:'user_id'}},{deleted:true},{updated:true}]){
    f.rows([{...root,...patch},child('om_a','text',{text:'无权读取'},'1700000000000')]);
    await assert.rejects(f.read(),/无法核对/);
  }
  f.rows([root]);await assert.rejects(f.read(),/没有可读取的直接子消息/);
  f.set(()=>new Response('denied',{status:403}));await assert.rejects(f.read(),/403/);
  let valid=true;
  f.set(()=>{valid=false;return Response.json({code:0,data:{items:[root,child('om_a','text',{text:'不可用'},'1700000000000')]}});});
  await assert.rejects(f.read(()=>{if(!valid) throw new Error('已撤权');}),/撤权/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readNativeShareMessages} from '../packages/core/src/native-conversation-export.ts';
import type {MachineClient} from '../packages/plugin-sdk/src/index.ts';
import type {NativeExportSource} from '../packages/protocol/src/index.ts';

function fixture(executorId:NativeExportSource['executorId'],rows:unknown[]) {
  const source={executorId,machineId:'fixture',nativeSessionId:'unit',cwd:'/synthetic'};
  const data=Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n'));
  const machines:MachineClient={
    list:()=>[{id:'fixture',name:'fixture',platform:'linux',connectedAt:'2026-01-01T00:00:00Z',online:true,capabilities:['agents.transcript']}],
    async call(){return {snapshot:{size:data.length,dev:1,ino:7},nextOffset:data.length,eof:true,data:data.toString('base64')};},
  };
  return (selection:Parameters<typeof readNativeShareMessages>[2])=>readNativeShareMessages(machines,source,selection,new AbortController().signal);
}

test('原生 Codex 只把同一用户轮中的工具交给紧接的正文，普通回执不推断成功',async()=>{
  const event=(payload:unknown)=>({type:'response_item',payload});
  const msg=(role:string,text:string)=>event({type:'message',role,content:text});
  const call=(name:string,id:string)=>event({type:'function_call',name,call_id:id,arguments:'private args'});
  const receipt=(id:string)=>event({type:'function_call_output',call_id:id,output:'private result'});
  const read=fixture('codex',[call('orphan','0'),msg('user','开始'),call('not_selected','1'),msg('assistant','不分享'),
    ...Array.from({length:23},(_,i)=>msg('assistant','填充'+i)),call('old_turn','old'),msg('user','下一轮'),
    call('read','2'),receipt('2'),call('ambiguous','3'),receipt('3'),receipt('3'),call('duplicate','4'),call('duplicate','4'),
    msg('assistant','分享'),msg('assistant','下一段')]);
  const page=await read({offset:25}),ids=page.items.map(i=>i.id);
  assert.deepEqual(page.items.map(i=>i.text),['下一轮','分享','下一段']);
  const {items}=await read({ids,showTools:true});
  assert.deepEqual(items[1],{...page.items[1],tools:[{name:'read',status:'returned'},{name:'ambiguous',status:'unknown'},
    {name:'duplicate',status:'unknown'},{name:'duplicate',status:'unknown'}]});
  assert.deepEqual(items[0],page.items[0]);assert.deepEqual(items[2],page.items[2]);
  assert.deepEqual((await read({ids})).items,page.items);
});

test('原生 Claude 混合块归当前正文，晚到回执只在原用户轮内更新',async()=>{
  const row=(type:string,content:unknown)=>({sessionId:'unit',type,message:{content}});
  const tool=(name:string,id:string)=>({type:'tool_use',name,id,input:{secret:'private args'}});
  const receipt=(tool_use_id:string,is_error:boolean)=>({type:'tool_result',tool_use_id,is_error,content:'private result'});
  const read=fixture('claude-code',[row('user','开始'),row('assistant',[tool('read','a')]),
    row('assistant',[{type:'text',text:'原正文'},tool('write','b'),tool('pending','c')]),
    row('user',[receipt('a',false),receipt('b',true)]),row('assistant',[tool('stale','d')]),
    row('user','新请求'),row('user',[receipt('c',false)]),row('assistant','另一轮')]);
  const baseline=await read({offset:0}),ids=baseline.items.map(i=>i.id);
  const {items}=await read({ids,showTools:true});
  assert.deepEqual(items[1],{...baseline.items[1],tools:[{name:'read',status:'succeeded'},{name:'write',status:'failed'},
    {name:'pending',status:'unknown'}]});
  assert.deepEqual(items[3],baseline.items[3]);
  assert.deepEqual(items.map(i=>i.text),['开始','原正文','新请求','另一轮']);
  assert.ok(!JSON.stringify(items).includes('private'));
});

test('Claude 明确分叉时，另一父链的工具和回执不能归到当前正文',async()=>{
  const row=(uuid:string,parentUuid:string|null,type:string,content:unknown)=>({sessionId:'unit',uuid,parentUuid,type,message:{content}});
  const tool=(name:string,id:string)=>({type:'tool_use',name,id});
  const read=fixture('claude-code',[
    row('u1',null,'user','第一轮'),row('a1','u1','assistant',[tool('other_branch','t1')]),
    row('a2','u1','assistant','另一个分支的总结'),
    row('u2','a2','user','第二轮'),row('a3','u2','assistant',[{type:'text',text:'同条记录'},tool('local','t2')]),
    row('r2','u2','user',[{type:'tool_result',tool_use_id:'t2',is_error:false}]),
  ]);
  const {items:plain}=await read({offset:0});
  const {items}=await read({ids:plain.map(row=>row.id),showTools:true});
  assert.deepEqual(items[1],plain[1]);
  assert.deepEqual(items[3],{...plain[3],tools:[{name:'local',status:'unknown'}]});
});

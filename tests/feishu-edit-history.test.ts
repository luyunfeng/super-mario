import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../packages/core/src/store.ts';
import {createFeishuEditHistory,type FeishuEditObservation} from '../plugins/feishu-edit-history.ts';
import {createFeishuIntegration} from '../plugins/feishu.ts';

const start = Date.parse('2030-01-01T01:00:00Z');
const time = (step:number) => new Date(start+step*1000).toISOString();
const row = (text:string,step:number,edited:boolean):FeishuEditObservation => ({
  chatId:'oc_test',messageId:'om_one',senderId:'ou_peer',text,timestamp:time(step),edited,deleted:false
});
test('历史仅来自启用期间的显式编辑，按账号、代次和事件顺序隔离', t => {
  const db=createStore(':memory:'); t.after(()=>db.close());
  const h=createFeishuEditHistory(db); let now=start; t.mock.method(Date,'now',()=>now);
  const read=()=>h.read('a','oc_test','om_one');
  assert.deepEqual(h.settings('a'),{enabled:false,revision:0});
  h.observe('a',0,[row('未启用',0,false)]);
  assert.equal(h.configure('a',true,0).revision,1);
  now+=100_000;
  h.observe('a',1,[row('很早',-3,false),row('首个基线',-1,true),row('无编辑标记',1,false),row('明确编辑',2,true)]);
  h.observe('a',1,[row('更早重放',0,true),row('明确编辑',2,true)]);
  assert.deepEqual(read().versions,[{text:'无编辑标记',replacedAt:time(2)}]);
  h.observe('a',1,[row('冲突',2,true),row('新基线',3,true),row('新值',4,true)]);
  assert.deepEqual(read().versions,[{text:'新基线',replacedAt:time(4)}]);
  assert.deepEqual(h.read('b','oc_test','om_one').versions,[]);
  assert.throws(()=>h.configure('a',false,0),{status:409});
  h.configure('a',false,1); h.configure('a',true,2);
  h.observe('a',1,[row('旧代',0,false),row('旧代编辑',3,true)]);
  assert.deepEqual(read().versions,[]);
});
test('SQLite 历史保留最新 50 次；撤回后不留旧文，重放无法复活',t=>{
  const db=createStore(':memory:'); t.after(()=>db.close());
  let now=start; t.mock.method(Date,'now',()=>now);
  const h=createFeishuEditHistory(db); h.configure('a',true,0); now+=90_000;
  h.observe('a',1,Array.from({length:55},(_,i)=>row('v'+i,i,i>0)));
  const retained=createFeishuEditHistory(db).read('a','oc_test','om_one');
  assert.equal(retained.versions.length,50); assert.equal(retained.truncated,true);
  assert.equal(retained.versions[0]?.text,'v4'); assert.equal(retained.versions.at(-1)?.text,'v53');
  h.observe('a',1,[{...row('',0,false),timestamp:'',deleted:true},row('旧页',0,false),row('旧编辑',1,true)]);
  assert.deepEqual(h.read('a','oc_test','om_one'),{versions:[],truncated:false});
});
test('个人分页仅投影已核实入站文本，缺失编辑时间不猜测；撤回不采集正文',async t=>{
  const base={chat_id:'oc_test',message_id:'om_one',chat_type:'p2p',msg_type:'text',content:'文本',sender:{id:'ou_peer',id_type:'open_id',sender_type:'user'},create_time:time(0)};
  const adapter=createFeishuIntegration({appId:'cli_fixture',appSecret:'',profile:'fixture',personalOpenId:'ou_me',personalCollectionPageLimit:2,
    onMessage:async()=>{},onInbox:async()=>{},runCLI:async args=>({ok:true,identity:'user',data:args.includes('+chat-list')?{chats:[],has_more:false}:{has_more:false,messages:[
      base,{...base,content:'新文本',updated:true,update_time:time(1)},{...base,edited:true},{...base,msg_type:'post'},
      {...base,sender:{id:'ou_me',id_type:'open_id'}},{...base,sender:{id:'ou_bot',sender_type:'bot'}},{...base,deleted:true,content:'不可保留'}
    ]}})});
  t.after(()=>adapter.close());
  const obs=(await adapter.collectBatch()).editObservations!;
  assert.deepEqual(obs.map(x=>[x.text,x.edited,x.deleted]),[['文本',false,false],['新文本',true,false],[undefined,false,true]]);
  assert.equal(obs[1]?.timestamp,time(1));
});

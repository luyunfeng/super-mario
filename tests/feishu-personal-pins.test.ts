import test from 'node:test';
import assert from 'node:assert/strict';
import {createPersonalPins} from '../plugins/feishu-personal-pins.ts';
import {PERSONAL_MESSAGE_SCOPES,PersonalAuthError,type PersonalCLI} from '../plugins/feishu-personal.ts';

const account={appId:'cli_fixture',profile:'test_pins',openId:'ou_owner',name:'测试账号'};
const signal=new AbortController().signal;
function fixture() {
  const calls:string[][]=[];
  const state={actor:'ou_owner',messageChat:'oc_chat',pinnedChat:'oc_chat',deleted:false,breakReceipt:false,throwWrite:false,wrongActor:false,threadChat:'oc_chat',threadId:'omt_thread',afterThreadActor:'ou_owner',rootThread:'omt_thread'};
  const run:PersonalCLI=async args=>{
    calls.push(args);
    assert.deepEqual(args.slice(0,2),['--profile',account.profile]);
    if (args.includes('auth')) return {identity:'user',verified:true,appId:account.appId,identities:{user:{
      available:true,openId:state.actor,scope:PERSONAL_MESSAGE_SCOPES.join(' ')}}};
    assert.equal(args[args.indexOf('--as')+1],'user');
    if (args.includes('list')) return {code:0,data:{items:[{message_id:'om_pin',...(state.pinnedChat && {chat_id:state.pinnedChat}),create_time:'1853000000000'}],
      has_more:!args.includes('--page-token'),page_token:'next'}};
    if (args.includes('+threads-messages-list')) {
      assert.equal(args[args.indexOf('--thread')+1],'omt_thread');
      state.actor=state.afterThreadActor;
      return {ok:true,identity:'user',data:{messages:args.includes('--page-token')?
        [{message_id:'om_erased',deleted:true,content:'已撤回的秘密',sender:{name:'某人'}}]:
        [{message_id:'om_child',chat_id:state.threadChat,thread_id:state.threadId,root_id:'om_root',content:'可读回复',sender:{name:'成员甲'},create_time:'2030-01-01T00:00:00Z'}],
        has_more:!args.includes('--page-token'),page_token:'t2'}};
    }
    if (args.includes('GET') && args.includes('/open-apis/im/v1/messages/om_root')) return {code:0,data:{items:[
      {message_id:'om_root',chat_id:'oc_chat',thread_id:state.rootThread,msg_type:'text',body:{content:'{"text":"话题开场"}'}}]}};
    if (args.includes('GET')) {
      assert.ok(args.includes('/open-apis/im/v1/messages/om_pin'));
      return {code:0,data:{items:[{message_id:'om_pin',chat_id:state.messageChat,body:{content:'{"text":"测试原文"}'},msg_type:'text',
        deleted:state.deleted,root_id:'om_root',parent_id:'om_parent',thread_id:'omt_thread',create_time:'1853000000000'}]}};
    }
    if (state.throwWrite) throw new PersonalAuthError('timeout');
    if (state.breakReceipt) return {ok:true,identity:'bot',data:{}};
    if (args.includes('create')) return {code:0,data:{pin:{message_id:'om_pin',chat_id:'oc_chat',operator_id:state.wrongActor?'ou_other':'ou_owner',operator_id_type:'open_id'}}};
    assert.ok(args.includes('delete') && args.includes('--yes'));
    return {code:0,data:{}};
  };
  return {calls,state,adapter:createPersonalPins(run)};
}
test('真实 CLI 协议分页，精确复核原文；已撤回原文不再显示',async()=>{
  const {adapter,state}=fixture();
  const first=await adapter.list(account,'oc_chat',signal);
  assert.equal(first.nextCursor,'next');assert.equal(first.items[0]?.pinnedAt,new Date(1853000000000).toISOString());
  assert.equal((await adapter.list(account,'oc_chat',signal,first.nextCursor)).nextCursor,undefined);
  state.pinnedChat='';assert.equal((await adapter.list(account,'oc_chat',signal)).items[0]?.messageId,'om_pin');
  state.pinnedChat='oc_else';await assert.rejects(adapter.list(account,'oc_chat',signal),/归属/);
  const original=await adapter.locate(account,'oc_chat','om_pin',signal);
  assert.equal(original.text,'测试原文');assert.equal(original.parentId,'om_parent');assert.equal(original.threadId,'omt_thread');
  state.deleted=true;assert.deepEqual(await adapter.locate(account,'oc_chat','om_pin',signal),{chatId:'oc_chat',messageId:'om_pin',deleted:true});
});
test('跨账号/跨会话/撤回/失去授权均不产生写入；只有主机确认后发原消息的一次写请求',async()=>{
  const {adapter,state,calls}=fixture();
  let guards=0;const write=(pinned:boolean)=>adapter.write(account,'oc_chat','om_pin',pinned,signal,async()=>{guards++});
  state.actor='ou_other';await assert.rejects(write(false),/账号已变化/);state.actor=account.openId;
  state.messageChat='oc_else';await assert.rejects(write(false),/所属会话/);state.messageChat='oc_chat';
  state.deleted=true;await assert.rejects(write(true),/撤回/);state.deleted=false;
  await assert.rejects(adapter.write(account,'oc_chat','om_pin',true,signal,async()=>{throw new Error('撤销授权')}),/撤销授权/);
  assert.equal(guards,0);assert.ok(!calls.some(a=>a.includes('pins')));
  assert.deepEqual(await write(true),{confirmed:true});assert.deepEqual(await write(false),{confirmed:true});
  assert.equal(guards,2);assert.equal(calls.filter(a=>a.includes('pins')).length,2);
  const argv=calls.find(a=>a.includes('create'))!;
  assert.deepEqual(JSON.parse(argv[argv.indexOf('--data')+1]!),{message_id:'om_pin'});
});
test('超时、矛盾的身份或目标回执均为未知，适配器不重试',async()=>{
  const {adapter,state,calls}=fixture();
  const write=()=>adapter.write(account,'oc_chat','om_pin',true,signal,async()=>{});
  state.throwWrite=true;await assert.rejects(write(),{delivery:'unknown'});
  state.throwWrite=false;state.breakReceipt=true;await assert.rejects(write(),{delivery:'unknown'});
  state.breakReceipt=false;state.wrongActor=true;await assert.rejects(write(),{delivery:'unknown'});
  assert.equal(calls.filter(a=>a.includes('create')).length,3);
});
test('置顶原消息仅展开同账号同话题，含已核实话题头、真实发言人与后一页撤回占位',async()=>{
  const {adapter,state,calls}=fixture(),read=(cursor?:string,thread?:string)=>adapter.topic(account,'oc_chat','om_pin',signal,cursor,thread);
  const page=await read();
  assert.equal(page.threadId,'omt_thread');assert.equal(page.root?.text,'话题开场');assert.equal(page.nextCursor,'t2');
  assert.deepEqual(page.messages,[{messageId:'om_child',text:'可读回复',senderName:'成员甲',createdAt:'2030-01-01T00:00:00.000Z',deleted:false}]);
  const next=await read(page.nextCursor,page.threadId);
  assert.deepEqual(next.messages,[{messageId:'om_erased',deleted:true}]); assert.equal(next.nextCursor,undefined);
  await assert.rejects(read('t2','omt_else'),{status:409});
  assert.equal(calls.filter(args=>args.includes('+threads-messages-list')).length,2);
  state.threadId='omt_other';await assert.rejects(read(),/范围/);state.threadId='omt_thread';
  state.threadChat='oc_other';await assert.rejects(read(),/范围/);state.threadChat='oc_chat';
  state.rootThread='omt_else';await assert.rejects(read(),/根消息/);state.rootThread='omt_thread';
  state.afterThreadActor='ou_other';await assert.rejects(read(),/账号已变化/);state.actor='ou_owner';
  state.deleted=true;await assert.rejects(read(),{status:410});
});

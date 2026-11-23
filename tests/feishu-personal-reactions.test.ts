import test from 'node:test';
import assert from 'node:assert/strict';
import {createPersonalReactions} from '../plugins/feishu-personal-reactions.ts';
import {PERSONAL_MESSAGE_SCOPES,PersonalAuthError,type PersonalCLI} from '../plugins/feishu-personal.ts';

const account={profile:'fixture',appId:'cli_fixture',openId:'ou_owner',name:'主人'};
const signal=new AbortController().signal;
const reaction=(reaction_id:string,operator_id:string,operator_type='user',emoji_type='SMILE')=>
  ({reaction_id,operator:{operator_id,operator_type},reaction_type:{emoji_type}});
function fixture() {
  const state={openId:'ou_owner',deleted:false,chatId:'oc_chat',timeOut:false,refused:false,wrongReceipt:false,changeAccount:false,
    pages:[[reaction('r_other','ou_peer'),reaction('r_bot','cli_bot','app')],[reaction('r_self','ou_owner')]]};
  const calls:string[][]=[];
  const run:PersonalCLI=async args=>{
    calls.push(args);
    assert.equal(args[1],account.profile);
    if (args.includes('auth')) return {identity:'user',verified:true,appId:account.appId,identities:{user:{
      available:true,openId:state.openId,scope:PERSONAL_MESSAGE_SCOPES.join(' ')}}};
    assert.equal(args[args.indexOf('--as')+1],'user');
    if (args.includes('GET')) return {code:0,data:{items:[{message_id:'om_source',chat_id:state.chatId,deleted:state.deleted}]}};
    assert.ok(args.includes('reactions'));assert.equal(args[args.indexOf('--message-id')+1],'om_source');
    if (args.includes('list')) {
      assert.equal(args[args.indexOf('--user-id-type')+1],'open_id');
      const index=args.includes('--page-token')?1:0;
      if (state.changeAccount) state.openId='ou_else';
      return {code:0,data:{items:state.pages[index],has_more:index+1<state.pages.length,page_token:'p2'}};
    }
    if (state.timeOut) throw new PersonalAuthError('timeout');
    if (state.refused) throw new PersonalAuthError('permissions',99991672);
    return {code:0,data:reaction('r_self',state.wrongReceipt?'ou_peer':'ou_owner')};
  };
  const adapter=createPersonalReactions(run);
  const write=(remove:boolean,before=async()=>{})=>adapter.write(account,'oc_chat','om_source','SMILE',remove,signal,before);
  const writes=()=>calls.filter(a=>a.includes('delete')||a.includes('create'));
  return {state,adapter,calls,write,writes};
}
test('可分页读取本人、其他用户与应用回应；恢复后用户身份改变时不返回该页',async()=>{
  const f=fixture();const list=(cursor?:string)=>f.adapter.list(account,'oc_chat','om_source',signal,cursor);
  const first=await list(),second=await list(first.nextCursor);
  assert.equal(first.nextCursor,'p2');assert.deepEqual(first.items.map(i=>[i.operatorType,i.mine]),[['user',false],['app',false]]);
  assert.deepEqual(second.items,[{reactionId:'r_self',emoji:'SMILE',operatorId:'ou_owner',operatorType:'user',mine:true}]);
  assert.equal(second.nextCursor,undefined);f.state.changeAccount=true;await assert.rejects(list(),{status:409});
});
test('同种表情按本人身份跨页去重，只会删除本人真实记录；目标状态已满足不写',async()=>{
  const f=fixture();let guards=0;const guard=async()=>{guards++};
  assert.deepEqual(await f.write(false,guard),{confirmed:true,changed:false});assert.equal(guards,0);
  assert.deepEqual(await f.write(true,guard),{confirmed:true,changed:true});
  const del=f.writes()[0]!;assert.equal(del[del.indexOf('--reaction-id')+1],'r_self');
  f.state.pages=[f.state.pages[0]!];assert.deepEqual(await f.write(true,guard),{confirmed:true,changed:false});
  assert.deepEqual(await f.write(false,guard),{confirmed:true,changed:true});
  const add=f.writes()[1]!;assert.deepEqual(JSON.parse(add[add.indexOf('--data')+1]!),{reaction_type:{emoji_type:'SMILE'}});
  assert.equal(guards,2);
});
test('跨会话、撤回、第三方冒用本人回应ID、过期授权均在发送前拒绝',async()=>{
  const f=fixture();
  f.state.chatId='oc_other';await assert.rejects(f.write(true),{status:404});f.state.chatId='oc_chat';
  f.state.deleted=true;await assert.rejects(f.write(true),{status:410});f.state.deleted=false;
  f.state.pages[0]!.push(reaction('r_self','ou_else'));await assert.rejects(f.write(true),/归属存在冲突/);
  f.state.pages[0]!.pop();await assert.rejects(f.write(true,async()=>{throw new Error('撤销授权')}),/撤销授权/);
  assert.equal(f.writes().length,0);
});
test('外发超时或回执含其他用户时结果未知，明确拒绝返回 no，每次请求只发送一次',async()=>{
  const f=fixture();
  f.state.timeOut=true;await assert.rejects(f.write(true),{delivery:'unknown'});
  f.state.timeOut=false;f.state.wrongReceipt=true;await assert.rejects(f.write(true),{delivery:'unknown'});
  f.state.refused=true;await assert.rejects(f.write(true),{delivery:'no'});
  assert.equal(f.writes().length,3);
});

import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type RequestListener} from 'node:http';
import type {AddressInfo} from 'node:net';
import {readUsageSource,normalizeUsageSourceURL} from '../plugins/usage-source-reader.ts';

async function local(t:TestContext,serve:RequestListener){
  const server=createServer(serve);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();}));
  return 'http://127.0.0.1:'+(server.address() as AddressInfo).port;
}
const signal=new AbortController().signal;
test('中转管理仅分页列出并批量读取存量窗口；统计去重，禁用和未请求的账号不入样本',async t=>{
  const paths:string[]=[];
  const url=await local(t,async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer test-secret');paths.push(req.url!);
    let data:unknown;
    if(req.method==='POST'){
      let body='';for await(const chunk of req)body+=chunk;
      assert.deepEqual(JSON.parse(body),{ids:['a','b'],refresh:false});
      data={accounts:[{account_id:'disabled',windows:[{kind:'5h',used_ratio:.9}]},
        {account_id:'a',plan_display_name:'Pro',error:'原始网关细节',windows:[
          {kind:'five_hour',used_ratio:.24,checked_at:'2020-01-01T00:00:00Z'},{kind:'5h',used_ratio:.29,checked_at:'2020-01-01T00:01:00Z'},
          {kind:'gemini_test_weekly',scope:'model',remaining:30,limit:100},{kind:'credits',used_ratio:.7}]},
        {account_id:'b',unsupported:true}]};
    } else data=req.url!.includes('after_id')?{accounts:[{id:'a'},{id:'b',provider:'x'}]}:
      {accounts:[{id:'a',name:'席位',provider:'CODEX'},{id:'disabled',provider:'skip',status:'disabled'}],next_after_id:'a &',next_after_priority:0};
    res.end(JSON.stringify(data));
  });
  const result=await readUsageSource({type:'relay',url:url+'/gateway',key:'test-secret'},signal);
  assert.equal(paths.length,3);assert.match(paths[1]!,/after_id=a\+%26&after_priority=0/);
  assert.equal(paths[2],'/gateway/api/admin/accounts/usage');
  assert.deepEqual(result.seen,{listed:3,accounts:1,windows:2,providers:{codex:1}});
  assert.deepEqual(result.accounts[0],{id:'a',name:'席位',provider:'codex',plan:'Pro',stale:true,sampledAt:'2020-01-01T00:01:00.000Z',
    windows:[{label:'5h',windowMinutes:300,usedPercent:29},{label:'7d',windowMinutes:10080,usedPercent:70,model:'gemini test'}]});
});
test('普通密钥只读 /me/usage，保留不共享与无读数的区别；generic 百分数无需乘100',async t=>{
  let hidden=false;
  const url=await local(t,(req,res)=>{
    assert.equal(req.method,'GET');
    if(req.url==='/relay/me/usage'){
      res.end(JSON.stringify(hidden?{account_quota_shared:false}:{accounts:[{account_id:'1',provider:'codex',plan:'pro',windows:[{kind:'hour',used_ratio:1}]},
        {account_id:'1'},{account_id:'2',provider:'x',windows:[]}],upstream:{ignored:true}}));
    } else {assert.equal(req.url,'/generic');res.end(JSON.stringify({accounts:[{name:'seat',provider:'TEST',sampled_at:'2099-01-01T00:00:00Z',
      windows:[{label:'7d',window_minutes:60,used_percent:.9},{window_minutes:45,used_percent:-1},{label:'7d',used_percent:99},{used_percent:null}]},
      {id:'empty',provider:'test',windows:[]}]}));}
  });
  const config={type:'relay_key' as const,url:url+'/relay/v1/'};
  const relay=await readUsageSource(config,signal);assert.equal(relay.accounts[0]?.name,'Codex Pro');assert.equal(relay.seen.listed,2);
  hidden=true;assert.deepEqual((await readUsageSource(config,signal)).seen,{accounts:0,windows:0,listed:0,providers:{},quotaHidden:true});
  const g=await readUsageSource({type:'generic',url:url+'/generic'},signal);
  assert.deepEqual(g.accounts[0]?.windows.map(w=>[w.label,w.usedPercent]),[['45m',0],['7d',.9]]);
  assert.ok(Date.parse(g.accounts[0]!.sampledAt!)<=Date.now());assert.equal(g.seen.listed,2);
});
test('异常状态、外站重定向、错误 JSON 与循环分页不会冒充成功或回显密钥',async t=>{
  let visits=0;const remote=await local(t,(_req,res)=>{visits++;res.end('{}');});
  const key='private-example-key';
  const url=await local(t,(req,res)=>{
    if(req.url==='/redirect')res.writeHead(302,{location:remote});
    if(req.url==='/echo'){res.end(JSON.stringify({accounts:[{name:key,provider:'test',windows:[{label:'1h',used_percent:1}]}]}));return;}
    if(req.url==='/denied')res.writeHead(403);
    if(req.url==='/too-big'){res.end('x'.repeat(8*1024*1024+1));return;}
    if(req.url==='/api/admin/accounts/usage'){res.end(JSON.stringify({accounts:[]}));return;}
    if(req.url?.includes('/api/admin/accounts?')){res.end(JSON.stringify({accounts:[{id:'a'}],next_after_id:'a'}));return;}
    res.end(key);
  });
  for(const [path,code] of [['redirect','redirect'],['denied','forbidden'],['bad','bad_response'],['echo','bad_response'],['too-big','too_large']] as const){
    await assert.rejects(readUsageSource({type:'generic',url:url+'/'+path,key},signal),e=>e instanceof Error && 'code'in e&&e.code===code&&!e.message.includes(key));
  }
  assert.equal(visits,0);assert.throws(()=>normalizeUsageSourceURL(url+'?token='+key),{code:'bad_config'});
  assert.deepEqual((await readUsageSource({type:'relay',url},signal)).seen,{accounts:0,windows:0,listed:1,providers:{},partial:true});
  await assert.rejects(readUsageSource({type:'generic',url},AbortSignal.abort()),{code:'aborted'});
});
test('管理网关过大或后续页失败时保留可验证读数；首请求失败和取消始终抛错',async t=>{
  const cancel=new AbortController();let mode='oversize';
  const url=await local(t,(req,res)=>{
    if(req.method==='POST'){
      res.end(JSON.stringify({accounts:[{account_id:'active',windows:[{kind:'hourly',used_ratio:.5}]}]}));return;
    }
    if(mode==='abort'&&req.url!.includes('after_id'))cancel.abort();
    if(mode==='first' || req.url!.includes('after_id')){res.writeHead(503).end();return;}
    const first={id:'active',provider:'test'};
    res.end(JSON.stringify(mode==='oversize'?{accounts:[first,...Array.from({length:2000},(_,i)=>({id:'d'+i,status:'disabled'}))]}:
      {accounts:[first],next_after_id:1}));
  });
  const config={url,type:'relay' as const};
  const large=await readUsageSource(config,signal);
  assert.deepEqual(large.seen,{listed:2000,windows:1,accounts:1,providers:{test:1},partial:true});
  mode='later';assert.deepEqual((await readUsageSource(config,signal)).seen,{...large.seen,listed:1});
  mode='first';await assert.rejects(readUsageSource(config,signal),{code:'server_error'});
  mode='abort';await assert.rejects(readUsageSource(config,cancel.signal),{code:'aborted'});
});
test('generic 可原样回读工作台 camelCase 用量结果，并保留采样时间与重置时间',async t=>{
  const sampledAt='2020-01-01T00:00:00.000Z',resetsAt='2020-01-02T00:00:00.000Z';
  const original={id:'seat',name:'示例席位',provider:'local',sampledAt,windows:[{label:'5h',windowMinutes:300,usedPercent:.35,resetsAt}]};
  const url=await local(t,(_req,res)=>res.end(JSON.stringify({accounts:[original]})));
  assert.deepEqual((await readUsageSource({type:'generic',url},signal)).accounts,[original]);
});

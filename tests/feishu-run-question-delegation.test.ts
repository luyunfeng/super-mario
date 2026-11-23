import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {startAgentNode} from '../apps/agent-node/src/index.ts';
import {startServer} from '../apps/server/src/index.ts';
import type {Card} from '../packages/core/src/interactions.ts';
import type {JsonObject,Message,Run} from '../packages/protocol/src/index.ts';
import type {FeishuOptions} from '../plugins/feishu.ts';

test('飞书「你来定」核验原卡，显示督办依据和实际送达；Web 发起也能回到同卡由本人确认或拒绝',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-fs-delegate-')),token='fixture',owner='ou_owner',chat='oc_owner';
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const data=JSON.parse(raw);
    const content=data.tools?.length ? '收到。' : JSON.stringify({action:'choose',answers:[{selected:['乙']}],assumption:'原执行只涉及本地合成文件'});
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,finish_reason] of [[{role:'assistant',content},null],[{},'stop']])res.write('data: '+JSON.stringify({
      id:'fixture',model:'fixture',created:1,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));const address=provider.address();assert.ok(address && typeof address==='object');
  const cards=new Map<string,any>(),inputs:string[]=[];
  let client:FeishuOptions,receipt:JsonObject={requested:true};
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,token,demo:false,
    model:{provider:'openai-compatible',model:'fixture',apiKey:'fixture',baseUrl:'http://127.0.0.1:'+address.port+'/v1'}},{botFactory:opts=>{
    client=opts;
    return {async start(){},async close(){},async collect(){return [];},status:()=>({connected:true}),
      async send(_target,_text,ctx){const id=randomUUID();ctx?.beforeSend?.();if(ctx?.card)cards.set(id,ctx.card);ctx?.onSent?.(id,ctx?.card?'interactive':'text');},
      async updateCard(id,card){assert.ok(cards.has(id));cards.set(id,card);}};
  }});
  const machineId='local';
  const node=startAgentNode({machineId,name:'合成执行端',token,url:server.url,dataDir:join(dir,'node'),
    executors:[{id:'codex',name:'协议替身',machineId,mode:'real',kind:'cli',available:true,description:'',defaultCwd:dir}],
    handlers:{'executor.start':async()=>({sessionId:randomUUID()}),'executor.input':async value=>{inputs.push(String(value.text));return receipt;}}});
  t.after(async()=>{await node.close();await server.close();provider.closeAllConnections();await new Promise<void>(done=>provider.close(()=>done()));await rm(dir,{recursive:true,force:true});});
  const app=server.app;
  await t.waitFor(()=>assert.ok(server.machines.list().some(row=>row.online)),{timeout:10000});
  const bot=await server.bots.create({name:'合成',appId:'cli_1212121212121212',appSecret:'fixture',scope:{kind:'global'},requireConfirmation:false});
  const speak=(text:string)=>client.onMessage(text,{messageId:randomUUID(),chatId:chat,senderId:owner,chatType:'p2p',senderType:'user'});
  await speak(bot.pairingCode!);await speak('/new 合成执行原文');
  const source=app.store.list<Message>('messages').find(row=>row.role==='user' && row.text==='合成执行原文')!;
  app.policies.write({},{ladder:['user']});
  const post=(path:string,body:unknown)=>fetch(server.url+'/api/v1'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  for(const mode of ['内部','未知回执','拒绝','确认']) {
    const external=['拒绝','确认'].includes(mode);
    const run=app.dispatch({executorId:machineId+'/codex',executionMode:'interactive',cwd:dir,conversationId:source.conversationId,sourceMessageId:source.id,prompt:'仅在本地核对样例'});
    await t.waitFor(()=>assert.ok(app.store.get<Run>('runs',run.id)?.sessionId),{timeout:10000});
    const response=await post('/interactions',{kind:'question',title:mode+'问题',body:'核对样例',runId:run.id,
      deadline:'2m',reversible:true,externallyVisible:external,questions:[{question:'采用哪种？',recommend:'甲',options:[{label:'甲'},{label:'乙'}]}]});
    const raw=await response.text();assert.equal(response.status,201,raw);
    const q=JSON.parse(raw) as Card;
    const original=()=>[...cards].find(([,card])=>card.body?.elements && JSON.stringify(card).includes(q.id));
    await t.waitFor(()=>assert.ok(original()),{timeout:10000});const [id]=original()!;
    const data=(label:string)=>cards.get(id).body.elements.find((el:any)=>el.text?.content===label)?.behaviors[0]?.value;
    const click=(value:Record<string,unknown>,messageId=id,operatorId=owner)=>client.onCardAction!({chatId:chat,operatorId,messageId,value});
    const ask=data('你来定');assert.ok(ask);
    click(ask,id,'ou_other');click(ask,'om_other');click({...ask,version:q.version+1});
    assert.equal(app.store.get<Card>('interactions',q.id)?.delegationRequestedAt,undefined);
    const before=inputs.length;
    receipt=mode==='未知回执'?{}:{requested:true};
    if (external) {
      const web=await post('/interactions/'+q.id+'/delegate',{version:q.version});assert.equal(web.status,200,await web.text());
      await t.waitFor(()=>assert.ok(data('是，采用推荐选项')),{timeout:10000});
      assert.ok(app.store.get<Card>('interactions',q.id)?.ownerConfirmation);
      assert.equal(inputs.length,before);
      const yes=data('是，采用推荐选项'),no=data('否，返回原题');
      click(yes,id,'ou_other');click({...yes,accept:'true'});assert.equal(inputs.length,before);
      if(mode==='拒绝'){
        click(no);await t.waitFor(()=>assert.ok(!data('是，采用推荐选项')),{timeout:10000});
        assert.equal(inputs.length,before);assert.equal(app.store.get<Card>('interactions',q.id)?.status,'open');
        click(data('乙'));
      }else click(yes);
    } else assert.match(JSON.stringify(click(ask)),/督办决定/);
    await t.waitFor(()=>assert.equal(app.store.get<Card>('interactions',q.id)?.delivery,mode==='未知回执'?'unknown':'confirmed'),{timeout:10000});
    if(mode==='未知回执') await t.waitFor(()=>assert.ok(app.store.get<Card>('interactions',q.id)?.error?.includes('未确认')),{timeout:10000});
    await t.waitFor(()=>assert.match(JSON.stringify(cards.get(id)),mode==='未知回执'?/是否收到尚未确认/:/执行机已确认收到/),{timeout:10000});
    if(!external){
      assert.match(JSON.stringify(cards.get(id)),/督办已代选/);
      assert.match(JSON.stringify(cards.get(id)),/原执行只涉及本地合成文件/);
    }
    await t.waitFor(()=>assert.equal(inputs.length,before+1),{timeout:10000});
    const answered=app.store.get<Card>('interactions',q.id)!;
    assert.equal(answered.answeredBy,external?'user_feishu':'supervisor_delegated');
    assert.deepEqual(answered.answers,[{selected:[mode==='确认'?'甲':'乙']}]);
    assert.doesNotMatch(JSON.stringify(cards.get(id)),/workbench.answerQuestion|workbench.confirmDelegation/);
  }
});

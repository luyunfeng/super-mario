import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {startServer} from '../apps/server/src/index.ts';

test('主人读取已关联来源的评论，切换账号或插件后丢弃在途结果',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'source-comments-'));
  const peopleGate=join(dir,'people-gate'),writeDenied=join(dir,'write-denied'),preflight=join(dir,'preflight'),actorFile=join(dir,'actor'),uncertain=join(dir,'unknown'),gate=join(dir,'hold'),denied=join(dir,'denied'),calls=join(dir,'calls');
  await writeFile(join(dir,'lark-cli'),`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--verify')){
  const openId=fs.existsSync(${JSON.stringify(actorFile)})?fs.readFileSync(${JSON.stringify(actorFile)},'utf8'):'one';
  if(openId==='unverified')process.exit(1);
  console.log(JSON.stringify({identity:'user',verified:true,appId:'app',identities:{user:{available:true,openId,userName:'样例主人'}}}));process.exit(0);
}
if(args[args.indexOf('--as')+1]!=='user'||args[args.indexOf('--profile')+1]!=='synthetic') process.exit(1);
const command=args[1]==='file.comments'||args[1]==='file.comment.replys'?args[2]:args[1];fs.appendFileSync(${JSON.stringify(calls)},command+'\\n');
if(args[0]==='contact' && command==='+search-user'){
  const people=[{open_id:'ou_fixture',localized_name:'合成同名',department:'合成部门'},{open_id:'ou_other',localized_name:'合成同名'}];
  const send=()=>console.log(JSON.stringify({ok:true,identity:'user',data:{users:people,has_more:false}}));
  if(fs.existsSync(${JSON.stringify(peopleGate)})){const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(peopleGate)})){clearInterval(timer);send();}},10);}
  else send();return;
}
const reply=()=>{
if(fs.existsSync(${JSON.stringify(denied)})||(command==='create_v2' && fs.existsSync(${JSON.stringify(writeDenied)}))){console.error(JSON.stringify({error:{type:'authorization',message:'private-provider-output'}}));process.exitCode=1;return;}
const data=command==='+inspect'?{type:'docx',token:'Doc1'}:command==='create_v2'?(fs.existsSync(${JSON.stringify(uncertain)})?{}:{comment_id:'created-thread'}):{file_token:'Doc1',file_type:'docx',has_more:false,items:[{comment_id:'comment1',quote:'合成引文',is_solved:true,reply_list:{replies:[{user_name:'样例作者',content:{elements:[{type:'text_run',text:'合成评论'}]}}]}}]};
console.log(JSON.stringify({ok:true,identity:'user',data}));};
const hold=command==='+list-comments'?${JSON.stringify(gate)}:command==='+inspect'?${JSON.stringify(preflight)}:undefined;
if(hold&&fs.existsSync(hold)){const timer=setInterval(()=>{if(!fs.existsSync(hold)){clearInterval(timer);reply();}},10);}else reply();
`,{mode:0o700});
  const old=process.env.PATH;process.env.PATH=dir;
  const config={host:'127.0.0.1',port:0,dataDir:join(dir,'db'),token:'synthetic-test',demo:true};
  let server=await startServer(config);
  t.after(async()=>{try {await server.close();} finally {if(old===undefined) delete process.env.PATH;else process.env.PATH=old;await rm(dir,{recursive:true,force:true});}});
  const app=server.app, page=await app.knowledge().put({layer:'personal',title:'样本',content:'无授权链接'}),
    other=await app.knowledge().put({layer:'personal',title:'伪造关联',content:'https://internal.example/docx/Doc1'});
  const job=app.knowledgeCurator.addSource({title:'来源',url:'https://internal.example/docx/Doc1'});
  app.store.put('knowledge.sources',job.id,{...job,knowledgeIds:[page.id],status:'completed'});
  const base=server.url+'/api/v1/knowledge/'+page.id+'/sources',url=base+'/'+job.id+'/comments';
  const headers={authorization:'Bearer synthetic-test'};
  const get=(path=url)=>fetch(path,{headers});
  const observed=async()=>(await readFile(calls,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean);
  assert.equal((await fetch(url)).status,401);
  assert.equal((await get()).status,400);
  app.knowledgeSources.configure({enabled:false,trustedHosts:['internal.example']});
  assert.equal((await (await get(base)).json()).sources[0].supportsComments,true);
  assert.equal((await get()).status,409);
  assert.equal((await get(url.replace(page.id,other.id))).status,404);
  assert.equal((await get(url+'?url=https://another.example/docx/Other')).status,400);
  let openId='one';app.setKnowledgeSourceAccount(()=>({profile:'synthetic',openId,appId:'app'}));
  app.knowledgeSources.configure({enabled:true,trustedHosts:['internal.example']});
  await assert.rejects(app.plugins.invocations.use('knowledge-local.document.comments',{url:job.url!}),{status:403});
  assert.deepEqual(await observed(),[]);
  const ready=await get();assert.equal(ready.status,200);
  const {binding,documentId,actorName,...visible}=await ready.json();
  assert.match(binding,/^[a-f0-9]{64}$/);assert.equal(documentId,'Doc1');assert.equal(actorName,'样例主人');
  assert.deepEqual(visible,{threads:[{id:'comment1',quote:'合成引文',resolved:true,replies:[{author:'样例作者',text:'合成评论'}]}],truncated:false});
  assert.equal((await fetch(url+'?token=synthetic-test')).status,200);
  await writeFile(denied,'deny');
  const rejected=await get();assert.equal(rejected.status,403);assert.doesNotMatch(await rejected.text(),/private-provider-output/);
  await rm(denied);
  const baseWrite={documentId,binding,requestId:'success-1',action:{kind:'create',text:'仅此合成评论正文'}};
  const endpoint=()=>server.url+'/api/v1/knowledge/'+page.id+'/sources/'+job.id+'/comments';
  const post=(data:object,media='application/json')=>fetch(endpoint(),{method:'POST',headers:{...headers,'content-type':media},body:JSON.stringify(data)});
  assert.equal((await post(baseWrite,'text/plain')).status,415);
  await writeFile(actorFile,'other');
  assert.equal((await post(baseWrite)).status,409);
  assert.equal((await get()).status,409);
  await writeFile(actorFile,'unverified');
  const readOnly=await (await get()).json();assert.equal(readOnly.binding,undefined);assert.equal(readOnly.documentId,'Doc1');
  await rm(actorFile);
  // Profile credentials can change between the read-only document inspection and the write.
  const callCount=(await observed()).length;
  await writeFile(preflight,'hold');
  const pausedWrite=post({...baseWrite,requestId:'changed-during-inspect'});
  const deadline=Date.now()+6000;
  while((await observed()).length===callCount){assert.ok(Date.now()<deadline);await delay(10);}
  await writeFile(actorFile,'other');await rm(preflight);
  const refused=await pausedWrite;assert.equal((await refused.json()).code,'COMMENT_NOT_SENT');
  await rm(actorFile);
  for(const res of await Promise.all([post(baseWrite),post(baseWrite)])){
    assert.equal(res.status,200);
    assert.deepEqual(await res.json(),{confirmed:true,threadId:'created-thread'});
  }
  const counted=async()=>(await observed()).filter(a=>a==='create_v2').length;
  assert.equal(await counted(),1);
  assert.doesNotMatch(JSON.stringify(app.effects.list()),/仅此合成评论正文|synthetic-test|internal.example/);
  const conflict=await post({...baseWrite,action:{kind:'create',text:'不同合成文字'}});
  assert.equal((await conflict.json()).code,'COMMENT_NOT_SENT');
  await writeFile(uncertain,'yes');
  const unknown={...baseWrite,requestId:'unknown-1'};
  const firstUnknown=await post(unknown);assert.equal((await firstUnknown.json()).code,'COMMENT_DELIVERY_UNKNOWN');
  assert.equal(await counted(),2);
  async function held(change:()=>Promise<void>|void) {
    const count=(await observed()).length;
    await writeFile(gate,'hold');
    const pending=get(endpoint());
    const deadline=Date.now()+8000;
    while((await observed()).length<count+2){assert.ok(Date.now()<deadline,'未进入评论读取');await delay(10);}
    await change();await rm(gate);
    const res=await pending;assert.ok([404,409,503].includes(res.status));assert.doesNotMatch(await res.text(),/合成评论/);
  }
  // Same durable receipts survive reconstruction. Reconfigure only the synthetic verified identity.
  await server.close();server=await startServer(config);
  server.app.setKnowledgeSourceAccount(()=>({profile:'synthetic',openId,appId:'app'}));
  assert.equal((await post(baseWrite)).status,200);
  const retried=await post(unknown);assert.equal((await retried.json()).code,'COMMENT_DELIVERY_UNKNOWN');
  assert.equal(await counted(),2);
  await rm(uncertain);
  const search=(value:object,where=endpoint())=>fetch(where+'/people',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(value)});
  const lookup={documentId,binding,query:'同名'};
  assert.equal((await search({...lookup,documentId:'wrong'})).status,409);
  assert.equal((await search({...lookup,query:'  '})).status,400);
  let wrapperMode='bypass',wrapped=0;
  server.app.plugins.register({id:'test-comment-directory',name:'合成通讯录中间件',capabilities:[],dependencies:['knowledge-local'],activate(context){
    context.wrap('knowledge-local.document.comments',async (input,next)=>{
      wrapped++;
      if(wrapperMode==='pass')return next(input);
      if(wrapperMode==='replace'){
        const result=await next(input) as {people:{openId:string}[]};
        result.people[0]!.openId='ou_invented';
        return result;
      }
      return {people:[{openId:'ou_invented',name:'伪造人员'}],truncated:false};
    });
  }});
  await server.app.plugins.start();
  const noEvidence=await search(lookup);
  assert.equal(noEvidence.status,502);assert.doesNotMatch(await noEvidence.text(),/ou_invented|proof/);
  wrapperMode='replace';
  const changedReceipt=await search(lookup);assert.equal(changedReceipt.status,502);
  assert.doesNotMatch(await changedReceipt.text(),/ou_invented|proof/);
  wrapperMode='pass';
  const found=await search(lookup);assert.equal(found.status,200);
  const directory=await found.json();assert.equal(directory.people.length,2);assert.equal(directory.truncated,false);
  assert.equal(wrapped,3);assert.ok(directory.people.every((p:{openId:string})=>p.openId!=='ou_invented'));
  await server.app.plugins.setEnabled('test-comment-directory',false);
  const [person,second]=directory.people;const {department,...first}=person;assert.equal(department,'合成部门');assert.equal(first.name,second.name);assert.notEqual(first.proof,second.proof);
  function mentioned(candidate:Record<string,unknown>,start=2){return {...baseWrite,requestId:'mention-write',action:{kind:'create',text:'🍏@合成同名',mentions:[{...candidate,start}]}};}
  const forged=await post(mentioned({...first,openId:second.openId}));assert.equal(forged.status,409);
  assert.equal((await post(mentioned({...first,name:'更名'}))).status,409);
  assert.equal((await post(mentioned(first,1))).status,400);
  const otherJob=server.app.knowledgeCurator.addSource({title:'其他来源',url:'https://internal.example/docx/Doc1'});
  server.app.store.put('knowledge.sources',otherJob.id,{...otherJob,knowledgeIds:[other.id],status:'completed'});
  const otherPath=server.url+'/api/v1/knowledge/'+other.id+'/sources/'+otherJob.id+'/comments';
  const otherBinding=(await (await get(otherPath)).json()).binding;
  const crossed=await fetch(otherPath,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({...mentioned(first),binding:otherBinding})});
  assert.equal(crossed.status,409);
  assert.equal((await post(mentioned(first))).status,200);
  const changedPerson=await post(mentioned(second));assert.equal(changedPerson.status,409);assert.equal(await counted(),3);
  assert.doesNotMatch(JSON.stringify(server.app.effects.list()),/ou_fixture|合成同名|合成部门/);
  const prior=(await observed()).length;
  await writeFile(peopleGate,'hold');
  const inFlight=search(lookup);
  const peopleDeadline=Date.now()+5000;
  while((await observed()).length===prior){assert.ok(Date.now()<peopleDeadline);await delay(10);}
  await writeFile(actorFile,'changed');await rm(peopleGate);
  const discarded=await inFlight;assert.equal(discarded.status,409);assert.doesNotMatch(await discarded.text(),/ou_fixture/);await rm(actorFile);
  server.app.knowledgeSources.configure({enabled:true,profile:'synthetic',trustedHosts:['internal.example']});
  await held(()=>writeFile(actorFile,'another-account'));
  await rm(actorFile);
  server.app.knowledgeSources.configure({enabled:true,trustedHosts:['internal.example']});
  await held(()=>{openId='two';});
  openId='one';
  await held(async()=>{await server.app.plugins.setEnabled('knowledge-local',false);await server.app.plugins.setEnabled('knowledge-local',true);});
  assert.equal((await post(baseWrite)).status,409);
  openId='one';const current=await (await get(endpoint())).json();
  await writeFile(writeDenied,'deny');
  const refusedByCloud=await post({...baseWrite,binding:current.binding,requestId:'write-access-denied'});
  const reason=await refusedByCloud.json();assert.equal(reason.code,'COMMENT_NOT_SENT');assert.match(reason.error,/权限|授权/);
  assert.doesNotMatch(reason.error,/private-provider-output/);
  await held(()=>{server.app.store.put('knowledge.sources',job.id,{...job,knowledgeIds:[other.id],status:'completed'});});
});

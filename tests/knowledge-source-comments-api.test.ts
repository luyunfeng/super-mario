import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {startServer} from '../apps/server/src/index.ts';

test('主人读取已关联来源的评论，切换账号或插件后丢弃在途结果',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'source-comments-'));
  const gate=join(dir,'hold'),denied=join(dir,'denied'),calls=join(dir,'calls');
  await writeFile(join(dir,'lark-cli'),`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args[args.indexOf('--as')+1]!=='user'||args[args.indexOf('--profile')+1]!=='synthetic') process.exit(1);
const command=args[1];fs.appendFileSync(${JSON.stringify(calls)},command+'\\n');
const reply=()=>{
if(fs.existsSync(${JSON.stringify(denied)})){console.error(JSON.stringify({error:{type:'authorization',message:'private-provider-output'}}));process.exitCode=1;return;}
const data=command==='+inspect'?{type:'docx',token:'Doc1'}:{file_token:'Doc1',file_type:'docx',has_more:false,items:[{comment_id:'comment1',quote:'合成引文',is_solved:true,reply_list:{replies:[{user_name:'样例作者',content:{elements:[{type:'text_run',text:'合成评论'}]}}]}}]};
console.log(JSON.stringify({ok:true,identity:'user',data}));};
if(command==='+list-comments'&&fs.existsSync(${JSON.stringify(gate)})){const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);reply();}},10);}else reply();
`,{mode:0o700});
  const old=process.env.PATH;process.env.PATH=dir;
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:join(dir,'db'),token:'synthetic-test',demo:true});
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
  const ready=await get();assert.equal(ready.status,200);assert.deepEqual(await ready.json(),{threads:[{id:'comment1',quote:'合成引文',resolved:true,replies:[{author:'样例作者',text:'合成评论'}]}],truncated:false});
  assert.equal((await fetch(url+'?token=synthetic-test')).status,200);
  await writeFile(denied,'deny');
  const rejected=await get();assert.equal(rejected.status,403);assert.doesNotMatch(await rejected.text(),/private-provider-output/);
  await rm(denied);
  async function held(change:()=>Promise<void>|void) {
    const count=(await observed()).length;
    await writeFile(gate,'hold');
    const pending=get();
    const deadline=Date.now()+8000;
    while((await observed()).length<count+2){assert.ok(Date.now()<deadline,'未进入评论读取');await delay(10);}
    await change();await rm(gate);
    const res=await pending;assert.ok([404,409,503].includes(res.status));assert.doesNotMatch(await res.text(),/合成评论/);
  }
  await held(()=>{openId='two';});
  await held(async()=>{await app.plugins.setEnabled('knowledge-local',false);await app.plugins.setEnabled('knowledge-local',true);});
  await held(()=>{app.store.put('knowledge.sources',job.id,{...job,knowledgeIds:[other.id],status:'completed'});});
});

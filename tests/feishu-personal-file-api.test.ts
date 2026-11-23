import assert from 'node:assert/strict';
import {access,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';
import {createPersonalFileReader} from '../plugins/feishu-personal-file.ts';
import {PersonalAuthError,PERSONAL_MESSAGE_SCOPES,type PersonalProvider} from '../plugins/feishu-personal.ts';

test('本人收件按在线原消息读取附件，跨号、错群及下载期间撤回均无法取得正文',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mario-file-api-test-'));
  const account={appId:'cli_fixture',profile:'fixture',openId:'ou_owner',name:'合成账号'};
  const provider:PersonalProvider={
    application:async()=>account,begin:async()=>({url:'https://accounts.feishu.cn/oauth/v1/device/verify',code:'fake',expiresIn:120}),
    complete:async()=>account,verify:async()=>account,collect:async()=>[],
  };
  const chat='oc_fixture',id='om_fixture',body='合成正文'.repeat(4100),bytes=Buffer.from(body);
  let remoteChat=chat,deleted=false,recallDuringDownload=false,remoteType='file',downloadMode='ok',downloads=0,lastDir='';
  const reader=createPersonalFileReader(async(args,options)=>{
    assert.equal(args[args.indexOf('--profile')+1],account.profile);
    if(args.includes('--verify')) return {appId:account.appId,identity:'user',verified:true,
      identities:{user:{available:true,openId:account.openId,scope:PERSONAL_MESSAGE_SCOPES.join(' ')}}};
    assert.equal(args[args.indexOf('--as')+1],'user');
    if(args.includes('GET')) return {code:0,data:{items:[{message_id:id,chat_id:remoteChat,deleted,msg_type:remoteType,
      body:{content:JSON.stringify({file_key:'file_synthetic',file_name:'合成.txt'})}}]}};
    assert.ok(args.includes('+messages-resources-download'));
    assert.equal(args[args.indexOf('--file-key')+1],'file_synthetic');
    assert.equal(args[args.indexOf('--message-id')+1],id);
    assert.equal(options.maxFileBytes,8*1024*1024);
    lastDir=options.cwd!;downloads++;
    if(downloadMode==='denied') throw new PersonalAuthError('permissions');
    if(downloadMode==='missing') return {ok:true,data:{size_bytes:bytes.length}};
    await writeFile(join(lastDir,args[args.indexOf('--output')+1]!),bytes);
    if(recallDuringDownload) deleted=true;
    return {ok:true,identity:'user',data:{size_bytes:bytes.length}};
  });
  const server=await startServer({host:'127.0.0.1',port:0,dataDir:dir,demo:true,token:'fixture'},
    {personalProvider:provider,personalFileReader:reader});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  server.personal.authorize();await t.waitFor(()=>assert.equal(server.personal.status().status,'connected'));
  const source='feishu:'+account.appId+':'+account.openId,foreign='feishu:cli_fixture:ou_other';
  const thing={title:'合成文件',text:'采集附件',last:id,thread:'feishu:message:'+JSON.stringify([chat,id]),origin:{connector:'飞书',kind:'direct' as const,chatId:chat}};
  for(const s of [source,foreign]) await server.app.inbox.ingest(s,[thing]);
  const path=(s:string)=>server.url+'/api/v1/inbox/'+server.app.inbox.list().find(r=>r.source===s)!.id+'/file-text';
  const get=(s=source)=>fetch(path(s),{headers:{authorization:'Bearer fixture'}});
  assert.equal((await fetch(path(source))).status,401);
  assert.equal((await get(foreign)).status,404);
  remoteChat='oc_mismatch';assert.equal((await get()).status,404);remoteChat=chat;
  remoteType='text';assert.equal((await get()).status,422);remoteType='file';assert.equal(downloads,0);
  const response=await get();assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{name:'合成.txt',text:body.slice(0,16000),truncated:true});
  await assert.rejects(access(lastDir));
  downloadMode='missing';const missing=await get();assert.equal(missing.status,502);
  assert.equal((await missing.json()).error,'下载未生成可读取的附件');await assert.rejects(access(lastDir));
  downloadMode='denied';assert.equal((await get()).status,403);
  downloadMode='ok';recallDuringDownload=true;assert.equal((await get()).status,410);await assert.rejects(access(lastDir));
});

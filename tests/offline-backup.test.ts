import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';
import JSZip from 'jszip';
import {startServer} from '../apps/server/src/index.ts';

const binary=Buffer.from([0,255,4,10,127,128]);
const secret='fixture-backup-private-value-9361';
const cli=fileURLToPath(new URL('../bin/super-mario.js',import.meta.url));
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const execute=promisify(execFile);

test('离线 CLI 备份校验并异地恢复 SQLite、知识原文和附件，拒绝异常归档和非空目标',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mario-backup-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'original'),archive=join(root,'snapshot.zip'),restored=join(root,'restored');
  async function run(args:string[],success=true){
    let ok=true,output='',result='';
    try{
      const {stdout,stderr}=await execute(process.execPath,[cli,'backup',...args],{cwd:root,env:{
        PATH:process.env.PATH,HOME:root,SUPER_MARIO_DEV:'1'
      },timeout:15000});
      output=stdout+stderr;result=stdout;
    }catch(e){
      const error=e as {code?:number;stdout?:string;stderr?:string};
      assert.equal(typeof error.code,'number','CLI 应给出明确退出码');
      ok=false;output=(error.stdout??'')+(error.stderr??'');
    }
    assert.ok(!output.includes(secret),'CLI 不应回显合成凭据');
    assert.equal(ok,success,output);
    return result;
  }
  const config={host:'127.0.0.1',port:0,dataDir:source,demo:true,token:'fixture'};
  const host=await startServer(config);
  const raw='合成原始资料：时间与数量由负责人复核。';
  let pageId:string,jobId:string,messageId:string;
  try{
    const page=await host.app.knowledge().put({title:'合成知识',content:'归档结论',layer:'personal'});
    pageId=page.id;
    const job=host.app.knowledgeCurator.addSource({title:'合成原始资料',text:raw,layer:'personal'});
    jobId=job.id;
    host.app.store.put('knowledge.sources',job.id,{...job,status:'completed',knowledgeIds:[page.id]});
    const rawDir=join(source,'plugins','knowledge-local','raw');
    await mkdir(rawDir,{recursive:true});await writeFile(join(rawDir,job.id+'.md'),raw);
    const headers={authorization:'Bearer fixture'};
    const upload=await fetch(host.url+'/api/v1/chat-files/uploads?conversationId=main&name=fixture.bin',{
      method:'PUT',headers:{...headers,'content-type':'application/octet-stream'},body:binary});
    assert.equal(upload.status,201);
    const {uploadId}=await upload.json();
    const response=await fetch(host.url+'/api/v1/messages',{method:'POST',headers:{...headers,'content-type':'application/json'},
      body:JSON.stringify({text:'合成附件',files:[{uploadId}]})});
    assert.equal(response.status,202);
    messageId=(await response.json()).id;
    host.app.store.put('backup.synthetic','value',{credential:secret});
    await writeFile(join(source,'runtime.env'),'SUPER_MARIO_TOKEN='+secret+'\n');
  }finally{await host.close();}
  await run(['create','--data-dir',source,'--output',archive]);
  await run(['verify',archive]);
  const inspected=JSON.parse(await run(['inspect',archive]));
  assert.equal(inspected.coverage.database,true);
  assert.ok(inspected.coverage.knowledgeFiles>=2);
  assert.equal(inspected.coverage.chatFiles,1);
  assert.equal((await stat(archive)).mode&0o077,0);
  const zip=await JSZip.loadAsync(await readFile(archive));
  const names=Object.keys(zip.files).filter(key=>!zip.files[key].dir);
  assert.equal(names.at(-1),'manifest.json');
  const manifestText=await zip.file('manifest.json')!.async('string');
  assert.ok(!manifestText.includes(secret));
  const manifest=JSON.parse(manifestText) as {format:string;version:number;files:{path:string;size:number;sha256:string}[]};
  assert.equal(manifest.format,'super-mario-backup');assert.equal(manifest.version,1);
  assert.deepEqual(manifest.files.map(f=>'data/'+f.path).sort(),names.filter(n=>n!=='manifest.json').sort());
  for(const f of manifest.files){
    const bytes=await zip.file('data/'+f.path)!.async('nodebuffer');
    assert.equal(sha(bytes),f.sha256);assert.equal(bytes.length,f.size);
  }
  await rename(source,source+'-moved');
  await run(['restore',archive,'--data-dir',restored]);
  for(const name of ['', 'workbench.sqlite','runtime.env','chat-files','chat-files/'+sha(binary)]){
    assert.equal((await stat(join(restored,name))).mode&0o077,0);
  }
  assert.equal(await readFile(join(restored,'runtime.env'),'utf8'),'SUPER_MARIO_TOKEN='+secret+'\n');
  const reopened=await startServer({...config,dataDir:restored});
  try{
    assert.deepEqual(reopened.app.store.get('backup.synthetic','value'),{credential:secret});
    const headers={authorization:'Bearer fixture'};
    const original=await fetch(reopened.url+'/api/v1/knowledge/'+pageId+'/sources/'+jobId,{headers});
    assert.equal(original.status,200);assert.equal((await original.json()).content,raw);
    const file=await fetch(reopened.url+'/api/v1/messages/'+messageId+'/files/0?conversationId=main',{headers});
    assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),binary);
  }finally{await reopened.close();}
  const sentinel=join(restored,'untouched');
  await writeFile(sentinel,'保留原有文件');
  await run(['restore',archive,'--data-dir',restored],false);
  assert.equal(await readFile(sentinel,'utf8'),'保留原有文件');

  // 用相同长度的条目名替换 ZIP 本地头及中央目录；JSZip 的高级 API 会覆盖同名条目。
  const payload=async()=>{
    const result=new JSZip();
    for(const name of names.filter(n=>n!=='manifest.json')) result.file(name,await zip.file(name)!.async('nodebuffer'),{createFolders:false});
    return result;
  };
  const duplicate=await payload();
  duplicate.file('data/runtime.enx',await zip.file('data/runtime.env')!.async('nodebuffer'),{createFolders:false});
  duplicate.file('manifest.json',manifestText);
  const repeated=await duplicate.generateAsync({type:'nodebuffer'});
  let offset=0;
  while((offset=repeated.indexOf('data/runtime.enx',offset))>=0){offset+=repeated.write('data/runtime.env',offset);}
  const badHash=await payload();
  badHash.file('data/chat-files/'+sha(binary),Buffer.alloc(binary.length),{createFolders:false});
  badHash.file('manifest.json',manifestText);
  const badDb=await payload(),dbBytes=Buffer.from('corrupt synthetic database');
  badDb.file('data/workbench.sqlite',dbBytes,{createFolders:false});
  badDb.file('manifest.json',JSON.stringify({...manifest,files:manifest.files.map(f=>f.path==='workbench.sqlite'
    ? {...f,size:dbBytes.length,sha256:sha(dbBytes)}:f)}));
  const dbArchive=join(root,'invalid-db.zip'),dbTarget=join(root,'invalid-db-target');
  await writeFile(dbArchive,await badDb.generateAsync({type:'nodebuffer'}));
  await run(['restore',dbArchive,'--data-dir',dbTarget],false);
  await assert.rejects(stat(join(dbTarget,'workbench.sqlite')),{code:'ENOENT'});
  const outside=await payload(),escaped=Buffer.from('must stay in archive');
  outside.file('data/../../escaped',escaped,{createFolders:false});
  outside.file('manifest.json',JSON.stringify({...manifest,files:[...manifest.files,{path:'../../escaped',size:escaped.length,sha256:sha(escaped)}]}));
  for(const [name,bytes] of [
    ['hash',await badHash.generateAsync({type:'nodebuffer'})],
    ['duplicate',repeated],
    ['traversal',await outside.generateAsync({type:'nodebuffer'})]
  ] as const){
    const bad=join(root,name+'.zip'),target=join(root,'failed-'+name);
    await writeFile(bad,bytes);
    await run(['verify',bad],false);await run(['restore',bad,'--data-dir',target],false);
    await assert.rejects(stat(join(target,'workbench.sqlite')),{code:'ENOENT'});
  }
  await assert.rejects(stat(join(root,'escaped')),{code:'ENOENT'});
});

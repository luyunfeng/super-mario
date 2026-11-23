import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {scrypt} from 'node:crypto';
import {createStore} from '../packages/core/src/store.ts';
import {createAdminAuth} from '../apps/server/src/admin-auth.ts';

const first='示例口令-例一甲乙',second='示例口令-例二丙丁';
test('首次设置码10分钟过期，重签取代旧码，竞争首设只签一份会话；限制按码点及字节计',async t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const auth=createAdminAuth(store);let now=Date.now();t.mock.method(Date,'now',()=>now);
  assert.equal(auth.configured(),false);
  const expired=auth.issueCode();now+=600_000;await assert.rejects(auth.setup(expired,first),{status:401});
  const old=auth.issueCode(),code=auth.issueCode();await assert.rejects(auth.setup(old,first),{status:401});
  await assert.rejects(auth.setup(code,'😀'.repeat(7)),{status:400});
  await assert.rejects(auth.setup(code,'😀'.repeat(65)),{status:400});
  const results=await Promise.allSettled([auth.setup(code,first),auth.setup(code.toLowerCase().replace('-',' '),first)]);
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
  assert.ok(results.some(v=>v.status==='rejected' && v.reason.status===409));
  assert.equal(auth.configured(),true);assert.throws(()=>auth.issueCode(),{status:409});
  const login=await auth.login(first);assert.deepEqual(auth.session(login.token),{csrf:login.csrf,expiresAt:login.expiresAt});
  now=login.expiresAt;assert.equal(auth.session(login.token),undefined);
});
test('重启可登录，SQLite 无明文；改密撤销所有旧会话并换发，退出导致在途改密失效',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'admin-auth-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const dbPath=join(dir,'db.sqlite');let store=createStore(dbPath);t.after(()=>store.close());
  let auth=createAdminAuth(store);const code=auth.issueCode(),receipt=await auth.setup(code,first);
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const records=JSON.stringify(db.prepare("SELECT * FROM documents WHERE collection LIKE 'core.admin-auth.%'").all());
    assert.match(records,/argon2id-v1|scrypt-v1/);
    for(const secret of [first,code,receipt.token,receipt.csrf])assert.ok(!records.includes(secret));
  } finally {db.close();}
  store.close();store=createStore(dbPath);auth=createAdminAuth(store);
  assert.ok(auth.session(receipt.token));
  const peer=await auth.login(first);
  await assert.rejects(auth.change(receipt.token,second,first),{status:401});
  const abandoned=auth.change(peer.token,first,second);auth.logout(peer.token);
  await assert.rejects(abandoned,{status:401});
  const before=await auth.login(first);
  const fresh=await auth.change(receipt.token,first,second);
  assert.equal(auth.session(receipt.token),undefined);assert.equal(auth.session(before.token),undefined);assert.ok(auth.session(fresh.token));
  await assert.rejects(auth.login(first),{status:401});assert.ok(await auth.login(second));
  auth.logout(fresh.token);assert.equal(auth.session(fresh.token),undefined);
});
test('计算密码期间设置码被重新签发时，旧请求不能完成首设',async t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const auth=createAdminAuth(store);const pending=auth.setup(auth.issueCode(),first),next=auth.issueCode();
  await assert.rejects(pending,{status:401});
  assert.equal(auth.configured(),false);assert.ok(await auth.setup(next,first));
});
test('密码派生最多同时两次，额外请求不会创建会话',async t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const auth=createAdminAuth(store);await auth.setup(auth.issueCode(),first);
  const one=auth.login(first),two=auth.login(first);
  await assert.rejects(auth.login(first),{status:503});
  const results=await Promise.all([one,two]);
  for(const value of results)assert.ok(auth.session(value.token));
});
test('可用 Argon2id 的运行环境仍可校验旧 scrypt 记录',async t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const salt=Buffer.alloc(16,1);
  const hash=await new Promise<Buffer>((resolve,reject)=>scrypt(first,salt,32,{N:1<<17,r:8,p:1,maxmem:144*1024*1024},
    (err,result)=>err?reject(err):resolve(result)));
  store.put('core.admin-auth.settings','password',{algorithm:'scrypt-v1',salt:salt.toString('hex'),hash:hash.toString('hex')});
  const auth=createAdminAuth(store),login=await auth.login(first);
  assert.ok(auth.session(login.token));
});

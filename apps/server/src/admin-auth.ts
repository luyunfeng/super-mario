import * as crypto from 'node:crypto';
import type {Store} from '../../../packages/plugin-sdk/src/index.ts';

type Algorithm='argon2id-v1'|'scrypt-v1';
type Verifier={algorithm:Algorithm;salt:string;hash:string};
type StoredSession={digest:string;expiresAt:number};
type Code={digest:string;expiresAt:number};
const settings='core.admin-auth.settings',sessions='core.admin-auth.sessions';
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sha256=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
const csrfFor=(token:string)=>crypto.createHmac('sha256',token).update('super-mario.admin.csrf.v1').digest('base64url');
const sessionHours=12;
let hashing=0;

function fail(status:number,message:string):never {throw Object.assign(new Error(message),{status});}
function checkNewPassword(value:string) {
  if(typeof value!=='string' || !value.trim() || Buffer.byteLength(value)>256 || [...value].length<8)
    fail(400,'管理员密码至少需要 8 个字符，最多 256 字节');
}
async function derive(password:string,salt:Buffer,algorithm:Algorithm):Promise<Buffer> {
  if(hashing>=2)fail(503,'密码校验繁忙，请稍后重试');
  hashing++;
  try {
    return await new Promise<Buffer>((resolve,reject)=>{
      const done=(err:Error|null,key:Buffer)=>err?reject(err):resolve(key);
      if(algorithm==='argon2id-v1' && typeof crypto.argon2==='function'){
        crypto.argon2('argon2id',{message:password,nonce:salt,memory:19*1024,passes:2,parallelism:1,tagLength:32},done);
      }else if(algorithm==='scrypt-v1'){
        crypto.scrypt(password,salt,32,{N:1<<17,r:8,p:1,maxmem:144*1024*1024},done);
      }else fail(503,'此运行环境无法校验已存储的管理员密码');
    });
  } finally {hashing--;}
}
async function newVerifier(password:string):Promise<Verifier> {
  const salt=crypto.randomBytes(16);
  const algorithm=typeof crypto.argon2==='function'?'argon2id-v1':'scrypt-v1';
  const key=await derive(password,salt,algorithm);
  return {algorithm,salt:salt.toString('hex'),hash:key.toString('hex')};
}
async function checkPassword(password:string,credential:Verifier) {
  if(typeof password!=='string' || Buffer.byteLength(password)>256)fail(401,'管理员密码不正确');
  if(!/^[0-9a-f]{32}$/.test(credential.salt)||!/^[0-9a-f]{64}$/.test(credential.hash))fail(503,'管理员密码记录无法读取');
  const key=await derive(password,Buffer.from(credential.salt,'hex'),credential.algorithm);
  if(!crypto.timingSafeEqual(key,Buffer.from(credential.hash,'hex')))fail(401,'管理员密码不正确');
}
// The plugin host reserves this collection prefix for server-owned authentication.
export function createAdminAuth(store:Store) {
  const verifier=()=>store.get<Verifier>(settings,'password');
  const configured=()=>!!verifier();
  function issueCode() {
    return store.transaction(()=>{
      if(configured())fail(409,'管理员密码已设置');
      const chars=[...crypto.randomBytes(8)].map(b=>alphabet[b&31]).join('');
      store.put<Code>(settings,'code',{digest:sha256(chars),expiresAt:Date.now()+600_000});
      return chars.slice(0,4)+'-'+chars.slice(4);
    });
  }
  function checkCode(code:string) {
    if(configured())fail(409,'管理员密码已设置');
    const saved=store.get<Code>(settings,'code');
    const chars=typeof code==='string' && code.length<=32 ? code.replace(/[- ]/g,'').toUpperCase() : '';
    if(chars.length!==8 || !saved || saved.expiresAt<=Date.now() ||
       !crypto.timingSafeEqual(Buffer.from(sha256(chars)),Buffer.from(saved.digest)))fail(401,'首次设置码不正确或已过期');
  }
  function startSession() {
    const now=Date.now();
    for(const item of store.list<StoredSession>(sessions))if(item.expiresAt<=now)store.remove(sessions,item.digest);
    const token=crypto.randomBytes(32).toString('base64url'),digest=sha256(token),expiresAt=now+sessionHours*3_600_000;
    store.put<StoredSession>(sessions,digest,{digest,expiresAt});
    return {token,csrf:csrfFor(token),expiresAt};
  }
  function session(token:string) {
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return;
    const digest=sha256(token),saved=store.get<StoredSession>(sessions,digest);
    if(!saved || saved.digest!==digest)return;
    if(saved.expiresAt<=Date.now()){store.remove(sessions,digest);return;}
    return {csrf:csrfFor(token),expiresAt:saved.expiresAt};
  }
  function logout(token:string) {
    if(typeof token==='string' && /^[A-Za-z0-9_-]{43}$/.test(token))store.remove(sessions,sha256(token));
  }
  async function setup(code:string,password:string) {
    checkCode(code);
    checkNewPassword(password);
    const next=await newVerifier(password);
    return store.transaction(()=>{
      // The code may expire or be reissued while hashing; the password may be claimed elsewhere.
      checkCode(code);
      store.put(settings,'password',next);
      store.remove(settings,'code');
      return startSession();
    });
  }
  function unchanged(original:Verifier) {
    const current=verifier();
    if(!current || original.hash!==current.hash || original.salt!==current.salt || original.algorithm!==current.algorithm)
      fail(409,'管理员密码已变更，请重新登录');
  }
  async function login(password:string) {
    const current=verifier();
    if(!current)fail(409,'请先设置管理员密码');
    await checkPassword(password,current);
    return store.transaction(()=>{unchanged(current);return startSession();});
  }
  async function change(token:string,currentPassword:string,newPassword:string) {
    const current=verifier();
    if(!session(token)||!current)fail(401,'管理员会话已失效');
    await checkPassword(currentPassword,current);
    checkNewPassword(newPassword);
    const next=await newVerifier(newPassword);
    return store.transaction(()=>{
      if(!session(token))fail(401,'管理员会话已失效');
      unchanged(current);
      store.put(settings,'password',next);
      for(const item of store.list<StoredSession>(sessions))store.remove(sessions,item.digest);
      return startSession();
    });
  }
  return {configured,issueCode,setup,login,change,session,logout};
}

import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {startServer} from '../apps/server/src/index.ts';

test('独立管理入口仅本机可申请初始化码；Cookie、来源和 CSRF 共同保护后续操作',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'admin-auth-http-')),root='synthetic-root';
  const server=await startServer({host:'127.0.0.1',port:0,dataDir,token:root,demo:true});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const url=server.url+'/api/v1/admin/';
  const send=(path:string,input?:object,headers:Record<string,string>={})=>fetch(url+path,{method:input?'POST':'GET',
    headers:{...(input&&{'content-type':'application/json'}),...headers},body:input&&JSON.stringify(input)});
  const bearer={authorization:'Bearer '+root};
  assert.deepEqual(await(await send('state')).json(),{configured:false,authenticated:false});
  assert.equal((await send('overview',undefined,bearer)).status,401);
  assert.equal((await send('setup-code?token='+root,{})).status,403);
  assert.equal((await send('setup-code',{}, {...bearer,forwarded:'for=127.0.0.1'})).status,403);
  assert.equal((await send('setup-code',{}, {...bearer,'x-forwarded-for':'127.0.0.1'})).status,403);
  assert.equal((await send('setup-code',{}, {...bearer,origin:'https://unrelated.invalid'})).status,403);
  assert.equal((await send('setup-code',{}, {...bearer,'content-type':'text/plain'})).status,415);
  // fetch normalizes Host; use a real HTTP request to present the proxy's external authority.
  async function issueAtHost(host:string) {
    return new Promise<number>((resolve,reject)=>{
      const request=httpRequest(url+'setup-code',{method:'POST',headers:{...bearer,host,'content-type':'application/json'}},res=>{
        res.resume();resolve(res.statusCode!);
      });
      request.on('error',reject);request.end('{}');
    });
  }
  assert.equal(await issueAtHost('public.example:443'),403);
  assert.equal(await issueAtHost('localhost'),200);
  assert.equal(await issueAtHost('[::1]:31000'),200);
  const issue=await send('setup-code',{}, {...bearer,origin:server.url});assert.equal(issue.status,200);
  const {code}=await issue.json(),password='Synthetic-Admin-Test-First',next='Synthetic-Admin-Test-Second';
  const setup=await send('setup',{code,password});assert.equal(setup.status,200);assert.match(setup.headers.get('cache-control')!,/no-store/);
  const raw=setup.headers.get('set-cookie')!;assert.match(raw,/HttpOnly/i);assert.match(raw,/SameSite=Strict/i);assert.match(raw,/Path=\/api\/v1\/admin\//);
  const {csrf}=await setup.json(),cookie=raw.split(';')[0]!;
  assert.deepEqual(await(await send('overview',undefined,{cookie})).json(),{version:'0.1.0'});
  assert.equal((await fetch(server.url+'/api/v1/state',{headers:{cookie}})).status,401);
  assert.equal((await send('password',{currentPassword:password,newPassword:next},{cookie})).status,403);
  assert.equal((await send('logout',{},{cookie,'x-csrf-token':csrf,'sec-fetch-site':'cross-site'})).status,403);
  const changed=await send('password',{currentPassword:password,newPassword:next},{cookie,'x-csrf-token':csrf});assert.equal(changed.status,200);
  assert.equal((await send('overview',undefined,{cookie})).status,401);
  const newCookie=changed.headers.get('set-cookie')!.split(';')[0]!,newCsrf=(await changed.json()).csrf;
  assert.notEqual(cookie,newCookie);assert.notEqual(csrf,newCsrf);
  const signedOut=await send('logout',{},{cookie:newCookie,'x-csrf-token':newCsrf});
  assert.equal(signedOut.status,200);assert.match(signedOut.headers.get('set-cookie')!,/Max-Age=0/);
  assert.equal((await send('overview',undefined,{cookie:newCookie})).status,401);
  assert.equal((await send('login',{password})).status,401);
  const login=await send('login',{password:next},{'x-forwarded-proto':'https',origin:server.url.replace('http:','https:')});
  assert.equal(login.status,200);assert.match(login.headers.get('set-cookie')!,/; Secure/);
  let limited=false;
  for(let i=0;i<12;i++){
    const r=await send('login',{password:'wrong-password-synthetic'});
    if(r.status===429){assert.ok(Number(r.headers.get('retry-after'))>0);limited=true;break;}
    assert.equal(r.status,401);
  }
  assert.ok(limited);
});

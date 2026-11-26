import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import QRCode from 'qrcode';
import {startServer} from '../apps/server/src/index.ts';

test('管理员公开地址跨重启保留，配对二维码与复制地址一致，清空后使用本次来源',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'admin-network-http-'));
  const root='synthetic-network-owner',password='synthetic-local-admin-password';
  const config={host:'127.0.0.1',port:0,dataDir,token:root,demo:true};
  let server=await startServer(config);
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  const request=(path:string,input?:object,headers:Record<string,string>={})=>fetch(server.url+'/api/v1/admin/'+path,{
    method:input?'POST':'GET',headers:{...(input&&{'content-type':'application/json'}),...headers},
    body:input&&JSON.stringify(input),
  });
  const bearer={authorization:'Bearer '+root};
  async function session(response:Response){
    assert.equal(response.status,200);
    return {cookie:response.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token':(await response.json()).csrf};
  }
  assert.equal((await request('network',undefined,bearer)).status,401);
  assert.equal((await request('network',{publicOrigin:''},bearer)).status,401);
  const code=await(await request('setup-code',{},bearer)).json();
  let admin=await session(await request('setup',{code:code.code,password}));
  const initial=await(await request('network',undefined,admin)).json();
  assert.equal(initial.publicOrigin,'');assert.equal(initial.listen,new URL(server.url).host);
  const publicOrigin='https://fixture-network.invalid';
  assert.equal((await request('network',{publicOrigin},{cookie:admin.cookie})).status,403);
  assert.equal((await request('network',{publicOrigin},{...admin,origin:'https://different.invalid'})).status,403);
  assert.equal((await request('network',{publicOrigin:publicOrigin+'/private/path'},admin)).status,400);
  const updated=await request('network',{publicOrigin:publicOrigin+'/'},admin);
  assert.equal(updated.status,200);assert.equal((await updated.json()).publicOrigin,publicOrigin);
  await server.close();server=await startServer(config);
  admin=await session(await request('login',{password}));
  assert.equal((await(await request('network',undefined,admin)).json()).publicOrigin,publicOrigin);
  async function checkInvite(configured:string){
    const issued=await request('devices/pairings',{name:'合成配对设备'},{...admin,origin:server.url});
    assert.equal(issued.status,201);
    const result=await issued.json();
    assert.equal(result.publicOrigin,configured);
    const expected=new URL(configured||server.url);
    assert.equal(result.qrOrigin,expected.origin);assert.ok(result.code);
    expected.hash='home?'+new URLSearchParams({browserPair:result.code});
    const expectedImage=await QRCode.toDataURL(expected.href,{width:240,margin:4,errorCorrectionLevel:'M'});
    assert.ok(result.qrDataUrl===expectedImage,'二维码应编码和复制入口相同的完整配对链接');
  }
  await checkInvite(publicOrigin);
  // A plain HTTP address outside the loopback is refused with the reason, and what was saved
  // before stays as it was.
  for (const refused of ['http://remote.invalid', 'https://user:secret@remote.invalid', 'https://remote.invalid/path', 'ftp://remote.invalid']) {
    const rejected = await request('network', { publicOrigin: refused }, admin);
    assert.equal(rejected.status, 400, refused);
    assert.match(JSON.stringify(await rejected.json()), /HTTPS|回环/, refused);
  }
  assert.equal((await (await request('network', undefined, admin)).json()).publicOrigin, publicOrigin);
  const cleared=await request('network',{publicOrigin:''},admin);
  assert.equal(cleared.status,200);assert.equal((await cleared.json()).publicOrigin,'');
  // Changing the address does not cut off the administrator who changed it: the same
  // session goes on reading and writing.
  const stillOpen = await request('network', { publicOrigin: 'https://later.invalid' }, admin);
  assert.equal(stillOpen.status, 200, 'the session that changed the address stays signed in');
  assert.equal((await stillOpen.json()).publicOrigin, 'https://later.invalid');
  assert.equal((await (await request('network', undefined, admin)).json()).publicOrigin, 'https://later.invalid');
  assert.equal((await request('network', { publicOrigin: '' }, admin)).status, 200);
  await checkInvite('');
});

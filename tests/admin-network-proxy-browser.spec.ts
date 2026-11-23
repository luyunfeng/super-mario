import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {chromium,expect} from '@playwright/test';
import {startServer} from '../apps/server/src/index.ts';

test('本机 HTTPS 反向代理保留独立的浏览器地址、后端 HTTP 监听及配对授权', {timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'admin-network-proxy-'));
  const cleanup:Array<()=>void|Promise<unknown>>=[()=>rm(dir,{recursive:true,force:true})];
  t.after(async()=>{for(const close of cleanup.reverse())await close();});
  const key=join(dir,'tls.key'),cert=join(dir,'tls.crt');
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
    '-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert]);
  const token='synthetic-proxy-admin-token',password='synthetic-proxy-admin-password';
  const server=await startServer({dataDir:join(dir,'data'),port:0,host:'127.0.0.1',token,demo:true});
  cleanup.push(()=>server.close());
  // Preserve the browser's Host and Origin while terminating TLS on loopback.
  const proxy=createHttpsServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{
    const upstream=httpRequest(server.url+req.url,{method:req.method,headers:{...req.headers,'x-forwarded-proto':'https'}},response=>{
      res.writeHead(response.statusCode!,response.headers);response.pipe(res);
    });
    upstream.on('error',()=>{res.writeHead(502).end();});
    req.pipe(upstream);
  });
  await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  cleanup.push(()=>{proxy.closeAllConnections();return new Promise<void>(resolve=>proxy.close(()=>resolve()));});
  const address=proxy.address();assert.ok(address && typeof address==='object');
  const origin='https://127.0.0.1:'+address.port;
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  cleanup.push(()=>browser.close());
  const admin=await browser.newContext({ignoreHTTPSErrors:true});
  const headers={authorization:'Bearer '+token};
  const denied=await admin.request.post(origin+'/api/v1/admin/setup-code',{headers,data:{}});
  assert.equal(denied.status(),403);
  const direct=server.url+'/api/v1/admin/';
  const code=await fetch(direct+'setup-code',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'});
  assert.equal(code.status,200);
  const setup=await fetch(direct+'setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:(await code.json()).code,password})});
  assert.equal(setup.status,200);
  const page=await admin.newPage();await page.goto(origin+'/admin.html');
  await page.getByLabel('管理员密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  const network=page.getByRole('region',{name:'网络设置'});
  await network.getByRole('button',{name:'查看网络设置'}).click();
  await expect(network.getByText(origin,{exact:true})).toBeVisible();
  await expect(network.getByText('HTTPS',{exact:true})).toBeVisible();
  await expect(network.getByText(new URL(server.url).host,{exact:true})).toBeVisible();
  await expect(network.getByText(server.url,{exact:true})).toBeVisible();
  const devices=page.getByRole('region',{name:'浏览器设备'});
  await devices.getByRole('button',{name:'读取设备列表'}).click();
  await devices.getByLabel('设备名称').fill('代理合成设备');
  await devices.getByRole('button',{name:'生成配对链接'}).click();
  const link=new URL(await devices.getByLabel('一次性配对链接').inputValue());
  assert.equal(link.origin,origin);
  const recipient=await browser.newContext({ignoreHTTPSErrors:true});
  const pairing=await recipient.newPage();
  await pairing.goto(link.href);
  const redeemed=pairing.waitForResponse(res=>res.url()===origin+'/api/v1/public/browser-pair');
  await pairing.getByRole('button',{name:'确认连接这台浏览器'}).click();
  assert.equal((await redeemed).status(),201);
  await devices.getByRole('button',{name:'刷新设备'}).click();
  await expect(devices.getByRole('article',{name:'代理合成设备'})).toBeVisible();
});

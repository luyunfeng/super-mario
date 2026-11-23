import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {isIP} from 'node:net';
import type {createAdminAuth} from './admin-auth.ts';

const base='/api/v1/admin/',cookieName='sm_admin_session';
function fail(status:number,message:string):never{throw Object.assign(new Error(message),{status});}
function exact(left:string|undefined,right:string) {
  if(!left)return false;
  const a=Buffer.from(left),b=Buffer.from(right);
  return a.length===b.length && timingSafeEqual(a,b);
}
function loopback(address:string){
  const ip=address.replace(/^::ffff:/i,'');
  return ip==='::1'||(isIP(ip)===4 && ip.startsWith('127.'));
}
function localHost(host:string|undefined){
  if(!host)return false;
  const match=/^(localhost|\[::1\]|[0-9.]+)(?::([0-9]{1,5}))?$/i.exec(host);
  if(!match || (match[2] && (Number(match[2])<1 || Number(match[2])>65535)))return false;
  const name=match[1]!.toLowerCase();
  return name==='localhost' || name==='[::1]' || loopback(name);
}
function secure(req:IncomingMessage) {
  // Only the actual TLS socket or an HTTPS terminator on this machine may select secure transport.
  return ('encrypted' in req.socket && req.socket.encrypted===true) ||
    (loopback(req.socket.remoteAddress??'') && req.headers['x-forwarded-proto']==='https');
}
function sameOrigin(req:IncomingMessage) {
  const origin=req.headers.origin,site=req.headers['sec-fetch-site'];
  if(site && site!=='none' && site!=='same-origin')fail(403,'管理请求必须来自同一站点');
  if(origin!==undefined){
    let expected:string;
    try{expected=new URL((secure(req)?'https://':'http://')+req.headers.host).origin;}catch{fail(403,'管理请求来源无效');}
    if(origin!==expected)fail(403,'管理请求来源无效');
  }
}
function sessionToken(req:IncomingMessage){
  const matching=(req.headers.cookie??'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(cookieName+'='));
  return matching.length===1?matching[0]!.slice(cookieName.length+1):'';
}
function cookie(req:IncomingMessage,res:ServerResponse,token:string,expiresAt:number) {
  const seconds=Math.max(0,Math.ceil((expiresAt-Date.now())/1000));
  res.setHeader('set-cookie',cookieName+'='+token+'; Path='+base+'; HttpOnly; SameSite=Strict; Max-Age='+seconds+(secure(req)?'; Secure':''));
}
export function createAdminRoutes(auth:ReturnType<typeof createAdminAuth>,rootToken:string|undefined,
  readBody:(req:IncomingMessage,limit:number)=>Promise<Record<string,unknown>>,
  json:(res:ServerResponse,status:number,value:unknown)=>void) {
  // Reserve a slot before the password hash starts, so concurrent guesses count as well.
  const attempts=new Map<string,{count:number;until:number}>();
  async function limited<T>(req:IncomingMessage,res:ServerResponse,operation:()=>Promise<T>):Promise<T> {
    const now=Date.now(),address=req.socket.remoteAddress??'unknown';
    for(const [key,bucket] of attempts)if(bucket.until<=now)attempts.delete(key);
    const keys=loopback(address)?[address]:[address,'all-remote'];
    const buckets=keys.map(key=>[key,attempts.get(key)??{count:0,until:now+60000}] as const);
    for(const [key,b] of buckets)if(b.count>=(key==='all-remote'?80:8)){
      res.setHeader('retry-after',String(Math.max(1,Math.ceil((b.until-now)/1000))));
      fail(429,'管理登录尝试过多，请稍后重试');
    }
    for(const [key,b] of buckets){b.count++;attempts.set(key,b);}
    const result=await operation();
    for(const [key,b] of buckets){b.count--;if(!b.count && attempts.get(key)===b)attempts.delete(key);}
    return result;
  }
  return async(req:IncomingMessage,res:ServerResponse,path:string)=>{
    res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');
    const action=path.slice(base.length),token=sessionToken(req),session=token?auth.session(token):undefined;
    if(req.method==='GET'){
      if(action==='state')return json(res,200,{configured:auth.configured(),authenticated:!!session,...(session && {csrf:session.csrf,expiresAt:session.expiresAt})});
      if(action==='overview'){
        if(!session)fail(401,'请先登录管理界面');
        return json(res,200,{version:'0.1.0'});
      }
    }
    if(!['setup-code','setup','login','password','logout'].includes(action))fail(404,'管理接口不存在');
    if(req.method!=='POST')fail(405,'此管理操作需要 POST');
    sameOrigin(req);
    if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')fail(415,'管理操作需要 JSON 请求');
    if(action==='setup-code'){
      const proxy=Object.keys(req.headers).some(k=>k==='forwarded'||k==='via'||k.startsWith('x-forwarded-')||['x-real-ip','cf-connecting-ip','true-client-ip','x-client-ip'].includes(k));
      if(!rootToken || !loopback(req.socket.remoteAddress??'') || !localHost(req.headers.host) || proxy || req.headersDistinct.authorization?.length!==1 ||
        !exact(req.headers.authorization,'Bearer '+rootToken))fail(403,'请在服务器本机使用工作台主令牌获取初始化码');
    }
    const fields=action==='setup'?['code','password']:action==='login'?['password']:action==='password'?['currentPassword','newPassword']:[];
    const input=await readBody(req,8192);
    if(Object.keys(input).some(k=>!fields.includes(k)) || fields.some(k=>typeof input[k]!=='string'))fail(400,'管理请求字段无效');
    if(action==='setup-code')return json(res,200,{code:auth.issueCode()});
    if(action==='password'||action==='logout'){
      const current=auth.session(token);
      if(!current)fail(401,'请先登录管理界面');
      if(req.headersDistinct['x-csrf-token']?.length!==1||!exact(req.headers['x-csrf-token'] as string|undefined,current.csrf))fail(403,'管理请求的 CSRF 验证失败');
      if(action==='logout'){
        auth.logout(token);cookie(req,res,'',0);return json(res,200,{configured:auth.configured(),authenticated:false});
      }
    }
    const result=await limited(req,res,()=>action==='setup'?auth.setup(input.code as string,input.password as string):
      action==='login'?auth.login(input.password as string):auth.change(token,input.currentPassword as string,input.newPassword as string));
    cookie(req,res,result.token,result.expiresAt);
    return json(res,200,{configured:true,authenticated:true,csrf:result.csrf,expiresAt:result.expiresAt});
  };
}

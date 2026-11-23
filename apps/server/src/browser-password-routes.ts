import type {IncomingMessage, ServerResponse} from 'node:http';
import {sameOrigin} from './admin-routes.ts';
import type {createBrowserPassword} from './browser-password.ts';

type Budget = {attempts:number; until:number};
const windowMs=60_000;
function fail(status:number,message:string):never { throw Object.assign(new Error(message),{status}); }

/** Both halves cost an attempt. A verified login releases its own reservations;
 * abandoned starts and wrong proofs keep theirs until the window ends. */
export function createPublicPasswordRoutes(password:ReturnType<typeof createBrowserPassword>,rootToken:string|undefined,
  deviceRevision:()=>number,readBody:(req:IncomingMessage,max:number)=>Promise<Record<string,unknown>>,
  json:(res:ServerResponse,status:number,value:unknown)=>void) {
  const budgets=new Map<string,Budget>();
  const starts=new Map<string,{until:number;release:()=>void}>();
  function reserve(req:IncomingMessage,res:ServerResponse) {
    const now=Date.now();
    for(const [key,b] of budgets)if(b.until<=now)budgets.delete(key);
    for(const [id,b] of starts)if(b.until<=now)starts.delete(id);
    const keys=['all',req.socket.remoteAddress??'unknown'];
    const costs=keys.map(key=>({key,b:budgets.get(key)??{attempts:0,until:now+windowMs}}));
    for(const {key,b} of costs)if(b.attempts>=(key==='all'?160:16)){
      res.setHeader('retry-after',String(Math.max(1,Math.ceil((b.until-now)/1000))));
      fail(429,'设备登录尝试过多，请稍后重试');
    }
    for(const {key,b} of costs){b.attempts++;budgets.set(key,b);}
    return ()=>{
      for(const {key,b} of costs)if(budgets.get(key)===b && --b.attempts===0)budgets.delete(key);
    };
  }
  return async (req:IncomingMessage,res:ServerResponse,path:string)=>{
    res.setHeader('cache-control','no-store');
    res.setHeader('referrer-policy','no-referrer');
    const action=path.slice('/api/v1/public/password/'.length);
    if(action==='state' && req.method==='GET'){
      let enabled=false;
      if(rootToken)try {deviceRevision();enabled=password.state().enabled;}
      catch(error){if((error as {status?:number})?.status!==503)throw error;}
      return json(res,200,{enabled});
    }
    if(action!=='start' && action!=='finish')fail(404,'设备登录接口不存在');
    if(req.method!=='POST')fail(405,'设备登录需要 POST');
    sameOrigin(req);
    if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')fail(415,'设备登录需要 JSON 请求');
    if(!rootToken)fail(403,'请先配置工作台访问令牌');
    const generation=deviceRevision();
    const input=await readBody(req,8192);
    if(deviceRevision()!==generation)fail(409,'设备配对设置已变化');
    if(Object.keys(input).length!==2 || typeof input.message!=='string')fail(400,'设备登录请求无效');
    if(action==='start'){
      if(typeof input.name!=='string')fail(400,'请提供设备名称');
      const release=reserve(req,res);
      const result=await password.loginStart(input.name,input.message);
      if(deviceRevision()!==generation)fail(409,'设备配对设置已变化');
      starts.set(result.session,{until:Date.now()+windowMs,release});
      return json(res,200,result);
    }
    if(typeof input.session!=='string')fail(400,'请提供登录会话');
    const release=reserve(req,res);
    const result=await password.loginFinish(input.session,input.message);
    if(deviceRevision()!==generation)fail(409,'设备配对设置已变化');
    starts.get(input.session)?.release();
    starts.delete(input.session);
    release();
    return json(res,200,result);
  };
}

import {randomBytes} from 'node:crypto';
import * as opaque from '@serenity-kit/opaque';
import type {Store} from '../../../packages/plugin-sdk/src/index.ts';

const collection='core.admin-auth.browser-password',userIdentifier='super-mario-browser';
const lifetime=5*60_000,capacity=128;
type Config={revision:string;enabled:boolean;serverSetup:string;registrationRecord:string};
type Flow={revision:string;epoch:number;expiresAt:number} & (
  {kind:'register';adminId:string;setup:string} | {kind:'login';name:string;serverState:string}
);
const randomId=()=>randomBytes(24).toString('base64url');
function fail(status:number,message:string):never{throw Object.assign(new Error(message),{status});}
function wire(message:string,length:number) {
  if(typeof message!=='string'||message.length!==length||!/^[A-Za-z0-9_-]+$/.test(message)||
      Buffer.from(message,'base64url').toString('base64url')!==message)fail(400,'密码协议消息无效');
  return message;
}
export function createBrowserPassword<T>(
  store:Store,devices:{issuePassword(name:string):T;revokePasswordDevices():()=>void},deviceRevision:()=>number
) {
  const flows=new Map<string,Flow>();
  let expiryTimer:ReturnType<typeof setTimeout>|undefined;
  const config=()=>store.get<Config>(collection,'config');
  const revision=()=>config()?.revision??'0';
  function state(){
    const current=config();
    return {enabled:current?.enabled===true,configured:!!current,revision:current?.revision??'0'};
  }
  function checkRevision(value:string){
    if(value!==revision())fail(409,'浏览器密码设置已变化，请刷新');
  }
  function expireFlows(){
    const now=Date.now();
    for(const [id,flow] of flows)if(flow.expiresAt<=now)flows.delete(id);
  }
  function scheduleExpiry(){
    if(expiryTimer || !flows.size)return;
    const oldest=flows.values().next().value!;
    expiryTimer=setTimeout(()=>{
      expiryTimer=undefined;
      expireFlows();
      scheduleExpiry();
    },Math.max(1,oldest.expiresAt-Date.now()));
    expiryTimer.unref();
  }
  function reserve(){
    expireFlows();
    if(flows.size>=capacity)fail(503,'等待完成的密码握手过多，请稍后重试');
  }
  function bind(flow:Flow,message:string){
    const session=randomId();
    flows.set(session,flow);
    scheduleExpiry();
    return {session,message};
  }
  function take(session:string,kind:Flow['kind'],adminId?:string){
    const flow=flows.get(session);
    if(!flow||flow.kind!==kind||flow.kind==='register'&&flow.adminId!==adminId)fail(401,'密码握手无效或已结束');
    flows.delete(session);
    if(flow.expiresAt<=Date.now()||flow.epoch!==deviceRevision()||flow.revision!==revision())fail(401,'密码握手无效或已结束');
    return flow;
  }
  // Device rows and password settings share a database. Close sockets only once both mutations have committed.
  function save(next:Config,previous:string,revoke:boolean,epoch:number) {
    if(typeof revoke!=='boolean')fail(400,'请选择是否撤销已登录设备');
    const disconnect=store.transaction(()=>{
      if(deviceRevision()!==epoch)fail(409,'设备登录设置已变化，请重新操作');
      checkRevision(previous);
      store.put(collection,'config',next);
      return revoke?devices.revokePasswordDevices():undefined;
    });
    flows.clear();
    clearTimeout(expiryTimer);
    expiryTimer=undefined;
    disconnect?.();
    return state();
  }
  async function registerStart(adminId:string,message:string,previous:string){
    if(typeof adminId!=='string'||!adminId)fail(401,'请重新登录管理界面');
    await opaque.ready;
    const epoch=deviceRevision();
    checkRevision(previous);
    const registrationRequest=wire(message,43);
    reserve();
    const setup=opaque.server.createSetup();
    let response:string;
    try {response=opaque.server.createRegistrationResponse({userIdentifier,serverSetup:setup,registrationRequest}).registrationResponse;}
    catch{fail(400,'密码注册请求无效');}
    return bind({kind:'register',adminId,setup,revision:previous,epoch,expiresAt:Date.now()+lifetime},response);
  }
  function registerFinish(adminId:string,session:string,message:string,revokeDevices:boolean){
    const flow=take(session,'register',adminId);
    if(flow.kind!=='register')fail(401,'密码注册握手已结束');
    const registrationRecord=wire(message,256);
    // This library validates a registration record when decoding it for startLogin.
    // The probe only checks its wire structure. Only a genuine client login can prove the password.
    try {
      const probe=opaque.client.startLogin({password:randomId()});
      opaque.server.startLogin({userIdentifier,serverSetup:flow.setup,registrationRecord,startLoginRequest:probe.startLoginRequest});
    } catch {fail(400,'密码注册记录无效');}
    return save({revision:randomId(),enabled:true,serverSetup:flow.setup,registrationRecord},flow.revision,revokeDevices,flow.epoch);
  }
  function toggle(enabled:boolean,previous:string,revokeDevices:boolean){
    const epoch=deviceRevision();
    checkRevision(previous);
    const current=config();
    if(!current)fail(409,'请先配置浏览器登录密码');
    return save({...current,enabled,revision:randomId()},previous,revokeDevices,epoch);
  }
  async function loginStart(name:string,message:string){
    if(typeof name!=='string'||!name.trim()||[...name.trim()].length>80||/[\p{Cc}\p{Cs}]/u.test(name))fail(400,'请输入有效的浏览器设备名称');
    await opaque.ready;
    const epoch=deviceRevision(),current=config();
    if(!current?.enabled)fail(403,'浏览器密码登录未启用');
    const startLoginRequest=wire(message,128);
    reserve();
    let result:opaque.server.LoginStartResult;
    try {result=opaque.server.startLogin({userIdentifier,serverSetup:current.serverSetup,registrationRecord:current.registrationRecord,startLoginRequest});}
    catch{fail(401,'浏览器密码登录未通过');}
    return bind({kind:'login',revision:current.revision,name:name.trim(),serverState:result.serverLoginState,
      expiresAt:Date.now()+lifetime,epoch},result.loginResponse);
  }
  function loginFinish(session:string,message:string):T{
    const flow=take(session,'login');
    if(flow.kind!=='login')fail(401,'密码登录握手已结束');
    const finishLoginRequest=wire(message,86);
    try {opaque.server.finishLogin({serverLoginState:flow.serverState,finishLoginRequest});}
    catch{fail(401,'浏览器密码登录未通过');}
    return store.transaction(()=>{
      if(deviceRevision()!==flow.epoch || config()?.enabled!==true || revision()!==flow.revision)fail(401,'密码登录握手已失效');
      return devices.issuePassword(flow.name);
    });
  }
  return {state,registerStart,registerFinish,loginStart,loginFinish,
    enable:(revision:string,revokeDevices:boolean)=>toggle(true,revision,revokeDevices),
    disable:(revision:string,revokeDevices:boolean)=>toggle(false,revision,revokeDevices)};
}

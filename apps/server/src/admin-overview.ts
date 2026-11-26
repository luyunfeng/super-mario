import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import type {AddressInfo} from 'node:net';
import type {MachineInfo} from '../../../packages/protocol/src/index.ts';
import type {Store} from '../../../packages/plugin-sdk/src/index.ts';
import {adminEndpoints} from './admin-endpoints.ts';
import {buildInfo} from '../../../packages/core/src/build-info.ts';

type Options={
  store:Store; version:string; startedAt:string; demo:boolean;
  address:()=>AddressInfo|string|null;
  machines:()=>MachineInfo[];
  machineRemoved?:(id:string)=>void;
  plugins:()=>{id:string;status:string}[];
  devices:()=>{id:string}[];
};
type Status='ok'|'warning'|'error';
type Check={label:string;status:Status;detail:string};
const collection='core.admin-auth.instance';
const machineNames='core.admin-auth.machine-names';

export function createAdminOverview(options:Options) {
  const {store}=options;
  const instanceId=store.transaction(()=>{
    const existing=store.get<string>(collection,'id');
    if(existing)return existing;
    const id=randomUUID();
    store.put(collection,'id',id);
    return id;
  });
  const host=hostname().split('.')[0]?.trim();
  const defaultName=host && host!=='localhost' && !/^[a-f0-9]{12,64}$/i.test(host) ? host : 'super-mario-'+instanceId.slice(0,6);
  function listener(){
    const address=options.address();
    const listen=!address?'':typeof address==='string'?address:
      (address.family==='IPv6'?'['+address.address+']':address.address)+':'+address.port;
    return {listen,endpoints:adminEndpoints(address)};
  }
  function publicOrigin(){
    return store.get<string>(collection,'publicOrigin')??'';
  }
  function network(){
    return {publicOrigin:publicOrigin(), ...listener()};
  }
  function setPublicOrigin(value:unknown){
    const invalid=()=>Object.assign(new Error('请输入完整的 HTTPS 源地址，仅回环地址允许 HTTP'),{status:400});
    if(typeof value!=='string'||value.length>512)throw invalid();
    if(value===''){
      store.remove(collection,'publicOrigin');
      return network();
    }
    // Reject paths and empty credentials/query/fragment before URL normalizes them away.
    const authority=/^https?:\/\/([^/@?#\\%\s]+)\/?$/iu.exec(value)?.[1];
    if(!authority||/[\p{Cc}\p{Cs}]/u.test(value))throw invalid();
    let url:URL;
    try{url=new URL(value);}catch{throw invalid();}
    if(url.protocol==='http:' && !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority))throw invalid();
    if(url.origin.length>512)throw invalid();
    store.put(collection,'publicOrigin',url.origin);
    return network();
  }
  function read(){
    const name=store.get<string>(collection,'name')??defaultName;
    const machines=options.machines();
    const devices=options.plugins().some(p=>p.id==='browser-devices'&&p.status==='active')?options.devices().length:null;
    return {version:options.version,name,defaultName,instanceId,platform:process.platform,arch:process.arch,startedAt:options.startedAt,
      ...listener(),mode:options.demo?'demo' as const:'live' as const,
      machines:{online:machines.filter(m=>m.online).length,total:machines.length},devices};
  }
  function rename(value:unknown){
    if(typeof value!=='string'||/[\p{Cc}\p{Cs}]/u.test(value)||Array.from(value.trim()).length>64)
      throw Object.assign(new Error('实例名称最多 64 个字符，请使用单行文字'),{status:400});
    const name=value.trim();
    if(name)store.put(collection,'name',name);
    else store.remove(collection,'name');
    return read();
  }
  function machineList(){
    // Each node's build is returned beside the server's own, so the page can say when a
    // machine runs a build other than the one the server was started from.
    return {machines:options.machines().map(({id,name:reportedName,online,platform,connectedAt,capabilities,build})=>({
      id, name:store.get<string>(machineNames,id)??reportedName, reportedName, online, platform, connectedAt,
      capabilities:[...capabilities], ...(build ? { build } : {}),
    })),build:buildInfo()};
  }
  function renameMachine(id:unknown,value:unknown){
    if(typeof id!=='string'||!options.machines().some(machine=>machine.id===id))
      throw Object.assign(new Error('未找到执行机'),{status:404});
    if(typeof value!=='string'||/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)||Array.from(value.trim()).length>64)
      throw Object.assign(new Error('执行机显示名最多 64 个字符，请使用单行文字'),{status:400});
    const name=value.trim();
    if(name)store.put(machineNames,id,name);
    else store.remove(machineNames,id);
    return machineList();
  }
  function removeMachine(id:string,revoke:(id:string)=>boolean){
    store.transaction(()=>{
      const machine=options.machines().find(item=>item.id===id);
      if(!machine)throw Object.assign(new Error('未找到执行机'),{status:404});
      if(machine.online)throw Object.assign(new Error('执行机仍在线，请先断开连接'),{status:409});
      if(!store.remove('machines',id))throw Object.assign(new Error('未找到执行机'),{status:404});
      store.remove(machineNames,id);
      revoke(id);
    });
    options.machineRemoved?.(id);
    return machineList();
  }
  function doctor(){
    const checkedAt=new Date().toISOString(),checks:Check[]=[];
    function check(label:string,run:()=>Omit<Check,'label'>){
      try{checks.push({label,...run()});}
      catch{checks.push({label,status:'error',detail:'无法读取当前状态'});}
    }
    check('本地存储',()=>store.get<string>(collection,'id')===instanceId
      ? {status:'ok',detail:'SQLite 已读回本实例标识'}:{status:'error',detail:'未读到匹配的实例标识'});
    check('HTTP 服务',()=>options.address()?{status:'ok',detail:'服务已监听'}:{status:'error',detail:'服务尚未监听'});
    check('执行机',()=>{
      const machines=options.machines(),online=machines.filter(m=>m.online).length;
      return {status:machines.length>0 && online===machines.length?'ok':'warning',detail:'已登记 '+machines.length+' 台，当前在线 '+online+' 台'};
    });
    check('插件',()=>{
      const plugins=options.plugins(),active=plugins.filter(p=>p.status==='active').length;
      const failed=plugins.filter(p=>p.status==='failed'),waiting=plugins.filter(p=>p.status==='waiting');
      const affected=[...failed,...waiting].map(p=>p.id).filter(id=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)).slice(0,5);
      const counts='运行 '+active+' 个，等待 '+waiting.length+' 个，失败 '+failed.length+' 个，停用 '+plugins.filter(p=>p.status==='disabled').length+' 个';
      return {status:failed.length?'error':waiting.length?'warning':'ok',detail:affected.length?counts+'。请检查 '+affected.join('、'):counts};
    });
    return {checkedAt,checks};
  }
  return {read,rename,doctor,machineList,renameMachine,removeMachine,network,setPublicOrigin,publicOrigin};
}
